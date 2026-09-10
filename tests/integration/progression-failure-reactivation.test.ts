import { describe, expect, it } from "vitest";
import { agentId, capabilityId, createKernel, defineAgent, defineCapability, defineSchema, factType,
  type ModelGateway, type ModelRequest, type ModelResult } from "../../src/index.js";
import { createMemoryDurability } from "../../src/testing/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { reconcileProgression } from "../../src/progression/reconcileProgression.js";
import type { DurableEffectIdentity } from "../../src/contracts/durability.js";
import type { KernelCheckpoint } from "../../src/contracts/checkpoint.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "failure-regression",
  validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });

async function fixture(retryable = false, group = false) {
  let phase = "begin";
  let interactionId = "";
  let attempts = 0;
  let effects = 0;
  let effectIdentity: DurableEffectIdentity | undefined;
  const started = factType("work.started");
  const begin = defineCapability({ id: capabilityId("work.begin"), version: 1, description: "Begin a new request",
    input: schema, output: schema, requires: [], provides: [{ type: started, version: 1 }], effect: "read",
    execute: () => Promise.resolve({ status: "completed", output: {}, artifacts: [], evidence: [],
      facts: [{ type: started, version: 1, value: { request: phase }, evidenceIds: [], dependsOn: [] }] }),
  });
  const write = defineCapability({ id: capabilityId("work.write"), version: 1, description: "Perform requested write",
    input: schema, output: schema, requires: [{ type: started, version: 1, description: "Current request" }], provides: [],
    effect: "write", confirmation: "required", automation: { version: 1, createInput: () => ({}) },
    execute: async (context) => {
      attempts += 1;
      if (retryable) return { status: "failed", issue: { code: "NOT_DISPATCHED", message: "No effect was attempted.", retryable: true } };
      try {
        await context.runEffect("current-write", () => { effects += 1; return Promise.reject(new Error("Synthetic uncertain transport")); });
      } catch {
        return { status: "failed", issue: { code: "WRITE_OUTCOME_UNKNOWN", message: "The outcome is not known.", retryable } };
      }
      throw new Error("Expected synthetic uncertainty");
    },
  });
  const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
    const noOperation = phase === "confirm" || phase === "idle";
    const cap = phase === "explicit" ? write.id : begin.id;
    const evidence = [{ text: phase, meaning: "Current request", messageIndex: 0 }];
    const values: Record<string, unknown> = {
      "capability.select": { mode: noOperation ? "no_match" : "selected", capabilityIds: noOperation ? [] : [cap],
        rationale: "Current request", evidence },
      "turn.interpret": { intentions: noOperation ? [] : [{ id: `request-${phase}`, objective: phase, evidence,
        references: [], proposedCapability: cap, input: {}, resolution: "resolved" }], contradictions: [],
        ...(phase === "confirm" ? { answerToInteraction: { interactionId, value: true, evidence: "confirm" } } : {}) },
      "interaction-answer.review": { verdict: "supported", rationale: "The user explicitly confirms the pending operation." },
      "capability-selection.interaction-review": { verdict: "supported", rationale: "Explicit independent request." },
      "response.compose": { parts: [{ text: "The current operation remains unresolved.", evidenceIds: [] }] },
      "response.grounding-review": { verdict: "supported", decisionVerdict: "supported", continuityVerdict: "supported",
        unsupportedClaims: [], approvedClaimIndexes: [] },
    };
    if (!(request.task in values)) throw new Error(`Unexpected task ${request.task}`);
    return Promise.resolve({ value: values[request.task] as T, provider: "scripted", model: "test", durationMs: 1 });
  } };
  const durability = createMemoryDurability();
  const definition = defineAgent({
    id: agentId("failure-reactivation"), version: 1, identity: "Test agent", capabilities: [begin, write], policies: [], modelPolicy: {},
    progression: { groups: group ? [{ id: "work.operations", label: "Operations", prompt: "Choose an operation", continueLabel: "Continue",
      repeatAfterMember: true, completedMemberVisibility: "show", members: [{ capabilityId: write.id, label: "Write", examples: [] }] }] : [],
    rules: [{ id: "write.after-start", version: 1, target: group ? { groupId: "work.operations" } : { capabilityId: write.id },
      mode: "required", priority: 100, activateWhen: [{ type: started, version: 1 }] }] },
  });
  const compiled = await compileAgentDefinition(definition);
  const runtime = await createKernel({ modelGateway: gateway, durability: {
    withTurn: (identity, operation) => durability.withTurn(identity, (scope) => operation({
      ...scope,
      runEffect: (effect, perform) => { effectIdentity = effect; return scope.runEffect(effect, perform); },
    })),
  } }).compile(definition);
  const run = async (nextPhase: string) => {
    phase = nextPhase;
    const result = await runtime.run({ threadId: "failure-thread" as never, turnId: `turn-${phase}` as never, input: { text: phase } });
    interactionId = result.checkpoint.interaction?.id ?? "";
    return result;
  };
  const assertUncertaintyPreserved = async () => {
    if (effectIdentity === undefined) throw new Error("No synthetic effect attempted");
    const recorded = effectIdentity;
    await expect(durability.withTurn({ threadId: "failure-thread" as never, turnId: "inspect-effect" as never },
      (scope) => scope.runEffect(recorded, () => { effects += 1; return Promise.resolve("must not run"); })))
      .rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    expect(effects).toBe(1);
  };
  return { run, compiled, assertUncertaintyPreserved, counts: () => ({ attempts, effects }) };
}

