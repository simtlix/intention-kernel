import { describe, expect, it } from "vitest";
import { agentId, capabilityId, defineAgent, defineCapability, defineSchema } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { selectCapabilities } from "../../src/interpreter/selectCapabilities.js";
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
  return { snapshot, selection };
}

describe("choice operation review binds requested operations to the proposed capability set", () => {
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
    expect(await reviewChoiceCapabilitySelection({ ...current, gateway, signal })).not.toEqual([]);
    expect(gateway.requests).toHaveLength(1);
  });

  it("accepts a supported operation only when its registered ID is already shortlisted", async () => {
    const current = await fixture("Quiero elegir la primera");
    const gateway = new Gateway([{ meaning: "operation_request", operationCapabilityIds: [selectId], rationale: "An explicit request to choose a product is covered by product.select." }]);
    expect(await reviewChoiceCapabilitySelection({ ...current, gateway, signal })).toEqual([]);
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
    const gateway = new Gateway([{ meaning, rationale: "Current option reference decision." }]);
    const issues = await reviewChoiceCapabilitySelection({ ...current, gateway, signal });
    expect(issues.length === 0).toBe(meaning === "unique_option");
  });
});
