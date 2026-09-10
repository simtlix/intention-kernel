import { describe, expect, it } from "vitest";
import { agentId, capabilityId, createKernel, defineAgent, defineCapability, defineSchema, factType } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { reduceCapabilityResults } from "../../src/reducer/reduceCapabilityResults.js";
import { reconcileProgression } from "../../src/progression/reconcileProgression.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { projectModelContext } from "../../src/context/projectModelContext.js";
import type { KernelCheckpoint } from "../../src/contracts/checkpoint.js";
import type { CapabilityResult } from "../../src/contracts/capability.js";
import type { Interaction } from "../../src/contracts/interaction.js";
import type { TurnPlan, StepExecutionResult } from "../../src/contracts/plan.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";
import { createMemoryDurability } from "../../src/testing/createMemoryDurability.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "suspension-regression",
  validate: value => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });
const ref = (name: string) => ({ type: factType(name), version: 1 });
const completed = (names: string[] = [], interaction?: Interaction | null): CapabilityResult<unknown> => ({
  status: "completed", output: {}, facts: names.map(name => ({ ...ref(name), value: true, evidenceIds: [], dependsOn: [] })),
  evidence: [], artifacts: [], ...(interaction === undefined ? {} : { interaction }),
});
const question = (owner: string, id: string): Interaction => ({ id: id as never, capabilityId: capabilityId(owner), kind: "choice",
  goal: id, requestedFacts: [], options: [{ id: "yes", label: "Yes", value: true }] });
const collecting = (owner: string, id: string): CapabilityResult<unknown> => ({ status: "needs_input",
  partialInput: { pending: id }, interaction: question(owner, id) });

async function fixture(ownerEffect: "read" | "write" = "read", discoveryDependency = false) {
  const executions: string[] = [];
  const operation = (id: string, provides: string[] = [], requires: string[] = [], effect: "read" | "write" = "read") => defineCapability({
    id: capabilityId(id), version: 1, description: id, input: schema, output: schema,
    provides: provides.map(ref), requires: requires.map(name => ({ ...ref(name), description: name })), effect,
    confirmation: effect === "write" ? "required" : "none", automation: { version: 1, createInput: () => ({}) },
    execute: context => {
      executions.push(id);
      if ((id === "other.consume" || (id === "option.discover" && discoveryDependency)) &&
        !context.facts.some(fact => fact.type === "other.ready")) return Promise.resolve({
        status: "needs_dependency", requirement: { ...ref("other.ready"), description: "Independent read prerequisite" },
        provider: { capabilityId: capabilityId("other.provide"), input: {} }, continuation: {},
      });
      if (id === "item.decide" && context.turn.interactionAnswer?.value !== true) return Promise.resolve(collecting(id, "include-item"));
      if (id === "option.simulate" && context.turn.interactionAnswer?.value !== 24) return Promise.resolve({ ...collecting(id, "choose-term"),
        interaction: { ...question(id, "choose-term"), options: [{ id: "24", label: "24", value: 24 }] } });
      return Promise.resolve(completed(provides, id === "option.discover" ? {
        ...question(id, "choose-option"), options: [{ id: "first", label: "First option", value: 1, targetCapabilityId: capabilityId("option.select") }],
      } : undefined));
    },
  });
  const definition = defineAgent({ id: agentId("suspended.input"), version: 1, identity: "Test agent",
    policies: [], modelPolicy: {}, capabilities: [operation("item.quote", ["item.quoted"]),
      operation("item.decide", ["item.decision"], ["item.quoted"], ownerEffect), operation("option.discover"),
      operation("option.select", ["option.selected"]), operation("option.simulate", ["option.simulated"], ["option.selected"]),
      operation("payment.decide", [], ["option.simulated"]), operation("other.read"),
      operation("other.consume"), operation("other.provide", ["other.ready"])],
    progression: { groups: [], rules: [
      { id: "item.decision", version: 1, target: { capabilityId: capabilityId("item.decide") }, mode: "required", priority: 200, activateWhen: [ref("item.quoted")] },
      { id: "option.simulation", version: 1, target: { capabilityId: capabilityId("option.simulate") }, mode: "required", priority: 100, activateWhen: [ref("option.selected")] },
      { id: "payment.decision", version: 1, target: { capabilityId: capabilityId("payment.decide") }, mode: "required", priority: 300, activateWhen: [ref("option.simulated")] },
    ] },
  });
  const compiled = await compileAgentDefinition(definition);
  let stepNumber = 0;
  const reduce = async (checkpoint: KernelCheckpoint, owner: string, result: CapabilityResult<unknown>, extra: Partial<TurnPlan> = {}) => {
    const id = `step-${String(++stepNumber)}` as never;
    const intention = { id, objective: owner, proposedCapability: capabilityId(owner), input: {}, resolution: "resolved" as const,
      references: [], evidence: [{ text: owner, meaning: owner, messageIndex: 0 }] };
    const plan: TurnPlan = { steps: [{ id, intentionId: id, intention, capabilityId: capabilityId(owner), input: {},
      dependsOn: [], missingFacts: [], disposition: "execute", reason: { code: "TEST", message: owner, evidence: [] } }],
      responseGoal: owner, ...extra };
    const results: StepExecutionResult[] = [{ status: "invoked", stepId: id, capabilityId: capabilityId(owner), result }];
    const reduced = await reduceCapabilityResults({ checkpoint, compiled, plan, results, turnId: id });
    return { checkpoint: reduced.checkpoint, plan, results };
  };
  const reconcile = (options: { checkpoint: KernelCheckpoint; plan?: TurnPlan; results?: readonly StepExecutionResult[];
    turnPublications?: KernelCheckpoint["facts"]; deferActivation?: boolean }) =>
    reconcileProgression({ ...options, compiled });
  const empty: KernelCheckpoint = { schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, messages: [], facts: [], agenda: [], effects: [] };
  const quoted = reconcile(await reduce(empty, "item.quote", completed(["item.quoted"])));
  const asking = await reduce(quoted.checkpoint, "item.decide", collecting("item.decide", "include-item"));
  const initial = reconcile(asking).checkpoint;
  const interrupt = (checkpoint = initial) => reduce(checkpoint, "option.discover", completed([], question("option.discover", "choose-option")));
  return { initial, interrupt, reduce, reconcile, compiled, definition, executions };
}

