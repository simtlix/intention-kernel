import assert from "node:assert/strict";
import {
  agentId,
  createKernel,
  getKernelPromptDefinitions,
  renderModelPrompt,
  defineAgent,
  interactionId,
  threadId,
  turnId,
  type ModelGateway,
  type ModelRequest,
  type ModelResult,
  type Interaction,
  type ModelPromptResolver,
} from "intention-kernel";
import { createMemoryDurability, createEventCollector, createAgentEvaluationAdapter, evaluateAssertions, EvaluationError, parseEvaluationSuite, parseEvaluationReport, runEvaluation } from "intention-kernel/testing";
import { searchProducts } from "./readme/search-products.js";
import { evaluateScenarios } from "./readme/evaluation.js";

const prompts = getKernelPromptDefinitions();
if (prompts.length !== 24 || !Object.isFrozen(prompts)) throw new Error("Packed prompt catalog is incomplete");
const promptResolver: ModelPromptResolver = { resolve: reference => ({ template: reference.definition.template, revision: "consumer-pinned" }) };
for (const prompt of prompts) {
  if (renderModelPrompt(prompt, {}) !== prompt.template) throw new Error("Packed default prompt changed");
}

const contextualInput: Interaction = { id: interactionId("collect-type"), kind: "input",
  goal: "Which type?", requestedFacts: [], responseMode: "contextual" };
if (contextualInput.responseMode !== "contextual") throw new Error("Contextual interaction contract missing");

const scriptedValues: Readonly<Record<string, unknown>> = {
  "capability.select": {
    mode: "selected",
    capabilityIds: ["product.search"],
    rationale: "The user requested a catalog search.",
    evidence: [{ text: "family option", meaning: "catalog search", messageIndex: 0 }],
  },
  "turn.interpret": {
    intentions: [{
      id: "request.1",
      objective: "Search for a family product",
      evidence: [{ text: "family option", meaning: "family product", messageIndex: 0 }],
      references: [],
      proposedCapability: "product.search",
      input: { query: "family" },
      resolution: "resolved",
    }],
    contradictions: [],
  },
  "response.compose": {
    parts: [
      { text: "Family One is available for 25,000 USD", evidenceIds: ["catalog-search-result"] },
      { text: ".", evidenceIds: [] },
    ],
  },
  "response.grounding-review": { verdict: "supported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: [0] },
};

const modelGateway: ModelGateway = {
  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    if (request.prompt === undefined || request.system !== renderModelPrompt(request.prompt.definition, request.prompt.values)) throw new Error("Packed request lacks exact identified instructions");
    const value = scriptedValues[request.task];
    if (value === undefined) throw new Error(`Missing scripted value for ${request.task}`);
    return Promise.resolve({
      value: value as T,
      provider: "packed-consumer",
      model: request.model ?? "scripted",
      durationMs: 1,
    });
  },
};

const collector = createEventCollector();
const agent = await createKernel({
  modelGateway,
  promptResolver,
  durability: createMemoryDurability(),
  eventSink: collector,
  ports: { catalog: { search: () => Promise.resolve({ products: [{ id: "family-one", name: "Family One", price: 25_000 }] }) } },
}).compile(defineAgent({
  id: agentId("consumer.agent"),
  version: 1,
  identity: "A concise product advisor",
  capabilities: [searchProducts],
  policies: [],
  modelPolicy: {},
}));

const result = await agent.run({
  threadId: threadId("packed-consumer-thread"),
  turnId: turnId("packed-consumer-turn"),
  input: { text: "Show me a family option" },
});

if (!result.response.grounded || result.response.status !== "completed") {
  throw new Error("Packed consumer did not complete a grounded turn");
}
if (result.checkpoint.facts[0]?.type !== "product.candidates") {
  throw new Error("Packed consumer did not persist the capability fact");
}
const evaluation = await runEvaluation({
  suite: parseEvaluationSuite({ schemaVersion: 1, id: "consumer", name: "Installed-package evaluation", scenarios: [{
    id: "search", name: "Catalog search", writePolicy: "read_only", steps: [{ id: "one", input: { text: "Show me a family option" }, assertions: [{
      id: "grounded", kind: "check", path: ["response", "grounded"], operator: "equals", value: true,
    }] }],
  }] }),
  target: { id: agent.id, fingerprint: agent.fingerprint },
  adapter: createAgentEvaluationAdapter({ agent }),
});
if (parseEvaluationReport(evaluation).summary.passed !== 1) throw new Error("Installed evaluation framework failed");
const readmeEvaluation = await evaluateScenarios(agent, evaluation.suite);
assert.equal(readmeEvaluation.summary.passed, 1, "The README evaluation example must execute from the installed package");
assert.ok(collector.events.some(event => event.type === "capability.completed"), "The public collector must capture the README capability execution");
const assertions = await evaluateAssertions([
  { id: "grounded", kind: "check", path: ["grounded"], operator: "equals", value: true },
  { id: "wrong-expectation", kind: "check", path: ["grounded"], operator: "equals", value: false },
], { observation: { grounded: result.response.grounded }, history: [] });
assert.deepEqual(assertions.map(check => check.passed), [true, false]);
assert.throws(() => parseEvaluationSuite({}), EvaluationError);
assert.throws(() => parseEvaluationReport({}), EvaluationError);
