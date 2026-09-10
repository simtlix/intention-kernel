import { describe, expect, it } from "vitest";
import { z } from "zod";

import { agentId, capabilityId, createKernel, defineAgent, defineCapability, defineSchema, evidenceId, interactionId, threadId, turnId } from "../../src/index.js";
import type { AgendaItemId, IntentionId } from "../../src/contracts/ids.js";
import type { AgendaItem } from "../../src/contracts/agenda.js";
import type { CapabilityResult } from "../../src/contracts/capability.js";
import type { KernelCheckpoint } from "../../src/contracts/checkpoint.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";
import type { ResponseBrief } from "../../src/contracts/response.js";
import { createMemoryDurability } from "../../src/testing/createMemoryDurability.js";
import { observeModelRequest } from "../../src/runtime/modelObservation.js";

const rawInput = z.strictObject({ request: z.string().min(1) });
const requestSchema = defineSchema<{ request: string }>({ vendor: "zod",
  validate: (value) => {
    const parsed = rawInput.safeParse(value);
    return parsed.success ? { value: parsed.data } : { issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
  }, jsonSchema: () => z.toJSONSchema(rawInput),
});
const outputSchema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });

type Proposal = "owner" | "owner_hours" | "owner_extra_hours" | "hours" | "extra" | "empty";
interface FixtureOptions {
  initial: Proposal;
  repaired?: Proposal;
  pending?: AgendaItem["status"];
  crossOwner?: boolean;
  answerForm?: "value" | "option_id" | "misbound_option" | "structured";
  submittedOptionId?: string;
  conversational?: boolean;
  protectedWrite?: boolean;
  duplicatePending?: boolean;
  numeric?: { text: string; optionId: string; reject: boolean; noLiteralTwo?: boolean; referenceExamples?: readonly string[] };
}

