import { describe, expect, it } from "vitest";

import {
  buildResponseBrief,
  buildResponseDelivery,
  capabilityId,
  composeResponse,
  ModelGatewayError,
  technicalFailureResponse,
  type ModelGateway,
  type ModelRequest,
  type ModelResult,
  type ResponseBrief,
  type TurnReduction,
  type TurnPlan,
} from "../../src/internal.js";

class ScriptedGateway implements ModelGateway {
  readonly requests: ModelRequest<unknown>[] = [];
  readonly #values: unknown[];

  constructor(...values: unknown[]) {
    this.#values = values;
  }

  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.requests.push(request);
    const value = this.#values.shift();
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve({
      value: value as T,
      provider: "scripted",
      model: "test-model",
      durationMs: 1,
    });
  }
}

function plan(): TurnPlan {
  return {
    steps: [
      {
        id: "step-1" as never,
        intentionId: "request.1" as never,
        intention: {
          id: "request.1" as never,
          objective: "Find products",
          evidence: [{ text: "find products", meaning: "search", messageIndex: 0 }],
          references: [],
          proposedCapability: capabilityId("product.search"),
          input: { query: "family" },
          resolution: "resolved",
        },
        capabilityId: capabilityId("product.search"),
        input: { query: "family" },
        dependsOn: [],
        missingFacts: [],
        disposition: "execute",
        reason: { code: "READY", message: "Ready", evidence: ["find products"] },
      },
    ],
    responseGoal: "Present search results naturally",
  };
}

function reduction(): TurnReduction {
  const evidence = {
    id: "evidence-1" as never,
    source: "external" as const,
    content: "The catalog contains Family One for 25000 USD.",
    data: { productId: "p-1", price: 25_000 },
  };
  return {
    checkpoint: {
      schemaVersion: 1,
      revision: 1,
      agentFingerprint: "composer",
      messages: [],
      facts: [{
        type: "product.candidates" as never,
        version: 1,
        value: [{ id: "p-1", name: "Family One", price: 25_000 }],
        evidenceIds: [evidence.id],
        evidence: [evidence],
        dependsOn: [],
        producedBy: {
          capabilityId: capabilityId("product.search"),
          capabilityVersion: 1,
          turnId: "turn-1" as never,
          stepId: "step-1" as never,
        },
      }],
      agenda: [],
      effects: [],
    },
    publishedFacts: [],
    invalidatedFacts: [],
    evidence: [evidence],
    artifacts: [{ id: "products-1", kind: "product-list", data: [{ id: "p-1" }] }],
    issues: [],
    results: [{
      status: "invoked",
      stepId: "step-1" as never,
      capabilityId: capabilityId("product.search"),
      result: {
        status: "completed",
        output: { count: 1, internalCursor: "must-not-be-special-cased" },
        facts: [],
        evidence: [evidence],
        artifacts: [],
      },
    }],
  };
}

const supportedReview = (claims: readonly Readonly<{ text: string; evidenceIds: readonly string[] }>[] = []) => ({
  verdict: "supported",
  continuityVerdict: "supported",
  decisionVerdict: "supported",
  unsupportedClaims: [],
  approvedClaimIndexes: claims.map((_claim, index) => index),
});

const draft = (...parts: readonly (readonly [text: string, evidenceIds: readonly string[]])[]) => ({
  parts: parts.map(([text, evidenceIds]) => ({ text, evidenceIds })),
});

