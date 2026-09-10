import { describe, expect, it } from "vitest";

import {
  agentId,
  buildContextSnapshot,
  capabilityId,
  compileAgentDefinition,
  createTurnPlan,
  defineAgent,
  defineCapability,
  definePolicy,
  defineSchema,
  factType,
  policyId,
  reduceCapabilityResults,
  type CapabilityDefinition,
  type CapabilityResult,
  type IntentionBatch,
  type KernelCheckpoint,
  type StepExecutionResult,
} from "../../src/internal.js";

const objectSchema = defineSchema<Record<string, unknown>>({
  vendor: "planner-test",
  validate: (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? { value: value as Record<string, unknown> }
      : { issues: [{ message: "Expected object" }] },
  jsonSchema: () => ({ type: "object" }),
});
const querySchema = defineSchema<{ query: string }>({
  vendor: "planner-test",
  validate: (value) => {
    const query = typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)["query"]
      : undefined;
    return typeof query === "string" && query.length > 0
      ? { value: { query } }
      : { issues: [{ message: "query is required", path: ["query"] }] };
  },
  jsonSchema: () => ({
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
    additionalProperties: false,
  }),
});

function capability(
  id: string,
  options: {
    requires?: readonly string[];
    provides?: readonly string[];
    invalidates?: readonly string[];
    effect?: "none" | "read" | "write";
    input?: typeof objectSchema;
  } = {},
): CapabilityDefinition<Record<string, unknown>, Record<string, unknown>> {
  return defineCapability({
    id: capabilityId(id),
    version: 1,
    description: `Perform ${id}`,
    input: options.input ?? objectSchema,
    output: objectSchema,
    requires: (options.requires ?? []).map((type) => ({ type: factType(type), version: 1, description: `Need ${type}` })),
    provides: (options.provides ?? []).map((type) => ({ type: factType(type), version: 1 })),
    invalidates: (options.invalidates ?? []).map((type) => ({ type: factType(type), version: 1 })),
    effect: options.effect ?? "read",
    confirmation: options.effect === "write" ? "required" : "none",
    execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
  });
}

const capabilities = [
  capability("catalog.search", {
    provides: ["catalog.candidates"],
    invalidates: ["catalog.selected"],
    input: querySchema,
  }),
  capability("catalog.select", { requires: ["catalog.candidates"], provides: ["catalog.selected"] }),
  capability("faq.answer"),
  capability("lead.create", { requires: ["catalog.selected"], effect: "write" }),
  capability("notification.send", { effect: "write" }),
];

async function compiled(options: { denyFaq?: boolean } = {}) {
  return compileAgentDefinition(
    defineAgent({
      id: agentId("planner.agent"),
      version: 1,
      identity: "Planner test agent",
      capabilities,
      policies: options.denyFaq
        ? [
            definePolicy({
              id: policyId("test.deny-faq"),
              version: 1,
              evaluate: (context) =>
                typeof context === "object" && context !== null && Reflect.get(context, "capabilityId") === "faq.answer"
                  ? { verdict: "deny", reason: "FAQ disabled for this tenant" }
                  : { verdict: "allow" },
            }),
          ]
        : [],
      modelPolicy: {},
    }),
  );
}

function checkpoint(facts: KernelCheckpoint["facts"] = []): KernelCheckpoint {
  return {
    schemaVersion: 1,
    revision: 1,
    agentFingerprint: "planner",
    messages: [],
    facts,
    agenda: [],
    effects: [],
  };
}

function intention(
  id: string,
  proposedCapability: string | undefined,
  input: unknown,
  resolution: "resolved" | "ambiguous" | "unsupported" = "resolved",
) {
  return {
    id: id as never,
    objective: `Objective ${id}`,
    evidence: [{ text: id, meaning: "request", messageIndex: 0 }],
    references: [],
    ...(proposedCapability === undefined ? {} : { proposedCapability: capabilityId(proposedCapability) }),
    input,
    resolution,
    ...(resolution === "ambiguous" ? { alternatives: ["current results", "new search"] } : {}),
  } as const;
}

function batch(...intentions: IntentionBatch["intentions"]): IntentionBatch {
  return { intentions, contradictions: [] };
}

function ids() {
  let sequence = 0;
  return { next: (kind: string) => `${kind}-${String(++sequence)}` };
}

async function context(state = checkpoint()) {
  const agent = await compiled();
  return {
    agent,
    snapshot: buildContextSnapshot({
      checkpoint: state,
      currentMessage: { role: "user", content: "request", at: "2026-09-03T10:00:00.000Z" },
      compiled: agent,
    }),
  };
}

