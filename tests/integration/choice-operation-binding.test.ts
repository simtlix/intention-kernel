import { describe, expect, it } from "vitest";
import { agentId, capabilityId, defineAgent, defineCapability, defineSchema } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { selectCapabilities } from "../../src/interpreter/selectCapabilities.js";
import { interpretTurn } from "../../src/interpreter/interpretTurn.js";
import { createTurnPlan } from "../../src/planner/createTurnPlan.js";
import { reviewChoiceCapabilitySelection } from "../../src/interpreter/reviewCapabilitySelection.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";

const selectId = capabilityId("product.select");
const searchId = capabilityId("product.search");
const hoursId = capabilityId("business.hours");
const signal = new AbortController().signal;
const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: value => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });
class Gateway implements ModelGateway {
  readonly requests: ModelRequest<unknown>[] = [];
  constructor(readonly responses: unknown[]) {}
  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.requests.push(request);
    if (this.responses.length === 0) throw Error("Unexpected review call");
    return Promise.resolve({ value: this.responses.shift() as T, provider: "scripted", model: "test", durationMs: 0 });
  }
}
async function fixture(text = "AT") {
  const compiled = await compileAgentDefinition(defineAgent({ id: agentId("choice.operation"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
    capabilities: [[selectId, "Choose exactly one displayed product, not refine filters"], [searchId, "Find or filter products"], [hoursId, "Read opening hours"]].map(([id, description]) => defineCapability({
      id: id as typeof selectId, version: 1, description: description as string, input: schema, output: schema, requires: [], provides: [], effect: "read",
      execute: () => { throw Error("Execution is outside this selection test"); },
    })),
  }));
  const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: text, at: "2026-09-06T14:00:00Z" }, checkpoint: {
    schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, facts: [], agenda: [], effects: [], messages: [],
    interaction: { id: "products" as never, kind: "choice", capabilityId: searchId, requestedFacts: [], goal: "Choose one product, or refine the search",
      options: [{ id: "first", label: "First automatic product", targetCapabilityId: selectId, value: "first" }, { id: "second", label: "Second automatic product", targetCapabilityId: selectId, value: "second" }] },
  } });
  const selection = { mode: "selected" as const, capabilityIds: [selectId], rationale: "Possible current selection", evidence: [{ text, meaning: "Current request", messageIndex: 0 }] };
  return { snapshot, selection, compiled };
}