describe("suspended required input across independent progression", () => {
  it.each([
    { label: "direct read", companion: false, discoveryDependency: false },
    { label: "companion dependency", companion: true, discoveryDependency: false },
    { label: "interrupting dependency", companion: false, discoveryDependency: true },
  ])("runs the full durable sequence with $label", async ({ companion, discoveryDependency }) => {
    const f = await fixture("read", discoveryDependency);
    const messages = ["Quote item", "Show options first", "First option", "24", "Yes include it"];
    const capabilities = ["item.quote", "option.discover", "option.select", "option.simulate", "item.decide"];
    let phase = 0;
    let interactionId = "";
    const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
      const cap = capabilities[phase];
      const requested = companion && phase === 2 ? [cap, "other.consume"] : [cap];
      const evidence = [{ text: messages[phase], meaning: "Explicit current request", messageIndex: phase * 2 }];
      const responses: Record<string, unknown> = {
        "capability.select": { mode: "selected", capabilityIds: requested, evidence, rationale: "Explicit current request" },
        "capability-selection.interaction-review": { verdict: "supported", rationale: "An independent explicit request." },
        "interaction-answer.review": { verdict: "supported", rationale: "Answers this exact displayed control." },
        "turn.interpret": { intentions: requested.map((requestedCapability, index) => ({ id: `request-${String(phase)}-${String(index)}`,
          objective: "Current request", proposedCapability: requestedCapability,
          input: {}, evidence, references: [], resolution: "resolved" })), contradictions: [],
          ...(phase >= 2 ? { answerToInteraction: { interactionId, value: phase === 2 ? 1 : phase === 3 ? 24 : true,
            evidence: messages[phase] } } : {}) },
        "response.compose": { parts: [{ text: "Choose how to continue.", evidenceIds: [] }] },
        "response.grounding-review": { verdict: "supported", decisionVerdict: "supported", continuityVerdict: "supported",
          unsupportedClaims: [], approvedClaimIndexes: [] },
      };
      if (!(request.task in responses)) throw new Error(`Unexpected task ${request.task}`);
      return Promise.resolve({ value: responses[request.task] as T, provider: "scripted", model: "test", durationMs: 1 });
    } };
    const durability = createMemoryDurability();
    for (phase = 0; phase < messages.length; phase += 1) {
      // New kernel instance per turn: no hidden process-local suspension state.
      const runtime = await createKernel({ modelGateway: gateway, durability }).compile(f.definition);
      const result = await runtime.run({ threadId: "sequence" as never, turnId: `turn-${String(phase)}` as never,
        input: { text: messages[phase] ?? "" }, ...(phase >= 2 ? { selection: { interactionId: interactionId as never,
          optionId: phase === 2 ? "first" : phase === 3 ? "24" : "yes" } } : {}) });
      interactionId = result.checkpoint.interaction?.id ?? "";
      if (phase === 0 || phase === 3) expect(interactionId).toBe("include-item");
      if (phase === 1) expect(interactionId).toBe("choose-option");
      if (phase === 2) expect(interactionId).toBe("choose-term");
      if (phase < 4) expect(result.checkpoint.facts.some(fact => fact.type === "item.decision")).toBe(false);
      expect(result.checkpoint.effects).toEqual([]);
    }
    expect(f.executions).toEqual(["item.quote", "item.decide", "option.discover",
      ...(discoveryDependency ? ["other.provide", "option.discover"] : []), "option.select",
      ...(companion ? ["other.consume", "other.provide", "other.consume"] : []),
      "option.simulate", "option.simulate", "item.decide", "payment.decide"]);
  });
  it("finishes a fresh higher-priority operation then restores the unresolved decision without answering or invoking it", async () => {
    const f = await fixture();
    const interrupted = await f.interrupt();
    const serialized = JSON.parse(JSON.stringify(interrupted.checkpoint)) as KernelCheckpoint;
    const selected = await f.reduce(serialized, "option.select", completed(["option.selected"]), { answeredInteractionCapabilityId: capabilityId("option.discover") });
    const simulation = f.reconcile(selected);
    expect(simulation.activation?.capabilityId).toBe("option.simulate");
    expect(simulation.checkpoint.interaction).toBeUndefined();
    const terms = f.reconcile(await f.reduce(simulation.checkpoint, "option.simulate", collecting("option.simulate", "choose-term")));
    expect(terms.checkpoint.interaction?.id).toBe("choose-term");
    const simulated = await f.reduce(JSON.parse(JSON.stringify(terms.checkpoint)) as KernelCheckpoint,
      "option.simulate", completed(["option.simulated"]));
    const resumed = f.reconcile(simulated);
    expect(resumed.activation).toBeUndefined();
    expect(resumed.interactionRequested).toBe(true);
    expect(resumed.checkpoint.interaction).toEqual(f.initial.interaction);
    expect(resumed.checkpoint.facts.map(fact => fact.type)).toEqual(["item.quoted", "option.selected", "option.simulated"]);
    expect(resumed.checkpoint.effects).toEqual([]);
    expect(JSON.stringify(resumed.checkpoint.agenda)).not.toContain("suspendedInteraction");
    const answered = f.reconcile(await f.reduce(resumed.checkpoint, "item.decide", completed(["item.decision"])));
    expect(answered.activation?.capabilityId).toBe("payment.decide");
  });

  it("does not project the private stored control to model tasks", async () => {
    const f = await fixture();
    const interrupted = await f.interrupt();
    expect(JSON.stringify(interrupted.checkpoint.agenda)).toContain("suspendedInteraction");
    const snapshot = buildContextSnapshot({ checkpoint: interrupted.checkpoint, compiled: f.compiled,
      currentMessage: { role: "user", content: "choose", turnId: "inspect" as never } });
    expect(JSON.stringify(projectModelContext(snapshot))).not.toContain("suspendedInteraction");
    expect(JSON.stringify(projectModelContext(snapshot))).not.toContain("include-item");
  });

  it("never resurrects an explicitly dismissed control on a later fact publication", async () => {
    const f = await fixture();
    const dismissed = await f.reduce(f.initial, "other.read", completed([], null));
    const selected = await f.reduce(JSON.parse(JSON.stringify(dismissed.checkpoint)) as KernelCheckpoint,
      "option.select", completed(["option.selected"]));
    const result = f.reconcile(selected);
    expect(result.activation).toBeUndefined();
    expect(result.checkpoint.interaction).toBeUndefined();
    expect(JSON.stringify(result.checkpoint.agenda)).not.toContain("suspendedInteraction");
  });

  it("does not treat an older fact as authority for new work before restoring the decision", async () => {
    const f = await fixture();
    const interrupted = await f.interrupt();
    const selected = await f.reduce(interrupted.checkpoint, "option.select", completed(["option.selected"]),
      { answeredInteractionCapabilityId: capabilityId("option.discover") });
    const restored = f.reconcile({ checkpoint: selected.checkpoint });
    expect(restored.activation).toBeUndefined();
    expect(restored.checkpoint.interaction?.id).toBe("include-item");
  });

  it("yields to a ready dependency without restoring the old control", async () => {
    const f = await fixture();
    const interrupted = await f.interrupt();
    const selected = await f.reduce(interrupted.checkpoint, "option.select", completed(["option.selected"]),
      { answeredInteractionCapabilityId: capabilityId("option.discover") });
    const deferred = f.reconcile({ ...selected, deferActivation: true });
    expect(deferred.activation).toBeUndefined();
    expect(deferred.checkpoint.interaction).toBeUndefined();
  });

  it.each(["cancel", "publication", "owner-completed"])("retires stored authority after %s", async change => {
    const f = await fixture();
    const interrupted = await f.interrupt();
    const selected = await f.reduce(interrupted.checkpoint, "option.select", completed(["option.selected"]),
      { answeredInteractionCapabilityId: capabilityId("option.discover") });
    const agendaId = selected.checkpoint.agenda.find(item => item.intention.proposedCapability === "item.decide")?.id;
    const changed = change === "publication"
      ? await f.reduce(selected.checkpoint, "item.quote", completed(["item.quoted"]))
      : change === "owner-completed"
        ? await f.reduce(selected.checkpoint, "item.decide", completed(["item.decision"]))
        : await f.reduce(selected.checkpoint, "other.read", completed(), { cancelledAgendaItemIds: [agendaId as never] });
    const result = f.reconcile(changed);
    expect(result.checkpoint.interaction?.id).not.toBe("include-item");
    expect(JSON.stringify(result.checkpoint.agenda)).not.toContain("suspendedInteraction");
  });

  it("does not suspend write or confirmation authority", async () => {
    const f = await fixture("write");
    const interrupted = await f.interrupt();
    expect(JSON.stringify(interrupted.checkpoint.agenda)).not.toContain("suspendedInteraction");
    const selected = f.reconcile(await f.reduce(interrupted.checkpoint, "option.select", completed(["option.selected"]),
      { answeredInteractionCapabilityId: capabilityId("option.discover") }));
    expect(selected.activation).toBeUndefined();
    expect(selected.checkpoint.interaction).toBeUndefined();
  });

  it.each(["confirmation", "protected", "ambiguous-owner", "completed-followup"])("does not retain %s authority", async kind => {
    const f = await fixture();
    const interaction = { ...f.initial.interaction } as Interaction;
    const firstItem = f.initial.agenda[0];
    if (firstItem === undefined) throw new Error("Expected pending owner");
    const checkpoint = { ...f.initial, interaction: kind === "confirmation" ? { ...interaction, kind: "confirmation" as const }
      : kind === "protected" ? { ...interaction, protectedCanonicalMessage: "Private confirmation" } : interaction,
      agenda: kind === "ambiguous-owner" ? [...f.initial.agenda, { ...firstItem, id: "duplicate" as never }]
        : kind === "completed-followup" ? f.initial.agenda.map(item => ({ ...item, completedFollowUp: true })) : f.initial.agenda };
    expect(JSON.stringify((await f.interrupt(checkpoint)).checkpoint.agenda)).not.toContain("suspendedInteraction");
  });

  it("preserves redactions and restores the control even with no pending progression candidate", async () => {
    const f = await fixture();
    const interrupted = await f.interrupt({ ...f.initial,
      agenda: f.initial.agenda.map(item => ({ ...item, modelRedactions: ["sensitive-data"] })) });
    const dismissedCurrent = await f.reduce(interrupted.checkpoint, "option.discover", completed([], null));
    const restored = f.reconcile(dismissedCurrent);
    expect(restored.checkpoint.interaction).toEqual(f.initial.interaction);
    expect(restored.checkpoint.agenda[0]?.modelRedactions).toEqual(["sensitive-data"]);
    expect(restored.activation).toBeUndefined();
  });

  it("does not accept a forged current step for an older activation publication", async () => {
    const f = await fixture();
    const interrupted = await f.interrupt();
    const selected = await f.reduce(interrupted.checkpoint, "option.select", completed(["option.selected"]),
      { answeredInteractionCapabilityId: capabilityId("option.discover") });
    const result = f.reconcile({ ...selected, results: selected.results.map(entry => ({ ...entry, stepId: "unrelated-step" as never })) });
    expect(result.activation).toBeUndefined();
    expect(result.checkpoint.interaction?.id).toBe("include-item");
  });

  it.each(["replaced", "removed"])("does not reuse accumulated publications after they were %s", async change => {
    const f = await fixture();
    const interrupted = await f.interrupt();
    const selected = await f.reduce(interrupted.checkpoint, "option.select", completed(["option.selected"]),
      { answeredInteractionCapabilityId: capabilityId("option.discover") });
    const old = selected.checkpoint.facts.find(fact => fact.type === "option.selected");
    if (old === undefined) throw new Error("Expected published selection");
    const checkpoint = { ...selected.checkpoint, facts: selected.checkpoint.facts.flatMap(fact =>
      fact.type !== old.type ? [fact] : change === "removed" ? []
        : [{ ...fact, producedBy: { ...fact.producedBy, stepId: "later-publication" as never } }]) };
    const result = f.reconcile({ checkpoint, turnPublications: [old] });
    expect(result.activation).toBeUndefined();
    expect(result.checkpoint.interaction?.id).toBe("include-item");
  });
});