describe("grounded response composition", () => {
  it.each(["model", "repair", "structural-fallback", "rejected-fallback", "protected"])(
    "preserves public branch choices and artifacts when a private surname overlaps (%s)", async (mode) => {
      const source = reduction();
      const interaction = {
        id: "branch:Cordoba" as never, kind: "choice" as const, requestedFacts: [],
        goal: "Elegí una sucursal de Cordoba.",
        options: [{ id: "branch:Cordoba:1", label: "Cordoba Centro", value: { branch: "Cordoba" } }],
        ...(mode === "protected" ? { protectedCanonicalMessage: "Ana Cordoba. ¿Confirmás?" } : {}),
      };
      const input = { plan: { steps: [], responseGoal: "Choose a branch" }, reduction: {
        ...source, results: [],
        checkpoint: { ...source.checkpoint, interaction,
          facts: source.checkpoint.facts.map((fact) => ({ ...fact, modelRedactions: ["Cordoba", "ana@example.com"] })),
        },
        artifacts: [{ id: "branches:Cordoba", kind: "branch-list", data: [{ id: "branch:Cordoba:1", label: "Cordoba Centro" }] }],
      } };
      const brief = buildResponseBrief(input);
      const rejectedReview = { ...supportedReview(), verdict: "unsupported", unsupportedClaims: ["Invalid framing"] };
      const gateway = mode === "protected" ? new ScriptedGateway()
        : mode === "structural-fallback" ? new ScriptedGateway(new ModelGatewayError({ code: "MODEL_JSON_INVALID", message: "Invalid output", retryable: false }))
        : mode === "repair" ? new ScriptedGateway(draft(["Try this.", []]), rejectedReview, draft(["Elegí una sucursal.", []]), supportedReview())
        : mode === "rejected-fallback" ? new ScriptedGateway(draft(["Try this.", []]), rejectedReview, draft(["Try this.", []]), rejectedReview)
        : new ScriptedGateway(draft(["Elegí una sucursal.", []]), supportedReview());
      const response = await composeResponse({
        brief, delivery: buildResponseDelivery(input), gateway, signal: AbortSignal.timeout(1_000),
        ...(mode === "protected" ? { protectedCanonicalMessage: interaction.protectedCanonicalMessage } : {}),
      });
      expect(response.interaction).toEqual({
        id: "branch:Cordoba", kind: "choice", requestedFacts: [], goal: "Elegí una sucursal de Cordoba.",
        options: [{ id: "branch:Cordoba:1", label: "Cordoba Centro", value: { branch: "Cordoba" } }],
      });
      expect(response.artifacts).toEqual([{ id: "branches:Cordoba", kind: "branch-list", data: [{ id: "branch:Cordoba:1", label: "Cordoba Centro" }] }]);
      expect(Object.isFrozen(response.interaction?.options)).toBe(true);
      if (mode.endsWith("fallback")) expect(response.message).toBe("Elegí una sucursal de Cordoba.");
      if (mode === "protected") expect(response.message).toBe("Ana Cordoba. ¿Confirmás?");
      expect(JSON.stringify(brief)).not.toContain("Cordoba");
      expect(JSON.stringify(gateway.requests)).not.toContain("Cordoba");
      expect(JSON.stringify(gateway.requests)).not.toContain("ana@example.com");
      expect(source.checkpoint.facts[0]?.modelRedactions).toBeUndefined();
      expect(input.reduction.checkpoint.interaction).toEqual(interaction);
    },
  );

  function requiredResultBrief(): ResponseBrief {
    const source = reduction();
    const goal = "Would you like financing?";
    const requiredMessage = "The estimated value is ARS 12.367.000.";
    const evidence = [{ id: "evidence-1" as never, source: "external" as const, content: requiredMessage, data: { estimatedValue: 12_367_000, currency: "ARS" } }];
    const results = source.results.map((execution) => execution.status === "invoked" && execution.result.status === "completed"
      ? { ...execution, result: { ...execution.result, evidence, canonicalResponse: {
          message: requiredMessage,
          claims: [{ text: requiredMessage, evidenceIds: ["evidence-1" as never] }],
          required: true,
        } } }
      : execution);
    // Completing another operation must not make the first result optional.
    const firstStep = plan().steps[0];
    if (firstStep === undefined) throw new Error("Missing fixture step");
    const followupId = capabilityId("payment.prepare");
    const combinedPlan: TurnPlan = { ...plan(), steps: [...plan().steps, {
      ...firstStep, id: "step-2" as never, capabilityId: followupId,
      intentionId: "request.2" as never,
      intention: { ...firstStep.intention, id: "request.2" as never, proposedCapability: followupId },
    }] };
    return buildResponseBrief({ plan: combinedPlan, reduction: {
      ...source,
      evidence,
      results: [...results, {
        status: "invoked", stepId: "step-2" as never, capabilityId: followupId,
        result: { status: "completed", output: { ready: true }, facts: [], evidence: [], artifacts: [] },
      }],
      checkpoint: { ...source.checkpoint, facts: [], interaction: {
        id: "payment-choice" as never, kind: "choice", goal, requestedFacts: [],
        options: [{ id: "cash", label: "Cash", value: "cash" }],
      } },
    } });
  }

  it.each(["fallback", "required", "protected-required"])(
    "delivers original canonical copy and citations when redaction overlaps (%s)", async (mode) => {
      const source = reduction();
      const message = "La sucursal es Cordoba Centro.";
      const evidence = [{ id: "evidence:Cordoba" as never, source: "external" as const, content: message }];
      const input = { plan: plan(), reduction: {
        ...source, evidence,
        checkpoint: { ...source.checkpoint,
          facts: source.checkpoint.facts.map((fact) => ({ ...fact, modelRedactions: ["Cordoba"] })),
          interaction: { id: "confirm" as never, kind: "confirmation" as const, requestedFacts: [], goal: "¿Seguimos?" },
        },
        results: source.results.map((execution) => execution.status === "invoked" && execution.result.status === "completed"
          ? { ...execution, result: { ...execution.result, evidence, canonicalResponse: {
              message, claims: [{ text: message, evidenceIds: ["evidence:Cordoba" as never] }],
              ...(mode === "fallback" ? {} : { required: true }),
            } } } : execution),
      } };
      const gateway = mode === "fallback"
        ? new ScriptedGateway(new ModelGatewayError({ code: "MODEL_OUTPUT_INVALID", message: "Invalid output", retryable: false }))
        : new ScriptedGateway();
      const brief = buildResponseBrief(input);
      const response = await composeResponse({ brief, delivery: buildResponseDelivery(input), gateway,
        signal: AbortSignal.timeout(1_000),
        ...(mode === "protected-required" ? { protectedCanonicalMessage: "Ana Cordoba. ¿Confirmás?" } : {}),
      });
      expect(response).toMatchObject({
        source: "canonical", grounded: true,
        message: mode === "fallback" ? message : `${message}\n\n${mode === "required" ? "¿Seguimos?" : "Ana Cordoba. ¿Confirmás?"}`,
        claims: [{ text: "La sucursal es Cordoba Centro.", evidenceIds: ["evidence:Cordoba"] }],
      });
      expect(JSON.stringify(brief)).not.toContain("Cordoba");
      expect(JSON.stringify(gateway.requests)).not.toContain("Cordoba");
    },
  );

  it("delivers a required invitation from the original projection when only its goal was redacted", async () => {
    const source = reduction();
    const message = "The request is ready.";
    const goal = "Choose a branch in Sampletown.";
    const evidence = [{ id: "evidence-1" as never, source: "external" as const, content: message }];
    const input = { plan: plan(), reduction: {
      ...source, evidence,
      checkpoint: { ...source.checkpoint,
        facts: source.checkpoint.facts.map((fact) => ({ ...fact, modelRedactions: ["Sampletown"] })),
        interaction: { id: "branch" as never, kind: "choice" as const, requestedFacts: [], goal,
          options: [{ id: "central", label: "Central", value: "central" }] },
      },
      results: source.results.map((execution) => execution.status === "invoked" && execution.result.status === "completed"
        ? { ...execution, result: { ...execution.result, evidence, canonicalResponse: {
            message, claims: [{ text: message, evidenceIds: ["evidence-1" as never] }], required: true,
          } } } : execution),
    } };
    const brief = buildResponseBrief(input);
    const delivery = buildResponseDelivery(input);
    expect(brief.requiredResponses).toEqual(delivery.requiredResponses);
    expect(brief.interaction?.goal).not.toBe(goal);
    if (brief.interaction === undefined) throw new Error("Missing fixture interaction");
    const claim = { text: message, evidenceIds: ["evidence-1"] };
    const gateway = new ScriptedGateway(draft([message, claim.evidenceIds], [` ${brief.interaction.goal}`, []]), supportedReview([claim]));
    const response = await composeResponse({ brief, delivery, gateway, signal: AbortSignal.timeout(1_000) });
    expect(response).toMatchObject({ source: "canonical", grounded: true, message: `${message}\n\n${goal}` });
    expect(gateway.requests).toHaveLength(0);
  });

  it("rejects a redacted required canonical delivery whose original citation is unavailable", async () => {
    const source = reduction();
    const input = { plan: plan(), reduction: {
      ...source, evidence: [],
      checkpoint: { ...source.checkpoint, facts: [] },
      results: source.results.map((execution) => execution.status === "invoked" && execution.result.status === "completed"
        ? { ...execution, result: { ...execution.result, modelRedactions: ["Cordoba"], canonicalResponse: {
            message: "Cordoba Centro", claims: [{ text: "Cordoba Centro", evidenceIds: ["missing" as never] }], required: true,
          } } } : execution),
    } };
    const gateway = new ScriptedGateway();
    await expect(composeResponse({ brief: buildResponseBrief(input), delivery: buildResponseDelivery(input), gateway,
      signal: AbortSignal.timeout(1_000),
    })).rejects.toMatchObject({ code: "UNGROUNDED_RESPONSE" });
    expect(gateway.requests).toHaveLength(0);
  });

  it.each([
    "Would you like financing?",
    "The estimated value is ARS 1.236.700. Would you like financing?",
    "The estimated value is USD 12.367.000. Would you like financing?",
  ])("does not accept a missing or changed required result even when the reviewer approves: %s", async (message) => {
    const gateway = new ScriptedGateway(draft([message, []]), supportedReview(), draft([message, []]), supportedReview());
    const response = await composeResponse({ brief: requiredResultBrief(), gateway, signal: AbortSignal.timeout(1_000) });
    expect(response).toMatchObject({
      grounded: true, source: "canonical",
      message: "The estimated value is ARS 12.367.000.\n\nWould you like financing?",
      claims: [{ text: "The estimated value is ARS 12.367.000.", evidenceIds: ["evidence-1"] }],
    });
    expect(gateway.requests.some(({ task }) => task === "response.compose.repair")).toBe(true);
  });

  it("keeps a model response that delivers the required result once with its evidence", async () => {
    const text = "The estimated value is ARS 12.367.000.";
    const claim = { text, evidenceIds: ["evidence-1"] };
    const gateway = new ScriptedGateway(draft([text, claim.evidenceIds], [" Would you like financing?", []]), supportedReview([claim]));
    const response = await composeResponse({ brief: requiredResultBrief(), gateway, signal: AbortSignal.timeout(1_000) });
    expect(response.source).toBe("model");
    expect(response.message).toBe(`${text} Would you like financing?`);
    expect(gateway.requests).toHaveLength(2);
  });

  it.each(["", " Would you like a different product?"])(
    "does not lose the pending invitation after a required result even if the reviewer approves: %s", async (suffix) => {
      const text = "The estimated value is ARS 12.367.000.";
      const claim = { text, evidenceIds: ["evidence-1"] };
      const candidate = draft([text, claim.evidenceIds], ...(suffix ? [[suffix, []] as const] : []));
      const gateway = new ScriptedGateway(candidate, supportedReview([claim]), candidate, supportedReview([claim]));
      const response = await composeResponse({ brief: requiredResultBrief(), gateway, signal: AbortSignal.timeout(1_000) });
      expect(response.source).toBe("canonical");
      expect(response.message).toBe(`${text}\n\nWould you like financing?`);
      expect(response.claims).toEqual([claim]);
      expect(gateway.requests.some(({ task }) => task === "response.compose.repair")).toBe(true);
    },
  );

  it.each(["absent", "optional"])("does not invent a mandatory follow-up when the interaction is %s", async (mode) => {
    const { interaction, ...base } = requiredResultBrief();
    const brief: ResponseBrief = mode === "optional" && interaction !== undefined
      ? { ...base, interaction: { ...interaction, mode: "optional" } }
      : base;
    const text = "The estimated value is ARS 12.367.000.";
    const claim = { text, evidenceIds: ["evidence-1"] };
    const gateway = new ScriptedGateway(draft([text, claim.evidenceIds]), supportedReview([claim]));
    const response = await composeResponse({ brief, gateway, signal: AbortSignal.timeout(1_000) });
    expect(response.source).toBe("model");
    expect(response.message).toBe(text);
    expect(gateway.requests).toHaveLength(2);
  });

  it.each(["before", "duplicated"])("rejects a required invitation that is %s the completed result", async (mode) => {
    const text = "The estimated value is ARS 12.367.000.";
    const question = "Would you like financing?";
    const claim = { text, evidenceIds: ["evidence-1"] };
    const candidate = mode === "before"
      ? draft([`${question} `, []], [text, claim.evidenceIds])
      : draft([text, claim.evidenceIds], [` ${question} ${question}`, []]);
    const gateway = new ScriptedGateway(candidate, supportedReview([claim]), candidate, supportedReview([claim]));
    const response = await composeResponse({ brief: requiredResultBrief(), gateway, signal: AbortSignal.timeout(1_000) });
    expect(response.source).toBe("canonical");
    expect(response.message).toBe(`${text}\n\n${question}`);
  });

  it("does not replay required results from historical facts on a later turn", () => {
    const source = reduction();
    const brief = buildResponseBrief({ plan: { steps: [], responseGoal: "Continue" }, reduction: { ...source, results: [] } });
    expect(brief.requiredResponses ?? []).toEqual([]);
  });

  it("preserves required results before a protected confirmation without exposing protected text to a model", async () => {
    const gateway = new ScriptedGateway();
    const response = await composeResponse({
      brief: requiredResultBrief(), gateway, signal: AbortSignal.timeout(1_000),
      protectedCanonicalMessage: "Private contact. Confirm?",
    });
    expect(response.message).toBe("The estimated value is ARS 12.367.000.\n\nPrivate contact. Confirm?");
    expect(response.claims).toHaveLength(1);
    expect(gateway.requests).toHaveLength(0);
  });

  it("rejects duplicated required text and preserves it exactly once in the fallback", async () => {
    const text = "The estimated value is ARS 12.367.000.";
    const repeated = draft([`${text} ${text}`, ["evidence-1"]]);
    const review = supportedReview([{ text, evidenceIds: ["evidence-1"] }]);
    const gateway = new ScriptedGateway(repeated, review, repeated, review);
    const response = await composeResponse({ brief: requiredResultBrief(), gateway, signal: AbortSignal.timeout(1_000) });
    expect(response.source).toBe("canonical");
    expect(response.message.split(text)).toHaveLength(2);
  });

  it("returns protected canonical confirmation without exposing it to a model", async () => {
    const source = reduction();
    const protectedInteraction = {
      id: "interaction-protected" as never,
      kind: "confirmation" as const,
      requestedFacts: [],
      goal: "Confirm protected information.",
      protectedCanonicalMessage: "Ana Pérez · ana@example.com · 5491123456789. ¿Confirmás?",
    };
    const protectedReduction: TurnReduction = {
      ...source,
      checkpoint: {
        ...source.checkpoint,
        interaction: protectedInteraction,
        facts: source.checkpoint.facts.map((fact) => ({
          ...fact, modelRedactions: ["Ana Pérez", "ana@example.com", "5491123456789"],
        })),
      },
    };
    const gateway = new ScriptedGateway();

    const brief = buildResponseBrief({ plan: plan(), reduction: protectedReduction });
    const response = await composeResponse({
      brief,
      protectedCanonicalMessage: protectedInteraction.protectedCanonicalMessage,
      gateway,
      signal: AbortSignal.timeout(1_000),
    });

    expect(response).toMatchObject({
      status: "completed",
      grounded: true,
      source: "canonical",
      message: "Ana Pérez · ana@example.com · 5491123456789. ¿Confirmás?",
    });
    expect(gateway.requests).toHaveLength(0);
    expect(brief.interaction).not.toHaveProperty("protectedCanonicalMessage");
    for (const sensitive of ["Ana Pérez", "ana@example.com", "5491123456789"]) {
      expect(JSON.stringify(brief)).not.toContain(sensitive);
    }
  });

  it("builds a port-free brief and composes a natural cited response", async () => {
    const brief = buildResponseBrief({ plan: plan(), reduction: reduction() });
    const gateway = new ScriptedGateway(
      draft(
        ["Encontré ", []],
        ["Family One a 25.000 USD", ["evidence-1"]],
        [". ¿Querés conocerlo mejor?", []],
      ),
      supportedReview([{ text: "Family One a 25.000 USD", evidenceIds: ["evidence-1"] }]),
    );

    const response = await composeResponse({ brief, gateway, signal: AbortSignal.timeout(1_000) });

    expect(response).toMatchObject({
      status: "completed",
      grounded: true,
      source: "model",
      artifacts: [{ id: "products-1" }],
    });
    expect(response.message).toContain("Family One");
    expect(gateway.requests.map((request) => request.task)).toEqual(["response.compose", "response.grounding-review"]);
    expect(gateway.requests[0]?.input).not.toHaveProperty("ports");
  });

  it("recomposes when the reviewer detects a continuity violation", async () => {
    const brief = {
      ...buildResponseBrief({ plan: { ...plan(), responseGoal: "Respond to the current message" }, reduction: reduction() }),
      conversation: {
        currentMessage: "Thanks",
        recentMessages: [
          { role: "user" as const, content: "Find a family product" },
          { role: "assistant" as const, content: "I found one option." },
        ],
        agentIdentity: "Product advisor",
      },
    };
    const gateway = new ScriptedGateway(
      draft(["Hello! I am your product advisor.", []]),
      { ...supportedReview(), continuityVerdict: "violated" },
      draft(["You're welcome. Let me know what you want to review next.", []]),
      supportedReview(),
    );

    const response = await composeResponse({ brief, gateway, signal: AbortSignal.timeout(1_000) });

    expect(response.message).toBe("You're welcome. Let me know what you want to review next.");
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "response.compose",
      "response.grounding-review",
      "response.compose.repair",
      "response.grounding-review",
    ]);
  });

  it("shares selected semantic guidance with composition and prevents stale facts from replacing an unbound message", async () => {
    const source = reduction();
    const brief = buildResponseBrief({
      plan: { steps: [], responseGoal: "Respond naturally to the current conversational message" },
      reduction: {
        ...source,
        evidence: [],
        artifacts: [],
        results: [],
        checkpoint: {
          ...source.checkpoint,
          progression: {
            objective: { id: "purchase", status: "cancelled" },
            occurrences: [],
          },
        },
      },
      context: {
        conversation: { recentMessages: [], totalMessages: 0 },
        currentMessage: { role: "user", content: "2", at: "2026-09-04T00:00:00.000Z", index: 0 },
        facts: source.checkpoint.facts,
        agenda: [],
        progression: {
          objective: { id: "purchase", status: "cancelled" },
          occurrences: [],
        },
        capabilities: [],
        decisions: [],
        agent: { id: "agent", version: 1, identity: "Product advisor", modelPolicy: {} },
        policies: [],
        selectedModelGuidancePolicies: [{
          id: "unbound-after-cancellation" as never,
          version: 1,
          description: "Do not resume cancelled work from an unbound value.",
          instructions: ["Ask what a standalone value refers to instead of using stale facts."],
          examples: [{ input: "2", expectedBehavior: "Ask what the value refers to." }],
          counterExamples: [],
          matchedSelectors: ["objectiveStatus"],
        }],
        omissions: [],
      },
      decision: {
        evidenceId: "turn.decision" as never,
        mode: "conversational",
        capabilityIds: [],
        rationale: "The standalone value is not bound to active work after cancellation.",
        evidence: [{ text: "2", meaning: "unbound value", messageIndex: 0 }],
      },
    });
    const gateway = new ScriptedGateway(
      draft(["Family One costs 25.000 USD.", ["evidence-1"]]),
      { ...supportedReview([{ text: "Family One costs 25.000 USD.", evidenceIds: ["evidence-1"] }]), decisionVerdict: "violated" },
      draft(["What does 2 refer to?", []]),
      supportedReview(),
    );

    const response = await composeResponse({ brief, gateway, signal: AbortSignal.timeout(1_000) });

    expect(brief.modelGuidance).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "unbound-after-cancellation" }),
    ]));
    expect(response.message).toBe("What does 2 refer to?");
    expect(response.claims).toEqual([]);
    const composeInput = gateway.requests[0]?.input as ResponseBrief | undefined;
    expect(composeInput?.decision?.mode).toBe("conversational");
    expect(composeInput?.modelGuidance[0]?.id).toBe("unbound-after-cancellation");
  });

  it("does not repeat an already acknowledged lifecycle action on a later conversational turn", async () => {
    const source = reduction();
    const brief = {
      ...buildResponseBrief({
        plan: { steps: [], responseGoal: "Respond naturally to the current conversational message" },
        reduction: {
          ...source,
          evidence: [],
          artifacts: [],
          results: [],
          checkpoint: {
            ...source.checkpoint,
            agenda: [],
            progression: {
              objective: { id: "purchase", status: "cancelled" as const },
              occurrences: [],
            },
          },
        },
      }),
      conversation: {
        currentMessage: "Nothing else, thanks",
        recentMessages: [
          { role: "user" as const, content: "Cancel the purchase" },
          { role: "assistant" as const, content: "The purchase was cancelled." },
        ],
        agentIdentity: "Product advisor",
      },
      decision: {
        evidenceId: "turn.decision" as never,
        mode: "conversational" as const,
        capabilityIds: [],
        rationale: "The current message closes the conversation and requests no operation.",
        evidence: [{ text: "Nothing else, thanks", meaning: "conversation closure", messageIndex: 2 }],
      },
    };
    const gateway = new ScriptedGateway(
      draft(["The purchase was cancelled.", []]),
      { ...supportedReview(), continuityVerdict: "violated" },
      draft(["You're welcome. I'm here if you need anything else.", []]),
      supportedReview(),
    );

    const response = await composeResponse({ brief, gateway, signal: AbortSignal.timeout(1_000) });

    expect(response.message).toBe("You're welcome. I'm here if you need anything else.");
    expect(gateway.requests[0]?.system).toContain("Treat a lifecycle acknowledgement as complete");
    expect(gateway.requests[2]?.input).toMatchObject({
      issues: ["The proposed response violates conversational continuity."],
    });
  });

  it("allows the same clarification when consecutive standalone values remain unbound", async () => {
    const source = reduction();
    const brief = {
      ...buildResponseBrief({
        plan: { steps: [], responseGoal: "Clarify the standalone value" },
        reduction: {
          ...source,
          evidence: [],
          artifacts: [],
          results: [],
          checkpoint: {
            ...source.checkpoint,
            agenda: [],
            progression: {
              objective: { id: "purchase", status: "cancelled" as const },
              occurrences: [],
            },
          },
        },
      }),
      conversation: {
        currentMessage: "person@example.com",
        recentMessages: [
          { role: "user" as const, content: "A standalone name" },
          { role: "assistant" as const, content: "What does that refer to?" },
        ],
        agentIdentity: "Product advisor",
      },
      decision: {
        evidenceId: "turn.decision" as never,
        mode: "conversational" as const,
        capabilityIds: [],
        rationale: "The standalone value is not bound to active work.",
        evidence: [{ text: "person@example.com", meaning: "unbound email", messageIndex: 2 }],
      },
    };
    const gateway = new ScriptedGateway(
      draft(["What does that refer to?", []]),
      supportedReview(),
    );

    const response = await composeResponse({ brief, gateway, signal: AbortSignal.timeout(1_000) });

    expect(response.message).toBe("What does that refer to?");
    expect(response.claims).toEqual([]);
    expect(gateway.requests).toHaveLength(2);
  });

  it("does not expose a conversational classification rationale as the answer", async () => {
    const source = reduction();
    const brief = {
      ...buildResponseBrief({ plan: { steps: [], responseGoal: "Respond naturally" }, reduction: source }),
      conversation: {
        currentMessage: "2",
        recentMessages: [{ role: "assistant" as const, content: "The purchase was cancelled." }],
        agentIdentity: "Product advisor",
      },
      decision: {
        evidenceId: "turn.decision" as never,
        mode: "conversational" as const,
        capabilityIds: [],
        rationale: "The number is unbound after cancellation.",
        evidence: [{ text: "2", meaning: "unbound number", messageIndex: 2 }],
      },
      evidence: [
        ...buildResponseBrief({ plan: { steps: [], responseGoal: "Respond naturally" }, reduction: source }).evidence,
        { id: "turn.decision" as never, source: "capability" as const, content: "Validated current-turn decision" },
      ],
    };
    const gateway = new ScriptedGateway(
      draft(["The number is unbound after cancellation.", ["turn.decision"]]),
      supportedReview([{ text: "The number is unbound after cancellation.", evidenceIds: ["turn.decision"] }]),
      draft(["¿A qué te referís con 2?", []]),
      supportedReview(),
    );

    const response = await composeResponse({ brief, gateway, signal: AbortSignal.timeout(1_000) });

    expect(response.message).toBe("¿A qué te referís con 2?");
    expect(gateway.requests[2]?.input).toMatchObject({
      issues: ["Conversational response cites the private decision rationale instead of addressing the current message."],
    });
  });

  it("clarifies a vague acknowledgement instead of replaying prior results at a multi-option interaction", async () => {
    const source = reduction();
    const activeInteraction = {
      id: "interaction-vehicle-actions" as never,
      kind: "choice" as const,
      mode: "required" as const,
      requestedFacts: [],
      goal: "Elegí cómo querés continuar con el vehículo.",
      options: [
        { id: "details", label: "Ver detalles", value: { capabilityId: "product.details" } },
        { id: "budget", label: "Continuar con el presupuesto", value: { capabilityId: "budget.create" } },
      ],
    };
    const brief = {
      ...buildResponseBrief({
        plan: { ...plan(), steps: [], responseGoal: "Clarify the unresolved choice" },
        reduction: {
          ...source,
          evidence: [],
          artifacts: [],
          results: [],
          checkpoint: { ...source.checkpoint, interaction: activeInteraction },
        },
      }),
      conversation: {
        currentMessage: "Dale",
        recentMessages: [
          { role: "assistant" as const, content: "Encontré varias opciones." },
          { role: "assistant" as const, content: "¿Cómo querés continuar?" },
        ],
        agentIdentity: "Vehicle advisor",
      },
    };
    const gateway = new ScriptedGateway(
      draft(["Encontré varias opciones con sus precios.", []]),
      { ...supportedReview(), continuityVerdict: "violated" },
      draft(["Perfecto. Elegí una de las opciones disponibles para continuar.", []]),
      supportedReview(),
    );

    const response = await composeResponse({ brief, gateway, signal: AbortSignal.timeout(1_000) });

    expect(response.message).toBe(activeInteraction.goal);
    expect(response.source).toBe("canonical");
    expect(response.interaction).toEqual(activeInteraction);
    expect(gateway.requests).toEqual([]);
  });

  it("repairs one malformed grounding review before failing the turn", async () => {
    const responseDraft = draft(
      ["Encontré ", []],
      ["Family One a 25.000 USD", ["evidence-1"]],
      [".", []],
    );
    const gateway = new ScriptedGateway(
      responseDraft,
      new ModelGatewayError({
        code: "MODEL_JSON_INVALID",
        message: "The provider returned malformed JSON.",
        retryable: false,
      }),
      supportedReview([{ text: "Family One a 25.000 USD", evidenceIds: ["evidence-1"] }]),
    );

    const response = await composeResponse({
      brief: buildResponseBrief({ plan: plan(), reduction: reduction() }),
      gateway,
      signal: AbortSignal.timeout(1_000),
      models: { review: "review-model", reviewRepair: "repair-model" },
    });

    expect(response.status).toBe("completed");
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "response.compose",
      "response.grounding-review",
      "response.grounding-review.repair",
    ]);
    expect(gateway.requests.at(-1)?.model).toBe("repair-model");
  });

  it("publishes capability issues as citable evidence", () => {
    const source = reduction();
    const brief = buildResponseBrief({
      plan: plan(),
      reduction: {
        ...source,
        issues: [{ code: "CATALOG_UNAVAILABLE", message: "The catalog is unavailable.", retryable: true }],
      },
    });

    expect(brief.evidence).toContainEqual({
      id: "issue:CATALOG_UNAVAILABLE",
      source: "capability",
      content: "The catalog is unavailable.",
      data: { code: "CATALOG_UNAVAILABLE", message: "The catalog is unavailable.", retryable: true },
    });
  });

  it("publishes the validated current-turn decision as one exact citable record", () => {
    const source = reduction();
    const brief = buildResponseBrief({
      plan: { steps: [], responseGoal: "Acknowledge cancellation" },
      reduction: { ...source, evidence: [], artifacts: [], results: [] },
      decision: {
        mode: "control",
        capabilityIds: [],
        rationale: "The user explicitly cancelled the active objective.",
        evidence: [{ text: "Cancel", meaning: "cancel active objective", messageIndex: 0 }],
      },
    });

    expect(brief.decision?.evidenceId).toBe("turn.decision");
    expect(brief.evidence).toContainEqual({
      id: "turn.decision",
      source: "capability",
      content: "Validated current-turn decision: The user explicitly cancelled the active objective.",
      data: {
        mode: "control",
        capabilityIds: [],
        evidence: [{ text: "Cancel", meaning: "cancel active objective", messageIndex: 0 }],
      },
    });
  });

  it("keeps current-turn evidence citable when the persisted fact is presence-only", () => {
    const source = reduction();
    const presenceOnly: TurnReduction = {
      ...source,
      checkpoint: {
        ...source.checkpoint,
        facts: source.checkpoint.facts.map((fact) => ({ ...fact, modelVisibility: "presence" as const })),
      },
    };

    const brief = buildResponseBrief({ plan: plan(), reduction: presenceOnly });

    expect(brief.facts[0]).toMatchObject({ value: { available: true }, evidenceIds: [], evidence: [] });
    expect(brief.completed[0]?.evidenceIds).toEqual(["evidence-1"]);
    expect(brief.evidence).toContainEqual(expect.objectContaining({ id: "evidence-1" }));
  });

  it("combines several authorized results into one response instead of concatenating messages", async () => {
    const source = reduction();
    const multi: TurnReduction = {
      ...source,
      evidence: [
        ...source.evidence,
        { id: "evidence-2" as never, source: "external", content: "Warranty lasts three years." },
      ],
    };
    const gateway = new ScriptedGateway(
      draft(
        ["Encontré ", []],
        ["Family One a 25.000 USD", ["evidence-1"]],
        [" y tiene ", []],
        ["tres años de garantía", ["evidence-2"]],
        [".", []],
      ),
      supportedReview([
        { text: "Family One a 25.000 USD", evidenceIds: ["evidence-1"] },
        { text: "tres años de garantía", evidenceIds: ["evidence-2"] },
      ]),
    );

    const response = await composeResponse({
      brief: buildResponseBrief({ plan: plan(), reduction: multi }),
      gateway,
      signal: AbortSignal.timeout(1_000),
    });

    expect(response.message).toContain("y tiene");
    expect(response.claims).toHaveLength(2);
  });

  it("keeps one server-owned interaction while the model writes its natural framing", async () => {
    const source = reduction();
    const interaction = {
      id: "interaction-1" as never,
      kind: "clarification" as const,
      requestedFacts: [],
      goal: "Clarify whether to continue the current search or start a new one.",
      options: [
        { id: "current", label: "Continue current search", value: "current" },
        { id: "new", label: "Start a new search", value: "new" },
      ],
    };
    const pending: TurnReduction = {
      ...source,
      checkpoint: { ...source.checkpoint, interaction },
    };
    const gateway = new ScriptedGateway(
      draft(["¿Preferís seguir con la búsqueda actual o empezar una nueva?", []]),
      supportedReview(),
    );

    const response = await composeResponse({
      brief: buildResponseBrief({ plan: { ...plan(), interaction }, reduction: pending }),
      gateway,
      signal: AbortSignal.timeout(1_000),
    });

    expect(response.interaction).toEqual(interaction);
    expect(response.claims).toEqual([]);
  });

  it("recomposes once when a citation is unknown or semantic review finds an unsupported claim", async () => {
    const gateway = new ScriptedGateway(
      draft(
        ["Family One ", []],
        ["costs 20.000 USD", ["invented-evidence"]],
        [" and is in stock.", []],
      ),
      { verdict: "unsupported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: ["costs 20.000 USD", "is in stock"], approvedClaimIndexes: [] },
      draft(
        ["Encontré ", []],
        ["Family One a 25.000 USD", ["evidence-1"]],
        [".", []],
      ),
      supportedReview([{ text: "Family One a 25.000 USD", evidenceIds: ["evidence-1"] }]),
    );

    const response = await composeResponse({
      brief: buildResponseBrief({ plan: plan(), reduction: reduction() }),
      gateway,
      signal: AbortSignal.timeout(1_000),
    });

    expect(response.message).toContain("25.000");
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "response.compose",
      "response.grounding-review",
      "response.compose.repair",
      "response.grounding-review",
    ]);
  });

  it("derives exact claim spans from cited response parts before review", async () => {
    const gateway = new ScriptedGateway(
      draft(
        ["Encontré ", []],
        ["Family One a 25.000 USD", ["evidence-1"]],
        [".", []],
      ),
      supportedReview([{ text: "Family One a 25.000 USD", evidenceIds: ["evidence-1"] }]),
    );

    const response = await composeResponse({
      brief: buildResponseBrief({ plan: plan(), reduction: reduction() }),
      gateway,
      signal: AbortSignal.timeout(1_000),
    });

    expect(response.message).toBe("Encontré Family One a 25.000 USD.");
    expect(response.claims).toEqual([{ text: "Family One a 25.000 USD", evidenceIds: ["evidence-1"] }]);
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "response.compose",
      "response.grounding-review",
    ]);
  });

  it("blocks a response that remains semantically ungrounded after one recomposition", async () => {
    const first = draft(
      ["Family One includes ", []],
      ["lifetime insurance", ["evidence-1"]],
      [".", []],
    );
    const gateway = new ScriptedGateway(
      first,
      { verdict: "unsupported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: ["lifetime insurance"], approvedClaimIndexes: [] },
      first,
      { verdict: "unsupported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: ["lifetime insurance"], approvedClaimIndexes: [] },
    );

    await expect(composeResponse({
      brief: buildResponseBrief({ plan: plan(), reduction: reduction() }),
      gateway,
      signal: AbortSignal.timeout(1_000),
    })).rejects.toMatchObject({ code: "UNGROUNDED_RESPONSE", retryable: false });
  });

  it("uses the host-localized unsupported-intention fallback after bounded model rejection", async () => {
    const sourcePlan = plan();
    const unsupportedPlan: TurnPlan = {
      responseGoal: "Explain that the requested operation is unavailable",
      steps: sourcePlan.steps.map((step) => ({
        ...step,
        capabilityId: undefined,
        disposition: "reject" as const,
        reason: {
          code: "UNSUPPORTED_INTENTION",
          message: "No registered capability represents this request.",
          evidence: ["book a flight"],
        },
      })),
    };
    const emptyReduction: TurnReduction = {
      ...reduction(),
      checkpoint: { ...reduction().checkpoint, facts: [] },
      evidence: [],
      artifacts: [],
      results: [],
    };
    const rejected = draft(["I can book that flight.", []]);
    const gateway = new ScriptedGateway(
      rejected,
      { verdict: "unsupported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: ["book that flight"], approvedClaimIndexes: [] },
      rejected,
      { verdict: "unsupported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: ["book that flight"], approvedClaimIndexes: [] },
    );

    const response = await composeResponse({
      brief: buildResponseBrief({
        plan: unsupportedPlan,
        reduction: emptyReduction,
        responseFallbacks: { unsupportedIntention: "I cannot perform that request." },
      }),
      gateway,
      signal: AbortSignal.timeout(1_000),
    });

    expect(response).toMatchObject({
      status: "completed",
      grounded: true,
      source: "canonical",
      message: "I cannot perform that request.",
    });
  });

  it("uses a capability-owned cited fallback when both model drafts remain ungrounded", async () => {
    const source = reduction();
    const withCanonicalFallback: TurnReduction = {
      ...source,
      results: source.results.map((execution) => execution.status === "invoked" && execution.result.status === "completed"
        ? {
            ...execution,
            result: {
              ...execution.result,
              canonicalResponse: {
                message: "Elegiste Family One a 25.000 USD.",
                claims: [{ text: "Family One a 25.000 USD", evidenceIds: ["evidence-1" as never] }],
              },
            },
          }
        : execution),
    };
    const rejected = draft(["Family One includes lifetime insurance.", ["evidence-1"]]);
    const gateway = new ScriptedGateway(
      rejected,
      { verdict: "unsupported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: ["lifetime insurance"], approvedClaimIndexes: [] },
      rejected,
      { verdict: "unsupported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: ["lifetime insurance"], approvedClaimIndexes: [] },
    );

    const response = await composeResponse({
      brief: buildResponseBrief({ plan: plan(), reduction: withCanonicalFallback }),
      gateway,
      signal: AbortSignal.timeout(1_000),
    });

    expect(response).toMatchObject({
      status: "completed",
      grounded: true,
      source: "canonical",
      message: "Elegiste Family One a 25.000 USD.",
    });
    expect(response.claims).toEqual([
      { text: "Family One a 25.000 USD", evidenceIds: ["evidence-1"] },
    ]);
  });

  it("uses a verified interaction fallback when structured model review is unavailable", async () => {
    const source = reduction();
    const interaction = {
      id: "interaction:next-term" as never,
      kind: "choice" as const,
      capabilityId: capabilityId("product.search"),
      requestedFacts: [],
      goal: "Which option do you want to explore next?",
      options: [{ id: "option-1", label: "Option one", value: "option-1" }],
    };
    const withInteraction: TurnReduction = {
      ...source,
      checkpoint: { ...source.checkpoint, interaction },
    };
    const responseDraft = draft(["Which option do you want to explore next?", []]);
    const malformedReview = new ModelGatewayError({
      code: "MODEL_JSON_INVALID",
      message: "The provider returned malformed JSON.",
      retryable: false,
    });
    const gateway = new ScriptedGateway(responseDraft, malformedReview, malformedReview);

    const response = await composeResponse({
      brief: buildResponseBrief({ plan: plan(), reduction: withInteraction }),
      gateway,
      signal: AbortSignal.timeout(1_000),
    });

    expect(response).toMatchObject({
      status: "completed",
      grounded: true,
      source: "canonical",
      message: "Which option do you want to explore next?",
      interaction,
    });
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "response.compose",
      "response.grounding-review",
      "response.grounding-review.repair",
    ]);
  });

  it("marks the deterministic fallback as a technical failure, never a normal grounded answer", () => {
    const response = technicalFailureResponse("trace-123");

    expect(response).toMatchObject({ status: "failed", grounded: false, source: "technical_fallback" });
    expect(response.message).not.toContain("Family One");
  });
});
