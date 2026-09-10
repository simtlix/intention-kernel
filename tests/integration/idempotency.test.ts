import { describe, expect, it } from "vitest";

import {
  capabilityId,
  EffectNotAppliedError,
  threadId,
  turnId,
  type DurableTurnScope,
  type KernelCheckpoint,
} from "../../src/index.js";
import { createMemoryDurability } from "../../src/testing/index.js";

const initial: KernelCheckpoint = {
  schemaVersion: 1,
  revision: 0,
  agentFingerprint: "memory",
  messages: [],
  facts: [],
  agenda: [],
  effects: [],
};

const effect = {
  idempotencyKey: "lead:create:customer-1",
  capabilityId: capabilityId("lead.create"),
  stepId: "step-1" as never,
};

describe("memory durability conformance", () => {
  it("replays a completed effect without invoking it twice", async () => {
    const durability = createMemoryDurability({ now: () => "2026-09-03T10:00:00.000Z" });
    let calls = 0;
    const execute = (scope: DurableTurnScope) => scope.runEffect(effect, () => {
      calls += 1;
      return Promise.resolve({ leadId: "lead-1" });
    });

    const first = await durability.withTurn({ threadId: threadId("thread-1"), turnId: turnId("turn-1") }, execute);
    const replay = await durability.withTurn({ threadId: threadId("thread-1"), turnId: turnId("turn-2") }, execute);

    expect(calls).toBe(1);
    expect(replay).toEqual(first);
    expect(replay.receipt.status).toBe("completed");
  });

  it("never retries an uncertain effect", async () => {
    const durability = createMemoryDurability({ now: () => "2026-09-03T10:00:00.000Z" });
    let calls = 0;
    const execute = (scope: DurableTurnScope) => scope.runEffect(effect, () => {
      calls += 1;
      throw new Error("connection lost after dispatch");
    });

    await expect(durability.withTurn({ threadId: threadId("thread-1"), turnId: turnId("turn-1") }, execute))
      .rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    await expect(durability.withTurn({ threadId: threadId("thread-1"), turnId: turnId("turn-2") }, execute))
      .rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    expect(calls).toBe(1);
  });

  it("allows retry only when the adapter proves the effect was not applied", async () => {
    const durability = createMemoryDurability({ now: () => "2026-09-03T10:00:00.000Z" });
    let calls = 0;
    const execute = (scope: DurableTurnScope) => scope.runEffect(effect, () => {
      calls += 1;
      if (calls === 1) {
        throw new EffectNotAppliedError({
          code: "UPSTREAM_REJECTED",
          message: "The upstream rejected the request before applying it.",
          retryable: true,
        });
      }
      return Promise.resolve({ leadId: "lead-1" });
    });

    await expect(durability.withTurn({ threadId: threadId("thread-1"), turnId: turnId("turn-1") }, execute))
      .rejects.toMatchObject({ code: "UPSTREAM_REJECTED" });
    const retried = await durability.withTurn({ threadId: threadId("thread-1"), turnId: turnId("turn-2") }, execute);

    expect(calls).toBe(2);
    expect(retried.receipt.status).toBe("completed");
  });

  it("exposes a committed result to a duplicate turn and serializes the thread", async () => {
    const durability = createMemoryDurability({ now: () => "2026-09-03T10:00:00.000Z" });
    const identity = { threadId: threadId("thread-1"), turnId: turnId("turn-1") };
    await durability.withTurn(identity, async (scope) => {
      await scope.commit({ value: { response: "done" }, checkpoint: { ...initial, revision: 1 } });
    });
    const replay = await durability.withTurn(identity, (scope) => Promise.resolve(scope.priorResult));

    expect(replay).toMatchObject({ value: { response: "done" }, checkpoint: { revision: 1 } });

    const order: string[] = [];
    await Promise.all([
      durability.withTurn({ threadId: threadId("thread-1"), turnId: turnId("turn-2") }, async () => {
        order.push("first:start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("first:end");
      }),
      durability.withTurn({ threadId: threadId("thread-1"), turnId: turnId("turn-3") }, () => {
        order.push("second:start");
        return Promise.resolve();
      }),
    ]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });
});
