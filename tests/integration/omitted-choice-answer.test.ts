import { describe, expect, it } from "vitest";
import { agentId, capabilityId, defineAgent, defineCapability, defineSchema } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { interpretTurn } from "../../src/interpreter/interpretTurn.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });

describe("omitted answers to an ordinary owned choice", () => {
  it.each([
    { message: "Si", optionId: "include" },
    { message: "No quiero incluirlo", optionId: "exclude" },
    { message: "Quiero ver más opciones", optionId: "more" },
    { message: "Busco otros productos nuevos", optionId: null },
    { message: "Todavía no lo sé", optionId: null },
    { message: "Sí, quiero cambiar la búsqueda", optionId: null },
    { message: "Si (invalid review)", optionId: "invented", invalid: true },
  ])("preserves the current request: $message", async ({ message, optionId, invalid }) => {
    const compiled = await compileAgentDefinition(defineAgent({ id: agentId("owned.choice"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
      capabilities: [defineCapability({ id: capabilityId("product.manage"), version: 1, description: "Manage chosen products or refine a product search", input: schema, output: schema,
        requires: [], provides: [], effect: "read", execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
      })],
    }));
    const options = [
      { id: "include", label: "Include the product", value: { decision: "include" }, targetCapabilityId: capabilityId("product.manage") },
      { id: "exclude", label: "Do not include the product", value: { decision: "exclude" }, targetCapabilityId: capabilityId("product.manage") },
      { id: "more", label: "More options", value: { type: "action", action: "more_options", targetIntent: "product.manage" }, targetCapabilityId: capabilityId("product.manage") },
    ];
    const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: message, at: "2026-09-06T10:00:00Z" }, checkpoint: {
      schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, facts: [], agenda: [], effects: [], messages: [],
      interaction: { id: "include-product" as never, kind: "choice", capabilityId: capabilityId("product.manage"), goal: "Do you want to include this product?", requestedFacts: [], options },
    } });
    const intentions = [{ objective: "Manage products", references: [], evidence: [{ text: message, meaning: "Current request", messageIndex: 0 }], proposedCapability: "product.manage", input: {}, resolution: "resolved" }];
    const requests: ModelRequest<unknown>[] = [];
    const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
      requests.push(request);
      const value = request.task === "turn.interpret" ? { intentions, contradictions: [] }
        : request.task === "turn.interpret.repair" ? { intentions, contradictions: [], ...(!invalid ? { answerToInteraction: { interactionId: "include-product", value: optionId, evidence: message } } : {}) }
          : (request.input as { reviewKind?: string }).reviewKind === "omitted_choice_answer"
            ? { verdict: optionId === null ? "unsupported" : "supported", optionId, rationale: optionId === null ? "The current message refines the search or remains undecided; it does not select an option." : "The current message directly answers the exact active choice or requests its offered navigation control." }
            : { decision: "selected", optionId, rationale: "Exact current option is supported by the complete message." };
      return Promise.resolve({ value: value as T, provider: "scripted", model: "test", durationMs: 1 });
    } };
    const pending = interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1000), selection: { mode: "selected", capabilityIds: [capabilityId("product.manage")], rationale: "Current request", evidence: [] } });
    if (invalid) { await expect(pending).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" }); return; }
    const result = await pending;
    expect(result.intentions.map((intention) => intention.proposedCapability)).toEqual(["product.manage"]);
    expect(result.answerToInteraction?.value).toEqual(options.find((option) => option.id === optionId)?.value);
    expect(requests.filter((request) => request.task === "turn.interpret.repair")).toHaveLength(optionId === null ? 0 : 1);
  });
});
