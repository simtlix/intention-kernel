import { describe, expect, it } from "vitest";

import { capabilityId, interactionId, type AgendaItemId, type IntentionId } from "../../src/contracts/ids.js";
import type { IntentionBatch, IntentionRequest } from "../../src/contracts/intention.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";
import type { ContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { reviewConfirmationIntentions } from "../../src/interpreter/reviewConfirmationIntentions.js";
import { interpretTurn } from "../../src/interpreter/interpretTurn.js";
import { createTurnPlan } from "../../src/planner/createTurnPlan.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { agentId, defineAgent, defineCapability, defineSchema } from "../../src/index.js";

class ReviewGateway implements ModelGateway {
  readonly requests: ModelRequest<unknown>[] = [];
  constructor(readonly value: unknown) {}
  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.requests.push(request);
    return Promise.resolve({ value: this.value as T, provider: "scripted", model: "test", durationMs: 1 });
  }
}

function operation(id: string, capability: string, evidence: string, input: unknown = {}): IntentionRequest {
  return {
    id: id as IntentionId, objective: evidence, proposedCapability: capabilityId(capability), input,
    evidence: [{ text: evidence, meaning: "Requested operation", messageIndex: 0 }],
    references: [], resolution: "resolved",
  };
}

const confirmationId = interactionId("confirm-existing-budget");
const signal = new AbortController().signal;

function snapshot(content: string): ContextSnapshot {
  return {
    conversation: { recentMessages: [], totalMessages: 0 },
    currentMessage: { role: "user", content, at: "2026-09-06T12:00:00.000Z", index: 0 },
    facts: [], decisions: [], policies: [], selectedModelGuidancePolicies: [], omissions: [],
    agenda: [{
      id: "existing-budget" as AgendaItemId,
      intention: operation("original-request", "budget.create", "Quiero el presupuesto para el auto A", { vehicleId: "A" }),
      status: "waiting_confirmation", missingFacts: [], dependencies: [],
    }],
    interaction: {
      id: confirmationId, kind: "confirmation", capabilityId: capabilityId("budget.create"),
      requestedFacts: [], goal: "¿Confirmás generar el presupuesto del auto A con las decisiones elegidas?",
    },
    capabilities: ["budget.create", "product.details", "unrelated.lookup"].map((id) => ({
      id: capabilityId(id), description: id, availability: "ready" as const, blockedBy: [],
      inputSchema: { type: "object" },
    })),
    agent: { id: "test", version: 1, identity: "Assistant", modelPolicy: { "turn.interpret.repair": "repair" } },
  };
}

function batch(text: string, intentions: readonly IntentionRequest[], value = true): IntentionBatch {
  return { answerToInteraction: { interactionId: confirmationId, value, evidence: text }, intentions, contradictions: [] };
}

