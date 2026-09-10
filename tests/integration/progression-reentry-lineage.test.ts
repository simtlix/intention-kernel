import { describe, expect, it } from "vitest";
import { agentId, capabilityId, createKernel, defineAgent, defineCapability, defineSchema, factType } from "../../src/index.js";
import type { CapabilityResult } from "../../src/contracts/capability.js";
import type { KernelCheckpoint } from "../../src/contracts/checkpoint.js";
import type { FactCandidate } from "../../src/contracts/facts.js";
import type { Interaction } from "../../src/contracts/interaction.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";
import type { StepExecutionResult, TurnPlan } from "../../src/contracts/plan.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { projectModelContext } from "../../src/context/projectModelContext.js";
import { reduceCapabilityResults } from "../../src/reducer/reduceCapabilityResults.js";
import { reconcileProgression } from "../../src/progression/reconcileProgression.js";
import { createMemoryDurability } from "../../src/testing/createMemoryDurability.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "reentry-regression",
  validate: value => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });
const ref = (type: string) => ({ type: factType(type), version: 1 });
const publication = (type: string, value: unknown, parents: string[] = []): FactCandidate => ({ ...ref(type), value,
  dependsOn: parents.map(ref), evidenceIds: [] });
const completed = (...facts: FactCandidate[]): CapabilityResult<unknown> => ({ status: "completed", output: {}, facts, evidence: [], artifacts: [] });
const contact: Interaction = { id: "contact-name" as never, capabilityId: capabilityId("contact.collect"), kind: "input",
  goal: "What is your name?", requestedFacts: [factType("contact.name")] };
const waitingContact: CapabilityResult<unknown> = { status: "needs_input", partialInput: { pending: "name", retained: "private-contact" },
  modelRedactions: ["private-contact"], interaction: contact };
const dependency = (fact: string, provider: string): CapabilityResult<unknown> => ({ status: "needs_dependency",
  requirement: { ...ref(fact), description: fact }, provider: { capabilityId: capabilityId(provider), input: {} }, continuation: {} });
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required fixture lineage is missing");
  return value;
}

