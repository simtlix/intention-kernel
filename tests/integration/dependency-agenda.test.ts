import { describe, expect, it } from "vitest";
import type { AgendaItem } from "../../src/contracts/agenda.js";
import type { KernelCheckpoint } from "../../src/contracts/checkpoint.js";
import type { PlanStep, StepExecutionResult, TurnPlan } from "../../src/contracts/plan.js";
import { capabilityId, factType } from "../../src/contracts/ids.js";
import { dependencyActivation } from "../../src/runtime/nodes.js";
import { updateAgenda } from "../../src/reducer/updateAgenda.js";
import { createMemoryDurability } from "../../src/testing/createMemoryDurability.js";
import { agentId, createKernel, defineAgent, defineCapability, defineSchema } from "../../src/index.js";
import type { ModelGateway, ModelResult } from "../../src/contracts/model.js";

function step(id: string, capability: string, intentionId = id): PlanStep {
  const intention = { id: intentionId as never, objective: capability, evidence: [], references: [],
    proposedCapability: capabilityId(capability), input: {}, resolution: "resolved" as const };
  return { id: id as never, intentionId: intention.id, intention, capabilityId: capabilityId(capability),
    input: {}, dependsOn: [], missingFacts: [], disposition: "execute", reason: { code: "READY", message: "Ready", evidence: [] } };
}

function pending(id: string, capability: string, missing: string, dependencies: readonly string[] = []): AgendaItem & { ownedDependencyIds: readonly string[] } {
  return { id: `agenda:${id}` as never, intention: step(id, capability).intention, status: "waiting_facts",
    missingFacts: [{ type: factType(missing), version: 1, description: missing }], dependencies: dependencies as never, ownedDependencyIds: dependencies };
}

function completed(item: PlanStep): StepExecutionResult {
  if (item.capabilityId === undefined) throw new Error("Fixture capability missing");
  return { status: "invoked", stepId: item.id, capabilityId: item.capabilityId,
    result: { status: "completed", output: {}, facts: [], evidence: [], artifacts: [] } };
}

function waiting(item: PlanStep, missing: string): StepExecutionResult {
  if (item.capabilityId === undefined) throw new Error("Fixture capability missing");
  return { status: "invoked", stepId: item.id, capabilityId: item.capabilityId, result: {
    status: "needs_dependency", requirement: { type: factType(missing), version: 1, description: missing },
    provider: { capabilityId: capabilityId("lookup.provider"), input: {} }, continuation: {},
  } };
}

function plan(...steps: PlanStep[]): TurnPlan { return { steps, responseGoal: "Continue" }; }

