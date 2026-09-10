import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  agentId,
  buildContextSnapshot,
  capabilityId,
  compileAgentDefinition,
  createCapabilitySelectionSchema,
  defineAgent,
  defineCapability,
  defineModelGuidancePolicy,
  defineSchema,
  factType,
  policyId,
  interpretTurn,
  selectCapabilities,
  type CapabilityDefinition,
  type KernelCheckpoint,
  type ModelGateway,
  type ModelRequest,
  type ModelResult,
} from "../../src/internal.js";

const objectSchema = defineSchema<Record<string, unknown>>({
  vendor: "interpretation-test",
  validate: (value) =>
    typeof value === "object" && value !== null
      ? { value: value as Record<string, unknown> }
      : { issues: [{ message: "Expected object" }] },
  jsonSchema: () => ({ type: "object", additionalProperties: true }),
});

function capability(
  id: string,
  options: Pick<CapabilityDefinition<Record<string, unknown>, Record<string, unknown>>, "referenceRequirements"> = {},
): CapabilityDefinition<Record<string, unknown>, Record<string, unknown>> {
  return defineCapability({
    id: capabilityId(id),
    version: 1,
    description: `Perform ${id}`,
    input: objectSchema,
    output: objectSchema,
    requires: [],
    provides: [],
    effect: "read",
    guidance: {
      whenToUse: [`The user explicitly requests ${id}`],
      whenNotToUse: ["A different operation is requested"],
      examples: [`Please ${id}`],
    },
    ...(options.referenceRequirements === undefined
      ? {}
      : { referenceRequirements: options.referenceRequirements }),
    execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
  });
}

async function compiledAgent() {
  return compileAgentDefinition(
    defineAgent({
      id: agentId("test.agent"),
      version: 1,
      identity: "A helpful test agent",
      capabilities: [capability("product.search"), capability("product.compare"), capability("support.answer")],
      policies: [],
      modelPolicy: { "turn.interpret": "test-model" },
    }),
  );
}

function checkpoint(overrides: Partial<KernelCheckpoint> = {}): KernelCheckpoint {
  return {
    schemaVersion: 1,
    revision: 3,
    agentFingerprint: "test",
    messages: [
      { role: "user", content: "I need a family car", at: "2026-09-03T10:00:00.000Z" },
      { role: "assistant", content: "Which size do you prefer?", at: "2026-09-03T10:00:01.000Z" },
      { role: "user", content: "Something spacious", at: "2026-09-03T10:00:02.000Z" },
    ],
    facts: [],
    agenda: [],
    effects: [],
    ...overrides,
  };
}

class ScriptedGateway implements ModelGateway {
  readonly requests: ModelRequest<unknown>[] = [];
  readonly #values: unknown[];

  constructor(...values: unknown[]) {
    this.#values = values;
  }

  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.requests.push(request);
    const value = this.#values.shift();
    return Promise.resolve({
      value: value as T,
      provider: "scripted",
      model: "test-model",
      durationMs: 1,
    });
  }
}

const oneSearch = {
  intentions: [
    {
      id: "request.1",
      objective: "Find an electric SUV",
      evidence: [{ text: "electric SUV", meaning: "vehicle filters", messageIndex: 3 }],
      references: [],
      proposedCapability: "product.search",
      input: { bodyStyle: "SUV", fuel: "electric" },
      resolution: "resolved",
    },
  ],
  contradictions: [],
};

function selected(...capabilityIds: string[]) {
  return {
    mode: "selected",
    capabilityIds,
    rationale: "The visible request maps to the selected capability contracts.",
    evidence: [{ text: "visible request", meaning: "capability routing evidence", messageIndex: 3 }],
  };
}

const conversational = {
  mode: "conversational",
  capabilityIds: [],
  rationale: "The message is purely conversational.",
  evidence: [{ text: "Hello there", meaning: "social greeting", messageIndex: 3 }],
};

const noMatch = {
  mode: "no_match",
  capabilityIds: [],
  rationale: "No compiled capability represents the operational request.",
  evidence: [{ text: "book a flight", meaning: "unsupported operation", messageIndex: 3 }],
};

const control = {
  mode: "control",
  capabilityIds: [],
  rationale: "The user explicitly cancels one pending objective.",
  evidence: [{ text: "cancel that objective", meaning: "explicit cancellation", messageIndex: 3 }],
};

function selectedWithControl(...capabilityIds: string[]) {
  return {
    mode: "selected_with_control" as const,
    capabilityIds,
    rationale: "The message independently requests an operation and cancellation of tracked work.",
    evidence: [{ text: "cancel that, then search", meaning: "combined lifecycle and capability request", messageIndex: 3 }],
  };
}

function lifecycleReviewed(verdict: "supported" | "unsupported", rationale = "The visible request is explicit.") {
  return { reviews: [{ actionIndex: 0, verdict, rationale }] };
}

function lifecycleSelectionReviewed(
  verdict: "supported" | "unsupported",
  rationale = "The visible request is explicit.",
) {
  return { verdict, rationale };
}

function capabilitySelectionReviewed(
  verdict: "supported" | "unsupported",
  rationale = "The current message was reviewed against the canonical conversation boundary.",
) {
  return { verdict, rationale };
}

function interactionAnswerReviewed(
  verdict: "supported" | "unsupported",
  rationale = "The current wording explicitly answers the active confirmation.",
) {
  return { verdict, rationale };
}