async function fixture(paymentEffect: "read" | "write" = "read", quoteEffect: "read" | "write" = "read") {
  const executions: string[] = [];
  const operation = (id: string, provides: string[], requires: string[], effect: "read" | "write" = "read") => defineCapability({
    id: capabilityId(id), version: 1, description: id, input: schema, output: schema, provides: provides.map(ref),
    requires: requires.map(type => ({ ...ref(type), description: type, resolution: "runtime" as const })), effect,
    confirmation: effect === "write" ? "capability" : "none", automation: { version: 1, createInput: () => ({}) },
    execute: (context, input) => {
      executions.push(id);
      const selected = context.facts.find(fact => fact.type === "option.selected");
      if (id === "option.select") return Promise.resolve(completed(publication("option.selected", { amount: input["amount"], line: "same-line" }, ["product.selected"])));
      if (id === "quote.calculate") {
        if (input["term"] !== 24 && context.turn.interactionAnswer?.value !== 24) return Promise.resolve({ status: "needs_input",
          partialInput: { option: selected?.value }, interaction: { id: "quote-term" as never, capabilityId: capabilityId(id), kind: "choice",
            goal: "How many installments?", requestedFacts: [], options: [{ id: "24", label: "24 installments", value: 24 }] } });
        return Promise.resolve(completed(publication("quote.selected", { ...(selected?.value as object), term: 24 }, ["option.selected"])));
      }
      if (id === "payment.decide") {
        const quote = context.facts.find(fact => fact.type === "quote.selected");
        if (quote === undefined) return Promise.resolve(dependency("quote.selected", "quote.calculate"));
        return Promise.resolve(completed(publication("payment.selected", quote.value, ["product.selected", "option.selected", "quote.selected"])));
      }
      if (id === "contact.collect") return Promise.resolve(waitingContact);
      // These pre-existing operations must stay pending throughout the read correction.
      if (id === "lead.create" || id === "budget.create") throw new Error("A suspended write was invoked during read correction");
      return Promise.resolve(completed());
    },
  });
  const definition = defineAgent({ id: agentId("reentry.lineage"), version: 1, identity: "Test agent", policies: [], modelPolicy: {},
    capabilities: [operation("product.select", ["product.selected"], []), operation("option.select", ["option.selected"], ["product.selected"]),
      operation("quote.calculate", ["quote.selected"], ["option.selected"], quoteEffect),
      operation("payment.decide", ["payment.selected", "payment.optional"], ["product.selected", "option.selected", "quote.selected"], paymentEffect),
      operation("contact.collect", ["contact.confirmed"], []), operation("lead.create", ["lead.created"], ["contact.confirmed"], "write"),
      operation("budget.create", ["budget.created"], ["product.selected", "payment.selected", "lead.created"], "write"),
      operation("other.read", [], [])],
    progression: { objective: { id: "complete-budget", activation: "conversation_start", completionFact: ref("budget.created") }, groups: [], rules: [
      { id: "quote.after-option", version: 1, target: { capabilityId: capabilityId("quote.calculate") }, mode: "required", priority: 150, activateWhen: [ref("option.selected")] },
      { id: "payment.after-product", version: 1, target: { capabilityId: capabilityId("payment.decide") }, mode: "required", priority: 300, activateWhen: [ref("product.selected")] },
      { id: "budget.after-product", version: 1, target: { capabilityId: capabilityId("budget.create") }, mode: "required", priority: 1300, activateWhen: [ref("product.selected")] },
    ] },
  });
  const compiled = await compileAgentDefinition(definition);
  let sequence = 0;
  const reduce = async (checkpoint: KernelCheckpoint, owner: string, result: CapabilityResult<unknown>, parent?: string, extra: Partial<TurnPlan> = {}) => {
    const id = `fixture-${String(++sequence)}` as never;
    const intention = { id, objective: owner, proposedCapability: capabilityId(owner), input: {}, resolution: "resolved" as const,
      references: [], evidence: [{ text: owner, meaning: owner, messageIndex: 0 }] };
    const plan: TurnPlan = { steps: [{ id, intentionId: id, intention, capabilityId: capabilityId(owner), input: {}, dependsOn: [],
      missingFacts: [], disposition: "execute", reason: { code: "READY", message: "Fixture", evidence: [] } }], responseGoal: "Continue", ...extra };
    const results: StepExecutionResult[] = [{ status: "invoked", stepId: id, capabilityId: capabilityId(owner), result }];
    const reduction = await reduceCapabilityResults({ checkpoint, plan, results, compiled, turnId: id,
      ...(parent === undefined ? {} : { dependencyParentId: parent as never }) });
    return { checkpoint: reduction.checkpoint, plan, results, turnPublications: reduction.publishedFacts, turnInvalidations: reduction.invalidatedFacts };
  };
  const reconcile = (state: Awaited<ReturnType<typeof reduce>>, deferActivation = false) => reconcileProgression({ ...state, compiled, deferActivation });
  let checkpoint: KernelCheckpoint = { schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, messages: [], facts: [], agenda: [], effects: [] };
  for (const [owner, fact] of [
    ["product.select", publication("product.selected", { id: "same-product" })],
    ["option.select", publication("option.selected", { amount: 1_000_000, line: "same-line" }, ["product.selected"])],
    ["quote.calculate", publication("quote.selected", { amount: 1_000_000, line: "same-line", term: 24 }, ["option.selected"])],
    ["payment.decide", publication("payment.selected", { amount: 1_000_000, line: "same-line", term: 24 }, ["product.selected", "option.selected", "quote.selected"])],
  ] as const) checkpoint = reconcile(await reduce(checkpoint, owner, completed(fact)), true).checkpoint;
  checkpoint = reconcileProgression({ checkpoint, compiled }).checkpoint;
  checkpoint = (await reduce(checkpoint, "budget.create", dependency("lead.created", "lead.create"))).checkpoint;
  const budget = checkpoint.agenda.find(item => item.intention.proposedCapability === "budget.create");
  checkpoint = (await reduce(checkpoint, "lead.create", dependency("contact.confirmed", "contact.collect"), budget?.id)).checkpoint;
  const lead = checkpoint.agenda.find(item => item.intention.proposedCapability === "lead.create");
  checkpoint = (await reduce(checkpoint, "contact.collect", waitingContact, lead?.id)).checkpoint;
  const initial = JSON.parse(JSON.stringify(checkpoint)) as KernelCheckpoint;
  const change = (cp = initial) => reduce(cp, "option.select", completed(publication("option.selected", { amount: 5_000_000, line: "same-line" }, ["product.selected"])));
  return { initial, compiled, definition, executions, reduce, reconcile, change };
}

