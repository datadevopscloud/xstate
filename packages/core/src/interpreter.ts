import {
  Event,
  EventObject,
  CancelActionObject,
  DefaultContext,
  ActionObject,
  StateSchema,
  ActivityActionObject,
  SpecialTargets,
  ActionTypes,
  InvokeDefinition,
  SendActionObject,
  ServiceConfig,
  DisposeActivityFunction,
  StateValue,
  InterpreterOptions,
  ActivityDefinition,
  SingleOrArray,
  DoneEvent,
  Unsubscribable,
  MachineOptions,
  ActionFunctionMap,
  SCXML,
  Observer,
  Spawnable,
  Typestate
} from './types';
import { State, bindActionToState, isState } from './State';
import * as actionTypes from './actionTypes';
import { doneInvoke, error, getActionFunction, initEvent } from './actions';
import { IS_PRODUCTION } from './environment';
import {
  isPromiseLike,
  mapContext,
  warn,
  keys,
  isArray,
  isFunction,
  isString,
  isObservable,
  uniqueId,
  isMachineNode,
  toSCXMLEvent,
  symbolObservable
} from './utils';
import { Scheduler } from './scheduler';
import {
  Actor,
  isActor,
  ActorRef,
  fromService,
  fromCallback,
  fromPromise,
  fromObservable,
  fromMachine
} from './Actor';
import { isInFinalState } from './stateUtils';
import { registry } from './registry';
import { registerService } from './devTools';
import { DEFAULT_SPAWN_OPTIONS } from './invoke';
import { MachineNode } from './MachineNode';

export type StateListener<
  TContext,
  TEvent extends EventObject,
  TTypestate extends Typestate<TContext> = any
> = (state: State<TContext, TEvent, any, TTypestate>, event: TEvent) => void;

export type ContextListener<TContext = DefaultContext> = (
  context: TContext,
  prevContext: TContext | undefined
) => void;

export type EventListener<TEvent extends EventObject = EventObject> = (
  event: TEvent
) => void;

export type Listener = () => void;
export type ErrorListener = (error: Error) => void;

export interface Clock {
  setTimeout(fn: (...args: any[]) => void, timeout: number): any;
  clearTimeout(id: any): void;
}

interface SpawnOptions {
  name?: string;
  autoForward?: boolean;
  sync?: boolean;
}

/**
 * Maintains a stack of the current service in scope.
 * This is used to provide the correct service to spawn().
 *
 * @private
 */
const withServiceScope = (() => {
  const serviceStack = [] as Array<Interpreter<any, any, any>>;

  return <T, TService extends Interpreter<any, any, any>>(
    service: TService | undefined,
    fn: (service: TService) => T
  ) => {
    service && serviceStack.push(service);

    const result = fn(
      service || (serviceStack[serviceStack.length - 1] as TService)
    );

    service && serviceStack.pop();

    return result;
  };
})();

enum InterpreterStatus {
  NotStarted,
  Running,
  Stopped
}

export class Interpreter<
  // tslint:disable-next-line:max-classes-per-file
  TContext,
  TStateSchema extends StateSchema = any,
  TEvent extends EventObject = EventObject,
  TTypestate extends Typestate<TContext> = any
