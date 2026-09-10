import { describe, expect, it } from "vitest";
import { agentId, capabilityId, interactionId, defineAgent, defineCapability, defineSchema } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { interpretTurn } from "../../src/interpreter/interpretTurn.js";
import { createTurnPlan } from "../../src/planner/createTurnPlan.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: value => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });
const memberIds = ["product.details", "product.images", "product.colors", "product.stock", "product.compare"];

describe("progression member current-message consent", () => {
  it.each([
    { label: "clarifies an acknowledgement after already delivered information", message: "Dale", supported: false },
    { label: "reviews an unsupported exact member before consuming repair on a missing operation", message: "Dale", supported: false, initiallyEmpty: true },
    { label: "still requires an owner operation for a supported member with an initially empty batch", message: "Mostrame la información del producto", supported: true, initiallyEmpty: true },
    { label: "does not accept repair that leaves a supported member without its operation", message: "Mostrame la información del producto", supported: true, initiallyEmpty: true, retainEmpty: true },
    { label: "rejects repair removing the member answer but keeping its invented operation", message: "Dale", supported: false, retainInvented: true },
    { label: "reviews the invented member operation even when the initial answer is omitted", message: "Dale", supported: false, omitInitially: true },
    { label: "preserves separate explicit work when rejecting an inferred member", message: "Dale, y consultá los horarios", supported: false, independent: true },
    { label: "rejects invalid evidence for an operation without a member answer", message: "Dale", supported: false, omitInitially: true, invalidReview: true },
    { label: "preserves an explicit member operation without manufacturing an answer", message: "Mostrame la información del producto", supported: true, omitInitially: true },
    { label: "preserves an explicit request for the current member", message: "Mostrame la información del producto", supported: true },
    { label: "preserves the exact structured member click", message: "Ver información", supported: true, structured: true },
    { label: "preserves independently requested compound work", message: "Mostrame información y además consultá los horarios", supported: true, compound: true },
    { label: "removes additional work not authorized by selecting a member", message: "Mostrame información", supported: true, extraUnsupported: true },
    { label: "keeps an explicit continuation with its existing semantic owner", message: "Continuemos con el presupuesto", supported: true, continuation: true },
  ])("$label", async ({ message, supported, retainInvented, omitInitially, structured, compound, continuation, extraUnsupported, independent, invalidReview, initiallyEmpty, retainEmpty }) => {
    const compiled = await compileAgentDefinition(defineAgent({ id: agentId("member.consent"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
      capabilities: [...memberIds, "business.hours"].map(id => defineCapability({ id: capabilityId(id), version: 1, description: id, input: schema, output: schema,
        requires: [], provides: [], effect: "read", execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }) })),
    }));
    const interaction = { id: interactionId("explore"), kind: "choice" as const, goal: "¿Imágenes, colores, disponibilidad, información, comparar o continuar?", requestedFacts: [],
      options: [...memberIds.map(id => ({ id, label: id, value: { kind: "progression.member", capabilityId: id, occurrenceId: "explore" }, targetCapabilityId: capabilityId(id) })),
        { id: "continue", label: "Continuar", value: { kind: "progression.continue", occurrenceId: "explore" } }],
      payload: { kind: "progression.group", occurrenceId: "explore" },
    };
    const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: message, at: "2026-09-06T10:00:00Z" }, checkpoint: {
      schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint,
      facts: [{ type: "product.details" as never, version: 1, value: { productId: "p-1", transmission: "automatic", safety: "ABS" }, evidenceIds: [], evidence: [], dependsOn: [],
        producedBy: { capabilityId: capabilityId("product.details"), capabilityVersion: 1, turnId: "prior-turn" as never, stepId: "prior-step" as never } }],
      agenda: [{ id: "pending-comparison" as never, status: "waiting_input", dependencies: [], missingFacts: [],
        intention: { id: "compare-request" as never, objective: "Compare once another product is identified", evidence: [], references: [], proposedCapability: capabilityId("product.compare"), input: {}, resolution: "resolved" },
        continuation: { awaiting: "secondProduct" } }], effects: [], interaction,
      messages: [{ role: "user", content: "Quisiera ver más información del producto", at: "2026-09-06T09:58:00Z" },
        { role: "assistant", content: "La ficha verificada informa transmisión automática y sistema ABS.", at: "2026-09-06T09:59:00Z" }],
    } });
    const before = structuredClone(snapshot);
    const evidence = [{ text: message, meaning: "Proposed current request", messageIndex: 2 }];
    const intentions = continuation ? [] : ["product.details", ...(compound || extraUnsupported || independent ? ["business.hours"] : [])].map(id => ({ objective: id, references: [], evidence,
      proposedCapability: id, input: { request: supported || id === "business.hours" ? message : "Quisiera ver más información del producto" }, resolution: "resolved" }));
    const answerToInteraction = { interactionId: interaction.id, value: continuation ? { kind: "progression.continue", occurrenceId: "explore" }
      : { kind: "progression.member", capabilityId: "product.details", occurrenceId: "explore" }, evidence: message };
    const requests: ModelRequest<unknown>[] = [];
    const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
      requests.push(request);
      const input = request.input as { reviewKind?: string; proposedOption?: unknown };
      const value = request.task === "turn.interpret" ? { intentions: initiallyEmpty ? [] : intentions, contradictions: [], ...(omitInitially ? {} : { answerToInteraction }) }
        : request.task === "turn.interpret.repair" ? { intentions: retainEmpty ? [] : initiallyEmpty && supported || retainInvented || invalidReview ? intentions : independent ? intentions.slice(1) : extraUnsupported ? intentions.slice(0, 1) : [], contradictions: [], ...(extraUnsupported || initiallyEmpty && supported ? { answerToInteraction } : {}) }
          : input.reviewKind === "omitted_progression_answer" ? { continuation: supported ? "not_requested" : "ambiguous", evidence: "", rationale: "The current words do not authorize the continuation option." }
          : invalidReview && input.reviewKind === "progression_member_operation" ? { verdict: "unclear", rationale: "Missing contract verdict" }
          : input.proposedOption !== undefined ? (supported
            ? { decision: "selected", optionId: "product.details", rationale: "The current member is explicitly selected." }
            : { decision: "not_selection", rationale: "Dale only acknowledges information already delivered." })
          : { verdict: input.reviewKind === "choice_intention_independence" && extraUnsupported ? "unsupported"
            : input.reviewKind === "progression_member_operation" ? (supported ? "supported" : "unsupported") : "supported",
            rationale: supported ? "The current message explicitly requests the operation." : "Dale acknowledges information already delivered; no option or repeated information request is chosen." };
      return Promise.resolve({ value: value as T, provider: "scripted", model: "test", durationMs: 1 });
    } };
    const result = interpretTurn({ snapshot, compiled, gateway, signal: AbortSignal.timeout(2000), selection: {
      mode: continuation ? "conversational" : "selected", capabilityIds: continuation ? [] : [capabilityId("product.details"), ...(compound || extraUnsupported || independent ? [capabilityId("business.hours")] : [])], rationale: "Proposed operation", evidence,
    }, ...(structured ? { validatedInteractionAnswer: answerToInteraction } : {}) });
    if (retainInvented || invalidReview || retainEmpty) {
      await expect(result).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
      if (!retainEmpty) expect(requests.at(-1)?.input).toMatchObject({ reviewKind: "progression_member_operation" });
    } else {
      const batch = await result;
      const plan = await createTurnPlan({ batch, snapshot, compiled, ids: { next: kind => kind } });
      expect(plan.steps.map(step => step.capabilityId)).toEqual(independent ? ["business.hours"] : continuation || !supported ? [] : ["product.details", ...(compound ? ["business.hours"] : [])]);
      expect(plan.progressionAction?.kind).toBe(continuation ? "continue" : supported && !omitInitially ? "member" : undefined);
      expect(batch.answerToInteraction?.value).toEqual(supported && !omitInitially ? answerToInteraction.value : undefined);
      expect(batch.lifecycleActions ?? []).toEqual([]);
      expect(plan.cancelledAgendaItemIds ?? []).toEqual([]);
      expect(plan.cancelledObjectiveIds ?? []).toEqual([]);
    }
    expect(snapshot).toEqual(before);
    if (structured) expect(requests.some(r => (r.input as { proposedOption?: unknown }).proposedOption !== undefined)).toBe(false);
    if (!supported && !omitInitially) expect(requests.some(r => (r.input as { proposedOption?: unknown }).proposedOption !== undefined)).toBe(true);
    if (compound) expect(requests.some(r => (r.input as { reviewKind?: string }).reviewKind === "choice_intention_independence")).toBe(true);
    if (initiallyEmpty) {
      expect(requests[1]?.task).toBe("interaction-answer.review");
      expect(requests[1]?.input).toMatchObject({ proposedOption: { value: answerToInteraction.value } });
      expect(requests.filter(request => request.task === "turn.interpret.repair")).toHaveLength(1);
    }
  });
});
