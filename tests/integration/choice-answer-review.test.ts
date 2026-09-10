import { describe, expect, it } from "vitest";

import { capabilityId, interactionId, type IntentionId } from "../../src/contracts/ids.js";
import type { IntentionBatch } from "../../src/contracts/intention.js";
import type { Interaction } from "../../src/contracts/interaction.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";
import type { ContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { reviewChoiceAnswer as runReview } from "../../src/interpreter/reviewChoiceAnswer.js";

class ReviewGateway implements ModelGateway {
  readonly requests: ModelRequest<unknown>[] = [];
  constructor(readonly value: unknown) {}
  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.requests.push(request);
    return Promise.resolve({ value: this.value as T, provider: "test", model: "review", durationMs: 1 });
  }
}

const paymentChoice: Interaction = {
  id: interactionId("payment-choice"),
  kind: "choice",
  capabilityId: capabilityId("payment.choose"),
  requestedFacts: [],
  goal: "¿Querés sumar opciones de financiación a tu presupuesto?",
  options: [
    { id: "cash", label: "No, al contado", value: { method: "cash" } },
    { id: "finance", label: "Sí, con financiación", value: { method: "financing" } },
  ],
};

function snapshot(text: string, interaction: Interaction = paymentChoice): ContextSnapshot {
  return {
    conversation: { recentMessages: [], totalMessages: 0 },
    currentMessage: { role: "user", content: text, at: "2026-09-06T12:00:00.000Z", index: 0 },
    facts: [], agenda: [], capabilities: [], decisions: [], policies: [],
    selectedModelGuidancePolicies: [], omissions: [],
    interaction,
    agent: {
      id: "test", version: 1, identity: "Test agent",
      modelPolicy: { "turn.interpret": "interpret", "turn.interpret.repair": "repair" },
    },
  };
}

function batch(text: string, withQuote = false): IntentionBatch {
  return {
    answerToInteraction: {
      interactionId: paymentChoice.id, value: { method: "financing" }, evidence: "Sí",
    },
    intentions: [
      {
        id: "payment-intent" as IntentionId, objective: "Choose financing",
        evidence: [{ text: "Sí", meaning: "Proposed financing acceptance", messageIndex: 0 }],
        references: [], proposedCapability: capabilityId("payment.choose"), input: {}, resolution: "resolved",
      },
      ...(withQuote ? [{
        id: "quote-intent" as IntentionId, objective: "Quote the owned vehicle",
        evidence: [{ text, meaning: "Independently requested quotation", messageIndex: 0 }],
        references: [], proposedCapability: capabilityId("vehicle.quote"), input: {}, resolution: "resolved" as const,
      }] : []),
    ],
    contradictions: [],
  };
}

const signal = new AbortController().signal;

