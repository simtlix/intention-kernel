import { describe, expect, it } from "vitest";
import type { ContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { capabilityId, interactionId } from "../../src/contracts/ids.js";
import type { IntentionBatch } from "../../src/contracts/intention.js";
import type { Interaction } from "../../src/contracts/interaction.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";
import { reviewChoiceAnswer } from "../../src/interpreter/reviewChoiceAnswer.js";

const signal = new AbortController().signal;
function fixture(text = "2", options: Interaction["options"] = [
  { id: "north", label: "North", referenceExamples: ["North"], value: { office: "north" } },
  { id: "south", label: "South", referenceExamples: ["South"], value: { office: "south" } },
]) {
  const interaction: Interaction = { id: interactionId("offices"), kind: "choice",
    capabilityId: capabilityId("office.choose"), goal: "Which office would you like?", requestedFacts: [], options };
  const snapshot: ContextSnapshot = { interaction,
    currentMessage: { role: "user", content: text, at: "2026-09-06T12:00:00Z", index: 0 },
    conversation: { recentMessages: [], totalMessages: 0 }, facts: [], agenda: [], capabilities: [],
    decisions: [], policies: [], selectedModelGuidancePolicies: [], omissions: [],
    agent: { id: "test", version: 1, identity: "Assistant", modelPolicy: {} } };
  const batch: IntentionBatch = { intentions: [], contradictions: [], answerToInteraction: {
    interactionId: interaction.id, value: options.at(-1)?.value, evidence: text } };
  return { snapshot, batch };
}
class Gateway implements ModelGateway {
  readonly requests: ModelRequest<unknown>[] = [];
  constructor(readonly value: unknown) {}
  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.requests.push(request);
    return Promise.resolve({ value: this.value as T, provider: "test", model: "scripted", durationMs: 0 });
  }
}
function run(value: unknown, current = fixture()) {
  const gateway = new Gateway(value);
  return { gateway, result: reviewChoiceAnswer({ ...current, gateway, signal }) };
}