describe("failed progression operation is not new automatic consent", () => {
  it("does not recreate confirmation after a nonretryable uncertain write, including a later turn", async () => {
    const { run, counts, assertUncertaintyPreserved, compiled } = await fixture();
    const initial = await run("begin");
    expect(initial.checkpoint.interaction?.kind).toBe("confirmation");
    const failed = await run("confirm");
    expect(counts()).toEqual({ attempts: 1, effects: 1 });
    const serialized = JSON.parse(JSON.stringify(failed.checkpoint)) as KernelCheckpoint;
    expect(reconcileProgression({ checkpoint: serialized, compiled }).activation).toBeUndefined();
    await assertUncertaintyPreserved();
    expect(failed.checkpoint.interaction).toBeUndefined();
    expect(failed.checkpoint.agenda).toEqual([expect.objectContaining({ status: "blocked" })]);
    expect(failed.checkpoint.progression?.occurrences).toEqual([expect.objectContaining({ status: "active", activeMember: "work.write" })]);
    const receipt = failed.checkpoint.effects;
    const idle = await run("idle");
    expect(idle.checkpoint.interaction).toBeUndefined();
    expect(idle.checkpoint.effects).toEqual(receipt);
    expect(counts()).toEqual({ attempts: 1, effects: 1 });
  });

  it("binds a direct nonretryable failure to the pending occurrence even without a progression action", async () => {
    const { run, compiled } = await fixture();
    const initial = await run("begin");
    const base = { ...initial.checkpoint };
    delete base.interaction;
    const checkpoint: KernelCheckpoint = { ...base, progression: { occurrences: (initial.checkpoint.progression?.occurrences ?? []).map((entry) => {
      const rest = { ...entry };
      delete rest.activeMember;
      return { ...rest, status: "pending" };
    }) } };
    const result = reconcileProgression({ checkpoint, compiled, results: [{ status: "invoked", stepId: "direct" as never,
      capabilityId: capabilityId("work.write"), result: { status: "failed", issue: { code: "REFUSED", message: "Cannot perform it.", retryable: false } } }] });
    expect(result.activation).toBeUndefined();
    expect(result.checkpoint.progression?.occurrences[0]?.activeMember).toBe("work.write");
  });

  it("retains existing retryable progression behavior rather than treating all failures as permanent", async () => {
    const { run, counts } = await fixture(true);
    await run("begin");
    const failed = await run("confirm");
    expect(failed.checkpoint.interaction?.kind).toBe("confirmation");
    expect(counts()).toEqual({ attempts: 1, effects: 0 });
  });

  it.each(["pending", "active"] as const)("does not reopen a group when its %s member fails nonretryably", async (status) => {
    const { run, compiled } = await fixture(false, true);
    const initial = await run("begin");
    const base = { ...initial.checkpoint };
    delete base.interaction;
    const occurrence = initial.checkpoint.progression?.occurrences[0];
    if (occurrence === undefined) throw new Error("Expected group occurrence");
    const checkpoint: KernelCheckpoint = { ...base, progression: { occurrences: [{ ...occurrence, status,
      ...(status === "active" ? { activeMember: capabilityId("work.write") } : {}) }] } };
    const result = reconcileProgression({ checkpoint, compiled,
      ...(status === "pending" ? { plan: { steps: [], responseGoal: "Current operation failed", progressionAction: {
        kind: "member" as const, occurrenceId: occurrence.id, capabilityId: capabilityId("work.write"),
      } } } : {}),
      results: [{ status: "invoked", stepId: "member" as never, capabilityId: capabilityId("work.write"),
        result: { status: "failed", issue: { code: "REFUSED", message: "Cannot perform it.", retryable: false } } }],
    });
    expect(result.interactionRequested).toBe(false);
    expect(result.checkpoint.progression?.occurrences[0]).toMatchObject({ status: "active", activeMember: "work.write" });
    expect(reconcileProgression({ checkpoint: result.checkpoint, compiled }).interactionRequested).toBe(false);
  });

  it("allows a fresh explicit request without silently retrying its prior uncertain effect", async () => {
    const { run, counts } = await fixture();
    await run("begin");
    const failed = await run("confirm");
    const explicit = await run("explicit");
    expect(explicit.checkpoint.interaction?.kind).toBe("confirmation");
    expect(explicit.checkpoint.effects).toEqual(failed.checkpoint.effects);
    expect(counts()).toEqual({ attempts: 1, effects: 1 });
  });

  it("allows a different fact publication to activate a new occurrence without erasing uncertainty", async () => {
    const { run, counts } = await fixture();
    await run("begin");
    const failed = await run("confirm");
    const another = await run("new-request");
    expect(another.checkpoint.interaction?.kind).toBe("confirmation");
    expect(another.checkpoint.progression?.occurrences.map((entry) => entry.status)).toEqual(["superseded", "active"]);
    expect(another.checkpoint.effects).toEqual(failed.checkpoint.effects);
    expect(counts()).toEqual({ attempts: 1, effects: 1 });
  });
});
