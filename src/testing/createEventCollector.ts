import type { EventSink, KernelEvent } from "../contracts/events.js";

/** Event sink that retains emitted events for local inspection and conformance tests. */
export interface EventCollector extends EventSink {
  /** Events retained in sink arrival order. */
  readonly events: readonly KernelEvent[];
}

/** Create an in-memory sink for trace inspection and conformance assertions. */
export function createEventCollector(): EventCollector {
  const events: KernelEvent[] = [];
  return {
    events,
    emit(event): Promise<void> {
      events.push(event);
      return Promise.resolve();
    },
  };
}
