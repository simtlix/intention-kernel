import { describe, expect, it } from "vitest";
import { agentId, capabilityId, defineAgent, defineCapability, defineSchema } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { interpretTurn } from "../../src/interpreter/interpretTurn.js";
import { createTurnPlan } from "../../src/planner/createTurnPlan.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: value => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });
const owner = capabilityId("exchange.decide");
const extra = capabilityId("credit.discover");

async function runCase(options: { message: string; supported: boolean; noAnswer?: boolean; omitOwner?: boolean; lifecycle?: boolean; malformed?: boolean; stubborn?: boolean; privateValue?: boolean; reviewError?: boolean }) {
  const compiled = await compileAgentDefinition(defineAgent({ id: agentId("deferred.choice"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
    capabilities: [owner, extra].map(id => defineCapability({ id, version: 1, description: id === owner ? "Decide whether to include the quoted exchange" : "Read available credit lines when explicitly requested", input: schema, output: schema,
      requires: [], provides: [], effect: "read", execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }) })),
  }));
  const evidence = [{ text: options.message, meaning: "Current request", messageIndex: 0 }];
  const operation = (id: string) => ({ proposedCapability: id, objective: id, input: { request: options.message }, resolution: "resolved", evidence, references: [] });
  const privateValue = "private-choice-target";
  const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: options.message, at: "2026-09-06T12:00:00Z" }, checkpoint: {
    schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, facts: [], effects: [], messages: [],
    agenda: [{ id: "older-credit" as never, status: "waiting_input", dependencies: [], missingFacts: [],
      ...(options.privateValue ? { modelRedactions: [privateValue] } : {}),
      intention: { id: "older-intention" as never, ...operation(extra), proposedCapability: extra, resolution: "resolved" } }],
    interaction: { id: "exchange-choice" as never, kind: "choice", capabilityId: owner, goal: "¿Querés incluir el usado cotizado?", requestedFacts: [],
      options: [{ id: "include", label: "Include", value: { decision: "include" }, targetCapabilityId: owner },
        { id: "exclude", label: "Exclude", value: { decision: "exclude", ...(options.privateValue ? { target: privateValue } : {}) }, targetCapabilityId: owner }] },
  } });
  const answer = { interactionId: "exchange-choice", value: snapshot.interaction?.options?.[1]?.value, evidence: options.message };
  const lifecycleActions = options.lifecycle ? [{ kind: "cancel_agenda_item", targetId: "older-credit", evidence: evidence[0] }] : [];
  const intentions = [...(options.omitOwner ? [] : [operation(owner)]), { ...operation(extra), input: { request: options.message, ...(options.privateValue ? { target: privateValue } : {}) } }];
  const requests: ModelRequest<unknown>[] = [];
  const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
    requests.push(request);
    const input = request.input as { reviewKind?: string; proposedOption?: unknown; selection?: { capabilityIds: string[] } };
    let value: unknown;
    if (request.task === "capability.select") value = { mode: options.lifecycle ? "selected_with_control" : "selected", capabilityIds: [owner, extra], rationale: "Current choice and possible additional request", evidence };
    else if (request.task === "capability-selection.choice-review") value = { meaning: "operation_request", operationCapabilityIds: [owner, ...(options.supported ? [extra] : [])], rationale: "Current request can include the active choice and another operation." };
    // Captured failure: the preliminary mixed vote removes an explicitly requested same-journey operation.
    else if (request.task === "capability-selection.interaction-review") value = { verdict: "unsupported", rationale: "Credit is merely the next stage of the same journey." };
    else if (request.task === "capability.select.repair") value = { mode: "selected", capabilityIds: [owner], rationale: "Only owner survived preliminary review", evidence };
    else if (request.task === "turn.interpret") value = { intentions: input.selection?.capabilityIds.includes(extra) ? intentions : [operation(owner)], contradictions: [], ...(options.noAnswer ? {} : { answerToInteraction: answer }), ...(options.lifecycle ? { lifecycleActions } : {}) };
    else if (request.task === "turn.interpret.repair") value = { intentions: options.stubborn ? intentions : options.omitOwner ? [] : [operation(owner)], contradictions: [], ...(options.noAnswer ? {} : { answerToInteraction: answer }), ...(options.lifecycle ? { lifecycleActions } : {}) };
    else if (request.task === "lifecycle.review") value = { reviews: [{ actionIndex: 0, verdict: "supported", rationale: "The user explicitly abandons the older request." }] };
    else if (input.proposedOption !== undefined) value = { decision: "selected", optionId: "exclude", rationale: "Explicit rejection selects the current exclude option." };
    else if (input.reviewKind === "omitted_choice_answer") value = { verdict: "unsupported", optionId: null, rationale: "The user has not selected an option." };
    else if (input.reviewKind === "choice_intention_independence") {
      if (options.reviewError) throw new Error("synthetic-review-unavailable");
      value = options.malformed ? { verdict: "broken" } : { verdict: options.supported ? "supported" : "unsupported", rationale: options.supported ? "The current message explicitly asks to see credit lines." : "The additional operation is inferred from older work, not requested now." };
    }
    else value = { verdict: "supported", rationale: "Explicit lifecycle control." };
    return Promise.resolve({ value: value as T, provider: "scripted", model: "test", durationMs: 0 });
  } };
  const result = interpretTurn({ snapshot, compiled, gateway, signal: AbortSignal.timeout(2000),
    ...(options.noAnswer || options.privateValue ? { selection: { mode: options.lifecycle ? "selected_with_control" as const : "selected" as const, capabilityIds: [owner, extra], rationale: "Over-approximate shortlist", evidence } } : {}) });
  return { result, requests, snapshot, compiled };
}

