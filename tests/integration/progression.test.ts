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
  type ModelGateway,
  type ModelRequest,
  type ModelResult,
} from "../../src/index.js";
import { createEventCollector, createMemoryDurability } from "../../src/testing/index.js";

const objectSchema = defineSchema<Record<string, unknown>>({
  vendor: "progression-test",
  validate: (value) => typeof value === "object" && value !== null
    ? { value: value as Record<string, unknown> }
    : { issues: [{ message: "Expected object" }] },
  jsonSchema: () => ({ type: "object" }),
});

class ScriptedGateway implements ModelGateway {
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
      model: "scripted",
      durationMs: 1,
    });
  }
}

const selected = {
  mode: "selected",
  capabilityIds: ["product.select"],
  rationale: "The user selected a product.",
  evidence: [{ text: "the first one", meaning: "select the first product", messageIndex: 0 }],
};

const interpreted = {
  intentions: [{
    id: "request.select",
    objective: "Select the first product",
    evidence: [{ text: "the first one", meaning: "select the first product", messageIndex: 0 }],
    references: [],
    proposedCapability: "product.select",
    input: { position: 1 },
    resolution: "resolved",
  }],
  contradictions: [],
};

const responseDraft = {
  parts: [{ text: "Selected. What would you like to review?", evidenceIds: [] }],
};