describe("canonical model context", () => {
  it("supplies host-selected contextual guidance to both capability selection and interpretation", async () => {
    const compiled = await compileAgentDefinition(defineAgent({
      id: agentId("test.agent"),
      version: 1,
      identity: "A helpful test agent",
      capabilities: [capability("product.search"), capability("product.compare")],
      policies: [],
      modelGuidancePolicies: [
        defineModelGuidancePolicy({
          id: policyId("product.replace-selection"),
          version: 2,
          description: "Interpret requests for alternatives in the current product context.",
          instructions: ["Treat a rejected selected product as a request to revisit product search."],
          examples: [{ input: "Show me other products", expectedBehavior: "Select product.search." }],
          counterExamples: [{ input: "Compare these two", expectedBehavior: "Select product.compare." }],
          select: (context) => ({
            selected: context.presentFactTypes.includes(factType("product.selected")),
            matchedSelectors: context.presentFactTypes.includes(factType("product.selected"))
              ? ["presentFactTypes"]
              : [],
          }),
        }),
        defineModelGuidancePolicy({
          id: policyId("product.unrelated"),
          version: 1,
          description: "Guidance that must remain hidden in this turn.",
          instructions: ["Do not project this policy without its prerequisite."],
          examples: [],
          counterExamples: [],
          select: () => ({ selected: false, matchedSelectors: [] }),
        }),
      ],
      modelPolicy: { "turn.interpret": "test-model" },
    }));
    const gateway = new ScriptedGateway(selected("product.search"), oneSearch);
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({
        facts: [{
          type: factType("product.selected"),
          version: 1,
          value: { id: "product-1" },
          evidenceIds: [],
          evidence: [],
          dependsOn: [],
          producedBy: {
            capabilityId: capabilityId("product.search"),
            capabilityVersion: 1,
            turnId: "turn-previous" as never,
            stepId: "step-previous" as never,
          },
        }],
      }),
      currentMessage: { role: "user", content: "Show electric SUVs", at: "2026-09-03T10:01:00.000Z" },
      compiled,
    });

    await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(snapshot.selectedModelGuidancePolicies).toEqual([
      expect.objectContaining({
        id: "product.replace-selection",
        version: 2,
        matchedSelectors: ["presentFactTypes"],
      }),
    ]);
    const selectorInput = gateway.requests[0]?.input as { selectedModelGuidancePolicies?: unknown };
    const interpreterInput = gateway.requests[1]?.input as {
      context?: { selectedModelGuidancePolicies?: unknown };
    };
    expect(selectorInput.selectedModelGuidancePolicies).toEqual(snapshot.selectedModelGuidancePolicies);
    expect(interpreterInput.context?.selectedModelGuidancePolicies).toEqual(snapshot.selectedModelGuidancePolicies);
  });

  it("repairs a requested capability that omitted its declarative progression continuation", async () => {
    const compiled = await compileAgentDefinition(defineAgent({
      id: agentId("test.agent"),
      version: 1,
      identity: "A helpful test agent",
      capabilities: [capability("product.search")],
      policies: [],
      modelGuidancePolicies: [defineModelGuidancePolicy({
        id: policyId("product.leaves-current-exploration"),
        version: 1,
        description: "A new product search exits the current optional exploration menu.",
        instructions: ["Preserve the search and answer the active progression continuation."],
        examples: [],
        counterExamples: [],
        continueProgressionForCapabilities: [capabilityId("product.search")],
        select: () => ({ selected: true, matchedSelectors: ["activeExploration"] }),
      })],
      modelPolicy: { "turn.interpret": "test-model" },
    }));
    const interaction = {
      id: "progression:product.explore" as never,
      kind: "choice" as const,
      mode: "optional" as const,
      requestedFacts: [],
      goal: "Choose a product action or continue",
      options: [{
        id: "progression:product.explore:continue",
        label: "Continue",
        value: { kind: "progression.continue", occurrenceId: "product.explore" },
      }],
      payload: { kind: "progression.group", occurrenceId: "product.explore" },
    };
    const repaired = {
      ...oneSearch,
      answerToInteraction: {
        interactionId: interaction.id,
        value: { kind: "progression.continue", occurrenceId: "product.explore" },
        evidence: "show other products",
      },
    };
    const gateway = new ScriptedGateway(oneSearch, repaired, {
      verdict: "supported", rationale: "The user explicitly requests other products; the transition policy only supplies the exit consequence.",
    });
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction }),
      currentMessage: {
        role: "user",
        content: "Show other products",
        at: "2026-09-03T10:01:00.000Z",
      },
      compiled,
    });

    const result = await interpretTurn({
      snapshot,
      gateway,
      selection: selected("product.search"),
      signal: AbortSignal.timeout(1_000),
    });

    expect(result.answerToInteraction).toEqual({
      interactionId: interaction.id,
      value: { kind: "progression.continue", occurrenceId: "product.explore" },
      evidence: "show other products",
    });
    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "turn.interpret",
      "turn.interpret.repair",
      "interaction-answer.review",
    ]);
    const repairInput = gateway.requests[1]?.input as { validationIssues?: Array<{ message: string }> };
    expect(repairInput.validationIssues?.[0]?.message).toContain(
      "progression:product.explore:continue",
    );
  });

  it("reviews progression evidence, repairing implied consent while allowing an independent explicit continuation", async () => {
    const compiled = await compileAgentDefinition(defineAgent({
      id: agentId("test.agent"),
      version: 1,
      identity: "A helpful test agent",
      capabilities: [capability("product.details")],
      policies: [],
      modelPolicy: { "turn.interpret": "test-model" },
    }));
    const interaction = {
      id: "progression:product.explore" as never,
      kind: "choice" as const,
      mode: "optional" as const,
      requestedFacts: [],
      goal: "Choose a product action or continue",
      options: [{
        id: "progression:product.explore:continue",
        label: "Continue",
        value: { kind: "progression.continue", occurrenceId: "product.explore" },
      }],
      payload: { kind: "progression.group", occurrenceId: "product.explore" },
    };
    const invalid = {
      intentions: [{
        ...oneSearch.intentions[0],
        id: "details-request",
        objective: "Show product details",
        proposedCapability: "product.details",
        input: { request: "show me more information" },
      }],
      contradictions: [],
      answerToInteraction: {
        interactionId: interaction.id,
        value: { kind: "progression.continue", occurrenceId: "product.explore" },
        evidence: "show me more information",
      },
    };
    const repaired = {
      intentions: invalid.intentions,
      contradictions: [],
    };
    const gateway = new ScriptedGateway(invalid, {
      verdict: "unsupported",
      rationale: "The user asks only for product information and does not request progression.",
    }, repaired);
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction }),
      currentMessage: {
        role: "user",
        content: "Show me more information about this product",
        at: "2026-09-03T10:01:00.000Z",
      },
      compiled,
    });

    const result = await interpretTurn({
      snapshot,
      gateway,
      selection: selected("product.details"),
      signal: AbortSignal.timeout(1_000),
    });

    expect(result.intentions[0]?.proposedCapability).toBe("product.details");
    expect(result.answerToInteraction).toBeUndefined();
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "turn.interpret",
      "interaction-answer.review",
      "turn.interpret.repair",
    ]);
    const repairInput = gateway.requests[2]?.input as { validationIssues?: Array<{ message: string }> };
    expect(repairInput.validationIssues?.[0]?.message).toContain("does not request progression");

    const explicitMessage = "Show me the details and then continue to the next step";
    const explicit = {
      ...invalid,
      answerToInteraction: {
        ...invalid.answerToInteraction,
        evidence: "then continue to the next step",
        rationale: "The user independently requested both product details and progression.",
      },
    };
    const explicitGateway = new ScriptedGateway(explicit, {
      verdict: "supported",
      rationale: "Then continue explicitly requests progression alongside the details request.",
    }, {
      verdict: "supported",
      rationale: "Show me the details independently requests product details in addition to continuation.",
    });
    const explicitResult = await interpretTurn({
      snapshot: { ...snapshot, currentMessage: { ...snapshot.currentMessage, content: explicitMessage } },
      gateway: explicitGateway,
      selection: selected("product.details"),
      signal: AbortSignal.timeout(1_000),
    });
    expect(explicitResult.intentions[0]?.proposedCapability).toBe("product.details");
    expect(explicitResult.answerToInteraction?.rationale).toBe(explicit.answerToInteraction.rationale);
    expect(explicitGateway.requests.map((request) => request.task)).toEqual([
      "turn.interpret", "interaction-answer.review", "interaction-answer.review",
    ]);
  });

  it("projects current input, bounded history, state lineage and explicit omissions", async () => {
    const compiled = await compiledAgent();
    const state = checkpoint({
      facts: [
        {
          type: factType("product.selected"),
          version: 1,
          value: { id: "p-1" },
          evidenceIds: [],
          evidence: [],
          dependsOn: [{ type: factType("product.candidates"), version: 1 }],
          producedBy: {
            capabilityId: capabilityId("product.search"),
            capabilityVersion: 1,
            turnId: "turn-previous" as never,
            stepId: "step-previous" as never,
          },
        },
      ],
    });

    const snapshot = buildContextSnapshot({
      checkpoint: state,
      currentMessage: { role: "user", content: "Show electric SUVs", at: "2026-09-03T10:01:00.000Z" },
      compiled,
      summary: "The customer needs a spacious family vehicle.",
      recentMessageLimit: 2,
    });

    expect(snapshot.currentMessage.content).toBe("Show electric SUVs");
    expect(snapshot.conversation.recentMessages.map((message) => message.content)).toEqual([
      "Which size do you prefer?",
      "Something spacious",
    ]);
    expect(snapshot.conversation.summary).toContain("family vehicle");
    expect(snapshot.facts[0]?.dependsOn[0]?.type).toBe("product.candidates");
    expect(snapshot.capabilities.map((entry) => entry.id)).toEqual([
      "product.compare",
      "product.search",
      "support.answer",
    ]);
    expect(snapshot.omissions).toEqual([
      expect.objectContaining({ path: "conversation.messages", omitted: 1 }),
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("projects protected facts without exposing hidden or presence-only values", async () => {
    const compiled = await compiledAgent();
    const factBase = {
      evidenceIds: ["evidence-protected" as never],
      evidence: [{ id: "evidence-protected" as never, source: "user" as const, content: "private value" }],
      dependsOn: [],
      producedBy: {
        capabilityId: capabilityId("product.search"),
        capabilityVersion: 1,
        turnId: "turn-previous" as never,
        stepId: "step-previous" as never,
      },
    };
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({
        facts: [
          { ...factBase, type: factType("customer.contact"), version: 1, value: { email: "private@example.com" }, modelVisibility: "hidden" },
          {
            ...factBase,
            type: factType("customer.identity"),
            version: 1,
            value: { name: "Private Person" },
            modelVisibility: "presence",
            modelRedactions: ["Private Person"],
          },
          {
            ...factBase,
            type: factType("product.selected"),
            version: 1,
            value: { id: "p-1" },
            evidenceIds: ["evidence-public" as never],
            evidence: [{ id: "evidence-public" as never, source: "external", content: "public product" }],
            modelVisibility: "full",
          },
        ],
        messages: [
          { role: "user", content: "My name is Private Person", at: "2026-09-03T10:00:00.000Z" },
          { role: "assistant", content: "Thanks, Private Person", at: "2026-09-03T10:00:01.000Z" },
        ],
        agenda: [{
          id: "agenda:private" as never,
          intention: {
            id: "request.private" as never,
            objective: "Continue protected collection",
            evidence: [],
            references: [],
            proposedCapability: capabilityId("support.answer"),
            input: {},
            resolution: "resolved",
          },
          status: "waiting_input",
          missingFacts: [],
          dependencies: [],
          continuation: { rawSecret: "agenda secret" },
          modelRedactions: ["agenda secret"],
        }],
      }),
      currentMessage: { role: "user", content: "Continue", at: "2026-09-03T10:01:00.000Z" },
      compiled,
    });
    const gateway = new ScriptedGateway(selected("support.answer"), {
      intentions: [{
        objective: "Continue protected collection",
        evidence: [{ text: "Continue", meaning: "Continue the pending request", messageIndex: 3 }],
        references: [],
        proposedCapability: "support.answer",
        input: {},
        resolution: "resolved",
      }],
      contradictions: [],
    }, interactionAnswerReviewed("supported"));

    await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    const projection = gateway.requests[0]?.input as { facts: readonly { type: string; value: unknown; evidence: readonly unknown[] }[]; omissions: readonly { path: string }[] };
    expect(projection.facts.map((fact) => fact.type)).toEqual(["customer.identity", "product.selected"]);
    expect(projection.facts[0]).toMatchObject({ value: { available: true }, evidence: [] });
    expect(JSON.stringify(projection)).not.toContain("private@example.com");
    expect(JSON.stringify(projection)).not.toContain("Private Person");
    expect(JSON.stringify(projection)).not.toContain("private value");
    expect(JSON.stringify(projection)).not.toContain("agenda secret");
    expect(JSON.stringify(projection)).not.toContain("continuation");
    expect(JSON.stringify(projection)).toContain("[redacted]");
    expect(projection.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "facts" }),
      expect.objectContaining({ path: "facts.value" }),
    ]));
  });
});