> implements ActorRef<State<TContext, TEvent>, TEvent> {
  /**
   * The default interpreter options:
   *
   * - `clock` uses the global `setTimeout` and `clearTimeout` functions
   * - `logger` uses the global `console.log()` method
   */
  public static defaultOptions: InterpreterOptions = ((global) => ({
    execute: true,
    deferEvents: true,
    clock: {
      setTimeout: (fn, ms) => {
        return global.setTimeout.call(null, fn, ms);
      },
      clearTimeout: (id) => {
        return global.clearTimeout.call(null, id);
      }
    },
    logger: global.console.log.bind(console),
    devTools: false
  }))(typeof window === 'undefined' ? global : window);
  /**
   * The current state of the interpreted machine.
   */
  private _state?: State<TContext, TEvent>;
  private _initialState?: State<TContext, TEvent>;
  /**
   * The clock that is responsible for setting and clearing timeouts, such as delayed events and transitions.
   */
  public clock: Clock;
  public options: Readonly<InterpreterOptions>;

  private scheduler: Scheduler = new Scheduler();
  private delayedEventsMap: Record<string, number> = {};
  private listeners: Set<StateListener<TContext, TEvent>> = new Set();
  private contextListeners: Set<ContextListener<TContext>> = new Set();
  private stopListeners: Set<Listener> = new Set();
  private errorListeners: Set<ErrorListener> = new Set();
  private doneListeners: Set<EventListener> = new Set();
  private eventListeners: Set<EventListener> = new Set();
  private sendListeners: Set<EventListener> = new Set();
  private logger: (...args: any[]) => void;
  /**
   * Whether the service is started.
   */
  public initialized = false;
  private _status: InterpreterStatus = InterpreterStatus.NotStarted;

  // Actor Ref
  public parent?: ActorRef<any, any>;
  public id: string;
  public ref: ActorRef<State<TContext, TEvent>, TEvent>;

  /**
   * The globally unique process ID for this invocation.
   */
  public sessionId: string;
  public children: Map<string | number, ActorRef<any, any>> = new Map();
  private forwardTo: Set<string> = new Set();

  // Dev Tools
  private devTools?: any;

  /**
   * Creates a new Interpreter instance (i.e., service) for the given machine with the provided options, if any.
   *
   * @param machine The machine to be interpreted
   * @param options Interpreter options
   */
  constructor(
    public machine: MachineNode<TContext, TStateSchema, TEvent, TTypestate>,
    options: Partial<InterpreterOptions> = Interpreter.defaultOptions
  ) {
    const resolvedOptions: InterpreterOptions = {
      ...Interpreter.defaultOptions,
      ...options
    };

    const { clock, logger, parent, id } = resolvedOptions;

    const resolvedId = id !== undefined ? id : machine.id;

    this.id = resolvedId;
    this.logger = logger;
    this.clock = clock;
    this.parent = parent;

    this.options = resolvedOptions;

    this.scheduler = new Scheduler({
      deferEvents: this.options.deferEvents
    });

    this.ref = fromService(this, this.parent, resolvedId);

    this.sessionId = this.ref.id;
  }
  public get initialState(): State<TContext, TEvent> {
    if (this._initialState) {
      return this._initialState;
    }

    return withServiceScope(this, () => {
      this._initialState = this.machine.getInitialState(this.ref);

      return this._initialState;
    });
  }
  public get current(): State<TContext, TEvent, any, TTypestate> {
    if (!IS_PRODUCTION) {
      warn(
        this._status !== InterpreterStatus.NotStarted,
        `Attempted to read state from uninitialized service '${this.id}'. Make sure the service is started first.`
      );
    }

    return this._state!;
  }
  public static interpret = interpret;
  /**
   * Executes the actions of the given state, with that state's `context` and `event`.
   *
   * @param state The state whose actions will be executed
   * @param actionsConfig The action implementations to use
   */
  public execute(
    state: State<TContext, TEvent>,
    actionsConfig?: MachineOptions<TContext, TEvent>['actions']
  ): void {
    for (const action of state.actions) {
      this.exec(action, state, actionsConfig);
    }
  }
  private update(
    state: State<TContext, TEvent>,
    _event: SCXML.Event<TEvent>
  ): void {
    // Attach session ID to state
    state._sessionid = this.sessionId;

    // Update state
    this._state = state;

    // Execute actions
    if (this.options.execute) {
      this.execute(this.current);
    }

    // Dev tools
    if (this.devTools) {
      this.devTools.send(_event.data, state);
    }

    // Execute listeners
    if (state.event) {
      for (const listener of this.eventListeners) {
        listener(state.event);
      }
    }

    for (const listener of this.listeners) {
      listener(state, state.event);
    }

    for (const contextListener of this.contextListeners) {
      contextListener(
        this.current.context,
        this.current.history ? this.current.history.context : undefined
      );
    }

    const isDone = isInFinalState(state.configuration || [], this.machine);

    if (this.current.configuration && isDone) {
      // get final child state node
      const finalChildStateNode = state.configuration.find(
        (sn) => sn.type === 'final' && sn.parent === this.machine
      );

      const doneData =
        finalChildStateNode && finalChildStateNode.data
          ? mapContext(finalChildStateNode.data, state.context, _event)
          : undefined;

      for (const listener of this.doneListeners) {
        listener(doneInvoke(this.id, doneData));
      }
      this.stop();
    }
  }
  /*
   * Adds a listener that is notified whenever a state transition happens. The listener is called with
   * the next state and the event object that caused the state transition.
   *
   * @param listener The state listener
   */
  public onTransition(
    listener: StateListener<TContext, TEvent, TTypestate>
  ): this {
    this.listeners.add(listener);

    // Send current state to listener
    if (this._status === InterpreterStatus.Running) {
      listener(this.current, this.current.event);
    }

    return this;
  }
  public subscribe(
    observer: Observer<State<TContext, TEvent, any, TTypestate>>
  ): Unsubscribable;
  public subscribe(
    nextListener?: (state: State<TContext, TEvent, any, TTypestate>) => void,
    // @ts-ignore
    errorListener?: (error: any) => void,
    completeListener?: () => void
  ): Unsubscribable;
  public subscribe(
    nextListenerOrObserver?:
      | ((state: State<TContext, TEvent, any, TTypestate>) => void)
      | Observer<State<TContext, TEvent, any, TTypestate>>,
    // @ts-ignore
    errorListener?: (error: any) => void,
    completeListener?: () => void
  ): Unsubscribable {
    if (!nextListenerOrObserver) {
      return { unsubscribe: () => void 0 };
    }

    let listener: (state: State<TContext, TEvent, any, TTypestate>) => void;
    let resolvedCompleteListener = completeListener;

    if (typeof nextListenerOrObserver === 'function') {
      listener = nextListenerOrObserver;
    } else {
      listener = nextListenerOrObserver.next.bind(nextListenerOrObserver);
      resolvedCompleteListener = nextListenerOrObserver.complete.bind(
        nextListenerOrObserver
      );
    }

    this.listeners.add(listener);

    // Send current state to listener
    if (this._status === InterpreterStatus.Running) {
      listener(this.current);
    }

    if (resolvedCompleteListener) {
      this.onDone(resolvedCompleteListener);
    }

    return {
      unsubscribe: () => {
        listener && this.listeners.delete(listener);
        resolvedCompleteListener &&
          this.doneListeners.delete(resolvedCompleteListener);
      }
    };
  }

  /**
   * Adds an event listener that is notified whenever an event is sent to the running interpreter.
   * @param listener The event listener
   */
  public onEvent(
    listener: EventListener
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.eventListeners.add(listener);
    return this;
  }
  /**
   * Adds an event listener that is notified whenever a `send` event occurs.
   * @param listener The event listener
   */
  public onSend(
    listener: EventListener
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.sendListeners.add(listener);
    return this;
  }
  /**
   * Adds a context listener that is notified whenever the state context changes.
   * @param listener The context listener
   */
  public onChange(
    listener: ContextListener<TContext>
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.contextListeners.add(listener);
    return this;
  }
  /**
   * Adds a listener that is notified when the machine is stopped.
   * @param listener The listener
   */
  public onStop(
    listener: Listener
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.stopListeners.add(listener);
    return this;
  }
  public onError(
    listener: ErrorListener
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.errorListeners.add(listener);
    return this;
  }
  /**
   * Adds a state listener that is notified when the statechart has reached its final state.
   * @param listener The state listener
   */
  public onDone(
    listener: EventListener<DoneEvent>
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.doneListeners.add(listener);
    return this;
  }
  /**
   * Removes a listener.
   * @param listener The listener to remove
   */
  public off(
    listener: (...args: any[]) => void
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.listeners.delete(listener);
    this.eventListeners.delete(listener);
    this.sendListeners.delete(listener);
    this.stopListeners.delete(listener);
    this.doneListeners.delete(listener);
    this.contextListeners.delete(listener);
    return this;
  }
  /**
   * Alias for Interpreter.prototype.start
   */
  public init = this.start;
  /**
   * Starts the interpreter from the given state, or the initial state.
   * @param initialState The state to start the statechart from
   */
  public start(
    initialState?: State<TContext, TEvent> | StateValue
  ): Interpreter<TContext, TStateSchema, TEvent, TTypestate> {
    if (this._status === InterpreterStatus.Running) {
      // Do not restart the service if it is already started
      return this;
    }

    registry.register(this.sessionId, this as Actor);
    this.initialized = true;
    this._status = InterpreterStatus.Running;

    const resolvedState =
      initialState === undefined
        ? this.initialState
        : isState<TContext, TEvent>(initialState)
        ? this.machine.resolveState(initialState)
        : this.machine.resolveState(
            State.from(initialState, this.machine.context)
          );

    if (this.options.devTools) {
      this.attachDev();
    }
    this.scheduler.initialize(() => {
      this.update(resolvedState, initEvent as SCXML.Event<TEvent>);
    });
    return this;
  }
  /**
   * Stops the interpreter and unsubscribe all listeners.
   *
   * This will also notify the `onStop` listeners.
   */
  public stop(): Interpreter<TContext, TStateSchema, TEvent> {
    for (const listener of this.listeners) {
      this.listeners.delete(listener);
    }
    for (const listener of this.stopListeners) {
      // call listener, then remove
      listener();
      this.stopListeners.delete(listener);
    }
    for (const listener of this.contextListeners) {
      this.contextListeners.delete(listener);
    }
    for (const listener of this.doneListeners) {
      this.doneListeners.delete(listener);
    }

    // Stop all children
    this.children.forEach((child) => {
      if (isFunction(child.stop)) {
        child.stop();
      }
    });

    // Cancel all delayed events
    for (const key of keys(this.delayedEventsMap)) {
      this.clock.clearTimeout(this.delayedEventsMap[key]);
    }

    this.scheduler.clear();
    this.initialized = false;
    this._status = InterpreterStatus.Stopped;
    registry.free(this.sessionId);

    return this;
  }
  /**
   * Sends an event to the running interpreter to trigger a transition.
   *
   * An array of events (batched) can be sent as well, which will send all
   * batched events to the running interpreter. The listeners will be
   * notified only **once** when all events are processed.
   *
   * @param event The event(s) to send
   */
  public send = (
    event: SingleOrArray<Event<TEvent>> | SCXML.Event<TEvent>
  ): State<TContext, TEvent> => {
    if (isArray(event)) {
      this.batch(event);
      return this.current;
    }

    const _event = toSCXMLEvent(event);

    if (this._status === InterpreterStatus.Stopped) {
      // do nothing
      if (!IS_PRODUCTION) {
        warn(
          false,
          `Event "${_event.name}" was sent to stopped service "${
            this.machine.id
          }". This service has already reached its final state, and will not transition.\nEvent: ${JSON.stringify(
            _event.data
          )}`
        );
      }
      return this.current;
    }

    if (
      this._status === InterpreterStatus.NotStarted &&
      this.options.deferEvents
    ) {
      // tslint:disable-next-line:no-console
      if (!IS_PRODUCTION) {
        warn(
          false,
          `Event "${_event.name}" was sent to uninitialized service "${
            this.machine.id
          }" and is deferred. Make sure .start() is called for this service.\nEvent: ${JSON.stringify(
            _event.data
          )}`
        );
      }
    } else if (this._status !== InterpreterStatus.Running) {
      throw new Error(
        `Event "${_event.name}" was sent to uninitialized service "${
          this.machine.id
          // tslint:disable-next-line:max-line-length
        }". Make sure .start() is called for this service, or set { deferEvents: true } in the service options.\nEvent: ${JSON.stringify(
          _event.data
        )}`
      );
    }

    this.scheduler.schedule(() => {
      // Forward copy of event to child actors
      this.forward(_event);

      const nextState = this.nextState(_event);

      this.update(nextState, _event);
    });

    return this._state!; // TODO: deprecate (should return void)
    // tslint:disable-next-line:semicolon
  };

  private batch(events: Array<TEvent | TEvent['type']>): void {
    if (
      this._status === InterpreterStatus.NotStarted &&
      this.options.deferEvents
    ) {
      // tslint:disable-next-line:no-console
      if (!IS_PRODUCTION) {
        warn(
          false,
          `${events.length} event(s) were sent to uninitialized service "${
            this.machine.id
          }" and are deferred. Make sure .start() is called for this service.\nEvent: ${JSON.stringify(
            event
          )}`
        );
      }
    } else if (this._status !== InterpreterStatus.Running) {
      throw new Error(
        // tslint:disable-next-line:max-line-length
        `${events.length} event(s) were sent to uninitialized service "${this.machine.id}". Make sure .start() is called for this service, or set { deferEvents: true } in the service options.`
      );
    }

    this.scheduler.schedule(() => {
      let nextState = this.current;
      let batchChanged = false;
      const batchedActions: Array<ActionObject<TContext, TEvent>> = [];
      for (const event of events) {
        const _event = toSCXMLEvent(event);

        this.forward(_event);

        nextState = withServiceScope(this, () => {
          return this.machine.transition(nextState, _event);
        });

        batchedActions.push(
          ...(nextState.actions.map((a) =>
            bindActionToState(a, nextState)
          ) as Array<ActionObject<TContext, TEvent>>)
        );

        batchChanged = batchChanged || !!nextState.changed;
      }

      nextState.changed = batchChanged;
      nextState.actions = batchedActions;
      this.update(nextState, toSCXMLEvent(events[events.length - 1]));
    });
  }

  /**
   * Returns a send function bound to this interpreter instance.
   *
   * @param event The event to be sent by the sender.
   */
  public sender(event: Event<TEvent>): () => State<TContext, TEvent> {
    return this.send.bind(this, event);
  }

  private sendTo = (
    event: SCXML.Event<TEvent>,
    to: string | number | ActorRef<any, any>
  ) => {
    const isParent = this.parent && to === SpecialTargets.Parent;
    const target = isParent
      ? this.parent
      : isActor(to)
      ? to
      : this.children.get(to) || registry.get(to as string);

    if (!target) {
      if (!isParent) {
        throw new Error(
          `Unable to send event to child '${to}' from service '${this.id}'.`
        );
      }

      // tslint:disable-next-line:no-console
      if (!IS_PRODUCTION) {
        warn(
          false,
          `Service '${this.id}' has no parent: unable to send event ${event.type}`
        );
      }
      return;
    }

    target.send({
      ...event,
      name: event.name === actionTypes.error ? `${error(this.id)}` : event.name,
      origin: this
    });

    // if ('machine' in (target as any)) {
    //   const scxmlEvent = {
    //     ...event,
    //     name:
    //       event.name === actionTypes.error ? `${error(this.id)}` : event.name,
    //     origin: this.sessionId
    //   };
    //   // Send SCXML events to machines
    //   target.send(scxmlEvent);
    // } else {
    //   console.log('no machine in', target);
    //   // Send normal events to other targets
    //   target.send(event.data);
    // }
  };
  /**
   * Returns the next state given the interpreter's current state and the event.
   *
   * This is a pure method that does _not_ update the interpreter's state.
   *
   * @param event The event to determine the next state
   */
  public nextState(
    event: Event<TEvent> | SCXML.Event<TEvent>
  ): State<TContext, TEvent> {
    const _event = toSCXMLEvent(event);

    if (
      _event.name.indexOf(actionTypes.errorPlatform) === 0 &&
      !this.current.nextEvents.some(
        (nextEvent) => nextEvent.indexOf(actionTypes.errorPlatform) === 0
      )
    ) {
      // TODO: refactor into proper error handler
      if (this.errorListeners.size > 0) {
        this.errorListeners.forEach((listener) => {
          listener((_event.data as any).data);
        });
      } else {
        throw (_event.data as any).data;
      }
    }

    const nextState = withServiceScope(this, () => {
      return this.machine.transition(this.current, _event);
    });

    return nextState;
  }
  private forward(event: SCXML.Event<TEvent>): void {
    for (const id of this.forwardTo) {
      const child = this.children.get(id);

      if (!child) {
        throw new Error(
          `Unable to forward event '${event.name}' from interpreter '${this.id}' to nonexistant child '${id}'.`
        );
      }

      child.send(event);
    }
  }
  private defer(sendAction: SendActionObject<TContext, TEvent>): void {
    this.delayedEventsMap[sendAction.id] = this.clock.setTimeout(() => {
      if (sendAction.to) {
        this.sendTo(sendAction._event, sendAction.to);
      } else {
        this.send(sendAction._event);
      }
    }, sendAction.delay as number);
  }
  private cancel(sendId: string | number): void {
    this.clock.clearTimeout(this.delayedEventsMap[sendId]);
    delete this.delayedEventsMap[sendId];
  }
  private exec(
    action: ActionObject<TContext, TEvent>,
    state: State<TContext, TEvent>,
    actionFunctionMap?: ActionFunctionMap<TContext, TEvent>
  ): void {
    const { context, _event } = state;
    const actionOrExec =
      getActionFunction(action.type, actionFunctionMap) || action.exec;
    const exec = isFunction(actionOrExec)
      ? actionOrExec
      : actionOrExec
      ? actionOrExec.exec
      : action.exec;

    if (exec) {
      try {
        return exec(context, _event.data, {
          action,
          state: this.current,
          _event
        });
      } catch (err) {
        if (this.parent) {
          this.parent.send({
            type: 'xstate.error',
            data: err
          } as EventObject);
        }

        throw err;
      }
    }

    switch (action.type) {
      case actionTypes.send:
        const sendAction = action as SendActionObject<TContext, TEvent>;

        if (typeof sendAction.delay === 'number') {
          this.defer(sendAction);
          return;
        } else {
          if (sendAction.to) {
            this.sendTo(sendAction._event, sendAction.to);
          } else {
            this.send(sendAction._event);
          }
        }
        break;

      case actionTypes.cancel:
        this.cancel((action as CancelActionObject<TContext, TEvent>).sendId);

        break;
      case actionTypes.start: {
        const activity = (action as ActivityActionObject<TContext, TEvent>)
          .actor as InvokeDefinition<TContext, TEvent>;

        // If the activity will be stopped right after it's started
        // (such as in transient states)
        // don't bother starting the activity.
        // if (!this.state.activities[activity.type]) {
        //   break;
        // }

        // Invoked services
        if (activity.type === ActionTypes.Invoke) {
          const actorCreator: ServiceConfig<TContext, TEvent> | undefined = this
            .machine.options.services
            ? this.machine.options.services[activity.src]
            : undefined;

          const { id, data } = activity;

          const autoForward =
            'autoForward' in activity
              ? activity.autoForward
              : !!activity.forward;

          if (!actorCreator) {
            // tslint:disable-next-line:no-console
            if (!IS_PRODUCTION) {
              warn(
                false,
                `No service found for invocation '${activity.src}' in machine '${this.machine.id}'.`
              );
            }
            return;
          }

          try {
            const actor = actorCreator(context, _event.data, {
              parent: this as any,
              id,
              data,
              _event
            });

            if (autoForward) {
              this.forwardTo.add(id);
            }

            this.children.set(id, actor);
            this.current.children[id] = actor;

            actor.start();
          } catch (err) {
            this.send(error(id, err));
          }
        }

        break;
      }
      case actionTypes.stop: {
        this.stopChild(action.actor.id);
        break;
      }

      case actionTypes.log:
        const { label, value } = action;

        if (label) {
          this.logger(label, value);
        } else {
          this.logger(value);
        }
        break;
      case actionTypes.assign:
        break;
      default:
        if (!IS_PRODUCTION) {
          warn(
            false,
            `No implementation found for action type '${action.type}'`
          );
        }
        break;
    }

    return undefined;
  }
  private removeChild(childId: string): void {
    this.children.delete(childId);
    this.forwardTo.delete(childId);

    delete this.current.children[childId];
  }

  private stopChild(childId: string): void {
    const child = this.children.get(childId);
    if (!child) {
      return;
    }

    this.removeChild(childId);

    if (isFunction(child.stop)) {
      child.stop();
    }
  }
  public spawn(
    entity: Spawnable,
    name: string,
    options?: SpawnOptions
  ): ActorRef<any, any> {
    if (isPromiseLike(entity)) {
      const actor = fromPromise(entity, this, name);
      this.children.set(name, actor);
      return actor;
    } else if (isFunction(entity)) {
      const actor = fromCallback(entity, this, name);
      this.children.set(name, actor);
      return actor;
    } else if (isActor(entity)) {
      this.children.set(entity.id, entity);
      return entity;
    } else if (isObservable<TEvent>(entity)) {
      const actor = fromObservable(entity, this, name);
      this.children.set(name, actor);
      return actor;
    } else if (isMachineNode(entity)) {
      return this.spawnMachine(entity, { ...options, id: name });
    } else {
      throw new Error(
        `Unable to spawn entity "${name}" of type "${typeof entity}".`
      );
    }
  }
  public spawnMachine<
    TChildContext,
    TChildStateSchema,
    TChildEvent extends EventObject
  >(
    machine: MachineNode<TChildContext, TChildStateSchema, TChildEvent>,
    options: Partial<InterpreterOptions> = {}
  ) {
    const resolvedOptions = {
      ...DEFAULT_SPAWN_OPTIONS,
      ...options
    };
    const actorRef = fromMachine(
      machine,
      this.ref,
      options.id || machine.id,
      resolvedOptions as InterpreterOptions
    );

    this.children.set(actorRef.id, actorRef); // TODO: fix types

    if (resolvedOptions.autoForward) {
      this.forwardTo.add(actorRef.id);
    }

    return actorRef;
  }

  private attachDev(): void {
    if (this.options.devTools && typeof window !== 'undefined') {
      if ((window as any).__REDUX_DEVTOOLS_EXTENSION__) {
        const devToolsOptions =
          typeof this.options.devTools === 'object'
            ? this.options.devTools
            : undefined;
        this.devTools = (window as any).__REDUX_DEVTOOLS_EXTENSION__.connect(
          {
            name: this.id,
            autoPause: true,
            stateSanitizer: (state: State<any, any>): object => {
              return {
                value: state.value,
                context: state.context,
                actions: state.actions
              };
            },
            ...devToolsOptions,
            features: {
              jump: false,
              skip: false,
              ...(devToolsOptions
                ? (devToolsOptions as any).features
                : undefined)
            }
          },
          this.machine
        );
        this.devTools.init(this.current);
      }

      // add XState-specific dev tooling hook
      registerService(this);
    }
  }
  public toJSON() {
    return {
      id: this.id
    };
  }

  public [symbolObservable]() {
    return this;
  }
}