describe("turn planner", () => {
  it("cancels exact pending work and removes its active interaction without a business capability", async () => {
    const pendingIntention = intention("request.pending", "catalog.search", { query: "SUV" });
    const state: KernelCheckpoint = {
      ...checkpoint(),
      agenda: [{
        id: "agenda:step-pending" as never,
        intention: pendingIntention,
        status: "waiting_input",
        missingFacts: [],
        dependencies: [],
      }],
      interaction: {
        id: "interaction-pending" as never,
        kind: "choice",
        requestedFacts: [],
        goal: "Choose one result",
        capabilityId: capabilityId("catalog.search"),
        options: [{ id: "vehicle-1", label: "Vehicle 1", value: "vehicle-1" }],
      },
    };
    const { agent, snapshot } = await context(state);
    const plan = await createTurnPlan({
      batch: {
        intentions: [],
        contradictions: [],
        lifecycleActions: [{
          kind: "cancel_agenda_item",
          targetId: "agenda:step-pending" as never,
          evidence: { text: "cancel this", meaning: "explicit cancellation", messageIndex: 0 },
        }],
      },
      snapshot,
      compiled: agent,
      ids: ids(),
    });

    const reduction = await reduceCapabilityResults({
      checkpoint: state,
      plan,
      results: [],
      compiled: agent,
      turnId: "turn-cancel" as never,
    });

    expect(plan.cancelledAgendaItemIds).toEqual(["agenda:step-pending"]);
    expect(plan.steps).toEqual([]);
    expect(plan.responseGoal).toContain("cancelled");
    expect(reduction.checkpoint.agenda).toEqual([]);
    expect(reduction.checkpoint.interaction).toBeUndefined();
  });

  it("cancels the complete objective, all pending work and active progression atomically", async () => {
    const pendingIntention = intention("request.pending", "catalog.search", { query: "SUV" });
    const state: KernelCheckpoint = {
      ...checkpoint(),
      agenda: [{
        id: "agenda:step-pending" as never,
        intention: pendingIntention,
        status: "waiting_input",
        missingFacts: [],
        dependencies: [],
      }],
      interaction: {
        id: "interaction-pending" as never,
        kind: "choice",
        requestedFacts: [],
        goal: "Choose one result",
        capabilityId: capabilityId("catalog.search"),
      },
      progression: {
        objective: { id: "purchase.journey", status: "active" },
        occurrences: [{
          id: "occurrence-1",
          ruleId: "rule-1",
          target: { capabilityId: capabilityId("catalog.search") },
          mode: "required",
          priority: 1,
          activationFacts: [],
          status: "active",
          presented: true,
          completedMembers: [],
          activeMember: capabilityId("catalog.search"),
        }],
      },
    };
    const { agent, snapshot } = await context(state);
    const plan = await createTurnPlan({
      batch: {
        intentions: [],
        contradictions: [],
        lifecycleActions: [{
          kind: "cancel_objective",
          targetId: "purchase.journey",
          evidence: { text: "cancel the objective", meaning: "complete cancellation", messageIndex: 0 },
        }],
      },
      snapshot,
      compiled: agent,
      ids: ids(),
    });
    const reduction = await reduceCapabilityResults({
      checkpoint: state,
      plan,
      results: [],
      compiled: agent,
      turnId: "turn-cancel-objective" as never,
    });

    expect(plan.cancelledObjectiveIds).toEqual(["purchase.journey"]);
    expect(reduction.checkpoint.agenda).toEqual([]);
    expect(reduction.checkpoint.interaction).toBeUndefined();
    expect(reduction.checkpoint.progression?.objective?.status).toBe("cancelled");
    expect(reduction.checkpoint.progression?.occurrences[0]).toMatchObject({
      status: "declined",
    });
    expect(reduction.checkpoint.progression?.occurrences[0]).not.toHaveProperty("activeMember");
  });

  it("keeps independent reads parallel", async () => {
    const { agent, snapshot } = await context();
    const plan = await createTurnPlan({
      batch: batch(
        intention("request.1", "catalog.search", { query: "SUV" }),
        intention("request.2", "faq.answer", { question: "warranty" }),
      ),
      snapshot,
      compiled: agent,
      ids: ids(),
    });

    expect(plan.steps.map((step) => ({ capability: step.capabilityId, disposition: step.disposition, dependencies: step.dependsOn }))).toEqual([
      { capability: "catalog.search", disposition: "execute", dependencies: [] },
      { capability: "faq.answer", disposition: "execute", dependencies: [] },
    ]);
  });

  it("orders a dependent operation behind its explicit provider", async () => {
    const { agent, snapshot } = await context();
    const plan = await createTurnPlan({
      batch: batch(
        intention("request.1", "catalog.search", { query: "SUV" }),
        intention("request.2", "catalog.select", { position: 1 }),
      ),
      snapshot,
      compiled: agent,
      ids: ids(),
    });

    expect(plan.steps[0]).toMatchObject({ capabilityId: "catalog.search", disposition: "execute", dependsOn: [] });
    expect(plan.steps[1]).toMatchObject({ capabilityId: "catalog.select", disposition: "execute", dependsOn: [plan.steps[0]?.id] });
  });

  it("orders runtime requirements when their provider shares the turn without eagerly deferring them otherwise", async () => {
    const provider = capability("profile.collect", { provides: ["profile.confirmed"] });
    const consumer = defineCapability({
      ...capability("purchase.create", { provides: ["purchase.created"] }),
      requires: [{
        type: factType("profile.confirmed"),
        version: 1,
        description: "Confirmed profile when this purchase needs one",
        resolution: "runtime" as const,
      }],
    });
    const agent = await compileAgentDefinition(defineAgent({
      id: agentId("runtime-requirement.agent"),
      version: 1,
      identity: "Runtime requirement test agent",
      capabilities: [provider, consumer],
      policies: [],
      modelPolicy: {},
    }));
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "request", at: "2026-09-03T10:00:00.000Z" },
      compiled: agent,
    });

    const consumerOnly = await createTurnPlan({
      batch: batch(intention("request.consumer", "purchase.create", {})),
      snapshot,
      compiled: agent,
      ids: ids(),
    });
    expect(consumerOnly.steps[0]).toMatchObject({
      capabilityId: "purchase.create",
      disposition: "execute",
      dependsOn: [],
      missingFacts: [],
    });

    const providerAndConsumer = await createTurnPlan({
      batch: batch(
        intention("request.provider", "profile.collect", {}),
        intention("request.consumer", "purchase.create", {}),
      ),
      snapshot,
      compiled: agent,
      ids: ids(),
    });
    expect(providerAndConsumer.steps[0]).toMatchObject({
      capabilityId: "profile.collect",
      disposition: "execute",
      dependsOn: [],
    });
    expect(providerAndConsumer.steps[1]).toMatchObject({
      capabilityId: "purchase.create",
      disposition: "execute",
      dependsOn: [providerAndConsumer.steps[0]?.id],
      missingFacts: [],
    });
  });

  it.each(["runtime", "planning"] as const)("does not promote an input-only continuation into an independent optional provider (%s)", async resolution => {
    const provider = capability("profile.collect", { provides: ["profile.confirmed"] });
    const consumer = defineCapability({ ...capability("purchase.decide"), requires: [{ type: factType("profile.confirmed"), version: 1,
      description: "Only some decisions need a profile", ...(resolution === "runtime" ? { resolution } : {}) }] });
    const agent = await compileAgentDefinition(defineAgent({ id: agentId("conditional-input"), version: 1, identity: "Assistant",
      capabilities: [provider, consumer], policies: [], modelPolicy: {} }));
    const oldRequest = intention("previous-provider", "profile.collect", {});
    const snapshot = buildContextSnapshot({ compiled: agent,
      currentMessage: { role: "user", content: "Use the alternative without a profile", at: "2026-09-06T12:00:00Z" },
      checkpoint: { ...checkpoint(), agenda: [{ id: "pending-input" as never, intention: oldRequest,
        status: "waiting_input", dependencies: [], missingFacts: [] }],
        interaction: { id: "profile-question" as never, capabilityId: provider.id, kind: "input", requestedFacts: [], goal: "How do you want to continue?" } } });
    const plan = await createTurnPlan({ compiled: agent, snapshot, ids: ids(),
      batch: { ...batch(intention("new-decision", "purchase.decide", {})),
        answerToInteraction: { interactionId: "profile-question" as never, value: "without profile", evidence: "Use the alternative without a profile" } } });
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({ capabilityId: "profile.collect", disposition: "execute" });
    expect(plan.steps[1]).toMatchObject({ capabilityId: "purchase.decide", disposition: "execute",
      dependsOn: resolution === "runtime" ? [] : [plan.steps[0]?.id] });
  });

  it("retires a same-turn input prompt when its owning dependency has become unnecessary", async () => {
    const { agent } = await context();
    const child = intention("old-child", "faq.answer", {});
    const parent = { id: "parent" as never, intention: intention("old-parent", "catalog.search", { query: "original" }),
      status: "waiting_facts" as const, missingFacts: [], dependencies: ["child" as never], ownedDependencyIds: ["child" as never] };
    const question = { id: "pending-question" as never, capabilityId: capabilityId("faq.answer"), kind: "input" as const,
      requestedFacts: [], goal: "How do you want to continue?" };
    const state: KernelCheckpoint = { ...checkpoint(), interaction: question,
      agenda: [parent, { id: "child" as never, intention: child, status: "waiting_input", dependencies: [], missingFacts: [] }] };
    const snapshot = buildContextSnapshot({ compiled: agent, checkpoint: state,
      currentMessage: { role: "user", content: "Search instead", at: "2026-09-06T12:00:00Z" } });
    const plan = await createTurnPlan({ compiled: agent, snapshot, ids: ids(), batch: {
      ...batch(intention("new-parent", "catalog.search", { query: "alternative" })),
      answerToInteraction: { interactionId: question.id, value: "alternative", evidence: "Search instead" } } });
    const results: StepExecutionResult[] = plan.steps.map(step => ({ status: "invoked", stepId: step.id, capabilityId: step.capabilityId as never,
      result: step.capabilityId === "faq.answer" ? { status: "needs_input", partialInput: {}, interaction: question }
        : { status: "completed", output: {}, facts: [], evidence: [], artifacts: [] } }));
    const reduced = await reduceCapabilityResults({ compiled: agent, checkpoint: state, plan, results, turnId: "replacement" as never });
    expect(reduced.checkpoint.agenda).toEqual([]);
    expect(reduced.checkpoint.interaction).toBeUndefined();
  });

  it("defers missing prerequisites and asks only one primary question", async () => {
    const { agent, snapshot } = await context();
    const plan = await createTurnPlan({
      batch: batch(intention("request.1", "catalog.select", { position: 1 })),
      snapshot,
      compiled: agent,
      ids: ids(),
    });

    expect(plan.steps[0]).toMatchObject({ disposition: "defer", capabilityId: "catalog.select" });
    expect(plan.interaction).toMatchObject({ kind: "input", requestedFacts: ["catalog.candidates"] });
    expect(plan.responseGoal).toBe(plan.interaction?.goal);
  });

  it("clarifies malformed input instead of executing it", async () => {
    const { agent, snapshot } = await context();
    const plan = await createTurnPlan({
      batch: batch(intention("request.1", "catalog.search", {})),
      snapshot,
      compiled: agent,
      ids: ids(),
    });

    expect(plan.steps[0]).toMatchObject({ disposition: "clarify", reason: { code: "INVALID_CAPABILITY_INPUT" } });
    expect(plan.interaction).toMatchObject({ kind: "clarification", capabilityId: "catalog.search" });
  });

  it("rejects an unknown capability and a denied policy", async () => {
    const standard = await context();
    const unknown = await createTurnPlan({
      batch: batch(intention("request.1", "unknown.operation", {})),
      snapshot: standard.snapshot,
      compiled: standard.agent,
      ids: ids(),
    });
    expect(unknown.steps[0]).toMatchObject({ disposition: "reject", reason: { code: "CAPABILITY_NOT_REGISTERED" } });

    const deniedAgent = await compiled({ denyFaq: true });
    const deniedSnapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "FAQ", at: "2026-09-03T10:00:00.000Z" },
      compiled: deniedAgent,
    });
    const denied = await createTurnPlan({
      batch: batch(intention("request.1", "faq.answer", {})),
      snapshot: deniedSnapshot,
      compiled: deniedAgent,
      ids: ids(),
    });
    expect(denied.steps[0]).toMatchObject({ disposition: "reject", reason: { code: "POLICY_DENIED" } });
  });

  it("turns ambiguous meaning into alternatives rather than a guessed execution", async () => {
    const { agent, snapshot } = await context();
    const plan = await createTurnPlan({
      batch: batch(intention("request.1", undefined, undefined, "ambiguous")),
      snapshot,
      compiled: agent,
      ids: ids(),
    });

    expect(plan.steps[0]).toMatchObject({ disposition: "clarify" });
    expect(plan.steps[0]).not.toHaveProperty("capabilityId");
    expect(plan.interaction?.options?.map((option) => option.label)).toEqual(["current results", "new search"]);
  });

  it("requires one explicit choice before unrelated writes", async () => {
    const selectedFact = {
      type: factType("catalog.selected"),
      version: 1,
      value: { id: "p-1" },
      evidenceIds: [],
      evidence: [],
      dependsOn: [],
      producedBy: {
        capabilityId: capabilityId("catalog.select"),
        capabilityVersion: 1,
        turnId: "previous-turn" as never,
        stepId: "previous-step" as never,
      },
    };
    const { agent, snapshot } = await context(checkpoint([selectedFact]));
    const plan = await createTurnPlan({
      batch: batch(
        intention("request.1", "lead.create", { customer: "A" }),
        intention("request.2", "notification.send", { channel: "email" }),
      ),
      snapshot,
      compiled: agent,
      ids: ids(),
    });

    expect(plan.steps.map((step) => step.disposition)).toEqual(["clarify", "clarify"]);
    expect(plan.interaction).toMatchObject({ kind: "choice" });
    expect(plan.interaction?.options).toHaveLength(2);
  });

  it("resumes a confirmed write from the durable interaction without asking twice", async () => {
    const selectedFact = {
      type: factType("catalog.selected"),
      version: 1,
      value: { id: "p-1" },
      evidenceIds: [],
      evidence: [],
      dependsOn: [],
      producedBy: {
        capabilityId: capabilityId("catalog.select"),
        capabilityVersion: 1,
        turnId: "previous-turn" as never,
        stepId: "previous-step" as never,
      },
    };
    const initialState = checkpoint([selectedFact]);
    const initial = await context(initialState);
    const confirmationPlan = await createTurnPlan({
      batch: batch(intention("request.1", "lead.create", { customer: "A" })),
      snapshot: initial.snapshot,
      compiled: initial.agent,
      ids: ids(),
    });
    const pending = await reduceCapabilityResults({
      checkpoint: initialState,
      plan: confirmationPlan,
      results: [],
      compiled: initial.agent,
      turnId: "turn-1" as never,
    });
    const resumedSnapshot = buildContextSnapshot({
      checkpoint: pending.checkpoint,
      currentMessage: { role: "user", content: "Yes", at: "2026-09-03T10:01:00.000Z" },
      compiled: initial.agent,
    });

    const resumed = await createTurnPlan({
      batch: {
        answerToInteraction: {
          interactionId: pending.checkpoint.interaction?.id as never,
          value: true,
          evidence: "Yes",
        },
        intentions: [],
        contradictions: [],
      },
      snapshot: resumedSnapshot,
      compiled: initial.agent,
      ids: ids(),
    });

    expect(resumed.steps).toHaveLength(1);
    expect(resumed.steps[0]).toMatchObject({
      capabilityId: "lead.create",
      input: { customer: "A" },
      disposition: "execute",
      reason: { code: "CONFIRMATION_ACCEPTED" },
    });
    expect(resumed.interaction).toBeUndefined();

    const resumedWithModelRestatement = await createTurnPlan({
      batch: {
        answerToInteraction: {
          interactionId: pending.checkpoint.interaction?.id as never,
          value: true,
          evidence: "Yes, create it",
        },
        intentions: [intention("request.confirmation-restatement", "lead.create", { customer: "A" })],
        contradictions: [],
      },
      snapshot: resumedSnapshot,
      compiled: initial.agent,
      ids: ids(),
    });
    expect(resumedWithModelRestatement.steps).toHaveLength(1);
    expect(resumedWithModelRestatement.steps[0]).toMatchObject({
      capabilityId: "lead.create",
      disposition: "execute",
      reason: { code: "CONFIRMATION_ACCEPTED" },
    });

    const pendingIntention = pending.checkpoint.agenda[0]?.intention;
    expect(pendingIntention).toBeDefined();
    const resumedWithRephrasedInput = await createTurnPlan({
      batch: {
        answerToInteraction: {
          interactionId: pending.checkpoint.interaction?.id as never,
          value: true,
          evidence: "Yes, create it",
        },
        intentions: [{
          ...pendingIntention as NonNullable<typeof pendingIntention>,
          id: "request.rephrased-confirmation" as never,
          input: { request: "Yes, create it" },
          evidence: [{ text: "Yes, create it", meaning: "confirmation restatement", messageIndex: 0 }],
        }],
        contradictions: [],
      },
      snapshot: resumedSnapshot,
      compiled: initial.agent,
      ids: ids(),
    });
    expect(resumedWithRephrasedInput.steps).toHaveLength(1);
    expect(resumedWithRephrasedInput.steps[0]).toMatchObject({
      capabilityId: "lead.create",
      input: { customer: "A" },
      disposition: "execute",
      reason: { code: "CONFIRMATION_ACCEPTED" },
    });

    const additionalObjective = await createTurnPlan({
      batch: {
        answerToInteraction: {
          interactionId: pending.checkpoint.interaction?.id as never,
          value: true,
          evidence: "Yes, and create another lead",
        },
        intentions: [{
          ...intention("request.second-lead", "lead.create", { customer: "B" }),
          objective: "Create a separate lead for customer B",
          evidence: [{ text: "create another lead", meaning: "independent second operation", messageIndex: 0 }],
        }],
        contradictions: [],
      },
      snapshot: resumedSnapshot,
      compiled: initial.agent,
      ids: ids(),
    });
    expect(additionalObjective.steps).toHaveLength(2);

    const declined = await createTurnPlan({
      batch: {
        answerToInteraction: {
          interactionId: pending.checkpoint.interaction?.id as never,
          value: false,
          evidence: "No",
        },
        intentions: [],
        contradictions: [],
      },
      snapshot: resumedSnapshot,
      compiled: initial.agent,
      ids: ids(),
    });
    expect(declined.steps).toHaveLength(1);
    expect(declined.steps[0]).toMatchObject({ disposition: "reject", reason: { code: "CONFIRMATION_DECLINED" } });
    const declinedReduction = await reduceCapabilityResults({
      checkpoint: pending.checkpoint,
      plan: declined,
      results: [],
      compiled: initial.agent,
      turnId: "turn-2" as never,
    });
    expect(declinedReduction.checkpoint.agenda).toEqual([]);
    expect(declinedReduction.checkpoint.interaction).toBeUndefined();
  });

  it("resumes the capability that owns a pending input when the model returns only the interaction answer", async () => {
    const pendingIntention = intention("request.search", "catalog.search", { query: "vehicle" });
    const pendingState: KernelCheckpoint = {
      ...checkpoint(),
      agenda: [{
        id: "agenda:catalog-search" as never,
        intention: pendingIntention,
        status: "waiting_input",
        missingFacts: [],
        dependencies: [],
        continuation: { askedCondition: true },
      }],
      interaction: {
        id: "interaction:condition" as never,
        kind: "input",
        capabilityId: capabilityId("catalog.search"),
        requestedFacts: [],
        goal: "Ask whether the vehicle should be new or used",
      },
    };
    const { agent, snapshot } = await context(pendingState);

    const plan = await createTurnPlan({
      batch: {
        answerToInteraction: {
          interactionId: pendingState.interaction?.id as never,
          value: "new",
          evidence: "0 km",
        },
        intentions: [],
        contradictions: [],
      },
      snapshot,
      compiled: agent,
      ids: ids(),
    });

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      capabilityId: "catalog.search",
      input: { query: "vehicle" },
      continuation: { askedCondition: true },
      interactionAnswer: {
        interactionId: "interaction:condition",
        value: "new",
        evidence: "0 km",
      },
      disposition: "execute",
    });
    expect(plan.answeredInteractionCapabilityId).toBe("catalog.search");
  });

  it("resumes the capability that owns a pending choice when the model returns only the interaction answer", async () => {
    const pendingIntention = intention("request.trade-in", "catalog.search", { query: "decision" });
    const pendingState: KernelCheckpoint = {
      ...checkpoint(),
      agenda: [{
        id: "agenda:trade-in" as never,
        intention: pendingIntention,
        status: "waiting_input",
        missingFacts: [],
        dependencies: [],
        continuation: { pending: "decision" },
      }],
      interaction: {
        id: "interaction:trade-in" as never,
        kind: "choice",
        capabilityId: capabilityId("catalog.search"),
        requestedFacts: [],
        goal: "Choose whether to continue",
      },
    };
    const { agent, snapshot } = await context(pendingState);

    const plan = await createTurnPlan({
      batch: {
        answerToInteraction: {
          interactionId: pendingState.interaction?.id as never,
          value: { decision: "exclude" },
          evidence: "No",
        },
        intentions: [],
        contradictions: [],
      },
      snapshot,
      compiled: agent,
      ids: ids(),
    });

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      capabilityId: "catalog.search",
      input: { query: "decision" },
      continuation: { pending: "decision" },
      interactionAnswer: {
        interactionId: "interaction:trade-in",
        value: { decision: "exclude" },
      },
      disposition: "execute",
    });
    expect(plan.answeredInteractionCapabilityId).toBe("catalog.search");
  });

  it("executes a choice target without rerunning the capability that presented the choice", async () => {
    const pendingSearch = intention("request.search", "catalog.search", { query: "vehicle" });
    const pendingState: KernelCheckpoint = {
      ...checkpoint(),
      agenda: [{
        id: "agenda:catalog-search" as never,
        intention: pendingSearch,
        status: "waiting_input",
        missingFacts: [],
        dependencies: [],
      }],
      interaction: {
        id: "interaction:catalog-results" as never,
        kind: "choice",
        capabilityId: capabilityId("catalog.search"),
        requestedFacts: [],
        goal: "Choose a vehicle",
        options: [{
          id: "vehicle-1",
          label: "Vehicle 1",
          targetCapabilityId: capabilityId("catalog.select"),
          value: { type: "option", optionId: "vehicle-1", targetIntent: "catalog.select" },
        }],
      },
    };
    const { agent, snapshot } = await context(pendingState);

    const plan = await createTurnPlan({
      batch: {
        answerToInteraction: {
          interactionId: pendingState.interaction?.id as never,
          value: {
            type: "option",
            optionId: "vehicle-1",
            targetIntent: "catalog.select",
          },
          evidence: "the first one",
        },
        intentions: [
          intention("request.select", "catalog.select", { position: 1 }),
          intention("request.faq", "faq.answer", { question: "What is included?" }),
        ],
        contradictions: [],
      },
      snapshot,
      compiled: agent,
      ids: ids(),
    });

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({
      capabilityId: "catalog.select",
      disposition: "defer",
      interactionAnswer: {
        interactionId: "interaction:catalog-results",
        value: { targetIntent: "catalog.select" },
      },
    });
    expect(plan.steps.some((step) => step.capabilityId === "catalog.search")).toBe(false);
  });
});

