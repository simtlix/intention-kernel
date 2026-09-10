import { describe, expect, it } from "vitest";
import { agentId, capabilityId, interactionId, defineAgent, defineCapability, defineSchema } from "../../src/index.js";
import type { IntentionId } from "../../src/contracts/ids.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { interpretTurn } from "../../src/interpreter/interpretTurn.js";
import { reviewConfirmationIntentions } from "../../src/interpreter/reviewConfirmationIntentions.js";
import { createTurnPlan } from "../../src/planner/createTurnPlan.js";
import type { IntentionBatch } from "../../src/contracts/intention.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";

const signal = new AbortController().signal;
const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: value => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });
async function fixture(text: string) {
  const compiled = await compileAgentDefinition(defineAgent({ id: agentId("confirmation.repair"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
    capabilities: ["budget.create", "business.hours"].map(id => defineCapability({ id: capabilityId(id), version: 1, description: id, input: schema, output: schema,
      requires: [], provides: [], effect: id === "budget.create" ? "write" : "read", ...(id === "budget.create" ? { confirmation: "kernel" as const } : {}),
      execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }) })),
  }));
  const operation = { id: "owned-budget" as IntentionId, objective: "Create the requested budget", evidence: [{ text: "Quiero presupuesto", meaning: "Original request", messageIndex: 0 }], references: [], proposedCapability: capabilityId("budget.create"), input: { selectedVehicle: "vehicle-a" }, resolution: "resolved" as const };
  const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: text, at: "2026-09-06T13:00:00Z" }, checkpoint: {
    schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, facts: [], effects: [], messages: [],
    agenda: [{ id: "pending-budget" as never, status: "waiting_confirmation", dependencies: [], missingFacts: [], intention: operation, modelRedactions: ["private-contact-value"] }],
    interaction: { id: interactionId("budget-confirmation"), kind: "confirmation", capabilityId: capabilityId("budget.create"), goal: "¿Confirmás generar el presupuesto?", requestedFacts: [], payload: { intention: operation, input: operation.input } },
  } });
  return { snapshot, compiled };
}

describe("repair feedback for an omitted confirmation answer", () => {
  it.each([{ text: "Confirmo generar el presupuesto con las decisiones elegidas.", accepted: true, compound: false },
    { text: "No, no generes el presupuesto.", accepted: false, compound: false },
    { text: "Confirmo el presupuesto y además quiero consultar los horarios.", accepted: true, compound: true }])(
    "permits a supported answer without demanding a duplicate operation: $text", async ({ text, accepted, compound }) => {
      const current = await fixture(text);
      const requests: ModelRequest<unknown>[] = [];
      const repaired = { intentions: compound ? [{ objective: "Read opening hours", evidence: [{ text: "quiero consultar los horarios", meaning: "Separate information request", messageIndex: 0 }], references: [], proposedCapability: "business.hours", input: { question: "horarios" }, resolution: "resolved" }] : [], contradictions: [],
        answerToInteraction: { interactionId: "budget-confirmation", value: accepted, evidence: text } };
      const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
        requests.push(request);
        const value = request.task === "turn.interpret" ? { intentions: [], contradictions: [] }
          : request.task === "turn.interpret.repair" ? repaired : { verdict: "supported", rationale: "The explicit answer and any separate hours request have current support." };
        return Promise.resolve({ value: value as T, provider: "scripted", model: "test", durationMs: 0 });
      } };
      const batch = await interpretTurn({ ...current, gateway, signal, selection: { mode: "selected", capabilityIds: [capabilityId("budget.create"), ...(compound ? [capabilityId("business.hours")] : [])], rationale: "Pending confirmation", evidence: [] } });
      const plan = await createTurnPlan({ ...current, batch, ids: { next: kind => kind } });
      expect(batch.answerToInteraction?.value).toBe(accepted);
      expect(batch.intentions.map(i => i.proposedCapability)).toEqual(compound ? ["business.hours"] : []);
      expect(plan.steps.filter(step => step.capabilityId === "budget.create" && step.disposition === "execute")).toHaveLength(accepted ? 1 : 0);
      if (accepted) expect(plan.steps.find(step => step.capabilityId === "budget.create")?.intentionId).toBe("owned-budget");
      const repairs = requests.filter(request => request.task === "turn.interpret.repair");
      expect(repairs).toHaveLength(1);
      const issues = (repairs[0]?.input as { validationIssues: { message: string }[] }).validationIssues;
      // This is the actual model-facing diagnostic, not source-text inspection.
      // Reintroducing the unconditional instruction contradicts the valid repaired answer above.
      expect(issues[0]?.message).not.toBe("A selected capability set requires at least one interpreted intention.");
    },
  );

  it("keeps all private values out of the confirmation independence review without mutating the batch", async () => {
    const { snapshot } = await fixture("Confirmo y quiero consultar información");
    const batch: IntentionBatch = { intentions: [{ id: "additional" as IntentionId, objective: "Inspect private-contact-value", proposedCapability: capabilityId("business.hours"), input: { privateTarget: "private-contact-value" }, resolution: "resolved", references: [], evidence: [{ text: "private-contact-value", meaning: "Additional request", messageIndex: 0 }] }], contradictions: [],
      answerToInteraction: { interactionId: interactionId("budget-confirmation"), value: true, evidence: "Confirmo private-contact-value" } };
    const before = structuredClone(batch);
    const requests: ModelRequest<unknown>[] = [];
    const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => { requests.push(request); return Promise.resolve({ value: { verdict: "supported", rationale: "Independent operation." } as T, provider: "scripted", model: "test", durationMs: 0 }); } };
    expect(await reviewConfirmationIntentions({ snapshot, batch, gateway, signal })).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.input)).not.toContain("private-contact-value");
    expect(batch).toEqual(before);
  });
});