describe("required read reentry under a transitive pending dependency", () => {
  it("suspends the contact question, recalculates and revalidates payment, then restores it across durable turns", async () => {
    const f = await fixture();
    const durability = createMemoryDurability();
    await durability.withTurn({ threadId: "reentry" as never, turnId: "seed" as never }, scope => scope.commit({ value: null, checkpoint: { ...f.initial, revision: 1 } }));
    let phase = 0;
    const messages = ["Change to 5000000 with the same option", "24 installments"];
    const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
      expect(JSON.stringify(request)).not.toMatch(/completionLineage|suspendedInteraction|private-contact/u);
      const capability = phase === 0 ? "option.select" : "quote.calculate";
      const evidence = [{ text: messages[phase], meaning: "Explicit current request", messageIndex: phase * 2 }];
      const responses: Record<string, unknown> = {
        "capability.select": { mode: "selected", capabilityIds: [capability], evidence, rationale: "Explicit current request" },
        "capability-selection.interaction-review": { verdict: "supported", rationale: "Independent current amount correction" },
        "interaction-answer.review": { verdict: "supported", rationale: "The current displayed installment choice" },
        "turn.interpret": { intentions: [{ id: `request-${String(phase)}`, objective: capability, proposedCapability: capability,
          input: phase === 0 ? { amount: 5_000_000 } : { term: 24 }, references: [], evidence, resolution: "resolved" }], contradictions: [] },
        "response.compose": { parts: [{ text: "Continue with the current question.", evidenceIds: [] }] },
        "response.grounding-review": { verdict: "supported", decisionVerdict: "supported", continuityVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: [] },
      };
      if (!(request.task in responses)) throw new Error(`Unexpected task ${request.task}`);
      return Promise.resolve({ value: responses[request.task] as T, provider: "scripted", model: "offline", durationMs: 1 });
    } };
    const firstRuntime = await createKernel({ modelGateway: gateway, durability }).compile(f.definition);
    const changed = await firstRuntime.run({ threadId: "reentry" as never, turnId: "change" as never, input: { text: messages[0] ?? "" } });
    expect(changed.checkpoint.facts.find(fact => fact.type === "option.selected")?.value).toEqual({ amount: 5_000_000, line: "same-line" });
    expect(changed.checkpoint.facts.some(fact => ["quote.selected", "payment.selected"].includes(fact.type))).toBe(false);
    expect(changed.checkpoint.interaction?.id).toBe("quote-term");
    for (const item of f.initial.agenda) {
      const retained = changed.checkpoint.agenda.find(candidate => candidate.id === item.id);
      if (item.intention.proposedCapability === "contact.collect") expect(retained).toMatchObject(item);
      else expect(retained).toEqual(item);
    }
    phase = 1;
    const freshRuntime = await createKernel({ modelGateway: gateway, durability }).compile(f.definition);
    const quoted = await freshRuntime.run({ threadId: "reentry" as never, turnId: "quote" as never,
      input: { text: messages[1] ?? "" }, selection: { interactionId: "quote-term" as never, optionId: "24" } });
    for (const type of ["quote.selected", "payment.selected"]) expect(quoted.checkpoint.facts.find(fact => fact.type === type)?.value)
      .toEqual({ amount: 5_000_000, line: "same-line", term: 24 });
    expect(quoted.checkpoint.interaction).toEqual(contact);
    expect(quoted.checkpoint.agenda).toEqual(f.initial.agenda);
    expect(quoted.checkpoint.effects).toEqual([]);
    expect(f.executions).toEqual(["option.select", "quote.calculate", "quote.calculate", "payment.decide"]);
    const replay = await freshRuntime.run({ threadId: "reentry" as never, turnId: "quote" as never,
      input: { text: messages[1] ?? "" }, selection: { interactionId: "quote-term" as never, optionId: "24" } });
    expect(replay.checkpoint).toEqual(quoted.checkpoint);
    expect(f.executions).toHaveLength(4);
  });

  it("reopens only the read completion whose actual publication was invalidated, not an absent conditional output", async () => {
    const f = await fixture();
    const payment = () => f.initial.progression?.occurrences.find(entry => entry.ruleId === "payment.after-product");
    expect(payment()?.status).toBe("satisfied");
    expect(f.initial.facts.some(fact => fact.type === "payment.optional")).toBe(false);
    expect(reconcileProgression({ checkpoint: f.initial, compiled: f.compiled }).checkpoint.progression?.occurrences.find(entry => entry.id === payment()?.id)?.status).toBe("satisfied");
    const changed = f.reconcile(await f.change());
    expect(changed.checkpoint.progression?.occurrences.find(entry => entry.id === payment()?.id)?.status).toBe("pending");
  });

  it.each(["confirmation", "protected", "write-owner", "unrelated-question", "unowned-dependency", "ambiguous-owner", "ambiguous-parents", "uncertain-owner", "prepared-owner", "no-fresh-publication"])("does not preempt %s", async kind => {
    const f = await fixture();
    let cp = f.initial;
    if (kind === "confirmation") cp = { ...cp, interaction: { ...contact, kind: "confirmation" } };
    if (kind === "protected") cp = { ...cp, interaction: { ...contact, protectedCanonicalMessage: "Bound confirmation" } };
    if (kind === "write-owner") cp = { ...cp, interaction: { ...contact, capabilityId: capabilityId("lead.create") } };
    if (kind === "unrelated-question") cp = { ...cp, interaction: { ...contact, capabilityId: capabilityId("other.read") },
      agenda: [...cp.agenda, { ...required(cp.agenda[2]), id: "other-question" as never,
        intention: { ...required(cp.agenda[2]).intention, proposedCapability: capabilityId("other.read") } }] };
    if (kind === "unowned-dependency") cp = { ...cp, agenda: cp.agenda.map(item => ({ ...item, ownedDependencyIds: [] })) };
    if (kind === "ambiguous-owner") cp = { ...cp, agenda: [...cp.agenda, { ...required(cp.agenda[2]), id: "duplicate-contact" as never }] };
    if (kind === "ambiguous-parents") cp = { ...cp, agenda: [...cp.agenda, { ...required(cp.agenda[1]), id: "second-parent" as never }] };
    if (kind === "uncertain-owner" || kind === "prepared-owner") cp = { ...cp, effects: [{ id: "unsettled-lead" as never, capabilityId: capabilityId("lead.create"),
      idempotencyKey: "unchanged", status: kind === "uncertain-owner" ? "uncertain" : "prepared", turnId: "earlier" as never,
      stepId: "earlier" as never, createdAt: "2026-01-01", updatedAt: "2026-01-01" }] };
    const changed = await f.change(cp);
    const reconciled = kind === "no-fresh-publication" ? reconcileProgression({ checkpoint: changed.checkpoint, compiled: f.compiled }) : f.reconcile(changed);
    expect(reconciled.activation).toBeUndefined();
    expect(reconciled.checkpoint.interaction).toEqual(cp.interaction);
    expect(reconciled.checkpoint.effects).toEqual(cp.effects);
    expect(f.executions).toEqual([]);
  });

  it("never promotes a freshly activated write ahead of the suspended read question", async () => {
    const f = await fixture("read", "write");
    const changed = f.reconcile(await f.change());
    expect(changed.activation).toBeUndefined();
    expect(changed.checkpoint.interaction).toEqual(contact);
    expect(changed.checkpoint.effects).toEqual([]);
    expect(f.executions).toEqual([]);
  });

  it("does not use a historical repaired prerequisite as fresh authority ahead of the stored question", async () => {
    const f = await fixture();
    const changed = f.reconcile(await f.change());
    const quoted = await f.reduce(changed.checkpoint, "quote.calculate", completed(
      publication("quote.selected", { amount: 5_000_000, line: "same-line", term: 24 }, ["option.selected"]),
    ));
    const restored = reconcileProgression({ checkpoint: quoted.checkpoint, compiled: f.compiled });
    expect(restored.activation).toBeUndefined();
    expect(restored.checkpoint.interaction).toEqual(contact);
    expect(restored.checkpoint.facts.some(fact => fact.type === "payment.selected")).toBe(false);
  });

  it.each(["declined", "write", "absent-without-invalidation", "different-publication", "legacy-without-lineage", "duplicate-occurrences"])("does not reopen a %s completion", async kind => {
    const f = await fixture(kind === "write" ? "write" : "read");
    let cp = f.initial;
    if (kind === "declined") cp = { ...cp, progression: { ...cp.progression, occurrences: required(cp.progression).occurrences.map(entry =>
      entry.ruleId === "payment.after-product" ? { ...entry, status: "declined" as const } : entry) } };
    if (kind === "absent-without-invalidation") cp = { ...cp, facts: cp.facts.filter(fact => fact.type !== "payment.selected") };
    if (kind === "different-publication") cp = { ...cp, facts: cp.facts.map(fact => fact.type === "payment.selected"
      ? { ...fact, producedBy: { ...fact.producedBy, stepId: "unrelated" as never } } : fact) };
    if (kind === "legacy-without-lineage") cp = { ...cp, progression: { ...cp.progression, occurrences: required(cp.progression).occurrences.map(entry => {
      const next = { ...entry } as typeof entry & { completionLineage?: unknown };
      delete next.completionLineage;
      return next;
    }) } };
    if (kind === "duplicate-occurrences") cp = { ...cp, progression: { ...cp.progression, occurrences: [...required(cp.progression).occurrences,
      { ...required(required(cp.progression).occurrences.find(entry => entry.ruleId === "payment.after-product")), id: "ambiguous-completion" }] } };
    const changed = f.reconcile(await f.change(cp));
    expect(changed.checkpoint.progression?.occurrences.find(entry => entry.ruleId === "payment.after-product")?.status).toBe(kind === "declined" ? "declined" : "satisfied");
    expect(changed.checkpoint.effects).toEqual([]);
  });

  it("does not reopen after retiring an actual optional output which the pending consumer never required", async () => {
    const f = await fixture();
    const withOptional = f.reconcile(await f.reduce(f.initial, "payment.decide", completed(
      publication("payment.selected", { method: "cash" }, ["product.selected"]),
      publication("payment.optional", { informational: true }, ["option.selected"]),
    ))).checkpoint;
    const changed = f.reconcile(await f.change(withOptional));
    expect(changed.checkpoint.facts.some(fact => fact.type === "payment.optional")).toBe(false);
    expect(changed.checkpoint.facts.find(fact => fact.type === "payment.selected")?.value).toEqual({ method: "cash" });
    expect(changed.checkpoint.progression?.occurrences.find(entry => entry.ruleId === "payment.after-product")?.status).toBe("satisfied");
  });

  it("does not resurrect a dismissed question or an explicitly cancelled objective", async () => {
    const f = await fixture();
    const dismissed = await f.reduce(f.initial, "other.read", { ...completed(), interaction: null } as CapabilityResult<unknown>);
    const changed = f.reconcile(await f.change(dismissed.checkpoint));
    expect(changed.activation).toBeUndefined();
    expect(changed.checkpoint.interaction).toBeUndefined();
    const cancelled = await f.reduce(f.initial, "other.read", completed(), undefined, { cancelledObjectiveIds: ["complete-budget"] });
    const corrected = f.reconcile(await f.change(cancelled.checkpoint));
    expect(corrected.checkpoint.progression?.objective?.status).toBe("cancelled");
    expect(corrected.checkpoint.interaction).toBeUndefined();
    // The new explicit read remains independent; it cannot revive the cancelled write journey.
    expect(corrected.activation?.capabilityId).not.toBe("budget.create");
    expect(corrected.checkpoint.progression?.occurrences.find(entry => entry.ruleId === "payment.after-product")?.status).not.toBe("pending");
  });

  it("retires pending completion repair when its consumer is cancelled instead of restoring its contact or activating payment", async () => {
    const f = await fixture();
    const changed = f.reconcile(await f.change());
    const cancelled = await f.reduce(changed.checkpoint, "other.read", completed(), undefined, {
      cancelledAgendaItemIds: [required(f.initial.agenda.find(item => item.intention.proposedCapability === "budget.create")).id],
    });
    const quoted = f.reconcile(await f.reduce(cancelled.checkpoint, "quote.calculate", completed(
      publication("quote.selected", { amount: 5_000_000, line: "same-line", term: 24 }, ["option.selected"]),
    )));
    expect(quoted.activation).toBeUndefined();
    expect(quoted.checkpoint.interaction).toBeUndefined();
    expect(quoted.checkpoint.agenda).toEqual([]);
    expect(quoted.checkpoint.facts.some(fact => fact.type === "payment.selected")).toBe(false);
  });

  it("keeps suspension and completion lineage out of model projections", async () => {
    const f = await fixture();
    const changed = f.reconcile(await f.change());
    expect(changed.activation?.capabilityId).toBe("quote.calculate");
    const projected = projectModelContext(buildContextSnapshot({ checkpoint: changed.checkpoint, compiled: f.compiled,
      currentMessage: { role: "user", content: "change amount", turnId: "project" as never } }));
    expect(JSON.stringify(projected)).not.toMatch(/suspendedInteraction|completionLineage|private-contact|contact-name/u);
  });
});
