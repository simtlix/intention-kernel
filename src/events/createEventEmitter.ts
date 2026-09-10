import type { EventSink, KernelEvent } from "../contracts/events.js";
import type { StepId, ThreadId, TurnId } from "../contracts/ids.js";
import { deepFreeze } from "../context/deepFreeze.js";

/** Turn-scoped causal event collector and sanitized sink facade. */
export interface KernelEventEmitter {
  readonly events: readonly KernelEvent[];
  emit(
    type: string,
    data: unknown,
    metadata: {
      readonly category: KernelEvent["category"];
      readonly stepId?: StepId;
      readonly causationId?: string;
    },
  ): Promise<KernelEvent>;
}

/** Create a turn-scoped event emitter with causal ordering and redaction. */
export function createEventEmitter(options: {
  readonly sink: EventSink;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly correlationId: string;
  readonly now?: () => string;
  readonly nextId: () => string;
  readonly redact?: (data: unknown) => unknown;
}): KernelEventEmitter {
  const now = options.now ?? (() => new Date().toISOString());
  let sequence = 0;
  const events: KernelEvent[] = [];
  return {
    events,
    async emit(type, data, metadata): Promise<KernelEvent> {
      const safeData = stripPrivateReasoning(options.redact === undefined ? data : options.redact(data));
      const event: KernelEvent = deepFreeze(structuredClone({
        id: options.nextId(),
        type,
        version: 1,
        occurredAt: now(),
        threadId: options.threadId,
        turnId: options.turnId,
        ...(metadata.stepId === undefined ? {} : { stepId: metadata.stepId }),
        sequence: ++sequence,
        correlationId: options.correlationId,
        ...(metadata.causationId === undefined ? {} : { causationId: metadata.causationId }),
        category: metadata.category,
        data: safeData,
      }));
      events.push(event);
      await options.sink.emit(event);
      return event;
    },
  };
}

function stripPrivateReasoning(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPrivateReasoning);
  if (value === null || typeof value !== "object") return value;
  const forbidden = new Set(["chainOfThought", "privateReasoning", "rawReasoning"]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !forbidden.has(key))
      .map(([key, child]) => [key, stripPrivateReasoning(child)]),
  );
}
