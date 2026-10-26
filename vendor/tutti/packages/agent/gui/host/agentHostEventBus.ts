import type { AgentHostEvent } from "../shared/contracts/dto";
import { getOptionalAgentHostApi } from "../agentActivityHost";

type UnsubscribeFn = () => void;
type EventCallback<TEvent extends AgentHostEvent = AgentHostEvent> = (
  event: TEvent
) => void;
type EventPredicate = (event: AgentHostEvent) => boolean;

export interface CoalescedSubscriptionOptions<TEvent extends AgentHostEvent> {
  delayMs: number;
  key?: (event: TEvent) => string;
  merge?: (events: TEvent[]) => TEvent;
}

interface Subscriber {
  matches: EventPredicate;
  emit: EventCallback;
  dispose?: () => void;
}

const LOG_PREFIX = "[agent-host-event-bus]";

let nextSubscriberId = 1;
const subscribers = new Map<number, Subscriber>();
let unsubscribeSource: UnsubscribeFn | null = null;

function logEventBusError(
  event: string,
  details: Record<string, unknown>
): void {
  console.error(`${LOG_PREFIX} ${JSON.stringify({ event, ...details })}`);
}

function ensureSourceListener(): void {
  if (unsubscribeSource !== null) {
    return;
  }
  const onEvent = getOptionalAgentHostApi()?.onHostEvent;
  if (typeof onEvent !== "function") {
    logEventBusError("source_listener_unavailable", {});
    return;
  }
  try {
    unsubscribeSource = onEvent(dispatchEvent);
  } catch (error) {
    logEventBusError("source_subscribe_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function releaseSourceListenerIfIdle(): void {
  if (subscribers.size > 0 || unsubscribeSource === null) {
    return;
  }
  const unsubscribe = unsubscribeSource;
  unsubscribeSource = null;
  try {
    unsubscribe();
  } catch (error) {
    logEventBusError("source_unsubscribe_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function addSubscriber(subscriber: Subscriber): UnsubscribeFn {
  const id = nextSubscriberId++;
  subscribers.set(id, subscriber);
  ensureSourceListener();
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    const current = subscribers.get(id);
    subscribers.delete(id);
    current?.dispose?.();
    releaseSourceListenerIfIdle();
  };
}

function dispatchEvent(event: AgentHostEvent): void {
  for (const [id, subscriber] of [...subscribers]) {
    let matches = false;
    try {
      matches = subscriber.matches(event);
    } catch (error) {
      logEventBusError("predicate_failed", {
        subscriberId: id,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    if (!matches) {
      continue;
    }
    try {
      subscriber.emit(event);
    } catch (error) {
      logEventBusError("callback_failed", {
        subscriberId: id,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export function subscribe<TType extends AgentHostEvent["type"]>(
  type: TType,
  callback: EventCallback<Extract<AgentHostEvent, { type: TType }>>
): UnsubscribeFn {
  return addSubscriber({
    matches: (event) => event.type === type,
    emit: (event) => callback(event as Extract<AgentHostEvent, { type: TType }>)
  });
}

export function subscribeMany<TType extends AgentHostEvent["type"]>(
  types: readonly TType[],
  callback: EventCallback<Extract<AgentHostEvent, { type: TType }>>
): UnsubscribeFn {
  const typeSet = new Set<AgentHostEvent["type"]>(types);
  return addSubscriber({
    matches: (event) => typeSet.has(event.type),
    emit: (event) => callback(event as Extract<AgentHostEvent, { type: TType }>)
  });
}

export function subscribeWhere(
  predicate: EventPredicate,
  callback: EventCallback
): UnsubscribeFn {
  return addSubscriber({
    matches: predicate,
    emit: callback
  });
}

export function subscribeCoalesced<TType extends AgentHostEvent["type"]>(
  type: TType,
  options: CoalescedSubscriptionOptions<
    Extract<AgentHostEvent, { type: TType }>
  >,
  callback: EventCallback<Extract<AgentHostEvent, { type: TType }>>
): UnsubscribeFn {
  type EventForType = Extract<AgentHostEvent, { type: TType }>;
  const pendingByKey = new Map<string, EventForType[]>();
  const timersByKey = new Map<string, number>();
  const delayMs = Math.max(0, options.delayMs);

  const clearTimer = (key: string): void => {
    const timer = timersByKey.get(key);
    if (timer === undefined) {
      return;
    }
    window.clearTimeout(timer);
    timersByKey.delete(key);
  };

  const flush = (key: string): void => {
    clearTimer(key);
    const events = pendingByKey.get(key) ?? [];
    pendingByKey.delete(key);
    if (events.length === 0) {
      return;
    }
    let nextEvent: EventForType;
    try {
      nextEvent = options.merge
        ? options.merge(events)
        : events[events.length - 1]!;
    } catch (error) {
      logEventBusError("merge_failed", {
        eventType: type,
        key,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    try {
      callback(nextEvent);
    } catch (error) {
      logEventBusError("callback_failed", {
        eventType: type,
        key,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  return addSubscriber({
    matches: (event) => event.type === type,
    emit: (event) => {
      const typedEvent = event as EventForType;
      let key: string = type;
      try {
        key = options.key ? options.key(typedEvent) : type;
      } catch (error) {
        logEventBusError("key_failed", {
          eventType: type,
          error: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      pendingByKey.set(key, [...(pendingByKey.get(key) ?? []), typedEvent]);
      clearTimer(key);
      timersByKey.set(
        key,
        window.setTimeout(() => flush(key), delayMs)
      );
    },
    dispose: () => {
      for (const key of timersByKey.keys()) {
        clearTimer(key);
      }
      pendingByKey.clear();
    }
  });
}