describe("ordinary choice review binds a structured decision to the exact current option", () => {
  it.each(["2", "The second", "The second, and also show the opening hours"])(
    "accepts a reviewed exact option without replacing the full message: %s", async text => {
      const current = fixture(text);
      const before = structuredClone(current);
      const { result, gateway } = run({ decision: "selected", optionId: "south", rationale: "Current position two." }, current);
      expect(await result).toEqual([]);
      expect(gateway.requests).toHaveLength(1);
      expect(gateway.requests[0]?.task).toBe("interaction-answer.review");
      expect(gateway.requests[0]?.input).toMatchObject({ context: { currentMessage: { content: text } }, proposedOption: { id: "south", position: 2 } });
      expect(current).toEqual(before);
    },
  );

  it("matches the unique private server value first, then exposes only its redacted projection", async () => {
    const secret = "private-office-code";
    const current = fixture("2", [
      { id: "north", label: "North", value: { office: "another-private-office" } },
      { id: "south", label: "South", value: { office: secret } },
    ]);
    current.snapshot = { ...current.snapshot, agenda: [{ id: "pending" as never,
      intention: { id: "choose" as never, objective: "Choose office", evidence: [], references: [], resolution: "resolved", input: {} },
      status: "waiting_input", missingFacts: [], dependencies: [], modelRedactions: [secret, "another-private-office"] }] };
    const answer = current.batch.answerToInteraction;
    if (answer === undefined) throw new Error("The fixture must include the proposed answer.");
    current.batch = { ...current.batch, intentions: [{ id: "hours" as never, objective: "Read opening hours", input: { location: secret },
      evidence: [], references: [], resolution: "resolved", proposedCapability: capabilityId("office.hours") }],
      answerToInteraction: { ...answer, rationale: `Select ${secret}` } };
    const { result, gateway } = run({ decision: "selected", optionId: "south", rationale: "Select the current second option." }, current);
    expect(await result).toEqual([]);
    expect(gateway.requests[0]?.input).toMatchObject({ proposedOption: { id: "south", value: { office: "[redacted]" } },
      proposedAnswer: { value: { office: "[redacted]" } }, intentions: [{ input: { location: "[redacted]" } }] });
    expect(JSON.stringify(gateway.requests[0]?.input)).not.toContain(secret);
    expect(gateway.requests[0]?.input).toMatchObject({ currentChoice: { options: [
      { id: "north", value: { office: "[redacted]" } }, { id: "south", value: { office: "[redacted]" } },
    ] } });
    expect(current.batch.answerToInteraction?.value).toEqual({ office: secret });
  });

  it.each([
    { decision: "selected", optionId: "north", rationale: "A different current option." },
    { decision: "selected", optionId: "old-option", rationale: "A historical option." },
    { decision: "ambiguous", optionIds: ["north", "south"], rationale: "Two current targets." },
    { decision: "ambiguous", optionIds: ["south", "south"], rationale: "Duplicate is not ambiguity." },
    { decision: "ambiguous", optionIds: ["south", "old-option"], rationale: "Historical is not current." },
    { decision: "not_selection", rationale: "The current message does not select." },
    { verdict: "supported", rationale: "The old unbound binary format is invalid." },
  ])("never authorizes the proposed value from $decision $optionId $verdict", async value => {
    const current = fixture();
    const { result, gateway } = run(value, current);
    expect((await result)[0]?.path).toEqual(["answerToInteraction"]);
    expect(gateway.requests).toHaveLength(1);
    expect(current.batch.answerToInteraction?.value).toEqual({ office: "south" });
  });

  it.each(["stale-interaction", "no-options", "duplicate-values"])("rejects %s before requesting a decision", async kind => {
    const current = fixture();
    const answer = current.batch.answerToInteraction;
    const interaction = current.snapshot.interaction;
    if (answer === undefined || interaction === undefined) throw new Error("The fixture must include the active choice and proposed answer.");
    if (kind === "stale-interaction") current.batch = { ...current.batch,
      answerToInteraction: { ...answer, interactionId: interactionId("old") } };
    if (kind === "no-options") current.snapshot = { ...current.snapshot, interaction: { ...interaction, options: [] } };
    if (kind === "duplicate-values") current.snapshot = { ...current.snapshot, interaction: { ...interaction, options: [
      { id: "north", label: "North", value: { office: "south" } }, { id: "south", label: "South", value: { office: "south" } },
    ] } };
    const { result, gateway } = run({ decision: "selected", optionId: "south", rationale: "Must not be consulted." }, current);
    expect((await result)[0]?.path).toEqual(["answerToInteraction"]);
    expect(gateway.requests).toHaveLength(0);
  });

  it("supports a single real option but rejects uncertainty or fabricated ambiguity", async () => {
    const current = fixture("South", [{ id: "south", label: "South", value: { office: "south" } }]);
    expect(await run({ decision: "selected", optionId: "south", rationale: "Exact choice." }, current).result).toEqual([]);
    for (const value of [{ decision: "not_selection", rationale: "Maybe is not commitment." },
      { decision: "ambiguous", optionIds: ["south", "south"], rationale: "No second target exists." }]) {
      expect(await run(value, { ...current, snapshot: { ...current.snapshot, currentMessage: { ...current.snapshot.currentMessage, content: "Maybe" } } }).result).not.toEqual([]);
    }
  });

  it("retains structural reference collisions and exact clicked choices without model votes", async () => {
    const current = fixture("2", [{ id: "two", label: "2 units", referenceExamples: ["2"], value: 2 },
      { id: "twelve", label: "12 units", referenceExamples: ["12"], value: 12 }]);
    const { result, gateway } = run({ decision: "selected", optionId: "twelve", rationale: "Must not override ambiguity." }, current);
    expect(await result).not.toEqual([]);
    expect(gateway.requests).toHaveLength(0);
    expect(await reviewChoiceAnswer({ ...current, gateway, signal, validatedInteractionAnswer: current.batch.answerToInteraction })).toEqual([]);
    expect(gateway.requests).toHaveLength(0);
  });
});