const createNullActor = (name: string = 'null'): Actor => ({
  id: name,
  send: () => void 0,
  subscribe: () => {
    // tslint:disable-next-line:no-empty
    return { unsubscribe: () => {} };
  },
  toJSON: () => ({ id: name })
});

const resolveSpawnOptions = (nameOrOptions?: string | SpawnOptions) => {
  if (isString(nameOrOptions)) {
    return { ...DEFAULT_SPAWN_OPTIONS, name: nameOrOptions };
  }

  return {
    ...DEFAULT_SPAWN_OPTIONS,
    name: uniqueId(),
    ...nameOrOptions
  };
};

export function spawn<TC, TE extends EventObject>(
  entity: MachineNode<TC, any, TE>,
  nameOrOptions?: string | SpawnOptions
): Interpreter<TC, any, TE>;
export function spawn(
  entity: Spawnable,
  nameOrOptions?: string | SpawnOptions
): ActorRef<any, any>;
export function spawn(
  entity: Spawnable,
  nameOrOptions?: string | SpawnOptions
): ActorRef<any, any> {
  const resolvedOptions = resolveSpawnOptions(nameOrOptions);

  return withServiceScope(undefined, (service) => {
    if (!IS_PRODUCTION) {
      warn(
        !!service,
        `Attempted to spawn an Actor (ID: "${
          isMachineNode(entity) ? entity.id : 'undefined'
        }") outside of a service. This will have no effect.`
      );
    }

    if (service) {
      const spawned = service.spawn(
        entity,
        resolvedOptions.name,
        resolvedOptions
      );
      spawned.start();
      return spawned;
    } else {
      return createNullActor(resolvedOptions.name);
    }
  });
}

/**
 * Creates a new Interpreter instance for the given machine with the provided options, if any.
 *
 * @param machine The machine to interpret
 * @param options Interpreter options
 */
export function interpret<
  TContext = DefaultContext,
  TStateSchema extends StateSchema = any,
  TEvent extends EventObject = EventObject,
  TTypestate extends Typestate<TContext> = any
>(
  machine: MachineNode<TContext, TStateSchema, TEvent, TTypestate>,
  options?: Partial<InterpreterOptions>
) {
  const interpreter = new Interpreter<
    TContext,
    TStateSchema,
    TEvent,
    TTypestate
  >(machine, options);

  return interpreter;
}
