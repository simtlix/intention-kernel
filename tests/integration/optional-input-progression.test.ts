import { describe, expect, it } from "vitest";
import { agentId, capabilityId, createKernel, defineAgent, defineCapability, defineSchema,
  factType, interactionId, threadId, turnId, type ModelGateway, type ModelRequest, type ModelResult,
  type KernelCheckpoint } from "../../src/index.js";
import { createMemoryDurability } from "../../src/testing/index.js";
import { waitsForOperationInput, withOptionalInput } from "../../src/reducer/agendaInputState.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "optional-input-regression",
  validate: value => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });
const ref = (type: string) => ({ type: factType(type), version: 1 });
const complete = (types: string[] = []) => ({ status: "completed" as const, output: {}, evidence: [], artifacts: [],
  facts: types.map(type => ({ ...ref(type), value: true, evidenceIds: [], dependsOn: [] })) });

describe("displaced optional input", () => {
  it("does not infer non-blocking authority for legacy, protected or confirmation input", () => {
    const item = { id: "pending", status: "waiting_input", missingFacts: [], dependencies: [],
      intention: { id: "request", objective: "Pending request", resolution: "resolved", evidence: [], references: [] }
    } as KernelCheckpoint["agenda"][number];
    const interaction = { id: interactionId("pending"), kind: "input" as const, mode: "optional" as const,
      requestedFacts: [], goal: "Question" };
    expect(waitsForOperationInput(item)).toBe(true);
    expect(waitsForOperationInput(withOptionalInput(item, { ...interaction, kind: "confirmation" }))).toBe(true);
    expect(waitsForOperationInput(withOptionalInput(item, { ...interaction, protectedCanonicalMessage: "Protected question" }))).toBe(true);
  });
  for (const mode of ["optional", "required"] as const) {
    it(`preserves unfinished ${mode} input with its blocking semantics across turns`, async () => {
      const resumed: unknown[] = [];
      const help = defineCapability({ id: capabilityId("help.browse"), version: 1, description: "Browse help",
        input: schema, output: schema, requires: [], provides: [ref("help.answer")], effect: "read",
        execute: context => {
          if (context.turn.currentMessage.content === "resume help") {
            resumed.push(context.turn.continuation);
            return Promise.resolve(complete(["help.answer"]));
          }
          return Promise.resolve({ status: "needs_input", partialInput: { topic: "general", page: 1 },
            interaction: { id: interactionId("help-topic"), capabilityId: capabilityId("help.browse"),
              kind: "choice", mode, requestedFacts: [], goal: "Which topic?",
              options: [{ id: "general", label: "General", value: "general" }] } });
        } });
      const search = defineCapability({ id: capabilityId("product.search"), version: 1, description: "Find products",
        input: schema, output: schema, requires: [], provides: [], effect: "read",
        execute: () => Promise.resolve({ ...complete(), interaction: { id: interactionId("products"),
          capabilityId: capabilityId("product.search"), kind: "choice", requestedFacts: [], goal: "Which product?",
          options: [{ id: "first", label: "First product", value: "first", targetCapabilityId: capabilityId("product.select") }] } }) });
      const select = defineCapability({ id: capabilityId("product.select"), version: 1, description: "Select a product",
        input: schema, output: schema, requires: [], provides: [ref("product.selected")], effect: "read",
        execute: () => Promise.resolve(complete(["product.selected"])) });
      const detail = defineCapability({ id: capabilityId("product.details"), version: 1, description: "Read product details",
        input: schema, output: schema, requires: [{ ...ref("product.selected"), description: "Selected product" }],
        provides: [], effect: "read", automation: { version: 1, createInput: () => ({}) },
        execute: () => Promise.resolve(complete()) });
      const gateway: ModelGateway = { invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
        const payload = request.input as { reviewKind?: string; currentMessage?: { content?: string; index?: number };
          context?: { currentMessage?: { content?: string; index?: number } }; response?: { claims: unknown[] } };
        const current = payload.context?.currentMessage ?? payload.currentMessage;
        const message = current?.content ?? "";
        const id = message === "help" || message === "resume help" ? "help.browse"
          : message === "find products" ? "product.search" : "product.select";
        const evidence = [{ text: message, meaning: "Current explicit request", messageIndex: current?.index ?? 0 }];
        let value: unknown;
        if (request.task === "capability.select") value = { mode: "selected", capabilityIds: [id], rationale: "Explicit request", evidence };
        else if (request.task === "turn.interpret") value = { intentions: [{ objective: message, evidence, references: [],
          proposedCapability: id, input: {}, resolution: "resolved" }], contradictions: [],
          ...(id === "product.select" ? { answerToInteraction: { interactionId: "products", value: "first", evidence: message } } : {}) };
        else if (request.task.startsWith("response.compose")) value = { parts: [{ text: "Here is the result.", evidenceIds: [] }] };
        else if (request.task === "response.grounding-review") value = { verdict: "supported", continuityVerdict: "supported",
          decisionVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: payload.response?.claims.map((_, i) => i) ?? [] };
        else if (payload.reviewKind === "omitted_progression_answer") value = {
          continuation: "not_requested", evidence: "", rationale: "Returning to help does not accept product continuation." };
        else if (request.task.endsWith("review")) value = { verdict: "supported", rationale: "Explicit independent request" };
        else throw new Error(`Unexpected task: ${request.task}`);
        return Promise.resolve({ value: value as T, provider: "scripted", model: "offline", durationMs: 1 });
      } };
      const durability = createMemoryDurability();
      const agent = await createKernel({ modelGateway: gateway, durability }).compile(defineAgent({
        id: agentId("optional.input"), version: 1, identity: "Test agent", capabilities: [help, search, select, detail],
        policies: [], modelPolicy: {}, progression: { groups: [{ id: "product.explore", label: "Product",
          prompt: "Details or continue?", continueLabel: "Continue", repeatAfterMember: true,
          members: [{ capabilityId: detail.id, label: "Details", examples: ["details"] }] }], rules: [{
          id: "product.explore", version: 1, mode: "required", priority: 100,
          target: { groupId: "product.explore" }, activateWhen: [ref("product.selected")] }] } }));
      const key = threadId(`optional-input-${mode}`);
      for (const [index, text] of ["help", "find products"].entries()) {
        await agent.run({ threadId: key, turnId: turnId(`turn-${String(index)}`), input: { text } });
      }
      const result = await agent.run({ threadId: key, turnId: turnId("select"), input: { text: "select product" },
        selection: { interactionId: interactionId("products"), optionId: "first" } });
      expect(result.checkpoint.interaction?.goal).toBe(mode === "optional" ? "Details or continue?" : undefined);
      const pending = result.checkpoint.agenda.find(item => item.intention.proposedCapability === help.id);
      expect(pending?.status).toBe("waiting_input");
      expect(pending?.continuation).toEqual({ topic: "general", page: 1 });
      expect(result.checkpoint.facts.map(fact => fact.type)).toEqual(["product.selected"]);
      expect(result.checkpoint.effects).toEqual([]);
      // Exercise persisted lineage, not an in-memory-only marker.
      await durability.withTurn({ threadId: key, turnId: turnId("persist") }, scope => scope.commit({ value: null,
        checkpoint: { ...JSON.parse(JSON.stringify(result.checkpoint)) as KernelCheckpoint, revision: result.checkpoint.revision + 1 } }));
      const continued = await agent.run({ threadId: key, turnId: turnId("resume"), input: { text: "resume help" } });
      expect(resumed).toEqual([{ topic: "general", page: 1 }]);
      expect(continued.checkpoint.facts.map(fact => fact.type)).toEqual(["product.selected", "help.answer"]);
    });
  }
});
