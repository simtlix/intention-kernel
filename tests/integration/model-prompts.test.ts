import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentId, capabilityId, interactionId, createKernel, defineAgent, defineCapability, defineSchema, threadId, turnId, type ModelGateway, type ModelRequest, type ModelResult, type ModelPromptResolver } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { reviewActiveInteractionDiversion } from "../../src/interpreter/reviewCapabilitySelection.js";
import { createEventCollector, createMemoryDurability } from "../../src/testing/index.js";

async function fixture(promptResolver?: ModelPromptResolver, invalidSelection = false) {
  const requests: ModelRequest<unknown>[] = [];
  const events = createEventCollector();
  const gateway: ModelGateway = { invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    requests.push(request);
    const values: Record<string, unknown> = {
      "capability.select": { mode: "conversational", capabilityIds: [], rationale: "Greeting", evidence: [{ text: "Hello", meaning: "Greeting", messageIndex: 0 }] },
      "turn.interpret": { intentions: [], contradictions: [] },
      "response.compose": { parts: [{ text: "Hello!", evidenceIds: [] }] },
      "response.grounding-review": { verdict: "supported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: [] },
    };
    return Promise.resolve({ value: (invalidSelection && request.task.startsWith("capability.select") ? { unexpected: true } : values[request.task]) as T, provider: "fixture", model: "fixture", durationMs: 1 });
  } };
  const agent = await createKernel({ modelGateway: gateway, durability: createMemoryDurability(), eventSink: events,
    ...(promptResolver === undefined ? {} : { promptResolver }),
  }).compile(defineAgent({ id: agentId("prompt-test"), version: 1, identity: "Assistant", capabilities: [], policies: [], modelPolicy: {} }));
  return { requests, events, run: () => agent.run({ threadId: threadId("prompt-thread"), turnId: turnId("prompt-turn"), input: { text: "Hello" } }) };
}

describe("resolved model invocation", () => {
  it("identifies the mixed selection review separately from its shared task", async () => {
    const schema = defineSchema<unknown>({ vendor: "fixture", validate: value => ({ value }), jsonSchema: () => ({}) });
    const active = capabilityId("active.operation");
    const extra = capabilityId("extra.operation");
    const compiled = await compileAgentDefinition(defineAgent({ id: agentId("mixed-prompt"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
      capabilities: [active, extra].map(id => defineCapability({ id, version: 1, description: id, input: schema, output: schema, requires: [], provides: [], effect: "read",
        execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
      })),
    }));
    const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: "Choose the first and perform the extra operation", at: "2026-09-09T00:00:00Z" }, checkpoint: {
      schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, facts: [], effects: [], messages: [], agenda: [],
      interaction: { id: interactionId("active-choice"), kind: "choice", capabilityId: active, goal: "Choose", requestedFacts: [], options: [{ id: "one", label: "One", value: 1, targetCapabilityId: active }] },
    } });
    const requests: ModelRequest<unknown>[] = [];
    const gateway: ModelGateway = { invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
      requests.push(request);
      return Promise.resolve({ value: { verdict: "supported", rationale: "Both requests are explicit." } as T, provider: "fixture", model: "fixture", durationMs: 1 });
    } };
    await reviewActiveInteractionDiversion({ snapshot, selection: { mode: "selected", capabilityIds: [active, extra], rationale: "Compound request", evidence: [{ text: snapshot.currentMessage.content, meaning: "Both operations", messageIndex: 0 }] }, gateway, signal: AbortSignal.timeout(1000) });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt?.definition.id).toBe("kernel.review-capability-selection.mixed");
    expect(requests[0]?.system).toBe(requests[0]?.prompt?.definition.template);
  });
  it("sends and observes the same replacement before invoking the provider", async () => {
    const customInstructions = "Follow the existing schema. Answer concisely.";
    const runtime = await fixture({ resolve: () => ({ template: customInstructions, revision: "revision-2" }) });
    const result = await runtime.run();
    expect(result.response.status).toBe("completed");
    expect(runtime.requests.length).toBeGreaterThan(0);
    const invoked = runtime.events.events.filter(event => event.type === "model.invoked");
    expect(invoked).toHaveLength(runtime.requests.length);
    for (const [index, request] of runtime.requests.entries()) {
      expect(request.system).toBe(customInstructions);
      expect(request.prompt?.definition.id).toBeTruthy();
      expect(invoked[index]).toMatchObject({ data: { audit: { prompt: {
        id: request.prompt?.definition.id, revision: "revision-2", instructions: request.system,
        templateHash: createHash("sha256").update(customInstructions).digest("hex"),
        instructionHash: createHash("sha256").update(request.system).digest("hex"),
      } } } });
    }
  });
  it("keeps defaults byte-identical without a resolver", async () => {
    const runtime = await fixture();
    await runtime.run();
    expect(runtime.requests.length).toBeGreaterThan(0);
    for (const request of runtime.requests) expect(request.system).toBe(request.prompt?.definition.template);
  });
  it("still enforces output schemas after replacing instructions", async () => {
    const runtime = await fixture({ resolve: () => ({ template: "Use the supplied schema.", revision: "r2" }) }, true);
    await expect(runtime.run()).rejects.toMatchObject({ code: "CAPABILITY_SELECTION_INVALID" });
    expect(runtime.requests.map(request => request.task)).toEqual(["capability.select", "capability.select.repair"]);
  });
  it("does not switch revisions or repair when a later composition resolver fails", async () => {
    const runtime = await fixture({ resolve: reference => {
      if (reference.definition.id === "kernel.response.compose") throw new Error("private resolver failure");
      return { template: reference.definition.template, revision: "r2" };
    } });
    const result = await runtime.run();
    expect(result.response.status).not.toBe("completed");
    expect(runtime.requests.some(request => request.task.startsWith("response."))).toBe(false);
    expect(JSON.stringify(runtime.events.events)).not.toContain("private resolver failure");
  });
  it.each([() => { throw new Error("private resolver failure"); }, () => ({ template: "{{undeclared}}", revision: "r2" })])("fails before invocation and observation without fallback", async resolve => {
    const runtime = await fixture({ resolve });
    await runtime.run().catch(() => undefined);
    expect(runtime.requests).toHaveLength(0);
    expect(runtime.events.events.filter(event => event.type === "model.invoked")).toHaveLength(0);
    expect(JSON.stringify(runtime.events.events)).not.toContain("private resolver failure");
  });
});
