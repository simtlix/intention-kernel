import type { StepId, ThreadId, TurnId } from "./ids.js";

/** Observable event emitted by the kernel. */
export interface KernelEvent<T = unknown> {
  /** Globally unique event identity supplied by the kernel ID generator. */
  readonly id: string;
  /** Stable event name such as `plan.created` or `capability.event`. */
  readonly type: string;
  /** Payload contract version for independent event evolution. */
  readonly version: number;
  /** ISO timestamp supplied by the kernel clock. */
  readonly occurredAt: string;
  /** Conversation thread that owns the event. */
  readonly threadId: ThreadId;
  /** Turn that owns the event. */
  readonly turnId: TurnId;
  /** Plan branch associated with the event, when applicable. */
  readonly stepId?: StepId;
  /** Monotonically increasing position within the turn. */
  readonly sequence: number;
  /** Root trace identity shared by every event in a turn. */
  readonly correlationId: string;
  /** Earlier event that directly caused this event. */
  readonly causationId?: string;
  /** Routing category selected before the event reaches the sink. */
  readonly category: "trace" | "audit" | "integration";
  /** Sanitized event-specific payload. */
  readonly data: T;
}

/** Sink for sanitized kernel events. */
export interface EventSink {
  /** Persist, stream or export one already-sanitized event. */
  emit(event: KernelEvent): Promise<void>;
}