describe("turn interpretation", () => {
  it("repairs a guessed downstream operation without discarding explicit progression continuation", async () => {
    const value = { kind: "progression.continue", occurrenceId: "product.explore" };
    const interaction = {
      id: "progression:product.explore" as never, kind: "choice" as const,
      requestedFacts: [], goal: "Continue the purchase process?",
      options: [{ id: "continue", label: "Continue", value }],
      payload: { kind: "progression.group", occurrenceId: "product.explore" },
    };
    const answer = { interactionId: interaction.id, value, evidence: "Yes, let's continue" };
    const gateway = new ScriptedGateway(
      { ...oneSearch, answerToInteraction: answer },
      interactionAnswerReviewed("supported", "The user explicitly requests continuation."),
      interactionAnswerReviewed("unsupported", "No independent search was requested; the operation predicts a later step."),
      { intentions: [], contradictions: [], answerToInteraction: answer },
      interactionAnswerReviewed("supported", "The user explicitly requests continuation."),
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction }), compiled: await compiledAgent(),
      currentMessage: { role: "user", content: "Yes, let's continue", at: "2026-09-03T10:01:00.000Z" },
    });
    const result = await interpretTurn({ snapshot, gateway, selection: selected("product.search"), signal: AbortSignal.timeout(1_000) });
    expect(result.intentions).toEqual([]);
    expect(result.answerToInteraction?.value).toEqual(value);
    expect(gateway.requests.some(({ task }) => task === "turn.interpret.repair")).toBe(true);
  });

  it("accepts camelCase segments already permitted by the public identifier contract", async () => {
    const schema = createCapabilitySelectionSchema([capabilityId("catalog.selectVehicle")]);

    await expect(schema.validate({
      mode: "selected",
      capabilityIds: ["catalog.selectVehicle"],
      rationale: "The user selected a vehicle from the active catalog interaction.",
      evidence: [{
        text: "PEUGEOT 208",
        meaning: "Selected catalog option",
        messageIndex: 1,
      }],
    })).resolves.toMatchObject({
      ok: true,
      value: { capabilityIds: ["catalog.selectVehicle"] },
    });
  });

  it("selects capabilities from compact summaries before exposing only the chosen contracts", async () => {
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: {
        role: "user",
        content: "Show electric SUVs and compare them",
        at: "2026-09-03T10:01:00.000Z",
      },
      compiled: await compiledAgent(),
    });
    const gateway = new ScriptedGateway(
      {
        mode: "selected",
        capabilityIds: ["product.search", "product.compare"],
        rationale: "The message asks to find products and compare the resulting candidates.",
        evidence: [{
          text: "Show electric SUVs and compare them",
          meaning: "Two related product operations",
          messageIndex: 3,
        }],
      },
      oneSearch,
    );

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "turn.interpret",
    ]);
    expect(gateway.requests[0]?.capabilities).toHaveLength(3);
    expect(gateway.requests[0]?.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "product.search", detail: "summary" }),
      expect.objectContaining({ id: "product.compare", detail: "summary" }),
      expect.objectContaining({ id: "support.answer", detail: "summary" }),
    ]));
    expect(gateway.requests[0]?.capabilities.every((entry) => !("inputSchema" in entry))).toBe(true);
    expect(gateway.requests[1]?.capabilities).toEqual([
      expect.objectContaining({ id: "product.compare", detail: "contract" }),
      expect.objectContaining({ id: "product.search", detail: "contract" }),
    ]);
    expect(gateway.requests[1]?.capabilities.every((entry) => "inputSchema" in entry)).toBe(true);
    expect(gateway.requests[1]?.capabilities.some((entry) => entry.id === "support.answer")).toBe(false);
    expect(gateway.requests.every((request) => {
      const input = request.input as { capabilities?: unknown };
      return input.capabilities === undefined;
    })).toBe(true);
  });

  it("repairs a selector response that names a capability outside the compiled agent", async () => {
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "Show electric SUVs", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });
    const gateway = new ScriptedGateway(
      selected("unknown.operation"),
      selected("product.search"),
      oneSearch,
    );

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "capability.select.repair",
      "turn.interpret",
    ]);
  });

  it("repairs an interpretation that escapes the selected capability boundary", async () => {
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "Show electric SUVs", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });
    const escaped = {
      intentions: [{
        ...oneSearch.intentions[0],
        proposedCapability: "support.answer",
      }],
      contradictions: [],
    };
    const gateway = new ScriptedGateway(selected("product.search"), escaped, oneSearch);

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "turn.interpret",
      "turn.interpret.repair",
    ]);
    expect(gateway.requests[2]?.capabilities.map((capability) => capability.id)).toEqual(["product.search"]);
  });

  it("repairs an empty interpretation that discards an audited selected capability", async () => {
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "Show electric SUVs", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });
    const gateway = new ScriptedGateway(
      selected("product.search"),
      { intentions: [], contradictions: [] },
      oneSearch,
    );

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "turn.interpret",
      "turn.interpret.repair",
    ]);
  });

  it("completes an omitted resolved capability only from a singleton selected contract", async () => {
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "Show electric SUVs", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });
    const omittedCapability = {
      intentions: [{
        ...oneSearch.intentions[0],
        proposedCapability: undefined,
      }],
      contradictions: [],
    };
    const gateway = new ScriptedGateway(selected("product.search"), omittedCapability);

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "turn.interpret",
    ]);
  });

  it("requires resolved capability identity in generation and repair with multiple selected contracts", async () => {
    const snapshot = buildContextSnapshot({ checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "Show electric SUVs", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent() });
    const original = oneSearch.intentions[0];
    if (original === undefined) throw Error("Missing fixture intention");
    const base = { objective: original.objective, evidence: original.evidence,
      references: original.references, input: original.input, resolution: original.resolution };
    const omitted = { intentions: [base], contradictions: [] };
    const valid = { intentions: [{ ...base, proposedCapability: "product.search" }], contradictions: [] };
    const gateway = new ScriptedGateway(selected("product.search", "product.compare"), omitted, valid);
    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });
    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    const requests = gateway.requests.filter(request => request.task.startsWith("turn.interpret"));
    expect(requests.map(request => request.task)).toEqual(["turn.interpret", "turn.interpret.repair"]);
    for (const request of requests) {
      const jsonSchema = await request.outputSchema.jsonSchema?.();
      if (jsonSchema === undefined) throw Error("Missing generation schema");
      const generated = z.fromJSONSchema(jsonSchema);
      expect(generated.safeParse(omitted).success).toBe(false);
      expect(generated.safeParse({ ...valid, intentions: [{ ...base, proposedCapability: null }] }).success).toBe(false);
      expect(generated.safeParse(valid).success).toBe(true);
      for (const intention of [
        { ...base, resolution: "unsupported" },
        { ...base, resolution: "ambiguous", alternatives: ["search", "compare"] },
      ]) {
        const batch = { intentions: [intention], contradictions: [] };
        expect(generated.safeParse(batch).success).toBe(true);
        expect((await request.outputSchema.validate(batch)).ok).toBe(true);
      }
    }
  });

  it("repairs a reference that combines multiple active option identifiers", async () => {
    const compiled = await compileAgentDefinition(defineAgent({
      id: agentId("reference.agent"),
      version: 1,
      identity: "A reference-aware test agent",
      capabilities: [capability("product.compare", {
        referenceRequirements: {
          source: "active_interaction_options",
          minimum: 2,
          maximum: 2,
        },
      })],
      policies: [],
      modelPolicy: { "turn.interpret": "test-model" },
    }));
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({
        interaction: {
          id: "catalog-options" as never,
          kind: "choice",
          requestedFacts: [],
          goal: "Choose products to compare",
          options: [
            { id: "product-1", label: "First product", value: { id: "product-1" } },
            { id: "product-2", label: "Second product", value: { id: "product-2" } },
          ],
        },
      }),
      currentMessage: { role: "user", content: "Compare the first and second options", at: "2026-09-03T10:01:00.000Z" },
      compiled,
    });
    const base = {
      objective: "Compare two active products",
      evidence: [{ text: "first and second options", meaning: "two products to compare", messageIndex: 3 }],
      proposedCapability: "product.compare",
      input: {},
      resolution: "resolved",
    };
    const gateway = new ScriptedGateway(
      selected("product.compare"),
      {
        intentions: [{
          ...base,
          references: [{ expression: "first and second", target: "product-1, product-2", evidence: "active options" }],
        }],
        contradictions: [],
      },
      {
        intentions: [{
          ...base,
          references: [
            { expression: "first", target: "product-1", evidence: "first active option" },
            { expression: "second", target: "product-2", evidence: "second active option" },
          ],
        }],
        contradictions: [],
      },
    );

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions[0]?.references.map((reference) => reference.target)).toEqual([
      "product-1",
      "product-2",
    ]);
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "turn.interpret",
      "turn.interpret.repair",
    ]);
  });

  it("interprets one grounded intention from the canonical snapshot", async () => {
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "Show electric SUVs", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });
    const gateway = new ScriptedGateway(selected("product.search"), oneSearch);

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions).toHaveLength(1);
    expect(result.intentions[0]).toMatchObject({
      proposedCapability: "product.search",
      resolution: "resolved",
      input: { bodyStyle: "SUV", fuel: "electric" },
    });
    expect(result.intentions[0]?.id).not.toBe("request.1");
    const interpretationJsonSchema = await gateway.requests[1]?.outputSchema.jsonSchema?.() as {
      properties?: { intentions?: { items?: { oneOf?: { properties: Record<string, unknown> }[] } } };
    };
    const branches = interpretationJsonSchema.properties?.intentions?.items?.oneOf;
    expect(branches).toHaveLength(3);
    for (const branch of branches ?? []) expect(branch.properties).not.toHaveProperty("id");
    expect(gateway.requests[0]?.input).toMatchObject({
      currentMessage: { content: "Show electric SUVs" },
      conversation: { totalMessages: 3 },
    });
    expect(gateway.requests[1]?.input).toMatchObject({
      context: {
        currentMessage: { content: "Show electric SUVs" },
        conversation: { totalMessages: 3 },
      },
      selection: {
        mode: "selected",
        capabilityIds: ["product.search"],
      },
    });
    expect(gateway.requests[1]?.system).toContain("never executes capabilities");
  });

  it("keeps multiple explicit operations as separate intentions", async () => {
    const gateway = new ScriptedGateway(selected("product.search", "product.compare"), {
      intentions: [
        oneSearch.intentions[0],
        {
          id: "request.2",
          objective: "Compare the results",
          evidence: [{ text: "compare them", meaning: "comparison request", messageIndex: 3 }],
          references: [{ expression: "them", target: "product search results", evidence: "Show SUVs and compare them" }],
          proposedCapability: "product.compare",
          input: { source: "request.1" },
          resolution: "resolved",
        },
      ],
      contradictions: [],
    });
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "Show SUVs and compare them", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions.map((entry) => entry.proposedCapability)).toEqual([
      "product.search",
      "product.compare",
    ]);
  });

  it("preserves an interaction answer and an additional request in the same turn", async () => {
    const activeInteraction = {
      id: "interaction-1" as never,
      kind: "confirmation" as const,
      requestedFacts: [],
      goal: "Confirm the selected product",
    };
    const gateway = new ScriptedGateway(selected("support.answer"), {
      answerToInteraction: { interactionId: "interaction-1", value: true, evidence: "yes" },
      intentions: [
        {
          id: "request.1",
          objective: "Answer a support question",
          evidence: [{ text: "and what is the warranty?", meaning: "support question", messageIndex: 3 }],
          references: [],
          proposedCapability: "support.answer",
          input: { question: "warranty" },
          resolution: "resolved",
        },
      ],
      contradictions: [],
    }, interactionAnswerReviewed("supported"), interactionAnswerReviewed("supported", "The warranty question is requested independently of confirming the selected product."));
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: activeInteraction }),
      currentMessage: { role: "user", content: "Yes, and what is the warranty?", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.answerToInteraction).toMatchObject({ interactionId: "interaction-1", value: true });
    expect(result.intentions[0]?.proposedCapability).toBe("support.answer");
  });

  it.each(["selected", "conversational"] as const)("accepts a %s confirmation answer without inventing another operation", async (mode) => {
    const gateway = new ScriptedGateway({ ...selected("support.answer"), mode, ...(mode === "conversational" ? { capabilityIds: [] } : {}) }, {
      intentions: [], contradictions: [],
      answerToInteraction: { interactionId: "model-reconstructed-confirmation", value: true, evidence: "yes, confirm it" },
    }, interactionAnswerReviewed("supported"));
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: {
        id: "confirmation-1" as never, kind: "confirmation", capabilityId: capabilityId("support.answer"),
        requestedFacts: [], goal: "Confirm the pending support operation",
      } }),
      currentMessage: { role: "user", content: "yes, confirm it", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });
    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });
    expect(result.intentions).toEqual([]);
    expect(result.answerToInteraction).toMatchObject({ interactionId: "confirmation-1", value: true });
    expect(gateway.requests.some(({ task }) => task === "turn.interpret.repair")).toBe(false);
  });

  it("binds a semantically grounded confirmation to the active server interaction", async () => {
    const activeInteraction = {
      id: "interaction-server-owned" as never,
      kind: "confirmation" as const,
      capabilityId: capabilityId("support.answer"),
      requestedFacts: [],
      goal: "Confirm the pending support operation",
    };
    const gateway = new ScriptedGateway(selected("support.answer"), {
      answerToInteraction: {
        interactionId: "model-reconstructed-id",
        value: true,
        evidence: "yes, confirm it",
      },
      intentions: [{
        id: "request.1",
        objective: "Confirm the pending support operation",
        evidence: [{ text: "yes, confirm it", meaning: "explicit confirmation", messageIndex: 3 }],
        references: [],
        proposedCapability: "support.answer",
        input: { question: "pending support operation" },
        resolution: "resolved",
      }],
      contradictions: [],
    }, interactionAnswerReviewed("supported"), interactionAnswerReviewed("unsupported", "The message only confirms the already-owned support operation."), {
      intentions: [], contradictions: [],
      answerToInteraction: { interactionId: "interaction-server-owned", value: true, evidence: "yes, confirm it" },
    }, interactionAnswerReviewed("supported"));
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: activeInteraction }),
      currentMessage: { role: "user", content: "yes, confirm it", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.answerToInteraction).toMatchObject({
      interactionId: "interaction-server-owned",
      value: true,
    });
    expect(result.intentions).toEqual([]);
  });

  it("does not bind a confirmation to an unrelated active capability", async () => {
    const activeInteraction = {
      id: "interaction-server-owned" as never,
      kind: "confirmation" as const,
      capabilityId: capabilityId("product.search"),
      requestedFacts: [],
      goal: "Confirm the pending search",
    };
    const proposed = {
      answerToInteraction: {
        interactionId: "model-reconstructed-id",
        value: true,
        evidence: "yes, answer support",
      },
      intentions: [{
        id: "request.1",
        objective: "Answer a support question",
        evidence: [{ text: "answer support", meaning: "support request", messageIndex: 3 }],
        references: [],
        proposedCapability: "support.answer",
        input: { question: "support" },
        resolution: "resolved",
      }],
      contradictions: [],
    };
    const repaired = { intentions: proposed.intentions, contradictions: proposed.contradictions };
    const gateway = new ScriptedGateway(selected("product.search", "support.answer"), proposed, repaired);
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: activeInteraction }),
      currentMessage: { role: "user", content: "yes, answer support", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.answerToInteraction).toBeUndefined();
    expect(result.intentions[0]?.proposedCapability).toBe("support.answer");
    expect(gateway.requests.at(-1)?.task).toBe("turn.interpret.repair");
  });

  it("retains the active confirmation owner when compact selection proposes a related capability", async () => {
    const activeInteraction = {
      id: "interaction-search-confirmation" as never,
      kind: "confirmation" as const,
      capabilityId: capabilityId("product.search"),
      requestedFacts: [],
      goal: "Confirm the pending search",
    };
    const gateway = new ScriptedGateway(
      selected("support.answer"),
      {
        intentions: [{
          id: "request.1",
          objective: "Confirm the pending search",
          evidence: [{ text: "yes, run the search", meaning: "confirm search", messageIndex: 3 }],
          references: [],
          proposedCapability: "product.search",
          input: { query: "pending" },
          resolution: "resolved",
        }],
        answerToInteraction: {
          interactionId: "interaction-search-confirmation",
          value: true,
          evidence: "yes, run the search",
        },
        contradictions: [],
      },
      interactionAnswerReviewed("supported"),
      interactionAnswerReviewed("unsupported", "The search is the already-owned operation being confirmed, not a new request."),
      {
        intentions: [], contradictions: [],
        answerToInteraction: { interactionId: "interaction-search-confirmation", value: true, evidence: "yes, run the search" },
      },
      interactionAnswerReviewed("supported"),
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: activeInteraction }),
      currentMessage: { role: "user", content: "yes, run the search", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(gateway.requests[1]?.capabilities.map(({ id }) => id)).toEqual([
      "product.search",
      "support.answer",
    ]);
    expect(result.intentions).toEqual([]);
    expect(result.answerToInteraction).toEqual({ interactionId: "interaction-search-confirmation", value: true, evidence: "yes, run the search" });
    expect(gateway.requests[1]?.input).toMatchObject({ selection: {
      rationale: selected("support.answer").rationale,
      adjustments: [{ code: "ACTIVE_CONFIRMATION_OWNER_RETAINED", capabilityId: "product.search" }],
    } });
  });

  it("repairs a name that was incorrectly proposed as confirmation acceptance", async () => {
    const activeInteraction = {
      id: "interaction-payment-confirmation" as never,
      kind: "confirmation" as const,
      capabilityId: capabilityId("support.answer"),
      requestedFacts: [],
      goal: "Confirm the selected payment option",
    };
    const pendingConfirmation = {
      intentions: [{
        id: "request.1",
        objective: "Continue the pending payment decision",
        evidence: [{ text: "Juan Cordoba", meaning: "name supplied during pending confirmation", messageIndex: 3 }],
        references: [],
        proposedCapability: "support.answer",
        input: { value: "Juan Cordoba" },
        resolution: "resolved",
      }],
      contradictions: [],
    };
    const gateway = new ScriptedGateway(
      {
        ...pendingConfirmation,
        answerToInteraction: {
          interactionId: activeInteraction.id,
          value: true,
          evidence: "Juan Cordoba",
        },
      },
      interactionAnswerReviewed("unsupported", "A personal name does not accept the payment option."),
      pendingConfirmation,
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: activeInteraction }),
      currentMessage: {
        role: "user",
        content: "Juan Cordoba",
        at: "2026-09-03T10:01:00.000Z",
      },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({
      snapshot,
      gateway,
      selection: selected("support.answer"),
      signal: AbortSignal.timeout(1_000),
    });

    expect(result.answerToInteraction).toBeUndefined();
    expect(result.intentions[0]?.proposedCapability).toBe("support.answer");
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "turn.interpret",
      "interaction-answer.review",
      "turn.interpret.repair",
    ]);
  });

  it("reviews and repairs an unsupported diversion from the active interaction", async () => {
    const activeInteraction = {
      id: "interaction-search-results" as never,
      kind: "choice" as const,
      capabilityId: capabilityId("product.search"),
      requestedFacts: [],
      goal: "Choose or refine a product result",
      options: [
        { id: "result-one", label: "First result", value: { optionId: "result-one" } },
        { id: "result-two", label: "Second result", value: { optionId: "result-two" } },
      ],
    };
    const gateway = new ScriptedGateway(
      selected("support.answer"),
      capabilitySelectionReviewed("unsupported", "The message refines the active product results."),
      selected("product.search"),
      oneSearch,
      { verdict: "unsupported", optionId: null, rationale: "The user changes a filter, not a current choice." },
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: activeInteraction }),
      currentMessage: { role: "user", content: "Only show the electric ones", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "capability-selection.interaction-review",
      "capability.select.repair",
      "turn.interpret",
      "interaction-answer.review",
    ]);
    expect(gateway.requests[1]?.capabilities.map(({ id }) => id)).toEqual([
      "product.search",
      "support.answer",
    ]);
  });

  it("recovers the complete server-owned choice value from one grounded option reference", async () => {
    const activeInteraction = {
      id: "interaction-choice" as never,
      kind: "choice" as const,
      capabilityId: capabilityId("product.search"),
      requestedFacts: [],
      goal: "Choose a follow-up",
      options: [{
        id: "option-support",
        label: "Ask support",
        targetCapabilityId: capabilityId("support.answer"),
        value: { type: "option", optionId: "option-support", targetIntent: "support.answer", valueRef: "support-1" },
      }],
    };
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: activeInteraction }),
      currentMessage: { role: "user", content: "that one", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    for (const [answerValue, answerInteractionId] of [
      [{ type: "option", optionId: "option-support" }, "interaction-choice"],
      ["option-support", "interaction-choice"],
      [undefined, "interaction-choice"],
      [{ type: "option", optionId: "option-support" }, "model-reconstructed-id"],
    ] as const) {
      const gateway = new ScriptedGateway(selected("support.answer"), {
        ...(answerValue === undefined ? {} : { answerToInteraction: {
          interactionId: answerInteractionId,
          value: answerValue,
          evidence: "that one",
        } }),
        intentions: [{
          id: "request.1",
          objective: "Ask support",
          evidence: [{ text: "that one", meaning: "select support", messageIndex: 3 }],
          references: [{ expression: "that one", target: "option-support", evidence: "that one" }],
          proposedCapability: "support.answer",
          input: { question: "selected support" },
          resolution: "resolved",
        }],
        contradictions: [],
      }, { decision: "selected", optionId: "option-support", rationale: "The current reference selects the sole support option." });
      const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

      expect(result.answerToInteraction?.value).toEqual({
        type: "option",
        optionId: "option-support",
        targetIntent: "support.answer",
        valueRef: "support-1",
      });
      expect(result.answerToInteraction?.interactionId).toBe("interaction-choice");
    }
  });

  it("keeps a validated structured choice authoritative over a malformed model answer", async () => {
    const answer = { interactionId: "choice-server" as never, value: "support-1", evidence: "Ask support" };
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: {
        id: answer.interactionId, kind: "choice", requestedFacts: [], goal: "Choose an action",
        capabilityId: capabilityId("support.answer"),
        options: [{ id: "support-option", label: "Ask support", value: "support-1", targetCapabilityId: capabilityId("support.answer") }],
      } }),
      currentMessage: { role: "user", content: "Ask support", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });
    const gateway = new ScriptedGateway(selected("support.answer"), {
      intentions: [{ ...oneSearch.intentions[0], proposedCapability: "support.answer" }], contradictions: [],
      answerToInteraction: { interactionId: "invented-container", value: "invented-value", evidence: "Ask support" },
    });
    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000), validatedInteractionAnswer: answer });
    expect(result.answerToInteraction).toEqual(answer);
    expect(gateway.requests.some(({ task }) => task === "turn.interpret.repair")).toBe(false);
  });

  it("does not infer a choice only because one option targets the selected capability", async () => {
    const activeInteraction = {
      id: "interaction-choice" as never,
      kind: "choice" as const,
      capabilityId: capabilityId("product.search"),
      requestedFacts: [],
      goal: "Choose a follow-up",
      options: [{
        id: "option-support",
        label: "Ask support",
        targetCapabilityId: capabilityId("support.answer"),
        value: { type: "option", optionId: "option-support", targetIntent: "support.answer", valueRef: "support-1" },
      }],
    };
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: activeInteraction }),
      currentMessage: { role: "user", content: "yes, I am interested", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });
    const gateway = new ScriptedGateway(selected("support.answer"), {
      intentions: [{
        id: "request.1",
        objective: "Ask support",
        evidence: [{ text: "yes, I am interested", meaning: "accept the offered follow-up", messageIndex: 3 }],
        references: [],
        proposedCapability: "support.answer",
        input: { question: "selected support" },
        resolution: "resolved",
      }],
      contradictions: [],
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.answerToInteraction).toBeUndefined();
  });

  it("repairs an incorrect numeric position through semantic review instead of treating text as a trusted click", async () => {
    const activeInteraction = {
      id: "interaction-choice" as never,
      kind: "choice" as const,
      capabilityId: capabilityId("product.search"),
      requestedFacts: [],
      goal: "Choose a result",
      options: [
        { id: "option-first", label: "First", value: { optionId: "option-first", valueRef: "first" } },
        { id: "option-second", label: "Second", value: { optionId: "option-second", valueRef: "second" } },
        { id: "option-third", label: "Third", value: { optionId: "option-third", valueRef: "third" } },
        { id: "option-fourth", label: "Fourth", value: { optionId: "option-fourth", valueRef: "fourth" } },
      ],
    };
    const wrongProposal = {
      answerToInteraction: {
        interactionId: "interaction-choice",
        value: "option-fourth",
        evidence: "3",
      },
      intentions: [{
        id: "request.1",
        objective: "Choose the third result",
        evidence: [{ text: "3", meaning: "third option", messageIndex: 3 }],
        references: [{ expression: "3", target: "option-fourth", evidence: "3" }],
        proposedCapability: "product.search",
        input: { query: "third result" },
        resolution: "resolved",
      }],
      contradictions: [],
    };
    const gateway = new ScriptedGateway(selected("product.search"), wrongProposal,
      { decision: "selected", optionId: "option-third", rationale: "3 selects the current third position, not the proposed fourth option." },
      { ...wrongProposal, answerToInteraction: { ...wrongProposal.answerToInteraction, value: "option-third" },
        intentions: wrongProposal.intentions.map((intention) => ({ ...intention, references: [{ expression: "3", target: "option-third", evidence: "3" }] })),
      },
      { decision: "selected", optionId: "option-third", rationale: "The repaired option is the unambiguous current third position." },
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: activeInteraction }),
      currentMessage: { role: "user", content: "3", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.answerToInteraction?.value).toEqual({
      optionId: "option-third",
      valueRef: "third",
    });
  });

  it("does not accept a model-invented answer that has no exact server-owned choice reference", async () => {
    const activeInteraction = {
      id: "interaction-choice" as never,
      kind: "choice" as const,
      capabilityId: capabilityId("product.search"),
      requestedFacts: [],
      goal: "Choose a result",
      options: [
        { id: "option-first", label: "First", value: { optionId: "option-first", valueRef: "first" } },
        { id: "action-more", label: "Show more", value: { type: "action", action: "more" } },
      ],
    };
    const proposed = {
      answerToInteraction: {
        interactionId: "interaction-choice",
        value: { type: "action", action: "more", targetIntent: "product.search" },
        evidence: "I prefer automatic",
      },
      intentions: [{
        id: "request.1",
        objective: "Refine the search to automatic products",
        evidence: [{ text: "automatic", meaning: "requested refinement", messageIndex: 3 }],
        references: [],
        proposedCapability: "product.search",
        input: { query: "automatic" },
        resolution: "resolved",
      }],
      contradictions: [],
    };
    const repaired = { intentions: proposed.intentions, contradictions: proposed.contradictions };
    const gateway = new ScriptedGateway(selected("product.search"), proposed, repaired,
      { verdict: "unsupported", optionId: null, rationale: "Automatic is a new search filter, not a selection or navigation request." });
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: activeInteraction }),
      currentMessage: { role: "user", content: "I prefer automatic", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.answerToInteraction).toBeUndefined();
    expect(result.intentions[0]?.input).toEqual({ query: "automatic" });
    expect(gateway.requests.at(-1)?.task).toBe("interaction-answer.review");
    expect(gateway.requests.at(-1)?.input).toMatchObject({ reviewKind: "omitted_choice_answer" });
  });

  it("keeps an exact option ID independent of references to other context entities", async () => {
    const option = { id: "option-first", label: "First", value: { optionId: "option-first", valueRef: { selected: true } } };
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: {
        id: "active-choice" as never, kind: "choice", capabilityId: capabilityId("product.search"),
        goal: "Choose", requestedFacts: [], options: [option],
      } }),
      currentMessage: { role: "user", content: "Choose the first option", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });
    const gateway = new ScriptedGateway(selected("product.search"), {
      ...oneSearch,
      intentions: [{ ...oneSearch.intentions[0], references: [{ expression: "my product", target: "product-context", evidence: "my product" }] }],
      answerToInteraction: { interactionId: "active-choice", value: { optionId: option.id, valueRef: "incorrect-copy" }, evidence: "first option" },
    }, { decision: "selected", optionId: "option-first", rationale: "The current message explicitly chooses the first option." });
    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });
    expect(result.answerToInteraction?.value).toEqual(option.value);
    expect(result.intentions[0]?.references[0]?.target).toBe("product-context");
  });

  it("repairs an answer-only proposal so its capability owner actually processes the choice", async () => {
    const answer = { interactionId: "active-choice", value: "option-first", evidence: "the first one" };
    const gateway = new ScriptedGateway(
      { ...conversational, rationale: "There is no independent new operation." },
      { intentions: [], contradictions: [], answerToInteraction: answer },
      { ...oneSearch, answerToInteraction: answer },
      { decision: "selected", optionId: "option-first", rationale: "The current words select the first offered choice." },
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: {
        id: "active-choice" as never, kind: "choice", capabilityId: capabilityId("product.search"),
        goal: "Choose", requestedFacts: [], options: [{
          id: "option-first", label: "First", value: { selected: "first" }, targetCapabilityId: capabilityId("product.search"),
        }],
      } }),
      currentMessage: { role: "user", content: "the first one", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });
    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });
    expect(result.answerToInteraction?.value).toEqual({ selected: "first" });
    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(gateway.requests.at(-2)?.task).toBe("turn.interpret.repair");
    expect(gateway.requests.at(-1)?.task).toBe("interaction-answer.review");
    expect(gateway.requests[1]?.capabilities.map(({ id }) => id)).toEqual(["product.search"]);
  });

  it("routes a declared choice action to its target without inventing a request for the originating capability", async () => {
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: {
        id: "active-choice" as never, kind: "choice", capabilityId: capabilityId("support.answer"),
        goal: "Do you want to explore products?", requestedFacts: [],
        options: [{ id: "explore", label: "Explore products", value: { action: "explore" }, targetCapabilityId: capabilityId("product.search") }],
      } }),
      currentMessage: { role: "user", content: "Yes, search for an electric SUV", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });
    const gateway = new ScriptedGateway({
      ...oneSearch,
      answerToInteraction: { interactionId: "active-choice", value: "explore", evidence: "Yes, search for an electric SUV" },
    }, { decision: "selected", optionId: "explore", rationale: "The requested search explicitly accepts product exploration." });
    const result = await interpretTurn({
      snapshot, gateway, selection: selected("product.search") as never, signal: AbortSignal.timeout(1_000),
    });
    expect(result.intentions.map(({ proposedCapability }) => proposedCapability)).toEqual(["product.search"]);
    expect(result.answerToInteraction?.value).toEqual({ action: "explore" });
    expect(gateway.requests.map(({ task }) => task)).toEqual(["turn.interpret", "interaction-answer.review"]);
  });

  it("repairs a global yes referring to a quotation without retaining an inferred financing intention", async () => {
    const text = "Sí, quiero cotizar un usado como parte de pago";
    const compiled = await compileAgentDefinition(defineAgent({
      id: agentId("choice.review-test"), version: 1, identity: "A test agent",
      capabilities: [capability("payment.choose"), capability("vehicle.quote")],
      policies: [], modelPolicy: { "turn.interpret": "test-model" },
    }));
    const activeInteraction = {
      id: "payment-choice" as never, kind: "choice" as const,
      capabilityId: capabilityId("payment.choose"), requestedFacts: [],
      goal: "¿Querés sumar opciones de financiación a tu presupuesto?",
      options: [
        { id: "cash", label: "No, al contado", value: { method: "cash" } },
        { id: "financing", label: "Sí, con financiación", value: { method: "financing" } },
      ],
    };
    const quoteIntention = {
      id: "quote-request", objective: "Cotizar el usado como parte de pago",
      evidence: [{ text: "quiero cotizar un usado como parte de pago", meaning: "Explicit quotation request", messageIndex: 3 }],
      references: [], proposedCapability: "vehicle.quote", input: { request: text }, resolution: "resolved",
    };
    const unsupported = {
      answerToInteraction: { interactionId: activeInteraction.id, value: "financing", evidence: "Sí" },
      intentions: [{
        id: "payment-request", objective: "Accept financing",
        evidence: [{ text: "Sí", meaning: "Inferred financing acceptance", messageIndex: 3 }],
        references: [], proposedCapability: "payment.choose", input: { request: "Sí" }, resolution: "resolved",
      }, quoteIntention],
      contradictions: [],
    };
    const gateway = new ScriptedGateway(
      unsupported,
      { decision: "not_selection", rationale: "The whole sentence asks to quote a vehicle and never commits to financing." },
      { intentions: [quoteIntention], contradictions: [] },
      { verdict: "supported", rationale: "The current words explicitly request the quotation while leaving payment unanswered." },
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: activeInteraction }),
      currentMessage: { role: "user", content: text, at: "2026-09-03T10:01:00.000Z" },
      compiled,
    });

    const result = await interpretTurn({
      snapshot, gateway, selection: selected("payment.choose", "vehicle.quote") as never,
      signal: AbortSignal.timeout(1_000),
    });

    expect(result.answerToInteraction).toBeUndefined();
    expect(result.intentions.map(({ proposedCapability }) => proposedCapability)).toEqual(["vehicle.quote"]);
    expect(result.intentions[0]?.input).toEqual({ request: text });
    expect(snapshot.interaction).toEqual(activeInteraction);
    expect(gateway.requests.map(({ task }) => task)).toEqual([
      "turn.interpret", "interaction-answer.review", "turn.interpret.repair", "interaction-answer.review",
    ]);
    const repair = gateway.requests[2]?.input as { validationIssues: readonly { message: string }[] };
    expect(repair.validationIssues[0]?.message).toContain("intentions inferred solely from that answer");
    expect(repair.validationIssues[0]?.message).toContain("preserve independently requested intentions");
  });

  it("accepts a purely conversational turn without inventing an operation", async () => {
    const gateway = new ScriptedGateway(conversational);
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "Hello there", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions).toEqual([]);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.task).toBe("capability.select");
    expect(gateway.requests[0]?.system).toContain("merely resembles capability input");
  });

  it.each([["product.search"], ["product.search", "product.compare"]])("bounds interpretation and repair to the selected contracts: %j", async (...allowed) => {
    const snapshot = buildContextSnapshot({ compiled: await compiledAgent(), checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "Find an electric SUV", at: "2026-09-03T10:01:00.000Z" } });
    const intention = { objective: "Find an electric SUV", evidence: oneSearch.intentions[0]?.evidence ?? [],
      references: [], proposedCapability: "product.search", input: {}, resolution: "resolved" };
    const valid = { intentions: [intention], contradictions: [] };
    const policyAsCapability = { ...valid, intentions: [{ ...intention, proposedCapability: "product.search-scope-boundary" }] };
    const gateway = new ScriptedGateway(policyAsCapability, valid);
    const result = await interpretTurn({ snapshot, gateway, selection: selected(...allowed), signal: AbortSignal.timeout(1000) });
    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(gateway.requests.map(request => request.task)).toEqual(["turn.interpret", "turn.interpret.repair"]);
    for (const request of gateway.requests) {
      const json = await request.outputSchema.jsonSchema?.();
      if (!json) throw Error("Missing output schema");
      const generated = z.fromJSONSchema(json);
      for (const id of [...allowed, "support.answer", "product.search-scope-boundary"]) {
        const candidate = { ...valid, intentions: [{ ...intention, proposedCapability: id }] };
        expect(generated.safeParse(candidate).success, id).toBe(allowed.includes(id));
        expect((await request.outputSchema.validate(candidate)).ok, id).toBe(allowed.includes(id));
      }
      expect(generated.safeParse({ ...valid, intentions: [{ ...intention, resolution: "ambiguous", proposedCapability: null,
        alternatives: ["search", "compare"] }] }).success).toBe(true);
    }
  });

  it("excludes resolved intentions when no contract is selected without preventing unsupported requests", async () => {
    const snapshot = buildContextSnapshot({ compiled: await compiledAgent(), checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "An unavailable operation", at: "2026-09-03T10:01:00.000Z" } });
    const intention = { objective: "An unavailable operation", evidence: oneSearch.intentions[0]?.evidence ?? [],
      references: [], resolution: "resolved" };
    const valid = { intentions: [{ ...intention, resolution: "unsupported" }], contradictions: [] };
    const gateway = new ScriptedGateway(oneSearch, valid);
    await interpretTurn({ snapshot, gateway, selection: { ...noMatch, mode: "no_match" }, signal: AbortSignal.timeout(1000) });
    for (const request of gateway.requests) {
      const json = await request.outputSchema.jsonSchema?.();
      if (!json) throw Error("Missing output schema");
      const candidate = { ...valid, intentions: [{ ...intention, proposedCapability: "product.search" }] };
      expect(z.fromJSONSchema(json).safeParse(candidate).success).toBe(false);
      expect(z.fromJSONSchema(json).safeParse(valid).success).toBe(true);
      expect((await request.outputSchema.validate(candidate)).ok).toBe(false);
    }
  });

  it("exposes conversational and lifecycle boundaries in the generation contract", async () => {
    const compiled = await compiledAgent();
    const snapshot = buildContextSnapshot({ compiled, checkpoint: checkpoint({ interaction: {
      id: "pending-search" as never, kind: "choice", capabilityId: capabilityId("product.search"),
      goal: "Which product?", requestedFacts: [], options: [{ id: "one", label: "First product", value: "one" }],
    } }), currentMessage: { role: "user", content: "I am not sure", at: "2026-09-03T10:01:00.000Z" } });
    const invalid = { intentions: [{ objective: "An unselected operation", resolution: "unsupported",
      references: [], evidence: [{ text: "I am not sure", meaning: "Ambiguous answer", messageIndex: 3 }] }], contradictions: [] };
    const valid = { intentions: [], contradictions: [] };
    const gateway = new ScriptedGateway(invalid, valid);
    const result = await interpretTurn({ snapshot, gateway, selection: { ...conversational, mode: "conversational" }, signal: AbortSignal.timeout(1000) });
    expect(result.intentions).toEqual([]);
    for (const request of gateway.requests) {
      const json = await request.outputSchema.jsonSchema?.();
      if (!json) throw Error("Missing output schema");
      const generated = z.fromJSONSchema(json);
      expect(generated.safeParse(invalid).success).toBe(false);
      expect(generated.safeParse(valid).success).toBe(true);
      expect(generated.safeParse({ ...valid, lifecycleActions: [{ kind: "cancel_agenda_item", targetId: "pending-search",
        evidence: invalid.intentions[0]?.evidence[0] }] }).success).toBe(false);
    }
  });

  it("does not route an isolated number when no active interaction or agenda item gives it meaning", async () => {
    const gateway = new ScriptedGateway(
      selected("product.search"),
      selected("product.search"),
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "2", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result).toEqual({ intentions: [], contradictions: [] });
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "capability.select.repair",
    ]);
  });

  it("interprets a continuation answer independently of an empty capability selection", async () => {
    const interaction = {
      id: "active-menu" as never, kind: "choice" as const, mode: "optional" as const,
      goal: "Choose an action or continue", requestedFacts: [],
      options: [{ id: "continue", label: "Continue", value: { kind: "progression.continue", occurrenceId: "explore" } }],
      payload: { kind: "progression.group", groupId: "explore" },
    };
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction }),
      currentMessage: { role: "user", content: "Yes, continue", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });
    const gateway = new ScriptedGateway(
      { intentions: [], contradictions: [], answerToInteraction: {
        interactionId: interaction.id, value: interaction.options[0]?.value,
        evidence: "Yes, continue", rationale: "The user explicitly chooses the continuation option.",
      } },
      { verdict: "supported", rationale: "The words explicitly answer the active option." },
    );
    const result = await interpretTurn({
      snapshot, gateway, selection: { ...conversational, mode: "conversational" }, signal: AbortSignal.timeout(1_000),
    });
    expect(result.intentions).toEqual([]);
    expect(result.answerToInteraction?.value).toEqual(interaction.options[0]?.value);
    expect(gateway.requests.map(({ task }) => task)).toEqual(["turn.interpret", "interaction-answer.review"]);
  });

  it("does not resume cancelled work from an unbound value that resembles capability input", async () => {
    const gateway = new ScriptedGateway(
      selected("support.answer"),
      capabilitySelectionReviewed("unsupported", "A name and location do not explicitly request an operation."),
      selected("support.answer"),
      capabilitySelectionReviewed("unsupported", "The value is still unbound after repair."),
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({
        progression: {
          objective: { id: "purchase.journey", status: "cancelled" },
          occurrences: [],
        },
      }),
      currentMessage: { role: "user", content: "Juan Cordoba", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result).toEqual({ intentions: [], contradictions: [] });
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "capability-selection.review",
      "capability.select.repair",
      "capability-selection.review",
    ]);
  });

  it("interprets explicit pending-work cancellation as a kernel control action", async () => {
    const pendingIntention = {
      id: "pending.1" as never,
      objective: "Find a family product",
      evidence: [{ text: "family product", meaning: "search request", messageIndex: 0 }],
      references: [],
      proposedCapability: capabilityId("product.search"),
      input: { query: "family" },
      resolution: "resolved" as const,
    };
    const gateway = new ScriptedGateway(control, lifecycleSelectionReviewed("supported"), {
      intentions: [],
      contradictions: [],
      lifecycleActions: [{
        kind: "cancel_agenda_item",
        targetId: "agenda:pending.1",
        evidence: { text: "cancel that objective", meaning: "explicit cancellation", messageIndex: 3 },
      }],
    }, lifecycleReviewed("supported"));
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({
        agenda: [{
          id: "agenda:pending.1" as never,
          intention: pendingIntention,
          status: "waiting_input",
          missingFacts: [],
          dependencies: [],
        }],
      }),
      currentMessage: { role: "user", content: "Please cancel that objective", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions).toEqual([]);
    expect(result.lifecycleActions).toEqual([expect.objectContaining({
      kind: "cancel_agenda_item",
      targetId: "agenda:pending.1",
    })]);
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "lifecycle-selection.review",
      "turn.interpret",
      "lifecycle.review",
    ]);
  });

  it("targets the configured objective when the complete journey is explicitly cancelled", async () => {
    const gateway = new ScriptedGateway(control, lifecycleSelectionReviewed("supported"), {
      intentions: [],
      contradictions: [],
      lifecycleActions: [{
        kind: "cancel_objective",
        targetId: "purchase.journey",
        evidence: { text: "cancel the entire goal", meaning: "complete objective cancellation", messageIndex: 3 },
      }],
    }, lifecycleReviewed("supported"));
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({
        progression: {
          objective: { id: "purchase.journey", status: "active" },
          occurrences: [],
        },
      }),
      currentMessage: { role: "user", content: "Cancel the entire goal", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.lifecycleActions).toEqual([expect.objectContaining({
      kind: "cancel_objective",
      targetId: "purchase.journey",
    })]);
  });

  it("repairs a capability shortlist that omitted an explicit objective rejection from an active progression choice", async () => {
    const progressionInteraction = {
      id: "progression:purchase.next" as never,
      kind: "choice" as const,
      requestedFacts: [],
      goal: "Choose how to continue the purchase journey",
      options: [{
        id: "progression:purchase.next:continue",
        label: "Continue with the budget",
        value: { kind: "progression.continue", occurrenceId: "purchase.next" },
      }],
      payload: { kind: "progression.group", occurrenceId: "purchase.next" },
    };
    const gateway = new ScriptedGateway(
      selected("product.search"),
      lifecycleSelectionReviewed("unsupported", "The user explicitly rejects the complete purchase objective."),
      control,
      lifecycleSelectionReviewed("supported"),
      {
        intentions: [],
        contradictions: [],
        lifecycleActions: [{
          kind: "cancel_objective",
          targetId: "purchase.journey",
          evidence: { text: "I do not want to prepare a budget", meaning: "objective rejection", messageIndex: 3 },
        }],
      },
      lifecycleReviewed("supported"),
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({
        progression: {
          objective: { id: "purchase.journey", status: "active" },
          occurrences: [],
        },
        interaction: progressionInteraction,
      }),
      currentMessage: { role: "user", content: "I do not want to prepare a budget", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.lifecycleActions).toEqual([expect.objectContaining({
      kind: "cancel_objective",
      targetId: "purchase.journey",
    })]);
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "lifecycle-selection.review",
      "capability.select.repair",
      "lifecycle-selection.review",
      "turn.interpret",
      "lifecycle.review",
    ]);
    const reviewInput = gateway.requests.find(({ task }) => task === "lifecycle-selection.review")?.input as Record<string, unknown>;
    expect(reviewInput["controlContract"]).toEqual({ actions: ["cancel_objective", "cancel_agenda_item"], interactionAnswersAreLifecycleActions: false });
    expect(reviewInput["proposedSelection"]).not.toHaveProperty("capabilityIds");
  });

  it("keeps an active multi-option interaction when a vague acknowledgement cannot identify one capability", async () => {
    const interaction = {
      id: "progression:vehicle-actions" as never,
      kind: "choice" as const,
      mode: "required" as const,
      requestedFacts: [],
      goal: "Choose a vehicle action",
      options: [
        {
          id: "progression:vehicle-actions:search",
          label: "Search other vehicles",
          targetCapabilityId: capabilityId("product.search"),
          value: { kind: "progression.member", capabilityId: "product.search" },
        },
        {
          id: "progression:vehicle-actions:compare",
          label: "Compare vehicles",
          targetCapabilityId: capabilityId("product.compare"),
          value: { kind: "progression.member", capabilityId: "product.compare" },
        },
      ],
      payload: { kind: "progression.group", occurrenceId: "vehicle-actions" },
    };
    const gateway = new ScriptedGateway(
      selected("product.search"),
      { meaning: "ambiguous_or_unrelated", rationale: "Sure does not distinguish search from comparison." },
      selected("product.compare"),
      { meaning: "ambiguous_or_unrelated", rationale: "Sure still does not identify comparison." },
      { intentions: [], contradictions: [] },
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction }),
      currentMessage: { role: "user", content: "Sure", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const selection = await selectCapabilities({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });
    expect(selection.source).toBe("kernel_boundary");
    const result = await interpretTurn({ snapshot, selection, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result).toEqual({ intentions: [], contradictions: [] });
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "capability-selection.choice-review",
      "capability.select.repair",
      "capability-selection.choice-review",
      "turn.interpret",
    ]);
  });

  it("reviews choices that share one target capability before accepting an arbitrary option", async () => {
    const interaction = {
      id: "catalog:vehicles" as never,
      kind: "choice" as const,
      mode: "required" as const,
      capabilityId: capabilityId("product.search"),
      requestedFacts: [],
      goal: "Choose one vehicle version",
      options: [
        {
          id: "vehicle-active",
          label: "PEUGEOT 208 ACTIVE",
          targetCapabilityId: capabilityId("product.search"),
          value: { type: "option", targetIntent: "product.search", valueRef: "active" },
        },
        {
          id: "vehicle-allure",
          label: "PEUGEOT 208 ALLURE",
          targetCapabilityId: capabilityId("product.search"),
          value: { type: "option", targetIntent: "product.search", valueRef: "allure" },
        },
      ],
    };
    const gateway = new ScriptedGateway(
      selected("product.search"),
      { meaning: "ambiguous_or_unrelated", rationale: "Both active options are Peugeot 208 versions." },
      conversational,
      { intentions: [], contradictions: [] },
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction }),
      currentMessage: { role: "user", content: "the 208", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result).toEqual({ intentions: [], contradictions: [] });
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "capability-selection.choice-review",
      "capability.select.repair",
      "turn.interpret",
    ]);
  });

  it("gives the choice reviewer the selected contract to distinguish refinement from picking a shared option", async () => {
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({ interaction: {
        id: "catalog:vehicles" as never,
        kind: "choice",
        mode: "required",
        capabilityId: capabilityId("product.search"),
        requestedFacts: [],
        goal: "Choose one product or refine the search",
        options: [
          { id: "active", label: "ACTIVE automatic", targetCapabilityId: capabilityId("product.search"), value: "active" },
          { id: "allure", label: "ALLURE automatic", targetCapabilityId: capabilityId("product.search"), value: "allure" },
        ],
      } }),
      currentMessage: { role: "user", content: "Refine the search to automatic models", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });
    const gateway = new ScriptedGateway(
      selected("product.search"),
      { meaning: "operation_request", operationCapabilityIds: ["product.search"], rationale: "The user requests a search refinement, not one of the shared options." },
    );

    const result = await selectCapabilities({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.capabilityIds).toEqual(["product.search"]);
    const review = gateway.requests.find((request) => request.task === "capability-selection.choice-review");
    expect(review?.capabilities).toEqual([expect.objectContaining({
      detail: "contract", id: "product.search", inputSchema: objectSchema.jsonSchema(),
      guidance: { whenToUse: ["The user explicitly requests product.search"], whenNotToUse: ["A different operation is requested"], examples: ["Please product.search"] },
    })]);
    expect(review?.system).toContain("independent operation or a refinement");
  });

  it("repairs a false control-only shortlist before capability contracts are reduced", async () => {
    const gateway = new ScriptedGateway(
      control,
      lifecycleSelectionReviewed("unsupported", "The user requested alternatives and did not abandon tracked work."),
      selected("product.search"),
      oneSearch,
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({
        progression: {
          objective: { id: "purchase.journey", status: "active" },
          occurrences: [],
        },
      }),
      currentMessage: { role: "user", content: "No, better show other products", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(result.lifecycleActions).toBeUndefined();
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "lifecycle-selection.review",
      "capability.select.repair",
      "turn.interpret",
    ]);
  });

  it("repairs a replacement request without converting it into lifecycle cancellation", async () => {
    const invalidInterpretation = {
      ...oneSearch,
      lifecycleActions: [{
        kind: "cancel_objective",
        targetId: "selected-product",
        evidence: { text: "No, better show other products", meaning: "replace the current selection", messageIndex: 3 },
      }],
    };
    const gateway = new ScriptedGateway(
      selected("product.search"),
      invalidInterpretation,
      oneSearch,
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({
        progression: {
          objective: { id: "purchase.journey", status: "active" },
          occurrences: [],
        },
      }),
      currentMessage: { role: "user", content: "No, better show other products", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.lifecycleActions).toBeUndefined();
    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "capability.select",
      "turn.interpret",
      "turn.interpret.repair",
    ]);
  });

  it("supports an explicit lifecycle cancellation and capability operation in the same turn", async () => {
    const gateway = new ScriptedGateway({
      ...oneSearch,
      lifecycleActions: [{
        kind: "cancel_objective",
        targetId: "purchase.journey",
        evidence: { text: "Cancel the purchase journey and search products", meaning: "explicit combined request", messageIndex: 3 },
      }],
    }, lifecycleReviewed("supported"));
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({
        progression: {
          objective: { id: "purchase.journey", status: "active" },
          occurrences: [],
        },
      }),
      currentMessage: { role: "user", content: "Cancel the purchase journey and search products", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({
      snapshot,
      gateway,
      selection: selectedWithControl("product.search"),
      signal: AbortSignal.timeout(1_000),
    });

    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(result.lifecycleActions).toEqual([expect.objectContaining({
      kind: "cancel_objective",
      targetId: "purchase.journey",
    })]);
  });

  it("repairs a semantically unsupported lifecycle cancellation without dropping the capability", async () => {
    const proposed = {
      ...oneSearch,
      lifecycleActions: [{
        kind: "cancel_objective",
        targetId: "purchase.journey",
        evidence: { text: "No, better show other products", meaning: "replace the current selection", messageIndex: 3 },
      }],
    };
    const gateway = new ScriptedGateway(
      proposed,
      lifecycleReviewed("unsupported", "The user replaced a selected entity but did not abandon the journey."),
      oneSearch,
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({
        progression: {
          objective: { id: "purchase.journey", status: "active" },
          occurrences: [],
        },
      }),
      currentMessage: { role: "user", content: "No, better show other products", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({
      snapshot,
      gateway,
      selection: selectedWithControl("product.search"),
      signal: AbortSignal.timeout(1_000),
    });

    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(result.lifecycleActions).toBeUndefined();
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "turn.interpret",
      "lifecycle.review",
      "turn.interpret.repair",
    ]);
  });

  it("keeps the capability operation when combined selection does not survive detailed interpretation", async () => {
    const gateway = new ScriptedGateway(oneSearch);
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint({
        progression: {
          objective: { id: "purchase.journey", status: "active" },
          occurrences: [],
        },
      }),
      currentMessage: { role: "user", content: "No, better show other products", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({
      snapshot,
      gateway,
      selection: selectedWithControl("product.search"),
      signal: AbortSignal.timeout(1_000),
    });

    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(result.lifecycleActions).toBeUndefined();
  });

  it.each([
    {
      label: "ambiguous reference",
      value: {
        intentions: [
          {
            id: "request.1",
            objective: "Select one result",
            evidence: [{ text: "the first", meaning: "position without a unique visible list", messageIndex: 3 }],
            references: [],
            resolution: "ambiguous",
            alternatives: ["first product list", "first comparison item"],
          },
        ],
        contradictions: [],
      },
      resolution: "ambiguous",
    },
    {
      label: "unsupported operation",
      value: {
        intentions: [
          {
            id: "request.1",
            objective: "Book a flight",
            evidence: [{ text: "book a flight", meaning: "unsupported operation", messageIndex: 3 }],
            references: [],
            resolution: "unsupported",
          },
        ],
        contradictions: [],
      },
      resolution: "unsupported",
    },
  ])("retains $label without converting it into an execution", async ({ value, resolution }) => {
    const gateway = new ScriptedGateway(
      resolution === "unsupported" ? noMatch : selected("product.search", "product.compare"),
      value,
    );
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "Handle this", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions[0]?.resolution).toBe(resolution);
    expect(result.intentions[0]?.proposedCapability).toBeUndefined();
  });

  it("uses exactly one structural repair for malformed model output", async () => {
    const gateway = new ScriptedGateway(selected("product.search"), { intentions: "invalid" }, oneSearch);
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "Show electric SUVs", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });

    expect(result.intentions[0]?.proposedCapability).toBe("product.search");
    expect(gateway.requests).toHaveLength(3);
    expect(gateway.requests[2]?.task).toBe("turn.interpret.repair");
  });

  it("fails with a typed issue after the structural repair budget is exhausted", async () => {
    const gateway = new ScriptedGateway(selected("product.search"), { intentions: "invalid" }, { contradictions: [] });
    const snapshot = buildContextSnapshot({
      checkpoint: checkpoint(),
      currentMessage: { role: "user", content: "Show electric SUVs", at: "2026-09-03T10:01:00.000Z" },
      compiled: await compiledAgent(),
    });

    await expect(
      interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000) }),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID", retryable: false });
    expect(gateway.requests).toHaveLength(3);
  });
});
