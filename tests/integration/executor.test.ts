import { describe, expect, it } from "vitest";

import {
  agentId,
  capabilityId,
  compileAgentDefinition,
  defineAgent,
  defineCapability,
  defineSchema,
  executeTurnPlan,
  factType,
  threadId,
  turnId,
  type CapabilityDefinition,
  type IntentionRequest,
  type KernelCheckpoint,
  type PlanStep,
  type TurnPlan,
} from "../../src/internal.js";
import { createMemoryDurability } from "../../src/testing/index.js";

const schema = defineSchema<Record<string, unknown>>({
  vendor: "executor-test",
  validate: (value) =>
    typeof value === "object" && value !== null
      ? { value: value as Record<string, unknown> }
      : { issues: [{ message: "Expected object" }] },
  jsonSchema: () => ({ type: "object" }),
});

function definition(
  id: string,
  execute: CapabilityDefinition<Record<string, unknown>, Record<string, unknown>>["execute"],
  options: {
    requires?: readonly string[];
    provides?: readonly string[];
    effect?: "read" | "write";
  } = {},
) {
  return defineCapability({
    id: capabilityId(id),
    version: 1,
    description: `Perform ${id}`,
    input: schema,
    output: schema,
    requires: (options.requires ?? []).map((type) => ({ type: factType(type), version: 1, description: type })),
    provides: (options.provides ?? []).map((type) => ({ type: factType(type), version: 1 })),
    effect: options.effect ?? "read",
    confirmation: options.effect === "write" ? "required" : "none",
    execute,
  });
}

function intention(id: string, operation: string): IntentionRequest {
  return {
    id: id as never,
    objective: operation,
    evidence: [{ text: operation, meaning: operation, messageIndex: 0 }],
    references: [],
    proposedCapability: capabilityId(operation),
    input: {},
    resolution: "resolved",
  };
}

function step(id: string, operation: string, dependsOn: readonly string[] = []): PlanStep {
  const request = intention(`request.${id}`, operation);
  return {
    id: id as never,
    intentionId: request.id,
    intention: request,
    capabilityId: capabilityId(operation),
    input: {},
    dependsOn: dependsOn as never,
    missingFacts: [],
    disposition: "execute",
    reason: { code: "READY", message: "Ready", evidence: [operation] },
  };
}

function plan(...steps: PlanStep[]): TurnPlan {
  return { steps, responseGoal: "Execute test plan" };
}

function checkpoint(): KernelCheckpoint {
  return {
    schemaVersion: 1,
    revision: 0,
    agentFingerprint: "executor",
    messages: [],
    facts: [],
    agenda: [],
    effects: [],
  };
}

async function run(
  capabilities: readonly CapabilityDefinition<Record<string, unknown>, Record<string, unknown>>[],
  turnPlan: TurnPlan,
) {
  const compiled = await compileAgentDefinition(defineAgent({
    id: agentId("executor.agent"),
    version: 1,
    identity: "Executor test agent",
    capabilities,
    policies: [],
    modelPolicy: {},
  }));
  const durability = createMemoryDurability({ now: () => "2026-09-03T10:00:00.000Z" });
  return durability.withTurn(
    { threadId: threadId("thread-1"), turnId: turnId("turn-1") },
    (scope) => executeTurnPlan({
      plan: turnPlan,
      compiled,
      checkpoint: checkpoint(),
      ports: {},
      threadId: threadId("thread-1"),
      turnId: turnId("turn-1"),
      scope,
      signal: AbortSignal.timeout(2_000),
    }),
  );
}