describe("ordinary choice answer semantic review", () => {
  it("keeps current positions and the proposed public option intact when a different label is redacted", async () => {
    const interaction: Interaction = {
      ...paymentChoice, goal: "Which office would you like?",
      options: [
        { id: "north", label: "North", referenceExamples: ["North"], value: { officeId: "north" } },
        { id: "south", label: "South", referenceExamples: ["South"], value: { officeId: "south" } },
      ],
    };
    const context = snapshot("2", interaction);
    const proposed: IntentionBatch = { intentions: [], contradictions: [],
      answerToInteraction: { interactionId: interaction.id, value: { officeId: "south" }, evidence: "2" },
    };
    const gateway = new ReviewGateway({ decision: "not_selection", rationale: "This test inspects input projection, not model semantics." });
    await runReview({ batch: proposed, snapshot: { ...context,
      conversation: { totalMessages: 1, recentMessages: [{ role: "user", content: "My previous profile uses North.", at: "2026-09-06T11:59:00.000Z", index: 0 }] },
      agenda: [{ id: "pending-office" as never, intention: { id: "choose-office" as IntentionId, objective: "Choose an office", evidence: [], references: [], resolution: "resolved", input: {} },
        status: "waiting_input", missingFacts: [], dependencies: [], modelRedactions: ["North"],
      }],
    }, gateway, signal });
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.input).toMatchObject({
      currentChoice: { options: [
        { id: "north", position: 1, label: "[redacted]", referenceExamples: ["[redacted]"] },
        { id: "south", position: 2, label: "South", referenceExamples: ["South"] },
      ] },
      proposedOption: { id: "south", position: 2, label: "South", value: { officeId: "south" } },
    });
    expect(interaction.options?.[0]?.label).toBe("North");
    expect(proposed.answerToInteraction?.value).toEqual({ officeId: "south" });
  });

  it("rejects a global yes attached to another request and asks repair to remove only answer-derived work", async () => {
    const text = "Sí, quiero cotizar un usado como parte de pago";
    const proposed = batch(text, true);
    const gateway = new ReviewGateway({
      decision: "not_selection", rationale: "The yes introduces the quotation request and never accepts financing.",
    });
    const issues = await runReview({ batch: proposed, snapshot: snapshot(text), gateway, signal });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["answerToInteraction"]);
    expect(issues[0]?.message).toContain("Remove answerToInteraction");
    expect(issues[0]?.message).toContain("intentions inferred solely from that answer");
    expect(issues[0]?.message).toContain("preserve independently requested intentions");
    expect(proposed.intentions).toHaveLength(2);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.task).toBe("interaction-answer.review");
    expect(gateway.requests[0]?.model).toBe("repair");
    expect(gateway.requests[0]?.input).toMatchObject({
      context: { currentMessage: { content: text }, interaction: paymentChoice },
      proposedAnswer: proposed.answerToInteraction,
      intentions: proposed.intentions,
    });
  });

  it.each(["Sí, quiero financiarlo", "Sí, quiero financiarlo y también cotizar mi usado"])(
    "accepts the exact financing commitment in %s without deleting a compound request", async (text) => {
      const proposed = batch(text, true);
      const gateway = new ReviewGateway({ decision: "selected", optionId: "finance", rationale: "Financing is explicitly requested." });
      expect(await runReview({ batch: proposed, snapshot: snapshot(text), gateway, signal })).toEqual([]);
      expect(proposed.intentions).toHaveLength(2);
      expect(gateway.requests).toHaveLength(1);
    },
  );

  it("bypasses model review for the exact server-validated selection", async () => {
    const proposed = batch("Sí");
    const gateway = new ReviewGateway({ decision: "not_selection", rationale: "Should not be called." });
    const issues = await runReview({
      batch: proposed, snapshot: snapshot("Sí"), gateway, signal,
      validatedInteractionAnswer: proposed.answerToInteraction,
    });
    expect(issues).toEqual([]);
    expect(gateway.requests).toHaveLength(0);
  });

  it("does not let validation of a different selected value bypass the review", async () => {
    const proposed = batch("Sí, quiero ver imágenes");
    const gateway = new ReviewGateway({ decision: "not_selection", rationale: "Only images were requested." });
    const issues = await runReview({
      batch: proposed, snapshot: snapshot("Sí, quiero ver imágenes"), gateway, signal,
      validatedInteractionAnswer: { interactionId: paymentChoice.id, value: { method: "cash" }, evidence: "click" },
    });
    expect(issues).toHaveLength(1);
    expect(gateway.requests).toHaveLength(1);
  });

  it("leaves confirmation, progression and absent answers to their existing owners", async () => {
    const proposed = batch("Sí");
    const gateway = new ReviewGateway(undefined);
    for (const interaction of [
      { ...paymentChoice, kind: "confirmation" as const },
      { ...paymentChoice, payload: { kind: "progression.group" } },
    ]) {
      expect(await runReview({ batch: proposed, snapshot: snapshot("Sí", interaction), gateway, signal })).toEqual([]);
    }
    expect(await runReview({
      batch: { intentions: [], contradictions: [] }, snapshot: snapshot("Hola"), gateway, signal,
    })).toEqual([]);
    expect(gateway.requests).toHaveLength(0);
  });

  it("uses the dedicated review model and fails closed on an invalid review result", async () => {
    const context = snapshot("Sí");
    const gateway = new ReviewGateway({ verdict: "maybe", rationale: "Ambiguous" });
    const issues = await runReview({
      batch: batch("Sí"),
      snapshot: { ...context, agent: { ...context.agent, modelPolicy: { "interaction-answer.review": "dedicated" } } },
      gateway, signal,
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toEqual(["answerToInteraction"]);
    expect(gateway.requests[0]?.model).toBe("dedicated");
  });
});