async function fixture(options: FixtureOptions) {
  const owner = capabilityId("credit.selectOption");
  const hours = capabilityId("office.hours");
  const extra = capabilityId("purchase.decidePayment");
  const crossOwner = options.crossOwner ?? options.pending === undefined;
  const message = options.numeric?.text ?? "Elijo la primera por quince millones y además quiero saber los horarios";
  const choice = { id: interactionId("credit-choice"), kind: "choice" as const,
    capabilityId: crossOwner ? extra : owner, goal: "¿Qué opción elegís?", requestedFacts: [],
    options: options.numeric === undefined
      ? [{ id: "credit-one", label: "Primera opción", targetCapabilityId: owner, value: { optionId: "credit-one", source: "published" } }]
      : [{ id: options.numeric.noLiteralTwo ? "term-twelve" : "term-two", label: options.numeric.noLiteralTwo ? "12 cuotas" : "2 cuotas", targetCapabilityId: owner, value: { optionId: options.numeric.noLiteralTwo ? "term-twelve" : "term-two", source: "published" }, ...(options.numeric.referenceExamples === undefined ? {} : { referenceExamples: options.numeric.referenceExamples }) },
          { id: "term-eighteen", label: "18 cuotas", targetCapabilityId: owner, value: { optionId: "term-eighteen", source: "published" } },
          { id: "term-twenty-four", label: "24 cuotas", targetCapabilityId: owner, value: { optionId: "term-twenty-four", source: "published" } }],
  };
  const selectedOptionId = options.numeric?.optionId ?? "credit-one";
  const canonicalAnswer = { interactionId: choice.id, value: { optionId: selectedOptionId, source: "published" }, evidence: message };
  const answer = options.answerForm === "option_id" ? { ...canonicalAnswer, value: "credit-one" }
    : options.answerForm === "misbound_option" ? { ...canonicalAnswer, interactionId: "model-reconstructed", value: { optionId: "credit-one", valueRef: "incorrect" } }
      : canonicalAnswer;
  const evidence = [{ text: message, meaning: "Explicit current request", messageIndex: 1 }];
  const intention = (id: typeof owner) => ({ id: `request-${id}` as IntentionId, objective: id, proposedCapability: id,
    input: { request: message }, evidence, references: [], resolution: "resolved" as const,
  });
  const proposal = (value: Proposal) => ({ contradictions: [], answerToInteraction: answer,
    intentions: (value === "empty" ? [] : value === "hours" ? [hours] : value === "extra" ? [extra]
      : value === "owner" ? [owner] : value === "owner_hours" ? [owner, hours] : [owner, extra, hours]).map(intention),
  });
  const pending: AgendaItem = { id: "pending-owner" as AgendaItemId, intention: { ...intention(owner), input: { request: "Original request retained verbatim" } },
    status: options.pending ?? "waiting_input", missingFacts: [], dependencies: [], continuation: { selectedSource: "durable" }, modelRedactions: ["private-state-marker"],
  };
  const requests: ModelRequest<unknown>[] = [];
  const calls: { capability: string; input: unknown; answer: unknown; continuation: unknown }[] = [];
  const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
    requests.push(request);
    let value: unknown;
    if (request.task === "capability.select") value = { mode: options.conversational ? "conversational" : "selected", capabilityIds: options.conversational ? [] : options.numeric === undefined ? [owner, hours, extra] : options.initial === "owner_hours" ? [owner, hours] : [owner], rationale: "Answer plus possible independent work", evidence };
    else if (request.task === "capability.select.repair") value = { mode: "conversational", capabilityIds: [], rationale: "The current reference is ambiguous.", evidence };
    else if (request.task === "turn.interpret") value = proposal(options.initial);
    else if (request.task === "turn.interpret.repair") value = options.numeric?.reject || options.numeric?.referenceExamples?.includes("2")
      ? { intentions: [], contradictions: [] } : proposal(options.repaired ?? options.initial);
    else if (request.task === "capability-selection.choice-review") value = { meaning: "operation_request", operationCapabilityIds: [owner], rationale: "The owner operation is shortlisted; detailed interpretation and answer review must evaluate its proposed option." };
    else if ((request.input as { proposedOption?: unknown }).proposedOption !== undefined) {
      value = options.numeric?.reject
        ? { decision: "not_selection", rationale: "The current words do not commit to an option." }
        : { decision: "selected", optionId: selectedOptionId, rationale: "The exact offered option is selected." };
    }
    else if (request.task === "interaction-answer.review" || request.task === "capability-selection.interaction-review") {
      const input = request.input as { reviewKind?: string; proposedIntentions?: readonly { proposedCapability?: string }[] };
      const independentReview = input.reviewKind === "choice_intention_independence";
      // A parent operation is not independently requested. The hours query is.
      const proposed = requests.some(({ task }) => task === "turn.interpret.repair") ? options.repaired ?? options.initial : options.initial;
      value = { verdict: (request.task === "interaction-answer.review" && options.numeric?.reject) ||
        (independentReview && (proposed === "extra" || proposed === "owner_extra_hours")) ? "unsupported" : "supported",
        rationale: "The option and hours are explicit; a separate parent payment decision is not requested." };
    } else if (request.task.startsWith("response.compose")) {
      const input = request.input as ResponseBrief & { brief?: ResponseBrief };
      const brief = input.brief ?? input;
      value = { parts: [ ...(brief.requiredResponses ?? []).map((entry) => ({ text: entry.message, evidenceIds: entry.claims.flatMap((claim) => claim.evidenceIds) })),
        ...(brief.interaction === undefined ? [] : [{ text: brief.interaction.goal, evidenceIds: [] }]),
      ] };
    } else if (request.task === "response.grounding-review") {
      const input = request.input as { response: { claims: readonly unknown[] } };
      value = { verdict: "supported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: input.response.claims.map((_, index) => index) };
    } else throw new Error(`Unexpected model task: ${request.task}`);
    return Promise.resolve({ value: value as T, provider: "scripted", model: "offline", durationMs: 1 });
  } };
  const capabilities = [owner, hours, extra].map((id) => defineCapability({ id, version: 1, description: id,
    input: requestSchema, output: outputSchema, requires: [], provides: [],
    effect: options.protectedWrite && id === owner ? "write" : "read",
    ...(options.protectedWrite && id === owner ? { confirmation: "required" as const } : {}),
    execute: (context, input): Promise<CapabilityResult<Record<string, unknown>>> => {
      calls.push({ capability: id, input, answer: context.turn.interactionAnswer?.value, continuation: context.turn.continuation });
      const content = id === owner ? "Opción elegida procesada." : id === hours ? "Horario verificado: de 9 a 18." : "Operación no solicitada.";
      const source = evidenceId(`evidence-${id}`);
      return Promise.resolve({ status: "completed", output: {}, facts: [], artifacts: [], evidence: [{ id: source, source: "capability", content }],
        canonicalResponse: { message: content, claims: [{ text: content, evidenceIds: [source] }], required: true },
      });
    },
  }));
  const durability = createMemoryDurability();
  const agent = await createKernel({ modelGateway: gateway, durability }).compile(defineAgent({ id: agentId("choice-owner-continuity"), version: 1,
    identity: "Asesor", capabilities, policies: [], modelPolicy: {},
  }));
  const checkpoint: KernelCheckpoint = { schemaVersion: 1, revision: 1, agentFingerprint: agent.fingerprint, facts: [], effects: [], interaction: choice,
    agenda: options.pending === undefined ? [] : [pending, ...(options.duplicatePending ? [{ ...pending, id: "second-pending" as AgendaItemId }] : [])],
    messages: [{ role: "assistant", content: choice.goal, at: "2026-09-06T09:00:00Z" }],
  };
  const identity = { threadId: threadId("choice-owner"), turnId: turnId("answer") };
  await durability.withTurn({ ...identity, turnId: turnId("seed") }, async (scope) => { await scope.commit({ value: null, checkpoint: JSON.parse(JSON.stringify(checkpoint)) as KernelCheckpoint }); });
  const run = () => agent.run({ ...identity, input: { text: message },
    ...(options.answerForm === "structured" ? { selection: { interactionId: choice.id, optionId: options.submittedOptionId ?? selectedOptionId } } : {}),
  });
  const readCheckpoint = () => durability.withTurn({ ...identity, turnId: turnId("inspect") }, (scope) => Promise.resolve(scope.checkpoint));
  return { run, readCheckpoint, checkpoint, calls, requests, owner, hours, message, canonicalAnswer, pending };
}