describe("dependency agenda lineage", () => {
  it("keeps dynamic ownership across three real turns and resumes the just-unblocked consumer first", async () => {
    const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });
    const executions: string[] = [];
    const provider = defineCapability({
      id: capabilityId("profile.collect"), version: 1, description: "Collect profile", input: schema, output: schema,
      requires: [], provides: [{ type: factType("profile.confirmed"), version: 1 }], effect: "read",
      execute: (context) => {
        executions.push("profile.collect");
        if (context.turn.continuation !== undefined && context.turn.interactionAnswer?.value === "done") return Promise.resolve({
          status: "completed" as const, output: {}, artifacts: [], evidence: [], facts: [{ type: factType("profile.confirmed"), version: 1, value: {}, evidenceIds: [], dependsOn: [] }],
        });
        return Promise.resolve({ status: "needs_input" as const, partialInput: { confirmed: true }, interaction: {
          id: "profile-input" as never, kind: "choice" as const, capabilityId: capabilityId("profile.collect"),
          goal: "Confirm your profile.", requestedFacts: [factType("profile.confirmed")],
          options: [{ id: "more", label: "More", value: "more" }, { id: "done", label: "Done", value: "done" }],
        } });
      },
    });
    const consumer = defineCapability({
      id: capabilityId("purchase.create"), version: 1, description: "Create purchase", input: schema, output: schema,
      requires: [], provides: [], effect: "read", execute: (context) => {
        executions.push("purchase.create");
        if (context.facts.some((fact) => fact.type === "profile.confirmed")) return Promise.resolve({
          status: "completed" as const, output: {}, facts: [], evidence: [], artifacts: [],
          interaction: { id: "purchase-next" as never, kind: "choice" as const, goal: "What's next?", requestedFacts: [], options: [{ id: "end", label: "Finish", value: "end" }] },
        });
        return Promise.resolve({
        status: "needs_dependency" as const, requirement: { type: factType("profile.confirmed"), version: 1, description: "Profile" },
        provider: { capabilityId: capabilityId("profile.collect"), input: {} }, continuation: {},
        });
      },
    });
    const older = defineCapability({ id: capabilityId("finance.choose"), version: 1, description: "Choose financing", input: schema, output: schema,
      requires: [], provides: [], effect: "read", execute: () => {
        executions.push("finance.choose");
        return Promise.resolve({ status: "completed" as const, output: {}, facts: [], evidence: [], artifacts: [],
          interaction: { id: "finance-input" as never, kind: "input" as const, goal: "Which financing?", requestedFacts: [] },
        });
      },
    });
    const evidence = [{ text: "create it", meaning: "create purchase", messageIndex: 0 }];
    const responses: Record<string, unknown> = {
      "capability.select": { mode: "selected", capabilityIds: ["purchase.create"], rationale: "Create purchase", evidence },
      "turn.interpret": { intentions: [{ id: "request", objective: "Create purchase", evidence, references: [], proposedCapability: "purchase.create", input: {}, resolution: "resolved" }], contradictions: [] },
      "response.compose": { parts: [{ text: "What's your name?", evidenceIds: [] }] },
      "response.grounding-review": { verdict: "supported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: [] },
    };
    const gateway: ModelGateway = { invoke: <T>(request: { task: string }): Promise<ModelResult<T>> => {
      if (!(request.task in responses)) throw new Error(`Unexpected task: ${request.task}`);
      return Promise.resolve({ value: responses[request.task] as T, provider: "scripted", model: "test", durationMs: 1 });
    } };
    let sequence = 0;
    const durability = createMemoryDurability();
    const agent = await createKernel({ modelGateway: gateway, durability,
      idGenerator: { next: (kind) => `${kind}-${String(++sequence)}` },
    }).compile(defineAgent({ id: agentId("lineage"), version: 1, identity: "Assistant", capabilities: [consumer, provider, older], policies: [], modelPolicy: {} }));
    await durability.withTurn({ threadId: "runtime-thread" as never, turnId: "seed" as never }, async (scope) => {
      await scope.commit({ value: null, checkpoint: { schemaVersion: 1, revision: 1, agentFingerprint: agent.fingerprint, messages: [], effects: [],
        agenda: [pending("older", "finance.choose", "product.selected")],
        facts: [{ type: factType("product.selected"), version: 1, value: {}, evidenceIds: [], evidence: [], dependsOn: [], producedBy: {
          capabilityId: capabilityId("finance.choose"), capabilityVersion: 1, turnId: "seed" as never, stepId: "seed" as never,
        } }],
      } });
    });
    const result = await agent.run({ threadId: "runtime-thread" as never, turnId: "runtime-turn" as never, input: { text: "create it" } });
    const parent = result.checkpoint.agenda.find((item) => item.intention.proposedCapability === "purchase.create");
    const child = result.checkpoint.agenda.find((item) => item.intention.proposedCapability === "profile.collect");
    expect(child).toBeDefined();
    expect(parent?.dependencies).toEqual([child?.id]);
    const alternate = step("alternate", "purchase.create");
    expect(updateAgenda(result.checkpoint.agenda, plan(alternate), [completed(alternate)]).map((item) => item.id)).toEqual(["agenda:older"]);
    for (const [index, optionId] of ["more", "done"].entries()) {
      const currentEvidence = [{ text: optionId, meaning: "answer profile", messageIndex: result.checkpoint.messages.length + index * 2 }];
      responses["capability.select"] = { mode: "selected", capabilityIds: ["profile.collect"], rationale: "Answer profile", evidence: currentEvidence };
      responses["turn.interpret"] = { intentions: [{ id: `new-answer-${String(index)}`, objective: "Answer profile", evidence: currentEvidence,
        references: [], proposedCapability: "profile.collect", input: {}, resolution: "resolved" }], contradictions: [] };
      const next = await agent.run({ threadId: "runtime-thread" as never, turnId: `answer-${String(index)}` as never,
        input: { text: optionId }, selection: { interactionId: "profile-input" as never, optionId } });
      if (index === 0) {
        const nextChild = next.checkpoint.agenda.find((item) => item.intention.proposedCapability === "profile.collect");
        expect(nextChild?.intention.id).not.toBe(child?.intention.id);
        expect(next.checkpoint.agenda.find((item) => item.intention.proposedCapability === "purchase.create")?.dependencies).toEqual([nextChild?.id]);
      } else {
        expect(next.checkpoint.agenda.map((item) => item.intention.proposedCapability)).toEqual(["finance.choose", "purchase.create"]);
        expect(next.checkpoint.interaction?.id).toBe("purchase-next");
      }
    }
    expect(executions).toEqual(["purchase.create", "profile.collect", "profile.collect", "profile.collect", "purchase.create"]);
  });

  it("resumes the consumer of just-published facts before older ready work", () => {
    const agenda = [pending("finance", "finance.choose", "product.selected"), pending("quote", "trade.quote", "identity.confirmed")];
    const identity = step("identity", "identity.confirm");
    const facts = ["product.selected", "identity.confirmed"].map((type) => ({
      type: factType(type), version: 1, value: {}, evidenceIds: [], evidence: [], dependsOn: [],
      producedBy: { capabilityId: capabilityId("identity.confirm"), capabilityVersion: 1, turnId: "turn" as never, stepId: identity.id },
    }));
    const result = completed(identity);
    const identityFact = facts[1];
    if (identityFact === undefined) throw new Error("Fixture identity missing");
    if (result.status !== "invoked" || result.result.status !== "completed") throw new Error("Fixture");
    const checkpoint: KernelCheckpoint = { schemaVersion: 1, revision: 1, agentFingerprint: "test", messages: [], facts, agenda, effects: [] };
    const activation = dependencyActivation({ plan: plan(identity), checkpoint,
      results: [{ ...result, result: { ...result.result, facts: [identityFact] } }],
      compiled: { capabilities: new Map() } as never,
    });
    expect(activation?.capabilityId).toBe("trade.quote");
  });

  it("records the actual child agenda identity on its dynamic parent", () => {
    const parent = pending("parent", "payment.choose", "finance.option");
    const child = step("child", "finance.choose");
    const agenda = updateAgenda([parent], plan(child), [waiting(child, "product.selected")], parent.id);
    expect(agenda.find((item) => item.id === parent.id)?.dependencies).toEqual(["agenda:child"]);
  });

  it("prunes obsolete dynamic descendants when their parent completes by an alternate path", () => {
    const parent = pending("parent", "payment.choose", "finance.option", ["agenda:child"]);
    const child = pending("child", "finance.choose", "product.selected", ["agenda:grandchild"]);
    const grandchild = pending("grandchild", "product.choose", "catalog.ready");
    const payment = step("cash", "payment.choose");
    expect(updateAgenda([parent, child, grandchild], plan(payment), [completed(payment)])).toEqual([]);
  });

  it("preserves a child still required by another live parent", () => {
    const parent = pending("parent", "payment.choose", "finance.option", ["agenda:child"]);
    const other = pending("other", "offer.prepare", "finance.option", ["agenda:child"]);
    const child = pending("child", "finance.choose", "product.selected");
    const payment = step("cash", "payment.choose");
    expect(updateAgenda([parent, other, child], plan(payment), [completed(payment)]).map((item) => item.id))
      .toEqual(["agenda:other", "agenda:child"]);
  });

  it("preserves independently admitted static prerequisites when their consumer completes", () => {
    const parent = { ...pending("parent", "payment.choose", "finance.option", ["agenda:child"]), ownedDependencyIds: [] };
    const child = pending("child", "finance.choose", "product.selected");
    const payment = step("cash", "payment.choose");
    expect(updateAgenda([parent, child], plan(payment), [completed(payment)]).map((item) => item.id)).toEqual(["agenda:child"]);
  });

  it("retires an old child when the parent now waits for a different dependency", () => {
    const parent = pending("parent", "payment.choose", "finance.option", ["agenda:child"]);
    const child = pending("child", "finance.choose", "product.selected");
    const changed = step("payment-next", "payment.choose", parent.intention.id);
    const agenda = updateAgenda([parent, child], plan(changed), [waiting(changed, "cash.confirmed")]);
    expect(agenda.map((item) => item.id)).toEqual(["agenda:payment-next"]);
    expect(agenda[0]?.dependencies).toEqual([]);
  });

  it("preserves dynamic ownership through durable commit, JSON serialization and reload", async () => {
    const parent = pending("parent", "payment.choose", "finance.option");
    const child = step("child", "finance.choose");
    const agenda = updateAgenda([parent], plan(child), [waiting(child, "product.selected")], parent.id);
    const checkpoint: KernelCheckpoint = { schemaVersion: 1, revision: 1, agentFingerprint: "test", messages: [], facts: [], agenda, effects: [] };
    const durability = createMemoryDurability();
    await durability.withTurn({ threadId: "thread" as never, turnId: "first" as never }, async (scope) => {
      await scope.commit({ checkpoint: JSON.parse(JSON.stringify(checkpoint)) as KernelCheckpoint, value: null });
    });
    await durability.withTurn({ threadId: "thread" as never, turnId: "second" as never }, (scope) => {
      const payment = step("cash", "payment.choose");
      expect(updateAgenda(scope.checkpoint?.agenda ?? [], plan(payment), [completed(payment)])).toEqual([]);
      return Promise.resolve();
    });
  });

  it("remaps an owned dependency when its agenda step resumes", () => {
    const parent = pending("parent", "payment.choose", "finance.option", ["agenda:child"]);
    const child = pending("child", "finance.choose", "product.selected");
    const resumed = step("child-next", "finance.choose", child.intention.id);
    const agenda = updateAgenda([parent, child], plan(resumed), [waiting(resumed, "term.selected")]);
    expect(agenda.find((item) => item.id === parent.id)?.dependencies).toEqual(["agenda:child-next"]);
  });

  it("keeps ownership when a trusted interaction answer gives the child a new intention ID", () => {
    const parent = pending("parent", "payment.choose", "finance.option", ["agenda:child"]);
    const child = pending("child", "finance.choose", "product.selected");
    const answered = step("answer", "finance.choose", "new-model-intention");
    const agenda = updateAgenda([parent, child], { ...plan(answered), answeredInteractionCapabilityId: capabilityId("finance.choose") }, [waiting(answered, "term.selected")]);
    expect(agenda.find((item) => item.id === parent.id)?.dependencies).toEqual(["agenda:answer"]);
    const payment = step("cash", "payment.choose");
    expect(updateAgenda(agenda, plan(payment), [completed(payment)])).toEqual([]);
  });

  it("keeps an independently requested provider after the old parent completes", () => {
    const parent = pending("parent", "payment.choose", "finance.option", ["agenda:child"]);
    const child = pending("child", "finance.choose", "product.selected");
    const explicit = step("independent", "finance.choose");
    const agenda = updateAgenda([parent, child], plan(explicit), [waiting(explicit, "product.selected")]);
    const payment = step("cash", "payment.choose");
    expect(updateAgenda(agenda, plan(payment), [completed(payment)]).map((item) => item.id)).toEqual(["agenda:independent"]);
  });

  it("does not make a pre-existing independent provider exclusively owned by a dynamic parent", () => {
    const parent = pending("parent", "payment.choose", "finance.option");
    const independent = pending("independent", "finance.choose", "product.selected");
    const automatic = step("automatic-child", "finance.choose");
    const agenda = updateAgenda([parent, independent], plan(automatic), [waiting(automatic, "product.selected")], parent.id);
    const payment = step("cash", "payment.choose");
    expect(updateAgenda(agenda, plan(payment), [completed(payment)]).map((item) => item.id)).toEqual(["agenda:automatic-child"]);
  });
});