describe("declarative progression", () => {
  it("does not activate a pending target again after explicit work completed it", async () => {
    const started = factType("flow.started");
    const begin = defineCapability({
      id: capabilityId("flow.begin"), version: 1, description: "Begin", input: objectSchema,
      output: objectSchema, requires: [], provides: [{ type: started, version: 1 }], effect: "read",
      execute: () => Promise.resolve({ status: "completed", output: {}, artifacts: [],
        facts: [{ type: started, version: 1, value: true, evidenceIds: [evidenceId("started")], dependsOn: [] }],
        evidence: [{ id: evidenceId("started"), source: "capability", content: "Started." }],
      }),
    });
    let executions = 0;
    const finish = defineCapability({
      id: capabilityId("flow.finish"), version: 1, description: "Finish", input: objectSchema,
      output: objectSchema, requires: [{ type: started, version: 1, description: "Started" }], provides: [], effect: "read",
      automation: { version: 1, createInput: () => ({}) },
      execute: () => {
        executions += 1;
        return Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] });
      },
    });
    const gateway = new ScriptedGateway({
      "capability.select": [{ ...selected, capabilityIds: ["flow.begin", "flow.finish"] }],
      "turn.interpret": [{ intentions: [begin, finish].map((capability, index) => ({
        id: `intention-${String(index)}`, objective: capability.description,
        evidence: [{ text: "Begin and finish", meaning: "Explicit compound request", messageIndex: 0 }],
        references: [], proposedCapability: capability.id, input: {}, resolution: "resolved",
      })), contradictions: [] }],
      "response.compose": [responseDraft],
      "response.grounding-review": [{ verdict: "supported", decisionVerdict: "supported", continuityVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: [] }],
    });
    const agent = await createKernel({ modelGateway: gateway, durability: createMemoryDurability() }).compile(defineAgent({
      id: agentId("direct.progression"), version: 1, identity: "Flow agent", capabilities: [begin, finish],
      policies: [], modelPolicy: {}, progression: { groups: [], rules: [{
        id: "finish.after-start", version: 1, target: { capabilityId: finish.id },
        mode: "required", priority: 100, activateWhen: [{ type: started, version: 1 }],
      }] },
    }));
    const result = await agent.run({ threadId: threadId("direct-progression"), turnId: turnId("direct-turn"), input: { text: "Begin and finish" } });
    expect(executions).toBe(1);
    expect(result.checkpoint.progression?.occurrences).toEqual([
      expect.objectContaining({ ruleId: "finish.after-start", status: "satisfied" }),
    ]);
  });

  it("attempts a failing automatic progression capability only once per turn", async () => {
    const begin = defineCapability({
      id: capabilityId("flow.begin"),
      version: 1,
      description: "Begin the flow",
      input: objectSchema,
      output: objectSchema,
      requires: [],
      provides: [{ type: factType("flow.started"), version: 1 }],
      effect: "read",
      execute: () => Promise.resolve({
        status: "completed" as const,
        output: { started: true },
        facts: [{
          type: factType("flow.started"),
          version: 1,
          value: { started: true },
          evidenceIds: [evidenceId("flow-started")],
          dependsOn: [],
        }],
        evidence: [{
          id: evidenceId("flow-started"),
          source: "capability" as const,
          content: "The flow started.",
        }],
        artifacts: [],
      }),
    });
    let attempts = 0;
    const triggers: string[] = [];
    const next = defineCapability({
      id: capabilityId("flow.next"),
      version: 1,
      description: "Continue the flow",
      input: objectSchema,
      output: objectSchema,
      requires: [{ type: factType("flow.started"), version: 1, description: "Started flow" }],
      provides: [],
      effect: "read",
      automation: {
        version: 1,
        createInput: ({ currentMessage }) => ({ request: currentMessage.content }),
      },
      execute: (context) => {
        attempts += 1;
        triggers.push(context.execution.trigger);
        return Promise.resolve({
          status: "failed" as const,
          issue: { code: "FLOW_NEXT_FAILED", message: "Could not continue.", retryable: false },
        });
      },
    });
    const gateway = new ScriptedGateway({
      "capability.select": [{
        mode: "selected",
        capabilityIds: ["flow.begin"],
        rationale: "Start the flow.",
        evidence: [{ text: "start", meaning: "start the flow", messageIndex: 0 }],
      }],
      "turn.interpret": [{
        intentions: [{
          id: "request.begin",
          objective: "Begin",
          evidence: [{ text: "start", meaning: "start the flow", messageIndex: 0 }],
          references: [],
          proposedCapability: "flow.begin",
          input: {},
          resolution: "resolved",
        }],
        contradictions: [],
      }],
      "response.compose": [{
        parts: [{ text: "I could not continue the next step.", evidenceIds: [] }],
      }],
      "response.grounding-review": [{
        verdict: "supported",
        continuityVerdict: "supported",
        decisionVerdict: "supported",
        unsupportedClaims: [],
        approvedClaimIndexes: [],
      }],
    });
    const events = createEventCollector();
    const kernel = createKernel({
      modelGateway: gateway,
      durability: createMemoryDurability({ now: () => "2026-09-03T10:00:00.000Z" }),
      eventSink: events,
      clock: { now: () => "2026-09-03T10:00:00.000Z" },
      idGenerator: { next: (kind) => `${kind}-failure` },
    });
    const agent = await kernel.compile(defineAgent({
      id: agentId("progression.failure.agent"),
      version: 1,
      identity: "A flow agent",
      capabilities: [begin, next],
      policies: [],
      modelPolicy: {},
      progression: {
        groups: [],
        rules: [{
          id: "flow.next.after-start",
          version: 1,
          target: { capabilityId: capabilityId("flow.next") },
          mode: "required",
          priority: 100,
          activateWhen: [{ type: factType("flow.started"), version: 1 }],
        }],
      },
    }));

    const result = await agent.run({
      threadId: threadId("progression-failure-thread"),
      turnId: turnId("turn-failure"),
      input: { text: "start" },
    });

    expect(attempts).toBe(1);
    expect(triggers).toEqual(["progression"]);
    expect(events.events.filter((event) => event.type === "progression.capability.activated")).toHaveLength(1);
    expect(result.checkpoint.progression?.occurrences).toEqual([
      expect.objectContaining({ ruleId: "flow.next.after-start", status: "active", activeMember: "flow.next" }),
    ]);
  });

  it("opens a required capability group when its activation fact is published", async () => {
    const selectProduct = defineCapability({
      id: capabilityId("product.select"),
      version: 1,
      description: "Select one product",
      input: objectSchema,
      output: objectSchema,
      requires: [],
      provides: [{ type: factType("product.selected"), version: 1 }],
      effect: "read",
      execute: () => Promise.resolve({
        status: "completed" as const,
        output: { id: "product-1" },
        facts: [{
          type: factType("product.selected"),
          version: 1,
          value: { id: "product-1" },
          evidenceIds: [evidenceId("product-selected")],
          dependsOn: [],
        }],
        evidence: [{
          id: evidenceId("product-selected"),
          source: "capability" as const,
          content: "Product 1 was selected.",
        }],
        artifacts: [],
      }),
    });
    const inspectProduct = defineCapability({
      id: capabilityId("product.inspect"),
      version: 1,
      description: "Inspect the selected product",
      input: objectSchema,
      output: objectSchema,
      requires: [{ type: factType("product.selected"), version: 1, description: "Selected product" }],
      provides: [{ type: factType("product.inspected"), version: 1 }],
      effect: "read",
      automation: {
        version: 1,
        createInput: ({ currentMessage }) => ({ request: currentMessage.content }),
      },
      execute: () => Promise.resolve({
        status: "completed" as const,
        output: { inspected: true },
        facts: [{
          type: factType("product.inspected"),
          version: 1,
          value: { inspected: true },
          evidenceIds: [evidenceId("product-inspected")],
          dependsOn: [{ type: factType("product.selected"), version: 1 }],
        }],
        evidence: [{
          id: evidenceId("product-inspected"),
          source: "capability" as const,
          content: "Product 1 details were inspected.",
        }],
        artifacts: [],
      }),
    });
    const choosePayment = defineCapability({
      id: capabilityId("payment.choose"),
      version: 1,
      description: "Choose how to pay for the selected product",
      input: objectSchema,
      output: objectSchema,
      requires: [{ type: factType("product.selected"), version: 1, description: "Selected product" }],
      provides: [{ type: factType("payment.selected"), version: 1 }],
      effect: "read",
      automation: {
        version: 1,
        createInput: ({ currentMessage }) => ({ request: currentMessage.content }),
      },
      execute: () => Promise.resolve({
        status: "needs_input" as const,
        interaction: {
          id: "payment-choice" as never,
          kind: "choice" as const,
          capabilityId: capabilityId("payment.choose"),
          requestedFacts: [],
          goal: "Cash or financing?",
          options: [
            { id: "cash", label: "Cash", value: { method: "cash" } },
            { id: "financing", label: "Financing", value: { method: "financing" } },
          ],
        },
        partialInput: { phase: "payment" },
      }),
    });
    const gateway = new ScriptedGateway({
      "capability.select": [selected],
      "turn.interpret": [interpreted],
      "response.compose": [responseDraft, {
        parts: [{ text: "Details ready. Would you like anything else?", evidenceIds: [] }],
      }, {
        parts: [{ text: "Cash or financing?", evidenceIds: [] }],
      }],
      "response.grounding-review": [{
        verdict: "supported",
        continuityVerdict: "supported",
        decisionVerdict: "supported",
        unsupportedClaims: [],
        approvedClaimIndexes: [],
      }, {
        verdict: "supported",
        continuityVerdict: "supported",
        decisionVerdict: "supported",
        unsupportedClaims: [],
        approvedClaimIndexes: [],
      }, {
        verdict: "supported",
        continuityVerdict: "supported",
        decisionVerdict: "supported",
        unsupportedClaims: [],
        approvedClaimIndexes: [],
      }],
    });
    const events = createEventCollector();
    let sequence = 0;
    const kernel = createKernel({
      modelGateway: gateway,
      durability: createMemoryDurability({ now: () => "2026-09-03T10:00:00.000Z" }),
      eventSink: events,
      clock: { now: () => "2026-09-03T10:00:00.000Z" },
      idGenerator: { next: (kind) => `${kind}-${String(++sequence)}` },
    });
    const agent = await kernel.compile(defineAgent({
      id: agentId("progression.agent"),
      version: 1,
      identity: "A product advisor",
      capabilities: [selectProduct, inspectProduct, choosePayment],
      policies: [],
      modelPolicy: {},
      progression: {
        objective: {
          id: "purchase.complete",
          activation: "conversation_start",
          completionFact: { type: factType("payment.selected"), version: 1 },
        },
        groups: [{
          id: "product.explore",
          label: "Explore product",
          prompt: "What would you like to review?",
          repeatPrompt: "Would you like to review anything else?",
          continueLabel: "Continue",
          continueExamples: ["continue"],
          repeatAfterMember: true,
          completedMemberVisibility: "hide",
          members: [{
            capabilityId: capabilityId("product.inspect"),
            label: "View details",
            examples: ["show details"],
          }],
        }],
        rules: [{
          id: "product.explore.after-selection",
          version: 1,
          target: { groupId: "product.explore" },
          mode: "required",
          priority: 100,
          activateWhen: [{ type: factType("product.selected"), version: 1 }],
        }, {
          id: "payment.after-exploration",
          version: 1,
          target: { capabilityId: capabilityId("payment.choose") },
          mode: "required",
          priority: 200,
          activateWhen: [{ type: factType("product.selected"), version: 1 }],
        }],
      },
    }));

    const result = await agent.run({
      threadId: threadId("progression-thread"),
      turnId: turnId("turn-1"),
      input: { text: "the first one" },
    });

    expect(result.checkpoint.progression?.objective).toEqual({
      id: "purchase.complete",
      status: "active",
    });
    expect(result.response.interaction).toMatchObject({
      kind: "choice",
      goal: "What would you like to review?",
      options: [
        { label: "View details", value: { kind: "progression.member", capabilityId: "product.inspect" } },
        { label: "Continue", value: { kind: "progression.continue" } },
      ],
    });
    expect(result.checkpoint.progression?.occurrences).toHaveLength(2);
    expect(events.events.map((event) => event.type)).toContain("progression.interaction.requested");

    const interaction = result.response.interaction;
    const details = interaction?.options?.find((option) => option.label === "View details");
    expect(interaction).toBeDefined();
    expect(details).toBeDefined();
    if (interaction === undefined || details === undefined) throw new Error("Expected progression detail choice.");
    const second = await agent.run({
      threadId: threadId("progression-thread"),
      turnId: turnId("turn-2"),
      input: { text: "View details" },
      selection: {
        interactionId: interaction.id,
        optionId: details.id,
      },
    });

    expect(second.checkpoint.facts.map((fact) => fact.type)).toContain("product.inspected");
    expect(second.response.interaction).toMatchObject({
      kind: "choice",
      goal: "Would you like to review anything else?",
      options: [{ label: "Continue", value: { kind: "progression.continue" } }],
    });
    expect(gateway.requests.filter((request) =>
      request.task === "capability.select" || request.task === "turn.interpret",
    )).toHaveLength(2);

    const continueOption = second.response.interaction?.options?.find((option) => option.label === "Continue");
    expect(continueOption).toBeDefined();
    if (second.response.interaction === undefined || continueOption === undefined) {
      throw new Error("Expected progression continue choice.");
    }
    const third = await agent.run({
      threadId: threadId("progression-thread"),
      turnId: turnId("turn-3"),
      input: { text: "Continue" },
      selection: {
        interactionId: second.response.interaction.id,
        optionId: continueOption.id,
      },
    });

    expect(third.response.interaction).toMatchObject({
      kind: "choice",
      capabilityId: "payment.choose",
      goal: "Cash or financing?",
    });
    expect(third.checkpoint.agenda[0]).toMatchObject({
      status: "waiting_input",
      intention: { proposedCapability: "payment.choose" },
    });
    expect(third.checkpoint.progression?.occurrences).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "product.explore.after-selection", status: "satisfied" }),
      expect.objectContaining({ ruleId: "payment.after-exploration", status: "active", activeMember: "payment.choose" }),
    ]));
  });
});
