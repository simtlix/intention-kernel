import { describe, expect, it } from "vitest";

import {
  agentId,
  capabilityId,
  createKernel,
  defineAgent,
  defineCapability,
  defineSchema,
  evidenceId,
  factType,
  threadId,
  turnId,
  type CapabilityDefinition,
  KernelConfigurationError,
  type ModelGateway,
  type ModelRequest,
  type ModelResult,
} from "../../src/index.js";
import { createEventCollector, createMemoryDurability } from "../../src/testing/index.js";
import { createAgentEvaluationAdapter, parseEvaluationSuite, runEvaluation } from "../../src/testing/index.js";

const objectSchema = defineSchema<Record<string, unknown>>({
  vendor: "runtime-test",
  validate: (value) =>
    typeof value === "object" && value !== null
      ? { value: value as Record<string, unknown> }
      : { issues: [{ message: "Expected object" }] },
  jsonSchema: () => ({ type: "object" }),
});

class TaskGateway implements ModelGateway {
  readonly requests: ModelRequest<unknown>[] = [];
  readonly #responses: Map<string, unknown[]>;

  constructor(responses: Readonly<Record<string, readonly unknown[]>>) {
    this.#responses = new Map(Object.entries(responses).map(([task, values]) => [task, [...values]]));
  }

  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.requests.push(request);
    const values = this.#responses.get(request.task);
    if (values === undefined || values.length === 0) throw new Error(`No response for ${request.task}`);
    return Promise.resolve({
      value: values.shift() as T,
      provider: "scripted",
      model: request.model ?? "scripted-model",
      usage: { inputTokens: 10, outputTokens: 5 },
      durationMs: 1,
    });
  }
}

function searchCapability(): CapabilityDefinition<Record<string, unknown>, Record<string, unknown>> {
  return defineCapability({
    id: capabilityId("product.search"),
    version: 1,
    description: "Search products by user needs",
    input: objectSchema,
    output: objectSchema,
    requires: [],
    provides: [{ type: factType("product.candidates"), version: 1 }],
    effect: "read",
    async execute(context, input) {
      await context.events.emit("catalog.query.completed", { matches: 1 });
      return {
        status: "completed",
        output: { query: input, products: [{ id: "p-1", name: "Family One", price: 25_000 }] },
        facts: [{
          type: factType("product.candidates"),
          version: 1,
          value: [{ id: "p-1", name: "Family One", price: 25_000 }],
          evidenceIds: [evidenceId("search-evidence")],
          dependsOn: [],
        }],
        evidence: [{ id: evidenceId("search-evidence"), source: "external", content: "Family One costs 25000 USD." }],
        artifacts: [{ id: "product-list", kind: "product-list", data: [{ id: "p-1" }] }],
      };
    },
  });
}

function selectCapability(observed: unknown[]): CapabilityDefinition<Record<string, unknown>, Record<string, unknown>> {
  return defineCapability({
    id: capabilityId("product.select"),
    version: 1,
    description: "Select one current product candidate",
    input: objectSchema,
    output: objectSchema,
    requires: [{ type: factType("product.candidates"), version: 1, description: "Current candidates" }],
    provides: [{ type: factType("product.selected"), version: 1 }],
    effect: "read",
    execute: (context) => {
      observed.push(context.facts.find((fact) => fact.type === "product.candidates")?.value);
      return Promise.resolve({
        status: "completed",
        output: { selected: "p-1" },
        facts: [{
          type: factType("product.selected"),
          version: 1,
          value: { id: "p-1", name: "Family One" },
          evidenceIds: [evidenceId("selection-evidence")],
          dependsOn: [{ type: factType("product.candidates"), version: 1 }],
        }],
        evidence: [{ id: evidenceId("selection-evidence"), source: "capability", content: "Selected Family One from current candidates." }],
        artifacts: [],
      });
    },
  });
}

function definition(observed: unknown[] = []) {
  return defineAgent({
    id: agentId("runtime.agent"),
    version: 1,
    identity: "A natural product advisor",
    capabilities: [searchCapability(), selectCapability(observed)],
    policies: [],
    modelPolicy: {
      "turn.interpret": "interpret-model",
      "response.compose": "compose-model",
      "response.grounding-review": "review-model",
    },
  });
}