describe("level executor", () => {
  it("rejects an unsupported response mode before publishing an interaction", async () => {
    const provider = definition("data.collect", () => Promise.resolve({ status: "needs_input", partialInput: {},
      interaction: { id: "input" as never, kind: "input", goal: "Which type?", requestedFacts: [],
        responseMode: "unreviewed" as never },
    }));
    await expect(run([provider], plan(step("collect", "data.collect"))))
      .rejects.toMatchObject({ code: "INVALID_INTERACTION_RESPONSE_MODE" });
  });

  it("accepts an explicit interaction dismissal only after a completed operation", async () => {
    const provider = definition("data.inspect", () => Promise.resolve({ status: "completed", output: {},
      facts: [], evidence: [], artifacts: [], interaction: null }));
    const summary = await run([provider], plan(step("inspect", "data.inspect")));
    expect(summary.results[0]).toMatchObject({ status: "invoked", result: { status: "completed", interaction: null } });
    const incomplete = definition("data.collect", () => Promise.resolve({ status: "needs_input", partialInput: {},
      interaction: null as never }));
    await expect(run([incomplete], plan(step("collect", "data.collect"))))
      .rejects.toMatchObject({ code: "INVALID_CAPABILITY_INTERACTION" });
  });
  it.each([{ examples: [1] }, { examples: Array<string>(1) }])("rejects invalid option reference examples before returning a capability interaction: $examples", async ({ examples }) => {
    const provider = definition("data.collect", () => Promise.resolve({ status: "needs_input", partialInput: {},
      interaction: { id: "input" as never, kind: "choice", goal: "Choose?", requestedFacts: [],
        options: [{ id: "option", label: "Option", value: "a", referenceExamples: examples as unknown as readonly string[] }],
      },
    }));
    await expect(run([provider], plan(step("collect", "data.collect"))))
      .rejects.toMatchObject({ code: "INVALID_INTERACTION_REFERENCE_EXAMPLES" });
  });

  it.each(["needs_input", "needs_confirmation", "needs_dependency"] as const)("retains declared prerequisites when a provider returns %s", async (status) => {
    let calls = 0;
    const provider = definition("data.collect", () => Promise.resolve(status === "needs_dependency" ? {
      status, requirement: { type: factType("other.fact"), version: 1, description: "Other" },
      provider: { capabilityId: capabilityId("other.collect"), input: {} }, continuation: {},
    } : status === "needs_confirmation" ? {
      status, proposedInput: {}, interaction: { id: "confirm" as never, kind: "confirmation", goal: "Confirm?", requestedFacts: [] },
    } : {
      status, partialInput: {}, interaction: { id: "input" as never, kind: "input", goal: "Data?", requestedFacts: [] },
    }), { provides: ["data.ready"] });
    const consumer = definition("data.use", () => {
      calls += 1;
      return Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] });
    }, { requires: ["data.ready"] });
    const summary = await run([provider, consumer], plan(step("use", "data.use", ["collect"]), step("collect", "data.collect")));
    expect(calls).toBe(0);
    expect(summary.results[0]).toMatchObject({ status: "skipped", reason: { code: "DEPENDENCY_PENDING" },
      pendingFacts: [{ type: "data.ready", version: 1, description: "data.ready" }] });
  });

  it("keeps a failed sibling authoritative over an interactive provider", async () => {
    const provider = definition("data.collect", () => Promise.resolve({ status: "needs_input", partialInput: {},
      interaction: { id: "input" as never, kind: "input", goal: "Data?", requestedFacts: [] },
    }), { provides: ["data.ready"] });
    const failure = definition("other.collect", () => Promise.resolve({ status: "failed", issue: { code: "UNAVAILABLE", message: "Unavailable", retryable: false } }), { provides: ["other.ready"] });
    const consumer = definition("data.use", () => { throw new Error("Must not execute"); }, { requires: ["data.ready", "other.ready"] });
    const summary = await run([provider, failure, consumer], plan(step("use", "data.use", ["collect", "fail"]), step("collect", "data.collect"), step("fail", "other.collect")));
    expect(summary.results[0]).toMatchObject({ status: "skipped", reason: { code: "DEPENDENCY_NOT_COMPLETED" } });
    expect(summary.results[0]).not.toHaveProperty("pendingFacts");
  });


  it("never invents a pending fact for an undeclared dependency edge", async () => {
    const provider = definition("data.collect", () => Promise.resolve({ status: "needs_input", partialInput: {},
      interaction: { id: "input" as never, kind: "input", goal: "Data?", requestedFacts: [] },
    }), { provides: ["data.ready"] });
    const consumer = definition("data.use", () => { throw new Error("Must not execute"); });
    const summary = await run([provider, consumer], plan(step("use", "data.use", ["collect"]), step("collect", "data.collect")));
    expect(summary.results[0]).toMatchObject({ status: "skipped", reason: { code: "DEPENDENCY_NOT_COMPLETED" } });
    expect(summary.results[0]).not.toHaveProperty("pendingFacts");
  });

  it("delivers the complete validated intention to the capability", async () => {
    let received: IntentionRequest | undefined;
    const inspect = definition("catalog.compare", (context) => {
      received = context.intention;
      return Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] });
    });
    const compare = step("step-1", "catalog.compare");
    const referenced: IntentionRequest = {
      ...compare.intention,
      references: [{ expression: "the first", target: "option-1", evidence: "the first option" }],
    };

    await run([inspect], plan({ ...compare, intention: referenced }));

    expect(received).toEqual(referenced);
  });

  it("runs independent reads concurrently", async () => {
    let active = 0;
    let peak = 0;
    const read = (id: string) => definition(id, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { status: "completed", output: {}, facts: [], evidence: [], artifacts: [] };
    });

    const summary = await run([read("read.one"), read("read.two")], plan(step("step-1", "read.one"), step("step-2", "read.two")));

    expect(peak).toBe(2);
    expect(summary.results.map((result) => result.status)).toEqual(["invoked", "invoked"]);
  });

  it("projects provider facts before executing a dependent step", async () => {
    let selectedCandidates: unknown;
    const search = definition("catalog.search", () => Promise.resolve({
      status: "completed",
      output: { count: 1 },
      facts: [{
        type: factType("catalog.candidates"),
        version: 1,
        value: [{ id: "car-1" }],
        evidenceIds: ["catalog-evidence" as never],
        dependsOn: [],
      }],
      evidence: [{ id: "catalog-evidence" as never, source: "external", content: "Catalog candidate car-1" }],
      artifacts: [],
    }), { provides: ["catalog.candidates"] });
    const select = definition("catalog.select", (context) => {
      selectedCandidates = context.facts.find((fact) => fact.type === "catalog.candidates")?.value;
      return Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] });
    }, { requires: ["catalog.candidates"] });

    const summary = await run(
      [search, select],
      plan(step("step-1", "catalog.search"), step("step-2", "catalog.select", ["step-1"])),
    );

    expect(selectedCandidates).toEqual([{ id: "car-1" }]);
    expect(summary.facts[0]?.type).toBe("catalog.candidates");
  });

  it("skips failed dependents while preserving independent successes", async () => {
    let dependentCalls = 0;
    const provider = definition("data.load", () => Promise.resolve({
      status: "failed",
      issue: { code: "DATA_UNAVAILABLE", message: "No data", retryable: true },
    }), { provides: ["data.loaded"] });
    const dependent = definition("data.use", () => {
      dependentCalls += 1;
      return Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] });
    }, { requires: ["data.loaded"] });
    const independent = definition("health.read", () => Promise.resolve({
      status: "completed",
      output: {},
      facts: [],
      evidence: [],
      artifacts: [],
    }));

    const summary = await run(
      [provider, dependent, independent],
      plan(
        step("step-1", "data.load"),
        step("step-2", "data.use", ["step-1"]),
        step("step-3", "health.read"),
      ),
    );

    expect(dependentCalls).toBe(0);
    expect(summary.results).toHaveLength(3);
    expect(summary.results[0]).toMatchObject({ stepId: "step-1", status: "invoked" });
    expect(summary.results[1]).toMatchObject({ stepId: "step-2", status: "skipped" });
    expect(summary.results[1]?.status === "skipped" ? summary.results[1].reason.code : undefined)
      .toBe("DEPENDENCY_NOT_COMPLETED");
    expect(summary.results[2]).toMatchObject({ stepId: "step-3", status: "invoked" });
  });

  it("runs writes sequentially and only through the effect coordinator", async () => {
    let active = 0;
    let peak = 0;
    const write = (id: string) => definition(id, async (context) => {
      const effect = await context.runEffect(`${id}:entity-1`, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return id;
      });
      return { status: "completed", output: { value: effect.value }, facts: [], evidence: [], artifacts: [] };
    }, { effect: "write" });

    const summary = await run(
      [write("write.one"), write("write.two")],
      plan(step("step-1", "write.one"), step("step-2", "write.two")),
    );

    expect(peak).toBe(1);
    expect(summary.effects).toHaveLength(2);
    expect(summary.effects.every((receipt) => receipt.status === "completed")).toBe(true);
    expect(summary.effects.map((receipt) => receipt.idempotencyKey)).toEqual([
      "write.one:write.one:entity-1",
      "write.two:write.two:entity-1",
    ]);
  });

  it("rejects unstable capability event names at the execution boundary", async () => {
    const capability = definition("events.publish", async (context) => {
      await context.events.emit("Invalid Event Name", { ignored: true });
      return { status: "completed", output: {}, facts: [], evidence: [], artifacts: [] };
    });

    await expect(run([capability], plan(step("step-1", "events.publish")))).rejects.toMatchObject({
      code: "INVALID_CAPABILITY_EVENT_NAME",
      retryable: false,
    });
  });
});
