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
  vendor: "dynamic-dependency-test",
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
    return Promise.resolve({ value: values.shift() as T, provider: "scripted", model: "scripted", durationMs: 1 });
  }
}

describe("dynamic capability dependencies", () => {
  it("executes the declared provider and resumes the consumer without asking the user", async () => {
    let consumerExecutions = 0;
    const collectProfile = defineCapability({
      id: capabilityId("profile.collect"),
      version: 1,
      description: "Collect a profile needed by the purchase",
      input: objectSchema,
      output: objectSchema,
      requires: [],
      provides: [{ type: factType("profile.confirmed"), version: 1 }],
      effect: "read",
      automation: { version: 1, createInput: ({ currentMessage }) => ({ request: currentMessage.content }) },
      execute: () => Promise.resolve({
        status: "completed" as const,
        output: { name: "Ada" },
        facts: [{
          type: factType("profile.confirmed"),
          version: 1,
          value: { name: "Ada" },
          evidenceIds: [evidenceId("profile-confirmed")],
          dependsOn: [],
        }],
        evidence: [{ id: evidenceId("profile-confirmed"), source: "capability" as const, content: "Profile confirmed." }],
        artifacts: [],
      }),
    });
    const createPurchase = defineCapability({
      id: capabilityId("purchase.create"),
      version: 1,
      description: "Create a purchase",
      input: objectSchema,
      output: objectSchema,
      requires: [],
      provides: [{ type: factType("purchase.created"), version: 1 }],
      effect: "read",
      automation: { version: 1, createInput: ({ currentMessage }) => ({ request: currentMessage.content }) },
      execute: (context) => {
        consumerExecutions += 1;
        const profile = context.facts.find((fact) => fact.type === "profile.confirmed");
        if (profile === undefined) {
          return Promise.resolve({
            status: "needs_dependency" as const,
            requirement: { type: factType("profile.confirmed"), version: 1, description: "Confirmed profile" },
            provider: { capabilityId: capabilityId("profile.collect"), input: { request: context.turn.currentMessage.content } },
            continuation: { phase: "waiting-profile" },
          });
        }
        return Promise.resolve({
          status: "completed" as const,
          output: { created: true },
          facts: [{
            type: factType("purchase.created"), version: 1, value: { created: true },
            evidenceIds: [evidenceId("purchase-created")],
            dependsOn: [{ type: factType("profile.confirmed"), version: 1 }],
          }],
          evidence: [{ id: evidenceId("purchase-created"), source: "capability" as const, content: "Purchase created." }],
          artifacts: [],
        });
      },
    });
    const gateway = new ScriptedGateway({
      "capability.select": [{
        mode: "selected", capabilityIds: ["purchase.create"], rationale: "Create the purchase.",
        evidence: [{ text: "create it", meaning: "create purchase", messageIndex: 0 }],
      }],
      "turn.interpret": [{
        intentions: [{
          id: "purchase-request", objective: "Create the purchase",
          evidence: [{ text: "create it", meaning: "create purchase", messageIndex: 0 }],
          references: [], proposedCapability: "purchase.create", input: { request: "create it" }, resolution: "resolved",
        }],
        contradictions: [],
      }],
      "response.compose": [{ parts: [{ text: "Purchase created.", evidenceIds: ["purchase-created"] }] }],
      "response.grounding-review": [{ verdict: "supported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: [0] }],
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
      id: agentId("dependency.agent"), version: 1, identity: "A purchase assistant",
      capabilities: [collectProfile, createPurchase], policies: [], modelPolicy: {},
    }));

    const result = await agent.run({
      threadId: threadId("dependency-thread"), turnId: turnId("dependency-turn"), input: { text: "create it" },
    });

    expect(result.checkpoint.facts.map((fact) => fact.type)).toEqual(expect.arrayContaining([
      "profile.confirmed", "purchase.created",
    ]));
    expect(result.checkpoint.agenda).toEqual([]);
    expect(result.response.interaction).toBeUndefined();
    expect(consumerExecutions).toBe(2);
    expect(events.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "dependency.capability.activated", "dependency.consumer.resumed",
    ]));
  });
});