describe("choice operation review binds requested operations to the proposed capability set", () => {
  it("resumes the sole durable collector with its original input without another interpretation call", async () => {
    const current = await fixture("2");
    const snapshot = { ...current.snapshot,
      interaction: { ...current.snapshot.interaction, id: "products" as never, kind: "choice" as const, capabilityId: selectId,
        goal: "Choose product", requestedFacts: [], options: current.snapshot.interaction?.options ?? [] },
      agenda: [{ id: "pending-collector" as never, status: "waiting_input" as const, dependencies: [], missingFacts: [],
        intention: { id: "durable-intention" as never, objective: "Original operation", proposedCapability: selectId,
          input: { original: "preserved" }, resolution: "resolved" as const, references: [], evidence: current.selection.evidence } }],
    };
    const gateway = new Gateway([current.selection, { meaning: "unique_option", optionId: "second", rationale: "Current second option." }]);
    const selection = await selectCapabilities({ snapshot, gateway, signal });
    const batch = await interpretTurn({ ...current, snapshot, selection, gateway, signal });
    const plan = await createTurnPlan({ batch, snapshot, compiled: current.compiled, ids: { next: kind => kind } });
    expect(batch.intentions).toEqual([]);
    expect(batch.answerToInteraction?.value).toBe("second");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.input).toEqual({ original: "preserved" });
    expect(plan.steps[0]?.interactionAnswer?.value).toBe("second");
    expect(gateway.requests.map(r => r.task)).toEqual(["capability.select", "capability-selection.choice-review"]);
  });
  it.each(["2", "la segunda"])("preserves the reviewed option for %s when interpretation repeats an earlier request", async text => {
    const current = await fixture(text);
    const gateway = new Gateway([current.selection,
      { meaning: "unique_option", optionId: "second", rationale: "The current positional reference selects the second product." },
      { intentions: [{ objective: "Earlier search", proposedCapability: selectId, resolution: "resolved", references: [], input: { request: "previous message" }, evidence: current.selection.evidence }], contradictions: [] },
    ]);
    const selection = await selectCapabilities({ snapshot: current.snapshot, gateway, signal });
    const batch = await interpretTurn({ ...current, selection, gateway, signal });
    expect(batch.answerToInteraction).toMatchObject({ interactionId: "products", value: "second", evidence: text });
    expect(gateway.requests.map(r => r.task)).toEqual(["capability.select", "capability-selection.choice-review", "turn.interpret"]);
  });

  it.each([undefined, "old-page-option"])("rejects a unique option without a current binding: %s", async optionId => {
    const current = await fixture("2");
    const gateway = new Gateway([{ meaning: "unique_option", ...(optionId === undefined ? {} : { optionId }), rationale: "Unbound choice." }]);
    expect((await reviewChoiceCapabilitySelection({ ...current, gateway, signal })).issues.length).toBeGreaterThan(0);
  });

  it("preserves the reviewed answer through repair even if the interpreter proposes a different option", async () => {
    const current = await fixture("la segunda");
    const intention = { objective: "Choose product", proposedCapability: selectId, resolution: "resolved", references: [], input: {}, evidence: current.selection.evidence };
    const gateway = new Gateway([current.selection,
      { meaning: "unique_option", optionId: "second", rationale: "The current second option is selected." },
      { intentions: [{ ...intention, resolution: "invalid" }], contradictions: [] },
      { intentions: [intention], contradictions: [], answerToInteraction: { interactionId: "products", value: "first", evidence: "earlier message" } },
    ]);
    const selection = await selectCapabilities({ snapshot: current.snapshot, gateway, signal });
    const batch = await interpretTurn({ ...current, selection, gateway, signal });
    expect(batch.answerToInteraction).toMatchObject({ value: "second", evidence: "la segunda" });
    expect(gateway.requests.map(r => r.task)).toEqual(["capability.select", "capability-selection.choice-review", "turn.interpret", "turn.interpret.repair"]);
  });

  it.each(["message", "interaction", "page"])("does not reuse a choice review after the %s changes", async change => {
    const current = await fixture("2");
    const gateway = new Gateway([current.selection, { meaning: "unique_option", optionId: "second", rationale: "Current second option." }]);
    const selection = await selectCapabilities({ snapshot: current.snapshot, gateway, signal });
    const interaction = current.snapshot.interaction;
    if (interaction === undefined) throw Error("Fixture interaction is required");
    const snapshot = { ...current.snapshot,
      ...(change === "message" ? { currentMessage: { ...current.snapshot.currentMessage, content: "another request" } } : {}),
      ...(change === "interaction" ? { interaction: { ...interaction, id: "new-choice" as never } } : {}),
      ...(change === "page" ? { interaction: { ...interaction, options: [{ id: "new-page-option", label: "New option", value: "new" }] } } : {}),
    };
    await expect(interpretTurn({ ...current, snapshot, selection, gateway, signal })).rejects.toMatchObject({ code: "CAPABILITY_SELECTION_INVALID" });
    expect(gateway.requests).toHaveLength(2);
  });
  it("repairs the AT shortlist to search when the reviewed operation is not selection", async () => {
    const current = await fixture();
    const gateway = new Gateway([current.selection,
      { meaning: "operation_request", operationCapabilityIds: [searchId], rationale: "AT requests a search refinement, not a unique product." },
      { ...current.selection, capabilityIds: [searchId] }]);
    const selected = await selectCapabilities({ snapshot: current.snapshot, gateway, signal });
    expect(selected.capabilityIds).toEqual([searchId]);
    expect(gateway.requests.map(r => r.task)).toEqual(["capability.select", "capability-selection.choice-review", "capability.select.repair"]);
    const repair = gateway.requests[2]?.input as { validationIssues: { path: string[]; message: string }[] };
    expect(repair.validationIssues[0]?.path).toEqual(["capabilityIds"]);
    expect(repair.validationIssues[0]?.message).toContain(searchId);
    expect(current.snapshot.interaction?.id).toBe("products");
  });

  it.each([
    { meaning: "operation_request", rationale: "Unbound operation type is not authority." },
    { meaning: "operation_request", operationCapabilityIds: [], rationale: "No operation is bound." },
    { meaning: "operation_request", operationCapabilityIds: ["invented.operation"], rationale: "Not a registered capability." },
    { meaning: "operation_request", operationCapabilityIds: [selectId, selectId], rationale: "Duplicate bindings." },
  ])("rejects missing, empty, unknown or duplicated bindings: %j", async value => {
    const current = await fixture();
    const gateway = new Gateway([value]);
    expect((await reviewChoiceCapabilitySelection({ ...current, gateway, signal })).issues).not.toEqual([]);
    expect(gateway.requests).toHaveLength(1);
  });

  it("accepts a supported operation only when its registered ID is already shortlisted", async () => {
    const current = await fixture("Quiero elegir la primera");
    const gateway = new Gateway([{ meaning: "operation_request", operationCapabilityIds: [selectId], rationale: "An explicit request to choose a product is covered by product.select." }]);
    expect((await reviewChoiceCapabilitySelection({ ...current, gateway, signal })).issues).toEqual([]);
  });

  it("retains a compound shortlist without giving the reviewer execution authority over extras", async () => {
    const current = await fixture("La primera y además los horarios");
    const selection = { ...current.selection, capabilityIds: [selectId, hoursId] };
    const gateway = new Gateway([selection, { meaning: "operation_request", operationCapabilityIds: [selectId, hoursId], rationale: "Both current operations are represented." }]);
    expect((await selectCapabilities({ snapshot: current.snapshot, gateway, signal })).capabilityIds).toEqual([selectId, hoursId]);
    expect(gateway.requests).toHaveLength(2);
  });

  it("does not append or route a reviewer-only capability when selection repair ignores it", async () => {
    const current = await fixture();
    const review = { meaning: "operation_request", operationCapabilityIds: [searchId], rationale: "The request is filtering, not selection." };
    const gateway = new Gateway([current.selection, review, current.selection, review]);
    const result = await selectCapabilities({ snapshot: current.snapshot, gateway, signal });
    expect(result.mode).toBe("conversational");
    expect(result.capabilityIds).toEqual([]);
    expect(gateway.requests.filter(r => r.task === "capability.select.repair")).toHaveLength(1);
    expect(current.snapshot.interaction?.id).toBe("products");
  });

  it.each(["unique_option", "ambiguous_or_unrelated"])("preserves the existing %s branch without inventing operation bindings", async meaning => {
    const current = await fixture();
    const gateway = new Gateway([{ meaning, ...(meaning === "unique_option" ? { optionId: "first" } : {}), rationale: "Current option reference decision." }]);
    const { issues } = await reviewChoiceCapabilitySelection({ ...current, gateway, signal });
    expect(issues.length === 0).toBe(meaning === "unique_option");
  });
});
