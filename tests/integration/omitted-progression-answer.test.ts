import { describe, expect, it } from "vitest";
import { agentId, capabilityId, defineAgent, defineCapability, defineSchema } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { interpretTurn } from "../../src/interpreter/interpretTurn.js";
import { createTurnPlan } from "../../src/planner/createTurnPlan.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });

describe("omitted progression answers", () => {
  it.each([
    { message: "Si, avancemos con el presupuesto", capability: "purchase.nextDecision", exit: true, independent: false },
    { message: "Primero quiero cotizar mi usado", capability: "ownedVehicle.quote", exit: false, independent: true },
    { message: "Mostrame información del producto", capability: "product.details", exit: false, independent: true },
    { message: "Cotizá mi usado y después continuemos con el presupuesto", capability: "ownedVehicle.quote", exit: true, independent: true },
    { message: "Continuemos con el presupuesto (invalid review)", capability: "purchase.nextDecision", exit: true, independent: false, fault: "invalid-review" },
    { message: "Continuemos con el presupuesto (unrepaired omission)", capability: "purchase.nextDecision", exit: true, independent: false, fault: "unrepaired" },
    { message: "Dale", capability: "product.details", exit: false, independent: false, noOperation: true, decision: "ambiguous" },
    { message: "Gracias por la información", capability: "product.details", exit: false, independent: false, noOperation: true, decision: "not_requested" },
    { message: "Dale, consultá los horarios", capability: "business.hours", exit: false, independent: true, decision: "ambiguous" },
    { message: "Dale (legacy verdict)", capability: "product.details", exit: false, independent: false, noOperation: true, fault: "legacy-verdict" },
    { message: "Dale (empty evidence)", capability: "product.details", exit: false, independent: false, noOperation: true, fault: "empty-evidence" },
    { message: "Dale (historical evidence)", capability: "product.details", exit: false, independent: false, noOperation: true, fault: "historical-evidence" },
  ])("preserves only the current request: $message", async ({ message, capability, exit, independent, fault, noOperation, decision }) => {
    const compiled = await compileAgentDefinition(defineAgent({ id: agentId("omitted.answer"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
      capabilities: ["purchase.nextDecision", "ownedVehicle.quote", "product.details", "business.hours"].map((id) => defineCapability({ id: capabilityId(id), version: 1, description: id, input: schema, output: schema,
        requires: [], provides: [], effect: "read", execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
      })),
    }));
    const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: message, at: "2026-09-06T10:00:00Z" }, checkpoint: {
      schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, facts: [], agenda: [], effects: [],
      messages: [{ role: "assistant", content: "La ficha verificada informa transmisión automática y ABS.", at: "2026-09-06T09:59:00Z" }],
      interaction: { id: "explore" as never, kind: "choice", goal: "Más información o continuar con el presupuesto?", requestedFacts: [],
        options: [{ id: "details", label: "Información", value: { kind: "progression.member", capabilityId: "product.details", occurrenceId: "explore" }, targetCapabilityId: capabilityId("product.details") },
          { id: "continue", label: "Continuar con el presupuesto", value: { kind: "progression.continue", occurrenceId: "explore" } }],
        payload: { kind: "progression.group", occurrenceId: "explore" },
      },
    } });
    const evidence = [{ text: independent && exit ? "Cotizá mi usado" : message, meaning: "Current request", messageIndex: 1 }];
    const intentions = noOperation ? [] : [{ objective: capability, references: [], evidence, proposedCapability: capability, input: {}, resolution: "resolved" }];
    const answer = { interactionId: "explore", value: "continue", evidence: independent ? "después continuemos con el presupuesto" : message };
    const requests: ModelRequest<unknown>[] = [];
    const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
      requests.push(request);
      const value = request.task === "turn.interpret" ? { intentions, contradictions: [] }
        : request.task === "turn.interpret.repair" ? (fault ? { intentions, contradictions: [] } : { intentions: independent ? intentions : [], contradictions: [], answerToInteraction: answer })
          : (request.input as { reviewKind?: string }).reviewKind === "omitted_progression_answer"
            ? (fault === "invalid-review" ? { continuation: "unknown" } : fault === "legacy-verdict" ? { verdict: "supported", rationale: "Legacy inverted polarity must not be accepted." }
              : { continuation: fault === "empty-evidence" || fault === "historical-evidence" ? "requested" : decision ?? (exit ? "requested" : "not_requested"),
                evidence: fault === "empty-evidence" ? "" : fault === "historical-evidence" ? "Continuemos con el presupuesto" : exit ? message : "",
                rationale: exit ? "The current words ask to leave the group; the next operation must not substitute for its answer." : "There is no unambiguous authorization to continue. Preserve the current request and group." })
            : { verdict: "supported", rationale: "Exact current request supported." };
      return Promise.resolve({ value: value as T, provider: "scripted", model: "test", durationMs: 1 });
    } };
    const interpretation = interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1000), selection: {
      mode: noOperation ? "conversational" : "selected", capabilityIds: noOperation ? [] : [capabilityId(capability)], rationale: "Current request", evidence,
    } });
    if (fault) {
      await expect(interpretation).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
      expect(requests.filter((request) => request.task === "turn.interpret.repair")).toHaveLength(1);
      expect(requests.filter((request) => (request.input as { reviewKind?: string }).reviewKind === "omitted_progression_answer")).toHaveLength(2);
      return;
    }
    const result = await interpretation;
    expect(result.intentions.map((item) => item.proposedCapability)).toEqual(independent ? [capability] : []);
    expect(result.answerToInteraction?.value).toEqual(exit ? { kind: "progression.continue", occurrenceId: "explore" } : undefined);
    const plan = await createTurnPlan({ batch: result, snapshot, compiled, ids: { next: (kind) => kind } });
    expect(plan.progressionAction?.kind).toBe(exit ? "continue" : undefined);
    expect(plan.steps.map((step) => step.capabilityId)).toEqual(independent ? [capability] : []);
    expect(snapshot.interaction?.id).toBe("explore");
    if (!exit) expect(requests.filter(request => request.task === "turn.interpret.repair")).toHaveLength(0);
    const review = requests.find((request) => (request.input as { reviewKind?: string }).reviewKind === "omitted_progression_answer");
    expect(review?.task).toBe("interaction-answer.review");
  });
});