describe("fact and agenda reducer", () => {
  it("applies declared working-set invalidations while a capability collects input", async () => {
    const oldCandidates = {
      type: factType("catalog.candidates"),
      version: 1,
      value: [{ id: "old" }],
      evidenceIds: [],
      evidence: [],
      dependsOn: [],
      producedBy: { capabilityId: capabilityId("catalog.search"), capabilityVersion: 1, turnId: "t0" as never, stepId: "s0" as never },
    };
    const oldSelection = {
      type: factType("catalog.selected"),
      version: 1,
      value: { id: "old" },
      evidenceIds: [],
      evidence: [],
      dependsOn: [{ type: factType("catalog.candidates"), version: 1 }],
      producedBy: { capabilityId: capabilityId("catalog.select"), capabilityVersion: 1, turnId: "t0" as never, stepId: "s1" as never },
    };
    const state = checkpoint([oldCandidates, oldSelection]);
    const { agent, snapshot } = await context(state);
    const plan = await createTurnPlan({
      batch: batch(intention("request.1", "catalog.search", { query: "other vehicles" })),
      snapshot,
      compiled: agent,
      ids: ids(),
    });
    const collecting: CapabilityResult<Record<string, unknown>> = {
      status: "needs_input",
      interaction: {
        id: "search-scope" as never,
        kind: "input",
        capabilityId: capabilityId("catalog.search"),
        requestedFacts: [],
        goal: "Keep the current filters or start again?",
      },
      partialInput: { pending: "scope" },
      invalidates: [
        { type: factType("catalog.candidates"), version: 1 },
        { type: factType("catalog.selected"), version: 1 },
      ],
    };
    const results: StepExecutionResult[] = [{
      status: "invoked",
      stepId: plan.steps[0]?.id as never,
      capabilityId: capabilityId("catalog.search"),
      result: collecting,
    }];

    const reduced = await reduceCapabilityResults({
      checkpoint: state,
      plan,
      results,
      compiled: agent,
      turnId: "turn-1" as never,
    });

    expect(reduced.checkpoint.facts).toEqual([]);
    expect(reduced.invalidatedFacts.map((fact) => fact.type)).toEqual([
      "catalog.candidates",
      "catalog.selected",
    ]);
    expect(reduced.checkpoint.interaction?.id).toBe("search-scope");
  });

  it("keeps a new capability interaction when the same turn cancels the previous objective", async () => {
    const state: KernelCheckpoint = {
      ...checkpoint(),
      agenda: [{
        id: "agenda:old-request" as never,
        intention: intention("old-request", "faq.answer", {}),
        status: "waiting_input", missingFacts: [], dependencies: [],
      }],
      progression: {
        objective: { id: "purchase.journey", status: "active" },
        occurrences: [],
      },
    };
    const { agent, snapshot } = await context(state);
    const plan = await createTurnPlan({
      batch: {
        ...batch(
          intention("request.1", "catalog.search", { query: "start over" }),
          intention("request.2", "lead.create", {}),
        ),
        lifecycleActions: [{
          kind: "cancel_objective",
          targetId: "purchase.journey",
          evidence: { text: "cancel the journey and search", meaning: "explicit combined request", messageIndex: 0 },
        }],
      },
      snapshot,
      compiled: agent,
      ids: ids(),
    });
    const results: StepExecutionResult[] = [{
      status: "invoked",
      stepId: plan.steps[0]?.id as never,
      capabilityId: capabilityId("catalog.search"),
      result: {
        status: "needs_input",
        interaction: {
          id: "new-search-input" as never,
          kind: "input",
          capabilityId: capabilityId("catalog.search"),
          requestedFacts: [],
          goal: "Which products should I search?",
        },
        partialInput: {},
      },
    }];

    const reduced = await reduceCapabilityResults({
      checkpoint: state,
      plan,
      results,
      compiled: agent,
      turnId: "turn-combined-control" as never,
    });

    expect(reduced.checkpoint.progression?.objective?.status).toBe("cancelled");
    expect(reduced.checkpoint.interaction?.id).toBe("new-search-input");
    expect(reduced.checkpoint.agenda.map((item) => [item.intention.proposedCapability, item.status])).toEqual([
      ["catalog.search", "waiting_input"],
      ["lead.create", "waiting_facts"],
    ]);
    expect(reduced.checkpoint.agenda.some((item) => item.id === "agenda:old-request")).toBe(false);
  });

  it("publishes validated facts with evidence and invalidates dependent descendants", async () => {
    const oldCandidates = {
      type: factType("catalog.candidates"),
      version: 1,
      value: [{ id: "old" }],
      evidenceIds: [],
      evidence: [],
      dependsOn: [],
      producedBy: { capabilityId: capabilityId("catalog.search"), capabilityVersion: 1, turnId: "t0" as never, stepId: "s0" as never },
    };
    const oldSelection = {
      type: factType("catalog.selected"),
      version: 1,
      value: { id: "old" },
      evidenceIds: [],
      evidence: [],
      dependsOn: [{ type: factType("catalog.candidates"), version: 1 }],
      producedBy: { capabilityId: capabilityId("catalog.select"), capabilityVersion: 1, turnId: "t0" as never, stepId: "s1" as never },
    };
    const state = checkpoint([oldCandidates, oldSelection]);
    const { agent, snapshot } = await context(state);
    const plan = await createTurnPlan({
      batch: batch(intention("request.1", "catalog.search", { query: "new" })),
      snapshot,
      compiled: agent,
      ids: ids(),
    });
    const completed: CapabilityResult<Record<string, unknown>> = {
      status: "completed",
      output: { count: 1 },
      facts: [{
        type: factType("catalog.candidates"),
        version: 1,
        value: [{ id: "new" }],
        evidenceIds: ["evidence-1" as never],
        dependsOn: [],
      }],
      evidence: [{ id: "evidence-1" as never, source: "external", content: "Catalog returned product new" }],
      artifacts: [],
    };
    const results: StepExecutionResult[] = [{
      status: "invoked",
      stepId: plan.steps[0]?.id as never,
      capabilityId: capabilityId("catalog.search"),
      result: completed,
    }];

    const reduced = await reduceCapabilityResults({
      checkpoint: state,
      plan,
      results,
      compiled: agent,
      turnId: "turn-1" as never,
    });

    expect(reduced.checkpoint.facts).toHaveLength(1);
    expect(reduced.checkpoint.facts[0]).toMatchObject({
      type: "catalog.candidates",
      value: [{ id: "new" }],
      evidence: [{ id: "evidence-1", content: "Catalog returned product new" }],
    });
    expect(reduced.invalidatedFacts.map((fact) => fact.type)).toEqual(["catalog.candidates", "catalog.selected"]);
  });

  it("rejects a canonical response that cites evidence absent from its capability result", async () => {
    const state = checkpoint();
    const { agent, snapshot } = await context(state);
    const plan = await createTurnPlan({
      batch: batch(intention("request.1", "catalog.search", { query: "new" })),
      snapshot,
      compiled: agent,
      ids: ids(),
    });
    const results: StepExecutionResult[] = [{
      status: "invoked",
      stepId: plan.steps[0]?.id as never,
      capabilityId: capabilityId("catalog.search"),
      result: {
        status: "completed",
        output: { count: 0 },
        facts: [],
        evidence: [],
        artifacts: [],
        canonicalResponse: {
          required: true,
          message: "No results are available.",
          claims: [{ text: "No results are available", evidenceIds: ["missing" as never] }],
        },
      },
    }];

    await expect(reduceCapabilityResults({
      checkpoint: state,
      plan,
      results,
      compiled: agent,
      turnId: "turn-1" as never,
    })).rejects.toMatchObject({ code: "UNKNOWN_EVIDENCE" });
  });

  it.each([true, "true"])("rejects an uncited or invalid required response flag: %s", async (required) => {
    const state = checkpoint();
    const { agent, snapshot } = await context(state);
    const plan = await createTurnPlan({ batch: batch(intention("request.1", "catalog.search", { query: "new" })), snapshot, compiled: agent, ids: ids() });
    const results: StepExecutionResult[] = [{
      status: "invoked", stepId: plan.steps[0]?.id as never, capabilityId: capabilityId("catalog.search"),
      result: { status: "completed", output: { count: 0 }, facts: [], evidence: [], artifacts: [],
        canonicalResponse: { message: "A result.", claims: [], required: required as boolean } },
    }];
    await expect(reduceCapabilityResults({ checkpoint: state, plan, results, compiled: agent, turnId: "turn-1" as never }))
      .rejects.toMatchObject({ code: "INVALID_CANONICAL_RESPONSE" });
  });

  it("does not invalidate confirmed state when its provider fails", async () => {
    const oldCandidates = {
      type: factType("catalog.candidates"),
      version: 1,
      value: [{ id: "old" }],
      evidenceIds: [],
      evidence: [],
      dependsOn: [],
      producedBy: { capabilityId: capabilityId("catalog.search"), capabilityVersion: 1, turnId: "t0" as never, stepId: "s0" as never },
    };
    const state = checkpoint([oldCandidates]);
    const { agent, snapshot } = await context(state);
    const plan = await createTurnPlan({
      batch: batch(intention("request.1", "catalog.search", { query: "new" })),
      snapshot,
      compiled: agent,
      ids: ids(),
    });
    const results: StepExecutionResult[] = [{
      status: "invoked",
      stepId: plan.steps[0]?.id as never,
      capabilityId: capabilityId("catalog.search"),
      result: { status: "failed", issue: { code: "UPSTREAM", message: "Unavailable", retryable: true } },
    }];

    const reduced = await reduceCapabilityResults({ checkpoint: state, plan, results, compiled: agent, turnId: "turn-1" as never });

    expect(reduced.checkpoint.facts).toEqual([oldCandidates]);
    expect(reduced.invalidatedFacts).toEqual([]);
  });

  it("persists deferred work in the agenda with one active interaction", async () => {
    const { agent, snapshot } = await context();
    const plan = await createTurnPlan({
      batch: batch(intention("request.1", "catalog.select", { position: 1 })),
      snapshot,
      compiled: agent,
      ids: ids(),
    });

    const reduced = await reduceCapabilityResults({
      checkpoint: checkpoint(),
      plan,
      results: [],
      compiled: agent,
      turnId: "turn-1" as never,
    });

    expect(reduced.checkpoint.agenda).toHaveLength(1);
    expect(reduced.checkpoint.agenda[0]).toMatchObject({ status: "waiting_facts", missingFacts: [{ type: "catalog.candidates" }] });
    expect(reduced.checkpoint.interaction).toEqual(plan.interaction);
  });

  it.each(["preserve", "dismiss"])("keeps pending work when independent completion chooses to %s its previous interaction", async (mode) => {
    const pendingIntention = intention("request.pending", "catalog.select", { position: 1 });
    const pendingState: KernelCheckpoint = {
      ...checkpoint(),
      agenda: [{
        id: "agenda:pending" as never,
        intention: pendingIntention,
        status: "waiting_facts",
        missingFacts: [{ type: factType("catalog.candidates"), version: 1, description: "Catalog candidates" }],
        dependencies: [],
      }],
      interaction: {
        id: "interaction:pending" as never,
        kind: "input",
        capabilityId: capabilityId("catalog.select"),
        requestedFacts: [factType("catalog.candidates")],
        goal: "Choose a catalog candidate",
      },
    };
    const { agent, snapshot } = await context(pendingState);
    const plan = await createTurnPlan({
      batch: batch(intention("request.info", "faq.answer", { question: "shipping" })),
      snapshot,
      compiled: agent,
      ids: ids(),
    });
    const results: StepExecutionResult[] = [{
      status: "invoked",
      stepId: plan.steps[0]?.id as never,
      capabilityId: capabilityId("faq.answer"),
      result: { status: "completed", output: {}, facts: [], evidence: [], artifacts: [],
        ...(mode === "dismiss" ? { interaction: null } : {}) },
    }];

    const reduced = await reduceCapabilityResults({
      checkpoint: pendingState,
      plan,
      results,
      compiled: agent,
      turnId: "turn-info" as never,
    });

    expect(reduced.checkpoint.agenda).toEqual(pendingState.agenda);
    expect(reduced.checkpoint.interaction).toEqual(mode === "dismiss" ? undefined : pendingState.interaction);
    expect(reduced.checkpoint.facts).toEqual(pendingState.facts);
    expect(pendingState.interaction?.id).toBe("interaction:pending");
  });

  it("keeps a required interaction active when ambient work proposes an optional follow-up", async () => {
    const pendingIntention = intention("request.pending", "catalog.select", { position: 1 });
    const pendingState: KernelCheckpoint = {
      ...checkpoint(),
      agenda: [{
        id: "agenda:pending" as never,
        intention: pendingIntention,
        status: "waiting_input",
        missingFacts: [],
        dependencies: [],
      }],
      interaction: {
        id: "interaction:catalog-choice" as never,
        kind: "choice",
        capabilityId: capabilityId("catalog.select"),
        requestedFacts: [],
        goal: "Choose a catalog candidate",
        options: [{ id: "vehicle-1", label: "Vehicle 1", value: "vehicle-1" }],
      },
    };
    const { agent, snapshot } = await context(pendingState);
    const plan = await createTurnPlan({
      batch: batch(intention("request.info", "faq.answer", { question: "test drive" })),
      snapshot,
      compiled: agent,
      ids: ids(),
    });
    const results: StepExecutionResult[] = [{
      status: "invoked",
      stepId: plan.steps[0]?.id as never,
      capabilityId: capabilityId("faq.answer"),
      result: {
        status: "completed",
        output: {},
        facts: [],
        evidence: [],
        artifacts: [],
        interaction: {
          id: "interaction:faq-follow-up" as never,
          kind: "choice",
          mode: "optional",
          capabilityId: capabilityId("faq.answer"),
          requestedFacts: [],
          goal: "Ask another question?",
          options: [{ id: "faq-more", label: "More questions", value: "more" }],
        },
      },
    }];

    const reduced = await reduceCapabilityResults({
      checkpoint: pendingState,
      plan,
      results,
      compiled: agent,
      turnId: "turn-info" as never,
    });

    expect(reduced.checkpoint.agenda).toEqual(pendingState.agenda);
    expect(reduced.checkpoint.interaction).toEqual(pendingState.interaction);
  });

  it("releases an optional follow-up when the user requests a different capability", async () => {
    const pendingState: KernelCheckpoint = {
      ...checkpoint(),
      agenda: [],
      interaction: {
        id: "interaction:optional-faq" as never,
        kind: "choice",
        mode: "optional",
        capabilityId: capabilityId("faq.answer"),
        requestedFacts: [],
        goal: "Ask another question?",
      },
    };
    const { agent, snapshot } = await context(pendingState);
    const plan = await createTurnPlan({
      batch: batch(intention("request.search", "catalog.search", { query: "new vehicle" })),
      snapshot,
      compiled: agent,
      ids: ids(),
    });
    const results: StepExecutionResult[] = [{
      status: "invoked",
      stepId: plan.steps[0]?.id as never,
      capabilityId: capabilityId("catalog.search"),
      result: { status: "completed", output: {}, facts: [], evidence: [], artifacts: [] },
    }];

    const reduced = await reduceCapabilityResults({
      checkpoint: pendingState,
      plan,
      results,
      compiled: agent,
      turnId: "turn-search" as never,
    });

    expect(reduced.checkpoint.interaction).toBeUndefined();
  });

  it("releases an unrelated required interaction when the requested capability declares a dynamic dependency", async () => {
    const pendingState: KernelCheckpoint = {
      ...checkpoint(),
      agenda: [],
      interaction: {
        id: "interaction:catalog-choice" as never,
        kind: "choice",
        mode: "required",
        capabilityId: capabilityId("catalog.search"),
        requestedFacts: [],
        goal: "Choose one catalog result",
        options: [{ id: "vehicle-1", label: "Vehicle 1", value: "vehicle-1" }],
      },
    };
    const { agent, snapshot } = await context(pendingState);
    const plan = await createTurnPlan({
      batch: batch(intention("request.quote", "faq.answer", { request: "start another operation" })),
      snapshot,
      compiled: agent,
      ids: ids(),
    });
    const results: StepExecutionResult[] = [{
      status: "invoked",
      stepId: plan.steps[0]?.id as never,
      capabilityId: capabilityId("faq.answer"),
      result: {
        status: "needs_dependency",
        requirement: { type: factType("profile.confirmed"), version: 1, description: "Confirmed profile" },
        provider: { capabilityId: capabilityId("catalog.select"), input: { request: "collect it" } },
      },
    }];

    const reduced = await reduceCapabilityResults({
      checkpoint: pendingState,
      plan,
      results,
      compiled: agent,
      turnId: "turn-dynamic-dependency" as never,
    });

    expect(reduced.checkpoint.interaction).toBeUndefined();
    expect(reduced.checkpoint.agenda).toEqual([
      expect.objectContaining({ status: "waiting_facts", missingFacts: [{ type: "profile.confirmed", version: 1, description: "Confirmed profile" }] }),
    ]);
  });
});