describe("intentions accompanying a supported confirmation", () => {
  it.each([
    { text: "Confirmo generar el presupuesto con las decisiones elegidas.", value: true },
    { text: "No, no generes ese presupuesto.", value: false },
  ])("rejects re-emitting the owned operation in '$text', including an unchanged bad repair", async ({ text, value }) => {
    const proposed = batch(text, [operation("duplicate", "budget.create", text, { vehicleId: "A" })], value);
    const original = structuredClone(proposed);
    const gateway = new ReviewGateway({ verdict: "unsupported", rationale: "The words only answer the existing confirmation, not a new budget request." });
    const options = { batch: proposed, snapshot: snapshot(text), gateway, signal };
    const issues = await reviewConfirmationIntentions(options);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["intentions"]);
    // A repair that repeats the duplicate cannot bypass this gate on its second pass.
    expect(await reviewConfirmationIntentions(options)).toHaveLength(1);
    expect(proposed).toEqual(original);

    const repaired = { ...proposed, intentions: [] };
    expect(await reviewConfirmationIntentions({ ...options, batch: repaired })).toEqual([]);
    expect(repaired.answerToInteraction).toEqual({ interactionId: confirmationId, value, evidence: text });
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0]).toMatchObject({ task: "interaction-answer.review", model: "repair", signal,
      input: { reviewKind: "confirmation_intention_independence", proposedAnswer: proposed.answerToInteraction,
        intentions: proposed.intentions, context: { agenda: [{ id: "existing-budget", status: "waiting_confirmation" }] } },
    });
    expect(gateway.requests[0]?.capabilities.map(({ id }) => id)).toEqual(["budget.create"]);
  });

  it.each([
    { text: "Confirmo ese presupuesto y mostrame los detalles del auto B.", intentions: [operation("details-B", "product.details", "mostrame los detalles del auto B", { vehicleId: "B" })] },
    { text: "Confirmo el del auto A y además quiero otros dos presupuestos: uno para B y otro para C.", intentions: [
      operation("budget-B", "budget.create", "uno para B", { vehicleId: "B" }),
      operation("budget-C", "budget.create", "otro para C", { vehicleId: "C" }),
    ] },
  ])("retains separately supported requests without capability-ID deduplication: $text", async ({ text, intentions }) => {
    const proposed = batch(text, intentions);
    const original = structuredClone(proposed);
    const gateway = new ReviewGateway({ verdict: "supported", rationale: "Each additional operation has a distinct requested target beyond the confirmed operation." });
    expect(await reviewConfirmationIntentions({ batch: proposed, snapshot: snapshot(text), gateway, signal })).toEqual([]);
    expect(proposed).toEqual(original);
    // The semantic reviewer must receive both same-capability requests, not a collapsed representative.
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.input).toMatchObject({ intentions: original.intentions, proposedAnswer: original.answerToInteraction });
  });

  it("fails closed on malformed independence review rather than admitting an unreviewed write", async () => {
    const text = "Confirmo";
    const gateway = new ReviewGateway({ verdict: "maybe", rationale: "Uncertain" });
    const context = snapshot(text);
    const issues = await reviewConfirmationIntentions({
      batch: batch(text, [operation("duplicate", "budget.create", text)]),
      snapshot: { ...context, agent: { ...context.agent, modelPolicy: { "interaction-answer.review": "dedicated" } } },
      gateway, signal,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["intentions"]);
    expect(gateway.requests[0]?.model).toBe("dedicated");
  });

  it("leaves absent, mismatched and non-confirmation answers to their existing validators", async () => {
    const text = "Sí";
    const proposed = batch(text, [operation("new", "budget.create", text)]);
    const context = snapshot(text);
    const gateway = new ReviewGateway(undefined);
    for (const candidate of [
      { batch: { intentions: proposed.intentions, contradictions: [] }, snapshot: context },
      { batch: { ...proposed, answerToInteraction: { interactionId: interactionId("other"), value: true, evidence: text } }, snapshot: context },
      { batch: { ...proposed, answerToInteraction: { interactionId: confirmationId, value: "yes", evidence: text } }, snapshot: context },
      { batch: proposed, snapshot: { ...context, interaction: { id: confirmationId, kind: "input" as const, requestedFacts: [], goal: "Provide a name" } } },
    ]) expect(await reviewConfirmationIntentions({ ...candidate, gateway, signal })).toEqual([]);
    expect(gateway.requests).toHaveLength(0);
  });
});

describe("confirmation independence through interpretation repair", () => {
  it.each(["preserved", "dropped", "changed", "duplicate"] as const)("requires the exact supported answer after a %s repair", async (repairKind) => {
    const text = "Confirmo generar el presupuesto con las decisiones elegidas.";
    const proposed = batch(text, [operation("duplicate", "budget.create", text, { vehicleId: "A", restated: true })]);
    const repaired = repairKind === "preserved" ? { ...proposed, intentions: [] }
      : repairKind === "dropped" ? { intentions: proposed.intentions, contradictions: [] }
      : repairKind === "changed" ? batch(text, [], false) : proposed;
    const supported = { verdict: "supported", rationale: "The current wording confirms the existing budget." };
    const unsupported = { verdict: "unsupported", rationale: "The additional budget merely re-emits the already-owned operation." };
    const responses: unknown[] = [proposed, supported, unsupported, repaired, supported, unsupported];
    const gateway: ModelGateway = {
      invoke: <T,>(): Promise<ModelResult<T>> => Promise.resolve({
        value: responses.shift() as T, provider: "scripted", model: "test", durationMs: 1,
      }),
    };
    const context = snapshot(text);
    const owner = operation("original-request", "budget.create", "Quiero el presupuesto para el auto A", { vehicleId: "A" });
    const current = { ...context, interaction: {
      id: confirmationId, kind: "confirmation" as const, capabilityId: capabilityId("budget.create"),
      requestedFacts: [], goal: "Confirm the existing budget", payload: { intention: owner, input: owner.input },
    } };
    const result = interpretTurn({ snapshot: current, gateway, signal, selection: {
      mode: "selected", capabilityIds: [capabilityId("budget.create")], rationale: "Pending budget", evidence: [],
    } });
    if (repairKind !== "preserved") {
      await expect(result).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
      return;
    }
    const accepted = await result;
    expect(accepted.intentions).toEqual([]);
    expect(accepted.answerToInteraction).toEqual({ interactionId: confirmationId, value: true, evidence: text });
    const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });
    const compiled = await compileAgentDefinition(defineAgent({
      id: agentId("confirmation-test"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
      capabilities: [defineCapability({ id: capabilityId("budget.create"), version: 1, description: "Create budget",
        input: schema, output: schema, requires: [], provides: [], effect: "write", confirmation: "kernel",
        execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
      })],
    }));
    const plan = await createTurnPlan({ batch: accepted, snapshot: current, compiled, ids: { next: (kind) => kind } });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ intentionId: "original-request", capabilityId: "budget.create", input: { vehicleId: "A" }, disposition: "execute" });
  });
});