describe("ordinary-choice extras are authorized from interpreted operations, not the shortlist", () => {
  it("preserves CE20's explicit exclusion plus request for financing", async () => {
    const setup = await runCase({ message: "NO, quiero ver financiacion", supported: true });
    const batch = await setup.result;
    const plan = await createTurnPlan({ batch, snapshot: setup.snapshot, compiled: setup.compiled, ids: { next: kind => kind } });
    expect(plan.steps.map(step => step.capabilityId)).toEqual([owner, extra]);
    expect(batch.answerToInteraction?.value).toEqual({ decision: "exclude" });
    expect(setup.requests.filter(request => request.task === "capability-selection.interaction-review")).toHaveLength(0);
    expect(setup.requests.filter(request => (request.input as { reviewKind?: string }).reviewKind === "choice_intention_independence")).toHaveLength(1);
  });

  it("does not infer financing from NO alone", async () => {
    const setup = await runCase({ message: "NO", supported: false });
    const batch = await setup.result;
    expect(batch.intentions.map(intention => intention.proposedCapability)).toEqual([owner]);
    expect(batch.answerToInteraction?.value).toEqual({ decision: "exclude" });
    expect(setup.requests.filter(request => request.task === "turn.interpret.repair")).toHaveLength(1);
  });

  it.each([{ omitOwner: false }, { omitOwner: true }, { omitOwner: true, lifecycle: true }])(
    "blocks unrequested extras with no answer, including omitted owner/lifecycle: %j", async flags => {
      const setup = await runCase({ message: flags.lifecycle ? "Cancelá la consulta anterior; todavía no decido sobre el usado" : "Todavía no decido sobre el usado", supported: false, noAnswer: true, ...flags });
      const batch = await setup.result;
      expect(batch.intentions.map(intention => intention.proposedCapability)).toEqual(flags.omitOwner ? [] : [owner]);
      expect(batch.answerToInteraction).toBeUndefined();
      expect(setup.requests.filter(request => request.task === "turn.interpret.repair")).toHaveLength(1);
      expect(setup.snapshot.interaction?.id).toBe("exchange-choice");
      expect(setup.snapshot.agenda[0]?.id).toBe("older-credit");
    },
  );

  it("keeps a genuinely requested extra without manufacturing an answer or owner", async () => {
    const setup = await runCase({ message: "Todavía no decido sobre el usado; quiero ver financiación", supported: true, noAnswer: true, omitOwner: true });
    const batch = await setup.result;
    expect(batch.intentions.map(intention => intention.proposedCapability)).toEqual([extra]);
    expect(batch.answerToInteraction).toBeUndefined();
  });

  it.each([{ malformed: true }, { stubborn: true }])("does not admit empty/unreviewed repair for malformed or rejected evidence: %j", async flags => {
    const setup = await runCase({ message: "Todavía no decido", supported: false, noAnswer: true, omitOwner: true, ...flags });
    await expect(setup.result).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    expect(setup.requests.filter(request => request.task === "turn.interpret.repair")).toHaveLength(1);
  });

  it("does not turn a failed reviewer call into supported abstention or execution", async () => {
    const setup = await runCase({ message: "Todavía no decido", supported: false, noAnswer: true, omitOwner: true, reviewError: true });
    await expect(setup.result).rejects.toThrow("synthetic-review-unavailable");
    expect(setup.requests.filter(request => request.task === "turn.interpret.repair")).toHaveLength(0);
    expect(setup.snapshot.interaction?.id).toBe("exchange-choice");
  });

  it("redacts private choice values and operation inputs at the final reviewer boundary", async () => {
    const setup = await runCase({ message: "NO, quiero ver financiacion", supported: true, privateValue: true });
    const batch = await setup.result;
    const review = setup.requests.find(request => (request.input as { reviewKind?: string }).reviewKind === "choice_intention_independence");
    expect(review).toBeDefined();
    expect(JSON.stringify(review?.input)).not.toContain("private-choice-target");
    expect(batch.answerToInteraction?.value).toEqual({ decision: "exclude", target: "private-choice-target" });
  });
});