describe("ordinary choice owning operation continuity", () => {
  it("exposes the verified click to selection and interpretation without replacing companion text", async () => {
    const setup = await fixture({ initial: "owner_hours", answerForm: "structured" });
    await setup.run();
    for (const task of ["capability.select", "turn.interpret"]) {
      const input = setup.requests.find(request => request.task === task)?.input as Record<string, unknown>;
      const context = (task === "capability.select" ? input : input["context"]) as Record<string, unknown>;
      expect(context["interactionSelection"]).toEqual({ interactionId: "credit-choice", optionId: "credit-one" });
      expect(context["currentMessage"]).toMatchObject({ content: setup.message });
      const observation = observeModelRequest(setup.requests.find(request => request.task === task) as ModelRequest<unknown>);
      expect(observation).toMatchObject({ context: { interactionSelection: { interactionId: "credit-choice", optionId: "credit-one" } } });
    }
    expect(setup.calls.map(call => call.capability).sort()).toEqual([setup.owner, setup.hours].sort());
    expect(setup.calls.find(call => call.capability === setup.owner)?.answer).toEqual(setup.canonicalAnswer.value);
    expect(await setup.readCheckpoint()).not.toHaveProperty("interactionSelection");
  });

  it("does not turn a free-text option reference into a host-verified click", async () => {
    const setup = await fixture({ initial: "owner_hours", answerForm: "option_id" });
    await setup.run();
    for (const task of ["capability.select", "turn.interpret"]) {
      const input = setup.requests.find(request => request.task === task)?.input as Record<string, unknown>;
      expect(task === "capability.select" ? input : input["context"]).not.toHaveProperty("interactionSelection");
    }
  });

  it("rejects an unknown clicked option before exposing it to the model", async () => {
    const setup = await fixture({ initial: "owner", answerForm: "structured", submittedOptionId: "not-published" });
    await expect(setup.run()).rejects.toMatchObject({ code: "INTERACTION_OPTION_NOT_FOUND" });
    expect(setup.requests).toEqual([]);
    expect(setup.calls).toEqual([]);
    expect(await setup.readCheckpoint()).toEqual(setup.checkpoint);
  });

  it.each(["term-two", "term-eighteen"])("preserves the pending choice when exact alias and position conflict despite model approval of %s", async (optionId) => {
    const setup = await fixture({ initial: "owner", pending: "waiting_input",
      numeric: { text: "2", optionId, reject: false, referenceExamples: ["2", "2 cuotas"] },
    });
    const result = await setup.run();
    expect(setup.calls).toEqual([]);
    expect(result.response.message).toContain("¿Qué opción elegís?");
    expect((JSON.parse(JSON.stringify(result.checkpoint)) as KernelCheckpoint).interaction).toEqual(setup.checkpoint.interaction);
  });

  it("does not let exact reference examples overrule a structured click", async () => {
    const setup = await fixture({ initial: "owner", answerForm: "structured",
      numeric: { text: "2", optionId: "term-two", reject: false, referenceExamples: ["2"] },
    });
    const result = await setup.run();
    expect(result.response.message).toContain("Opción elegida procesada.");
    expect(setup.calls[0]?.answer).toEqual({ optionId: "term-two", source: "published" });
  });

  it("redacts reference examples in both reviews while preserving durable server references", async () => {
    const setup = await fixture({ initial: "owner", pending: "waiting_input",
      numeric: { text: "24", optionId: "term-twenty-four", reject: false, referenceExamples: ["private-state-marker"] },
    });
    const result = await setup.run();
    expect(result.response.message).toContain("Opción elegida procesada.");
    for (const task of ["capability-selection.choice-review", "interaction-answer.review"]) {
      const input = setup.requests.find((request) => request.task === task)?.input as {
        currentChoice: { options: readonly { referenceExamples?: readonly string[] }[] };
      };
      expect(input.currentChoice.options[0]?.referenceExamples).toEqual(["[redacted]"]);
      expect(JSON.stringify(input)).not.toContain("private-state-marker");
    }
    expect(setup.checkpoint.interaction?.options?.[0]?.referenceExamples).toEqual(["private-state-marker"]);
  });

  it("does not treat a non-conflicting registered example as consent when semantic review rejects it", async () => {
    const setup = await fixture({ initial: "owner", pending: "waiting_input",
      numeric: { text: "24", optionId: "term-twenty-four", reject: true, referenceExamples: ["24"] },
    });
    const result = await setup.run();
    expect(setup.calls).toEqual([]);
    expect(result.response.message).toContain("¿Qué opción elegís?");
    expect(result.checkpoint.interaction).toEqual(setup.checkpoint.interaction);
  });

  it("preserves an explicit value with a genuinely independent query despite registered numeric examples", async () => {
    const setup = await fixture({ initial: "owner_hours",
      numeric: { text: "2 cuotas y además quiero saber los horarios", optionId: "term-two", reject: false, referenceExamples: ["2"] },
    });
    const result = await setup.run();
    expect(result.response.message).toContain("Opción elegida procesada.");
    expect(result.response.message).toContain("Horario verificado: de 9 a 18.");
    expect(setup.calls.map(({ capability }) => capability).sort()).toEqual([setup.owner, setup.hours].sort());
    expect(setup.calls.find(({ capability }) => capability === setup.hours)?.answer).toBeUndefined();
  });

  it.each([null, "2", [2], [""], [" "], Array.from({ length: 33 }, () => "two"), ["a".repeat(257)]].map((referenceExamples) => ({ referenceExamples })))("rejects malformed or unbounded reference examples before model or capability calls: $referenceExamples", async ({ referenceExamples }) => {
    const setup = await fixture({ initial: "owner", pending: "waiting_input",
      numeric: { text: "2", optionId: "term-two", reject: false, referenceExamples: referenceExamples as readonly string[] },
    });
    await expect(setup.run()).rejects.toMatchObject({ code: "INVALID_INTERACTION_REFERENCE_EXAMPLES" });
    expect(setup.requests).toEqual([]);
    expect(setup.calls).toEqual([]);
    expect(await setup.readCheckpoint()).toEqual(setup.checkpoint);
  });
  it("asks again instead of treating an ambiguous bare number as trusted positional consent", async () => {
    const setup = await fixture({ initial: "owner", pending: "waiting_input", numeric: { text: "2", optionId: "term-eighteen", reject: true } });
    const result = await setup.run();
    expect(setup.calls).toEqual([]);
    expect(result.response.message).toContain("¿Qué opción elegís?");
    expect(result.response.interaction?.options).toHaveLength(3);
    expect(result.checkpoint.interaction).toEqual(setup.checkpoint.interaction);
  });

  it.each([
    { text: "24", optionId: "term-twenty-four" },
    { text: "2", optionId: "term-eighteen", noLiteralTwo: true },
    { text: "la segunda", optionId: "term-eighteen" },
    { text: "2 cuotas", optionId: "term-two" },
    { text: "2", optionId: "term-two", structured: true },
    { text: "1", optionId: "term-two", referenceExamples: ["1"] },
    { text: "2", optionId: "term-eighteen", noLiteralTwo: true, referenceExamples: [] },
    { text: "2 cuotas", optionId: "term-two", referenceExamples: ["2"] },
  ])("executes only the semantically supported value or exact click: $text -> $optionId", async ({ text, optionId, structured, noLiteralTwo, referenceExamples }) => {
    const setup = await fixture({ initial: "owner", numeric: { text, optionId, reject: false, ...(noLiteralTwo ? { noLiteralTwo } : {}), ...(referenceExamples === undefined ? {} : { referenceExamples }) },
      ...(structured ? { answerForm: "structured" } : {}),
    });
    const result = await setup.run();
    expect(result.response.message).toContain("Opción elegida procesada.");
    expect(setup.calls).toHaveLength(1);
    expect(setup.calls[0]?.answer).toEqual({ optionId, source: "published" });
    if (!structured) {
      for (const task of ["capability-selection.choice-review", "interaction-answer.review"]) {
        const input = setup.requests.find((request) => request.task === task)?.input as {
          currentChoice?: { options: readonly { position: number; id: string; label: string }[] };
        };
        expect(input.currentChoice?.options.map(({ position, id, label }) => ({ position, id, label }))).toEqual([
          { position: 1, id: noLiteralTwo ? "term-twelve" : "term-two", label: noLiteralTwo ? "12 cuotas" : "2 cuotas" },
          { position: 2, id: "term-eighteen", label: "18 cuotas" },
          { position: 3, id: "term-twenty-four", label: "24 cuotas" },
        ]);
      }
    }
  });

  it.each(["value", "option_id", "misbound_option", "structured"] as const)("delivers both explicit requests with a %s answer and no repair", async (answerForm) => {
    const setup = await fixture({ initial: "owner_hours", answerForm });
    const result = await setup.run();
    expect(result.response.message).toContain("Opción elegida procesada.");
    expect(result.response.message).toContain("Horario verificado: de 9 a 18.");
    expect(setup.calls).toHaveLength(2);
    expect(setup.calls.find(({ capability }) => capability === setup.owner)?.answer).toEqual(setup.canonicalAnswer.value);
    expect(setup.calls.find(({ capability }) => capability === setup.hours)?.answer).toBeUndefined();
    expect(setup.requests.filter(({ task }) => task === "turn.interpret.repair")).toHaveLength(0);
  });

  it.each(["hours", "owner_extra_hours"] as const)("repairs %s without losing the explicit owner or the independent hours query", async (initial) => {
    const setup = await fixture({ initial, repaired: "owner_hours", answerForm: "option_id" });
    const result = await setup.run();
    expect(result.response.message).toContain("Opción elegida procesada.");
    expect(result.response.message).toContain("Horario verificado: de 9 a 18.");
    expect(setup.calls.map(({ capability }) => capability).sort()).toEqual([setup.owner, setup.hours].sort());
    expect(setup.calls.find(({ capability }) => capability === setup.owner)?.input).toEqual({ request: setup.message });
    expect(setup.calls.find(({ capability }) => capability === setup.hours)?.answer).toBeUndefined();
    expect(setup.requests.filter(({ task }) => task === "turn.interpret.repair")).toHaveLength(1);
  });

  it.each([
    { initial: "owner_extra_hours", repaired: "hours" },
    { initial: "hours", repaired: "hours" },
    { initial: "empty", repaired: "empty" },
  ] as const)("rejects a missing owner after bounded repair ($initial -> $repaired), without consuming the choice", async (options) => {
    const setup = await fixture(options);
    await expect(setup.run()).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    expect(setup.calls).toEqual([]);
    expect(await setup.readCheckpoint()).toEqual(setup.checkpoint);
    expect(setup.requests.filter(({ task }) => task === "turn.interpret.repair")).toHaveLength(1);
  });

  it.each([
    { initial: "empty", conversational: false },
    { initial: "empty", conversational: true },
    { initial: "extra", repaired: "empty" },
    { initial: "hours" },
  ] as const)("resumes only the exact waiting-input owner and preserves durable input ($initial)", async (options) => {
    const setup = await fixture({ ...options, pending: "waiting_input", answerForm: "misbound_option" });
    const result = await setup.run();
    expect(result.response.message).toContain("Opción elegida procesada.");
    expect(setup.calls.find(({ capability }) => capability === setup.owner)).toEqual({ capability: setup.owner,
      input: setup.pending.intention.input, answer: setup.canonicalAnswer.value, continuation: setup.pending.continuation,
    });
    expect(setup.calls).toHaveLength(options.initial === "hours" ? 2 : 1);
    if (options.initial === "hours") {
      expect(result.response.message).toContain("Horario verificado: de 9 a 18.");
      expect(setup.calls.find(({ capability }) => capability === setup.hours)?.answer).toBeUndefined();
    }
    expect(result.response.interaction).toBeUndefined();
  });

  it.each([
    { pending: "waiting_confirmation" }, { pending: "blocked" }, { pending: "waiting_facts" },
    { pending: "waiting_input", crossOwner: true }, { pending: "waiting_input", duplicatePending: true },
  ] as const)("does not invent or reuse ineligible owner authority: %j", async (options) => {
    const setup = await fixture({ initial: "hours", ...options });
    await expect(setup.run()).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    expect(setup.calls).toEqual([]);
    expect(await setup.readCheckpoint()).toEqual(setup.checkpoint);
  });

  it("keeps protected write confirmation when resuming a valid pending choice", async () => {
    const setup = await fixture({ initial: "empty", pending: "waiting_input", protectedWrite: true });
    const result = await setup.run();
    expect(result.response.interaction?.kind).toBe("confirmation");
    expect(result.response.message).toContain("Confirm before");
    expect(setup.calls).toEqual([]);
    expect((await setup.readCheckpoint())?.effects).toEqual([]);
  });
});