function resolved(id: string, operation: string, input: unknown) {
  return {
    id,
    objective: operation,
    evidence: [{ text: operation, meaning: operation, messageIndex: 0 }],
    references: [],
    proposedCapability: operation,
    input,
    resolution: "resolved",
  };
}

function selected(...capabilityIds: string[]) {
  return {
    mode: "selected",
    capabilityIds,
    rationale: "The current request maps to the selected capabilities.",
    evidence: [{ text: "current request", meaning: "routing evidence", messageIndex: 0 }],
  };
}

function kernel(gateway: ModelGateway) {
  const events = createEventCollector();
  let sequence = 0;
  return {
    events,
    value: createKernel({
      modelGateway: gateway,
      durability: createMemoryDurability({ now: () => "2026-09-03T10:00:00.000Z" }),
      eventSink: events,
      clock: { now: () => "2026-09-03T10:00:00.000Z" },
      idGenerator: { next: (kind) => `${kind}-${String(++sequence)}` },
      ports: {},
    }),
  };
}

const supported = { verdict: "supported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: [] };
const draft = (...parts: readonly (readonly [text: string, evidenceIds: readonly string[]])[]) => ({
  parts: parts.map(([text, evidenceIds]) => ({ text, evidenceIds })),
});

describe("compiled LangGraph agent", () => {
  it("commits canonical result copy, replays it, and gives the next acknowledgement no invented interaction", async () => {
    const message = "Family One costs 25000 USD.";
    const gateway = new TaskGateway({
      "capability.select": [selected("product.search"), {
        mode: "conversational", capabilityIds: [], rationale: "The current message only acknowledges the result.",
        evidence: [{ text: "Bueno", meaning: "Acknowledgement", messageIndex: 2 }],
      }],
      "turn.interpret": [{ intentions: [resolved("request.1", "product.search", {})], contradictions: [] }],
      "response.compose": [draft(["Perfecto.", []])],
      "response.grounding-review": [supported],
    });
    const search = searchCapability();
    let executions = 0;
    const runtime = kernel(gateway);
    const agent = await runtime.value.compile(defineAgent({
      id: agentId("canonical.agent"), version: 1, identity: "Product assistant", policies: [], modelPolicy: {},
      capabilities: [defineCapability({
        ...search,
        async execute(context, input) {
          executions += 1;
          const result = await search.execute(context, input);
          if (result.status !== "completed") throw new Error("Expected fixture completion");
          return { ...result, canonicalResponse: {
            message, claims: [{ text: message, evidenceIds: [evidenceId("search-evidence")] }], required: true,
          } };
        },
      })],
    }));
    const request = { threadId: threadId("canonical-thread"), turnId: turnId("canonical-turn"), input: { text: "Find products" } };
    const result = await agent.run(request);
    expect(result.response).toMatchObject({ source: "canonical", grounded: true, message });
    expect(result.checkpoint.messages.at(-1)?.content).toBe(message);
    expect(result.checkpoint.interaction).toBeUndefined();
    expect(gateway.requests.map(({ task }) => task)).toEqual(["capability.select", "turn.interpret"]);
    const replayed = await agent.run(request);
    expect(replayed.replayed).toBe(true);
    expect(replayed.checkpoint).toEqual(result.checkpoint);
    expect(executions).toBe(1);
    const next = await agent.run({ threadId: request.threadId, turnId: turnId("acknowledgement-turn"), input: { text: "Bueno" } });
    expect(next.response).toMatchObject({ source: "model", grounded: true, message: "Perfecto." });
    expect(next.checkpoint.facts).toEqual(result.checkpoint.facts);
    expect(next.checkpoint.interaction).toBeUndefined();
    expect(next.checkpoint.agenda).toEqual(result.checkpoint.agenda);
    expect(executions).toBe(1);
  });

  it("delivers and replays protected confirmation text without model composition", async () => {
    const gateway = new TaskGateway({
      "capability.select": [selected("profile.review")],
      "turn.interpret": [{ intentions: [resolved("request.1", "profile.review", {})], contradictions: [] }],
    });
    const runtime = kernel(gateway);
    const agent = await runtime.value.compile(defineAgent({
      id: agentId("protected.agent"), version: 1, identity: "Profile assistant", policies: [], modelPolicy: {},
      capabilities: [defineCapability({
        id: capabilityId("profile.review"), version: 1, description: "Review profile details",
        input: objectSchema, output: objectSchema, requires: [], provides: [], effect: "read",
        execute: () => Promise.resolve({
          status: "needs_confirmation" as const,
          proposedInput: {}, continuation: {}, modelRedactions: ["Ana Pérez", "ana@example.com"],
          interaction: {
            id: "profile-confirm" as never, kind: "confirmation" as const,
            capabilityId: capabilityId("profile.review"), requestedFacts: [], goal: "Confirm profile details",
            protectedCanonicalMessage: "Ana Pérez · ana@example.com. Confirm?",
          },
        }),
      })],
    }));
    const input = { threadId: threadId("protected-thread"), turnId: turnId("protected-turn"), input: { text: "Review my details" } };
    const result = await agent.run(input);
    const replayed = await agent.run(input);
    expect(result.response.message).toBe("Ana Pérez · ana@example.com. Confirm?");
    expect(result.checkpoint.messages.at(-1)?.content).toBe(result.response.message);
    expect(replayed.response.message).toBe(result.response.message);
    expect(replayed.replayed).toBe(true);
    expect(gateway.requests.map(({ task }) => task)).toEqual(["capability.select", "turn.interpret"]);
    expect(JSON.stringify(gateway.requests)).not.toContain("ana@example.com");
  });
  it("rejects an invalid kernel configuration before compiling an agent", () => {
    expect(() => createKernel({
      modelGateway: {} as ModelGateway,
      durability: createMemoryDurability(),
    })).toThrow(KernelConfigurationError);

    try {
      createKernel({
        modelGateway: { invoke: () => Promise.reject(new Error("unused")) },
        durability: createMemoryDurability(),
        limits: { maxSteps: 0 },
      });
      throw new Error("Expected createKernel to reject maxSteps=0");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_KERNEL_LIMIT" });
    }
  });

  it("runs one complete grounded turn and commits its conversation", async () => {
    const gateway = new TaskGateway({
      "capability.select": [selected("product.search")],
      "turn.interpret": [{ intentions: [resolved("request.1", "product.search", { query: "family" })], contradictions: [] }],
      "response.compose": [draft(
        ["Encontré ", []],
        ["Family One a 25.000 USD", ["search-evidence"]],
        [". ¿Querés verlo?", []],
      )],
      "response.grounding-review": [{ ...supported, approvedClaimIndexes: [0] }],
    });
    const runtime = kernel(gateway);
    const agent = await runtime.value.compile(definition());

    const result = await agent.run({
      threadId: threadId("thread-1"),
      turnId: turnId("turn-1"),
      input: { text: "Busco algo para mi familia" },
    });

    expect(result.response).toMatchObject({ status: "completed", grounded: true, source: "model" });
    expect(result.checkpoint.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.checkpoint.facts[0]?.type).toBe("product.candidates");
    expect(result.replayed).toBe(false);
    expect(gateway.requests.map((request) => request.model)).toEqual([
      "interpret-model",
      "interpret-model",
      "compose-model",
      "review-model",
    ]);
    expect(runtime.events.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "turn.started",
      "context.built",
      "model.invoked",
      "capabilities.selected",
      "intention.interpreted",
      "plan.created",
      "step.started",
      "capability.event",
      "capability.completed",
      "facts.reduced",
      "response.composed",
      "state.committed",
      "turn.completed",
    ]));
    const capabilityEvent = runtime.events.events.find((event) => event.type === "capability.event");
    const invokedEvent = runtime.events.events.find((event) => event.type === "capability.invoked" && event.stepId === capabilityEvent?.stepId);
    expect(capabilityEvent).toMatchObject({
      causationId: invokedEvent?.id,
      data: { capabilityId: "product.search", name: "catalog.query.completed", data: { matches: 1 } },
    });
    const modelRequestEvent = runtime.events.events.find((event) => event.type === "model.invoked");
    const modelResultEvent = runtime.events.events.find((event) => event.type === "model.completed");
    expect(modelRequestEvent).toMatchObject({ data: {
      task: "capability.select",
      audit: { context: { currentMessage: { content: "Busco algo para mi familia", index: 0 } } },
    } });
    expect(modelResultEvent).toMatchObject({
      causationId: modelRequestEvent?.id,
      data: { proposal: selected("product.search") },
    });
  });

  it("evaluates a compiled agent through the public testing adapter with correlated events", async () => {
    const gateway = new TaskGateway({
      "capability.select": [selected("product.search")],
      "turn.interpret": [{ intentions: [resolved("request.1", "product.search", { query: "family" })], contradictions: [] }],
      "response.compose": [draft(["Family One a 25.000 USD", ["search-evidence"]])],
      "response.grounding-review": [{ ...supported, approvedClaimIndexes: [0] }],
    });
    const runtime = kernel(gateway);
    const agent = await runtime.value.compile(definition());
    const report = await runEvaluation({
      suite: parseEvaluationSuite({ schemaVersion: 1, id: "compiled", name: "Compiled", scenarios: [{
        id: "search", name: "Search", writePolicy: "read_only", steps: [{ id: "request", input: { text: "Busco algo para mi familia" }, assertions: [
          { id: "grounded", kind: "check", path: ["response", "grounded"], operator: "equals", value: true },
          { id: "facts", kind: "check", path: ["checkpoint", "facts"], operator: "contains", value: { type: "product.candidates" } },
          { id: "events", kind: "check", path: ["events"], operator: "contains", value: { type: "capability.completed" } },
        ] }],
      }] }),
      target: { id: agent.id, fingerprint: agent.fingerprint },
      adapter: createAgentEvaluationAdapter({ agent, events: () => runtime.events.events }),
    });
    expect(report.summary).toMatchObject({ passed: 1, failed: 0, error: 0 });
    expect(report.cases[0]?.turns[0]?.observation?.["events"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "turn.completed", threadId: report.cases[0]?.threadId }),
    ]));
  });

  it("executes dependent intentions in one turn with newly produced facts", async () => {
    const observed: unknown[] = [];
    const gateway = new TaskGateway({
      "capability.select": [selected("product.search", "product.select")],
      "turn.interpret": [{
        intentions: [
          resolved("request.1", "product.search", { query: "family" }),
          resolved("request.2", "product.select", { position: 1 }),
        ],
        contradictions: [],
      }],
      "response.compose": [draft(
        ["Encontré ", []],
        ["y seleccioné Family One", ["selection-evidence"]],
        [" a 25.000 USD", ["search-evidence"]],
        [".", []],
      )],
      "response.grounding-review": [{ ...supported, approvedClaimIndexes: [0, 1] }],
    });
    const runtime = kernel(gateway);
    const agent = await runtime.value.compile(definition(observed));

    const result = await agent.run({
      threadId: threadId("thread-2"),
      turnId: turnId("turn-1"),
      input: { text: "Buscá una opción familiar y elegí la primera" },
    });

    expect(observed).toEqual([[{ id: "p-1", name: "Family One", price: 25_000 }]]);
    expect(result.checkpoint.facts.map((fact) => fact.type)).toEqual(["product.candidates", "product.selected"]);
  });

  it("clarifies across turns and deduplicates a replayed turn ID", async () => {
    const gateway = new TaskGateway({
      "capability.select": [
        selected("product.search", "product.select"),
        selected("product.search"),
      ],
      "turn.interpret": [
        {
          intentions: [{
            id: "request.1",
            objective: "Interpret other options",
            evidence: [{ text: "other options", meaning: "ambiguous scope", messageIndex: 0 }],
            references: [],
            resolution: "ambiguous",
            alternatives: ["continue current search", "start a new search"],
          }],
          contradictions: [],
        },
        {
          intentions: [resolved("request.1", "product.search", { query: "electric" })],
          contradictions: [],
        },
      ],
      "response.compose": [
        draft(["¿Querés seguir la búsqueda actual o iniciar una nueva?", []]),
        draft(
          ["Inicié una nueva búsqueda y encontré ", []],
          ["Family One a 25.000 USD", ["search-evidence"]],
          [".", []],
        ),
      ],
      "response.grounding-review": [supported, { ...supported, approvedClaimIndexes: [0] }],
    });
    const runtime = kernel(gateway);
    const agent = await runtime.value.compile(definition());
    const first = await agent.run({
      threadId: threadId("thread-3"),
      turnId: turnId("turn-1"),
      input: { text: "Mostrame otras opciones" },
    });
    expect(first.response.interaction?.kind).toBe("clarification");
    const interactionId = first.response.interaction?.id;
    expect(interactionId).toBeDefined();

    const second = await agent.run({
      threadId: threadId("thread-3"),
      turnId: turnId("turn-2"),
      input: { text: "Una búsqueda nueva" },
    });
    expect(second.response.interaction).toBeUndefined();
    expect(second.checkpoint.agenda).toEqual([]);
    const callsAfterSecondTurn = gateway.requests.length;

    const replay = await agent.run({
      threadId: threadId("thread-3"),
      turnId: turnId("turn-2"),
      input: { text: "This changed payload must not execute" },
    });
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(second.response);
    expect(gateway.requests).toHaveLength(callsAfterSecondTurn);
  });

  it("resumes opaque capability state with prior conversation and host context", async () => {
    const observations: unknown[] = [];
    const stateful = defineCapability({
      id: capabilityId("workflow.collect"),
      version: 1,
      description: "Collect a workflow choice across turns",
      input: objectSchema,
      output: objectSchema,
      requires: [],
      provides: [{ type: factType("workflow.completed"), version: 1 }],
      effect: "read",
      execute: (context, input) => {
        observations.push({ turn: context.turn, input });
        if (context.turn.continuation === undefined) {
          return Promise.resolve({
            status: "completed" as const,
            output: { phase: "options_ready" },
            facts: [{
              type: factType("workflow.completed"),
              version: 1,
              value: { phase: "options_ready" },
              evidenceIds: [evidenceId("workflow-options-evidence")],
              dependsOn: [],
            }],
            evidence: [{ id: evidenceId("workflow-options-evidence"), source: "capability" as const, content: "Workflow options are ready." }],
            artifacts: [{ id: "workflow-options", kind: "options", data: ["standard"] }],
            interaction: {
              id: "workflow-choice" as never,
              kind: "choice" as const,
              capabilityId: capabilityId("workflow.collect"),
              requestedFacts: [],
              goal: "Choose one workflow option",
              options: [{ id: "standard", label: "Standard", value: { mode: "standard" } }],
            },
            continuation: { phase: "waiting_for_mode" },
          });
        }
        return Promise.resolve({
          status: "completed" as const,
          output: { mode: "standard" },
          facts: [{
            type: factType("workflow.completed"),
            version: 1,
            value: { mode: "standard" },
            evidenceIds: [evidenceId("workflow-evidence")],
            dependsOn: [],
          }],
          evidence: [{ id: evidenceId("workflow-evidence"), source: "capability" as const, content: "Standard workflow selected." }],
          artifacts: [],
        });
      },
    });
    const gateway = new TaskGateway({
      "capability.select": [selected("workflow.collect"), selected("workflow.collect")],
      "turn.interpret": [
        { intentions: [resolved("request.1", "workflow.collect", { request: "start" })], contradictions: [] },
        {
          intentions: [resolved("request.2", "workflow.collect", { request: "standard" })],
          contradictions: [],
        },
      ],
      "response.compose": [
        draft(["Which workflow option do you prefer?", []]),
        draft(["Standard workflow selected", ["workflow-evidence"]], [".", []]),
      ],
      "response.grounding-review": [
        supported,
        { ...supported, approvedClaimIndexes: [0] },
      ],
    });
    const runtime = kernel(gateway);
    const agent = await runtime.value.compile(defineAgent({
      id: agentId("stateful.agent"),
      version: 1,
      identity: "A stateful workflow agent",
      capabilities: [stateful],
      policies: [],
      modelPolicy: {},
    }));

    const first = await agent.run({
      threadId: threadId("stateful-thread"),
      turnId: turnId("turn-1"),
      input: { text: "Start" },
      hostContext: { tenant: "tenant-a" },
    });
    expect(first.checkpoint.agenda[0]?.continuation).toEqual({ phase: "waiting_for_mode" });

    const second = await agent.run({
      threadId: threadId("stateful-thread"),
      turnId: turnId("turn-2"),
      input: { text: "Standard" },
      selection: { interactionId: "workflow-choice" as never, optionId: "standard" },
      hostContext: { tenant: "tenant-a" },
    });

    expect(second.checkpoint.facts.map((fact) => fact.type)).toContain("workflow.completed");
    expect(second.checkpoint.agenda).toEqual([]);
    expect(second.response.interaction).toBeUndefined();
    expect(observations[1]).toMatchObject({
      turn: {
        continuation: { phase: "waiting_for_mode" },
        hostContext: { tenant: "tenant-a" },
        interactionAnswer: { interactionId: "workflow-choice", value: { mode: "standard" } },
        previousMessages: [
          { role: "user", content: "Start" },
          { role: "assistant", content: "Which workflow option do you prefer?" },
        ],
      },
    });
  });
});
