import { describe, expect, it } from "vitest";

import { createEventEmitter, threadId, turnId } from "../../src/internal.js";
import { createEventCollector } from "../../src/testing/index.js";

describe("causal event emitter", () => {
  it.each([null, undefined])("never restores sensitive data when the host redactor returns %s", async (redacted) => {
    const collector = createEventCollector();
    const emitter = createEventEmitter({
      sink: collector,
      threadId: threadId("redacted-thread"),
      turnId: turnId("redacted-turn"),
      correlationId: "redacted-trace",
      nextId: () => "redacted-event",
      redact: () => redacted,
    });

    const event = await emitter.emit("model.invoked", {
      audit: { prompt: { instructions: "sensitive-host-instructions" } },
      credential: "sensitive-host-token",
    }, { category: "audit" });

    expect(event.data).toBe(redacted);
    expect(collector.events[0]?.data).toBe(redacted);
    expect(emitter.events[0]?.data).toBe(redacted);
    expect(JSON.stringify(collector.events)).not.toContain("sensitive-host");
  });

  it("emits monotonic, correlated and redacted events without private reasoning", async () => {
    const collector = createEventCollector();
    let id = 0;
    const emitter = createEventEmitter({
      sink: collector,
      threadId: threadId("thread-1"),
      turnId: turnId("turn-1"),
      correlationId: "correlation-1",
      now: () => "2026-09-03T10:00:00.000Z",
      nextId: () => `event-${String(++id)}`,
      redact: (data) => {
        const source = data as Record<string, unknown>;
        return { ...source, secret: source["secret"] === undefined ? undefined : "[redacted]" };
      },
    });

    const started = await emitter.emit("turn.started", {
      message: "hello",
      secret: "token",
      chainOfThought: "must never leave the process",
    }, { category: "trace" });
    await emitter.emit("plan.created", {
      rationale: { code: "READY", evidence: ["hello"] },
    }, { category: "audit", causationId: started.id, stepId: "step-1" as never });

    expect(collector.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(collector.events[1]).toMatchObject({
      correlationId: "correlation-1",
      causationId: "event-1",
      stepId: "step-1",
      category: "audit",
    });
    expect(collector.events[0]?.data).toEqual({ message: "hello", secret: "[redacted]" });
    expect(JSON.stringify(collector.events)).not.toContain("chainOfThought");
  });
});
