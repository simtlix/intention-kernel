import { describe, expect, it } from "vitest";

import { capabilityId, interactionId } from "../../src/contracts/ids.js";
import type { Interaction } from "../../src/contracts/interaction.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";
import type { ContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { interpretTurn } from "../../src/interpreter/interpretTurn.js";
import { observeModelRequest } from "../../src/runtime/modelObservation.js";

const control = {
  id: "more", label: "Browse more entries", value: { operation: "next-page" },
  targetCapabilityId: capabilityId("inventory.list"),
};
const choice: Interaction = {
  id: interactionId("inventory-page"), kind: "choice", requestedFacts: [],
  capabilityId: capabilityId("inventory.list"), goal: "Which item would you like?",
  options: [{ id: "item", label: "First item", value: { item: "first" }, targetCapabilityId: capabilityId("inventory.pick") }, control],
};
const text = "Show me the rest";
const context: ContextSnapshot = {
  conversation: { recentMessages: [], totalMessages: 0 },
  currentMessage: { role: "user", content: text, at: "2026-09-06T12:00:00.000Z", index: 0 },
  facts: [], agenda: [], decisions: [], policies: [], selectedModelGuidancePolicies: [], omissions: [],
  interaction: choice,
  capabilities: ["inventory.list", "inventory.pick"].map((id) => ({
    id: capabilityId(id), description: id, inputSchema: { type: "object", additionalProperties: true },
    availability: "ready", blockedBy: [],
  })),
  agent: { id: "test", version: 1, identity: "Test agent", modelPolicy: {} },
};

class ControlGateway implements ModelGateway {
  readonly requests: ModelRequest<unknown>[] = [];
  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.requests.push(request);
    const answerToInteraction = { interactionId: choice.id, value: control.value, evidence: text };
    const proposedOption = (request.input as { proposedOption?: { id: string } }).proposedOption;
    const value = request.task === "interaction-answer.review"
      ? { decision: proposedOption?.id === control.id ? "selected" : "not_selection", ...(proposedOption?.id === control.id ? { optionId: control.id } : {}), rationale: "The user requests the offered navigation control, not an inventory item." }
      : {
          answerToInteraction, contradictions: [],
          intentions: request.task === "turn.interpret.repair" ? [{
            objective: "Browse more entries", proposedCapability: "inventory.list", input: { request: text },
            resolution: "resolved", references: [], evidence: [{ text, meaning: "Request more entries", messageIndex: 0 }],
          }] : [],
        };
    return Promise.resolve({ value: value as T, provider: "test", model: "test", durationMs: 1 });
  }
}

describe("ordinary choice navigation controls", () => {
  it("reviews the exact offered control after repairing its missing owning operation", async () => {
    const gateway = new ControlGateway();
    const result = await interpretTurn({
      snapshot: context, gateway, signal: AbortSignal.timeout(2_000),
      selection: { mode: "conversational", capabilityIds: context.capabilities.map(({ id }) => id), evidence: [], rationale: "Responding to the active list." },
    });
    expect(result.answerToInteraction?.value).toEqual(control.value);
    expect(result.intentions.map(({ proposedCapability }) => proposedCapability)).toEqual(["inventory.list"]);
    expect(gateway.requests.map(({ task }) => task)).toEqual(["turn.interpret", "turn.interpret.repair", "interaction-answer.review"]);
    const review = gateway.requests.at(-1);
    expect(review?.input).toMatchObject({ proposedOption: { position: 2, ...control } });
    expect(review?.system).toContain("navigation");
    expect(context.interaction?.options).toHaveLength(2);
  });

  it("preserves the reviewed option and current positions in the auditable request", async () => {
    const gateway = new ControlGateway();
    await interpretTurn({ snapshot: context, gateway, signal: AbortSignal.timeout(2_000),
      selection: { mode: "conversational", capabilityIds: context.capabilities.map(({ id }) => id), evidence: [], rationale: "Browse the active list." } });
    const review = gateway.requests.at(-1);
    expect(review).toBeDefined();
    expect(observeModelRequest(review as ModelRequest<unknown>)).toMatchObject({
      currentChoice: { id: choice.id, options: [{ position: 1 }, { position: 2 }] },
      proposedOption: { position: 2, ...control },
    });
  });
});
