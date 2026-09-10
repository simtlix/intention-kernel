import { describe, expect, it } from "vitest";
import { buildResponseBrief, capabilityId, composeResponse, type IntentionBatch, type ModelGateway, type ModelRequest, type ModelResult, type TurnPlan, type TurnReduction } from "../../src/internal.js";

const owner = capabilityId("contact.collect");
const initial = { mode: "selected" as const, capabilityIds: [owner], rationale: "The user selected a branch and completed contact registration.", evidence: [{ text: "2", meaning: "Register contact", messageIndex: 1 }] };
const reduction: TurnReduction = {
  checkpoint: { schemaVersion: 1, revision: 1, agentFingerprint: "final-decision", messages: [], facts: [], agenda: [], effects: [],
    interaction: { id: "branches" as never, kind: "choice", capabilityId: owner, requestedFacts: [], goal: "Which branch do you prefer?", options: [{ id: "one", label: "North", value: "north" }, { id: "two", label: "South", value: "south" }] } },
  publishedFacts: [], invalidatedFacts: [], evidence: [], artifacts: [], issues: [], results: [],
};
const plan: TurnPlan = { steps: [], responseGoal: "Continue the active interaction." };
const empty: IntentionBatch = { intentions: [], contradictions: [] };
const request = { id: "request" as never, objective: "Show opening hours", evidence: [{ text: "hours", meaning: "Request opening hours", messageIndex: 1 }], references: [], proposedCapability: capabilityId("office.hours"), input: {}, resolution: "resolved" as const };
const question = "Which branch do you prefer?";
const falseOutcome = "Your data is registered and an advisor will contact you.";
const draft = (text: string, evidenceIds: string[] = []) => ({ parts: [{ text, evidenceIds }] });
const supported = { verdict: "supported", decisionVerdict: "supported", continuityVerdict: "supported", approvedClaimIndexes: [], unsupportedClaims: [] };
const unsupported = { ...supported, verdict: "unsupported", decisionVerdict: "violated", unsupportedClaims: [falseOutcome] };
class Gateway implements ModelGateway {
  readonly calls: string[] = [];
  constructor(readonly values: unknown[]) {}
  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.calls.push(request.task);
    return Promise.resolve({ value: this.values.shift() as T, model: "fixture", provider: "fixture", durationMs: 0 });
  }
}

describe("response decision after final interpretation", () => {
  it("does not expose a rejected branch operation as a validated registration", () => {
    const brief = buildResponseBrief({ plan, reduction, decision: initial, batch: empty });
    expect(brief.decision?.mode).toBe("conversational");
    expect(brief.decision?.capabilityIds).toEqual([]);
    expect(JSON.stringify(brief.decision)).not.toContain("completed contact registration");
    expect(JSON.stringify(brief.evidence)).not.toContain("Register contact");
    expect(brief.completed).toEqual([]);
    expect(brief.interaction?.id).toBe("branches");
  });

  it("preserves an independently retained request after dropping the selected owner", () => {
    const brief = buildResponseBrief({ plan, reduction, decision: initial, batch: { ...empty, intentions: [request] } });
    expect(brief.decision?.mode).toBe("selected");
    expect(brief.decision?.capabilityIds).toEqual(["office.hours"]);
    expect(brief.decision?.evidence).toEqual(request.evidence);
    expect(JSON.stringify(brief.decision)).not.toContain("contact.collect");
  });

  it("keeps a pure continuation distinct from an inferred downstream operation", () => {
    const brief = buildResponseBrief({ plan: { ...plan, progressionAction: { kind: "continue", occurrenceId: "explore" } }, reduction, decision: initial,
      batch: { ...empty, answerToInteraction: { interactionId: "explore" as never, value: { kind: "progression.continue", occurrenceId: "explore" }, evidence: "Continue" } } });
    expect(brief.decision?.mode).toBe("conversational");
    expect(brief.decision?.capabilityIds).toEqual([]);
    expect(brief.decision?.rationale).toContain("accepted interaction answer");
  });

  it("preserves compound accepted operations and applied lifecycle control", () => {
    const brief = buildResponseBrief({ plan: { ...plan, cancelledObjectiveIds: ["purchase"] }, reduction, decision: initial,
      batch: { ...empty, intentions: [request], lifecycleActions: [{ kind: "cancel_objective", targetId: "purchase", evidence: { text: "cancel purchase", meaning: "Cancel purchase", messageIndex: 1 } }] } });
    expect(brief.decision?.mode).toBe("selected_with_control");
    expect(brief.decision?.capabilityIds).toEqual(["office.hours"]);
    expect(brief.decision?.evidence).toHaveLength(2);
  });

  it("does not turn ambiguity or no-match into a selected operation", () => {
    for (const batch of [empty, { ...empty, intentions: [{ ...request, resolution: "ambiguous" as const, proposedCapability: undefined, alternatives: ["North", "South"] }] }]) {
      const brief = buildResponseBrief({ plan, reduction, decision: { ...initial, mode: "no_match", capabilityIds: [] }, batch: batch as IntentionBatch });
      expect(brief.decision?.mode).toBe("no_match");
      expect(brief.decision?.capabilityIds).toEqual([]);
    }
  });

  it("does not describe a plan-rejected request as authorized or completed work", () => {
    const rejectedPlan: TurnPlan = { ...plan, steps: [{ id: "rejected" as never, intentionId: request.id, intention: request,
      capabilityId: request.proposedCapability, input: {}, dependsOn: [], missingFacts: [], disposition: "reject",
      reason: { code: "POLICY_DENIED", message: "Not permitted", evidence: [] } }] };
    const brief = buildResponseBrief({ plan: rejectedPlan, reduction, decision: initial, batch: { ...empty, intentions: [request] } });
    expect(brief.decision?.mode).toBe("no_match");
    expect(brief.decision?.capabilityIds).toEqual([]);
    expect(brief.decision?.rationale).toContain("rejected");
    expect(brief.completed).toEqual([]);
    expect(brief.allowedActions).toEqual([]);
  });

  it("delivers the exact still-pending question before an untrusted registration draft", async () => {
    const gateway = new Gateway([draft(falseOutcome), unsupported, draft(question), supported]);
    const response = await composeResponse({ brief: buildResponseBrief({ plan, reduction, decision: initial, batch: empty }), gateway, signal: AbortSignal.timeout(1000) });
    expect(response.message).toBe(question);
    expect(response.claims).toEqual([]);
    expect(response.interaction?.id).toBe("branches");
    expect(response.source).toBe("canonical");
    expect(gateway.calls).toEqual([]);
  });

  it("does not deliver a persistent false registration after the bounded repair", async () => {
    const gateway = new Gateway([draft(falseOutcome), unsupported, draft(falseOutcome), unsupported]);
    const response = await composeResponse({ brief: buildResponseBrief({ plan, reduction, decision: initial, batch: empty }), gateway, signal: AbortSignal.timeout(1000) });
    expect(response.message).toBe(question);
    expect(response.source).toBe("canonical");
    expect(response.claims).toEqual([]);
  });

  it("does not consult an inconsistent reviewer when the pending question fully represents the turn", async () => {
    const gateway = new Gateway([draft(falseOutcome), { ...supported, unsupportedClaims: [falseOutcome] }, draft(question), supported]);
    const response = await composeResponse({ brief: buildResponseBrief({ plan, reduction, decision: initial, batch: empty }), gateway, signal: AbortSignal.timeout(1000) });
    expect(response.message).toBe(question);
    expect(response.source).toBe("canonical");
    expect(gateway.calls).toHaveLength(0);
  });

  it("keeps genuine conversational greetings citation-free without extra reviews", async () => {
    const gateway = new Gateway([draft("Hello, how can I help?"), supported]);
    const greetingReduction = structuredClone(reduction);
    delete greetingReduction.checkpoint.interaction;
    const brief = buildResponseBrief({ plan, reduction: greetingReduction, decision: initial, batch: empty });
    const response = await composeResponse({ brief, gateway, signal: AbortSignal.timeout(1000) });
    expect(response.message).toBe("Hello, how can I help?");
    expect(response.claims).toEqual([]);
    expect(gateway.calls).toHaveLength(2);
  });

  it("preserves a real current registration supported by completed work evidence", async () => {
    const claim = "The inquiry was registered.";
    const registration = { ...request, objective: "Register the inquiry", proposedCapability: capabilityId("lead.create") };
    const evidence = { id: "registration-proof" as never, source: "external" as const, content: claim, data: { receiptId: "receipt", inquiryId: "inquiry" } };
    const step: TurnPlan["steps"][number] = { id: "write" as never, intentionId: registration.id, intention: registration, capabilityId: registration.proposedCapability, input: {}, dependsOn: [], missingFacts: [], disposition: "execute", reason: { code: "READY", message: "Ready", evidence: [] } };
    const brief = buildResponseBrief({ plan: { ...plan, steps: [step] }, reduction: { ...reduction, evidence: [evidence], results: [{ status: "invoked", stepId: step.id, capabilityId: registration.proposedCapability, result: { status: "completed", output: evidence.data, facts: [], evidence: [evidence], artifacts: [] } }] }, decision: initial, batch: { ...empty, intentions: [registration] } });
    const gateway = new Gateway([draft(claim, ["registration-proof"]), { ...supported, approvedClaimIndexes: [0] }]);
    const response = await composeResponse({ brief, gateway, signal: AbortSignal.timeout(1000) });
    expect(brief.completed).toHaveLength(1);
    expect(response.message).toBe(claim);
    expect(response.claims).toEqual([{ text: claim, evidenceIds: ["registration-proof"] }]);
    expect(gateway.calls).toHaveLength(2);
  });
});
