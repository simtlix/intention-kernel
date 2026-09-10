import { describe, expect, it } from "vitest";
import { z } from "zod";

import { agentId, capabilityId, createKernel, defineAgent, defineCapability, defineSchema, evidenceId, interactionId, threadId, turnId } from "../../src/index.js";
import type { AgendaItemId, IntentionId } from "../../src/contracts/ids.js";
import type { CapabilityResult } from "../../src/contracts/capability.js";
import type { KernelCheckpoint } from "../../src/contracts/checkpoint.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";
import type { ResponseBrief } from "../../src/contracts/response.js";
import { createMemoryDurability } from "../../src/testing/createMemoryDurability.js";

const requestObject = z.strictObject({ request: z.string().min(1) });
const requestSchema = defineSchema<{ request: string }>({
  vendor: "zod",
  validate(value) {
    const parsed = requestObject.safeParse(value);
    return parsed.success ? { value: parsed.data } : { issues: parsed.error.issues.map(({ message, path }) => ({ message, path })) };
  },
  jsonSchema: () => z.toJSONSchema(requestObject),
});
const outputSchema = defineSchema<Record<string, unknown>>({
  vendor: "test", validate: value => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }),
});

interface FixtureOptions {
  pending?: boolean;
  compound?: boolean;
  acceptNull?: boolean;
  acceptMissing?: boolean;
  omitInput?: boolean;
  unresolved?: boolean;
  invalidRepair?: boolean;
  missingData?: boolean;
  confirmation?: "unsupported" | "supported";
  answerOnly?: "initial" | "repair";
  pendingStatus?: KernelCheckpoint["agenda"][number]["status"];
  duplicatePending?: boolean;
  staleAnswer?: boolean;
}

async function fixture(options: FixtureOptions = {}) {
  const owner = capabilityId("record.collect");
  const hours = capabilityId("office.hours");
  const write = capabilityId("record.publish");
  const message = options.confirmation === "unsupported" ? "Antes de confirmar, consultá el registro"
    : options.confirmation === "supported" ? "Confirmo publicarlo, y consultá el registro"
      : options.pending ? "dato-sintetico" : options.compound ? "Consultá el registro y el horario" : "Consultá el registro";
  const current = { id: interactionId("pending-input"), kind: "input" as const, capabilityId: owner,
    goal: "¿Cuál es el dato que falta?", requestedFacts: [],
  };
  const confirmation = { id: interactionId("pending-confirmation"), kind: "confirmation" as const,
    capabilityId: write, goal: "¿Confirmás publicar el registro?", requestedFacts: [],
    payload: { intention: { id: "original-write" as IntentionId, objective: "Publicar el registro", proposedCapability: write,
      input: { request: "Publicar el registro original" }, references: [], resolution: "resolved" as const,
      evidence: [{ text: "Publicar el registro original", meaning: "Requested publication", messageIndex: 0 }],
    }, input: { request: "Publicar el registro original" } },
  };
  const input = options.confirmation === undefined ? current : confirmation;
  const evidence = [{ text: message, meaning: "Current explicit request", messageIndex: 1 }];
  const intention = (id: typeof owner, value: unknown) => ({ objective: id, proposedCapability: id, ...(options.omitInput ? {} : { input: value }),
    references: [], resolution: "resolved" as const, evidence,
  });
  const answer = options.confirmation === undefined
    ? { interactionId: options.staleAnswer ? interactionId("stale-input") : current.id, value: message, evidence: message }
    : { interactionId: confirmation.id, value: true, evidence: options.confirmation === "supported" ? "Confirmo publicarlo" : "Antes de confirmar" };
  const requests: ModelRequest<unknown>[] = [];
  const calls: { capability: string; input: unknown; answer?: unknown; continuation?: unknown }[] = [];
  const gateway: ModelGateway = { invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    requests.push(request);
    let value: unknown;
    if (request.task === "capability.select") value = { mode: "selected", capabilityIds: options.compound ? [owner, hours] : [owner], evidence,
      rationale: "Explicit request and any active answer", };
    else if (request.task === "turn.interpret" || request.task === "turn.interpret.repair") {
      const repaired = request.task === "turn.interpret.repair" && !options.invalidRepair;
      const answerOnly = options.answerOnly === "initial" || (options.answerOnly === "repair" && repaired);
      value = { contradictions: [],
        intentions: options.unresolved
          ? [{ objective: "¿Qué registro?", input: null, references: [], evidence, resolution: "ambiguous", alternatives: ["El registro actual", "Un registro distinto"] }]
          : [...(answerOnly ? [] : [intention(owner, repaired ? { request: message } : null)]),
            ...(options.compound ? [intention(hours, repaired || answerOnly ? { request: "Consultar el horario" } : null)] : [])],
        ...(options.pending || options.confirmation !== undefined ? { answerToInteraction: answer } : {}),
      };
    } else if (request.task === "interaction-answer.review" || request.task === "capability-selection.interaction-review") {
      value = { verdict: request.task === "interaction-answer.review" && options.confirmation === "unsupported" ? "unsupported" : "supported",
        rationale: options.confirmation === "unsupported" ? "The current wording explicitly postpones confirmation." : "The current request and answer are explicit and independent.", };
    } else if (request.task.startsWith("response.compose")) {
      const projected = request.input as ResponseBrief & { brief?: ResponseBrief };
      const brief = projected.brief ?? projected;
      value = { parts: [ ...(brief.requiredResponses ?? []).map(entry => ({ text: entry.message, evidenceIds: entry.claims.flatMap(claim => claim.evidenceIds) })),
        ...(brief.interaction === undefined ? [] : [{ text: brief.interaction.goal, evidenceIds: [] }]),
      ] };
    } else if (request.task === "response.grounding-review") {
      const projected = request.input as { response: { claims: readonly unknown[] } };
      value = { verdict: "supported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: [],
        approvedClaimIndexes: projected.response.claims.map((_, index) => index), };
    } else throw new Error(`Unexpected task: ${request.task}`);
    return Promise.resolve({ value: value as T, provider: "scripted", model: "offline", durationMs: 1 });
  } };
  const nullSchema = defineSchema<null>({ vendor: "null", validate: value => value === null ? { value: null } : { issues: [{ message: "Expected null" }] },
    jsonSchema: () => ({ type: "null" }), });
  const missingSchema = defineSchema<undefined>({ vendor: "absent", validate: value => value === undefined ? { value: undefined } : { issues: [{ message: "Expected absent input" }] },
    jsonSchema: () => ({}), });
  const capabilities = [owner, hours, write].map(id => defineCapability({ id, version: 1, description: id,
    input: id === owner && options.acceptNull ? nullSchema : id === owner && options.acceptMissing ? missingSchema : requestSchema,
    output: outputSchema, requires: [], provides: [], effect: id === write ? "write" : "read",
    ...(id === write ? { confirmation: "required" as const } : {}),
    async execute(context, proposed): Promise<CapabilityResult<Record<string, unknown>>> {
      calls.push({ capability: id, input: proposed,
        ...(context.turn.interactionAnswer === undefined ? {} : { answer: context.turn.interactionAnswer.value }),
        ...(context.turn.continuation === undefined ? {} : { continuation: context.turn.continuation }),
      });
      if (id === owner && options.missingData) return { status: "needs_input", interaction: {
        ...current, id: interactionId("missing-amount"), goal: "¿Qué importe querés consultar?",
      }, partialInput: { prior: "retained", awaiting: "amount" } };
      const content = id === owner ? "Registro consultado." : id === hours ? "Horario verificado: 9 a 18." : "Publicación realizada.";
      const source = evidenceId(`evidence:${id}`);
      if (id === write) await context.runEffect("publication", () => Promise.resolve({ published: true }));
      return { status: "completed", output: { content }, facts: [], artifacts: [], evidence: [{ id: source, source: "capability", content }],
        canonicalResponse: { message: content, claims: [{ text: content, evidenceIds: [source] }], required: true }, };
    },
  }));
  const durability = createMemoryDurability();
  const agent = await createKernel({ modelGateway: gateway, durability }).compile(defineAgent({ id: agentId("operation-input-repair"), version: 1,
    identity: "Asesor", capabilities, policies: [], modelPolicy: {}, }));
  const thread = threadId("operation-input");
  const original: KernelCheckpoint = { schemaVersion: 1, revision: 1, agentFingerprint: agent.fingerprint, facts: [], effects: [],
    messages: [{ role: "assistant", content: options.pending || options.confirmation !== undefined ? input.goal : "¿Qué necesitás?", at: "2026-09-06T09:00:00Z" }],
    ...(options.pending || options.confirmation !== undefined ? { interaction: input } : {}),
    agenda: options.pending ? [{ id: "pending-owner" as AgendaItemId, intention: { ...intention(owner, { request: "Solicitud anterior" }), id: "prior-owner" as IntentionId },
      status: options.pendingStatus ?? "waiting_input", missingFacts: [], dependencies: [], continuation: { prior: "retained", awaiting: "field" }, }]
      : options.confirmation === undefined ? [] : [{ id: "pending-write" as AgendaItemId, intention: confirmation.payload.intention,
        status: "waiting_confirmation", missingFacts: [], dependencies: [], }],
  };
  if (options.duplicatePending && original.agenda[0] !== undefined) {
    (original as { agenda: KernelCheckpoint["agenda"] }).agenda = [...original.agenda,
      { ...original.agenda[0], id: "other-pending-owner" as AgendaItemId,
        intention: { ...original.agenda[0].intention, id: "other-owner-intention" as IntentionId } }];
  }
  await durability.withTurn({ threadId: thread, turnId: turnId("seed") }, async scope => {
    await scope.commit({ value: null, checkpoint: JSON.parse(JSON.stringify(original)) as KernelCheckpoint });
  });
  const checkpoint = () => durability.withTurn({ threadId: thread, turnId: turnId("inspect") }, scope => Promise.resolve(scope.checkpoint));
  const run = () => agent.run({ threadId: thread, turnId: turnId("answer"), input: { text: message } });
  return { run, requests, calls, checkpoint, original };
}

describe("resolved operation input repair", () => {
  it.each(["initial", "repair"] as const)("resumes the unique pending input from an %s answer-only proposal without reconstructing its operation", async answerOnly => {
    const setup = await fixture({ pending: true, answerOnly });
    const result = await setup.run();
    expect(result.response.message).toContain("Registro consultado.");
    expect(result.response.interaction).toBeUndefined();
    expect(setup.calls).toEqual([{ capability: "record.collect", input: { request: "Solicitud anterior" }, answer: "dato-sintetico",
      continuation: { prior: "retained", awaiting: "field" } }]);
    expect((await setup.checkpoint())?.agenda).toEqual([]);
    expect(setup.requests.filter(({ task }) => task === "turn.interpret.repair")).toHaveLength(answerOnly === "repair" ? 1 : 0);
    await setup.run();
    expect(setup.calls).toHaveLength(1);
  });

  it("keeps a companion request separate from the resumed input and does not transfer the answer to it", async () => {
    const setup = await fixture({ pending: true, answerOnly: "initial", compound: true });
    await setup.run();
    expect(setup.calls).toEqual(expect.arrayContaining([
      { capability: "record.collect", input: { request: "Solicitud anterior" }, answer: "dato-sintetico",
        continuation: { prior: "retained", awaiting: "field" } },
      { capability: "office.hours", input: { request: "Consultar el horario" } },
    ]));
    expect(setup.calls).toHaveLength(2);
  });

  it.each([
    { label: "blocked work", pendingStatus: "blocked" as const },
    { label: "waiting for facts", pendingStatus: "waiting_facts" as const },
    { label: "waiting for confirmation", pendingStatus: "waiting_confirmation" as const },
    { label: "ready work", pendingStatus: "ready" as const },
    { label: "multiple pending owners", duplicatePending: true },
    { label: "stale interaction", staleAnswer: true },
  ])("cannot borrow durable input authority from $label", async settings => {
    const setup = await fixture({ pending: true, answerOnly: "initial", compound: true, ...settings });
    await expect(setup.run()).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    expect(setup.calls).toEqual([]);
    expect(await setup.checkpoint()).toEqual(setup.original);
    expect(setup.requests.filter(({ task }) => task === "turn.interpret.repair")).toHaveLength(1);
  });

  it("processes a pending free-text answer with its durable private state instead of repeating the field", async () => {
    const setup = await fixture({ pending: true });
    const result = await setup.run();
    expect(result.response.message).toContain("Registro consultado.");
    expect(result.response.interaction).toBeUndefined();
    expect(setup.calls).toEqual([{ capability: "record.collect", input: { request: "dato-sintetico" }, answer: "dato-sintetico",
      continuation: { prior: "retained", awaiting: "field" } }]);
    expect((await setup.checkpoint())?.agenda).toEqual([]);
    expect(setup.requests.filter(({ task }) => task === "turn.interpret.repair")).toHaveLength(1);
    await setup.run();
    expect(setup.calls).toHaveLength(1);
  });

  it("repairs every independently requested operation in an initial compound turn", async () => {
    const setup = await fixture({ compound: true });
    const result = await setup.run();
    expect(result.response.message).toContain("Registro consultado.");
    expect(result.response.message).toContain("Horario verificado: 9 a 18.");
    expect(result.response.interaction).toBeUndefined();
    expect(setup.calls).toEqual(expect.arrayContaining([
      { capability: "record.collect", input: { request: "Consultá el registro y el horario" } },
      { capability: "office.hours", input: { request: "Consultar el horario" } },
    ]));
    expect(setup.calls).toHaveLength(2);
    const repair = setup.requests.find(({ task }) => task === "turn.interpret.repair");
    expect(repair?.input).toMatchObject({ validationIssues: [
      { path: ["intentions", 0, "input"] }, { path: ["intentions", 1, "input"] },
    ] });
  });

  it("preserves null when the selected capability explicitly accepts it", async () => {
    const setup = await fixture({ acceptNull: true });
    const result = await setup.run();
    expect(result.response.message).toContain("Registro consultado.");
    expect(setup.calls).toEqual([{ capability: "record.collect", input: null }]);
    expect(setup.requests.some(({ task }) => task === "turn.interpret.repair")).toBe(false);
  });

  it.each([
    { label: "explicit null", settings: { acceptNull: true }, present: true, value: null },
    { label: "absent input", settings: { acceptMissing: true, omitInput: true }, present: false, value: undefined },
  ])("preserves $label through pending checkpoint serialization without substituting the other", async ({ settings, present, value }) => {
    const setup = await fixture({ ...settings, missingData: true });
    const result = await setup.run();
    expect(result.response.interaction?.id).toBe("missing-amount");
    expect(setup.calls).toEqual([{ capability: "record.collect", input: value }]);
    const checkpoint = await setup.checkpoint();
    expect(Object.hasOwn(checkpoint?.agenda[0]?.intention ?? {}, "input")).toBe(present);
    expect(checkpoint?.agenda[0]?.intention.input).toBe(value);
    const serialized = JSON.parse(JSON.stringify(checkpoint)) as KernelCheckpoint;
    expect(Object.hasOwn(serialized.agenda[0]?.intention ?? {}, "input")).toBe(present);
    expect(serialized.agenda[0]?.intention.input).toBe(value);
    expect(setup.requests.some(({ task }) => task === "turn.interpret.repair")).toBe(false);
  });

  it.each([
    { label: "explicit null for an absent-only contract", settings: { acceptMissing: true } },
    { label: "absent input for a null-only contract", settings: { acceptNull: true, omitInput: true } },
  ])("does not silently normalize $label into a valid input", async ({ settings }) => {
    const setup = await fixture({ ...settings, invalidRepair: true });
    await expect(setup.run()).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    expect(setup.calls).toEqual([]);
    expect(setup.requests.filter(({ task }) => task === "turn.interpret.repair")).toHaveLength(1);
  });

  it("asks about an unresolved request without trying to fill its input or execute it", async () => {
    const setup = await fixture({ unresolved: true });
    const result = await setup.run();
    expect(result.response.interaction?.kind).toBe("clarification");
    expect(result.response.message).toContain("¿Qué registro?");
    expect(setup.calls).toEqual([]);
    expect(setup.requests.some(({ task }) => task === "turn.interpret.repair")).toBe(false);
  });

  it("does not invent genuinely missing data while repairing the request wrapper", async () => {
    const setup = await fixture({ pending: true, missingData: true });
    const result = await setup.run();
    expect(result.response.message).toContain("¿Qué importe querés consultar?");
    expect(result.response.interaction?.id).toBe("missing-amount");
    expect(setup.calls[0]?.input).toEqual({ request: "dato-sintetico" });
    expect((await setup.checkpoint())?.agenda[0]?.continuation).toEqual({ prior: "retained", awaiting: "amount" });
  });

  it("rejects a still-invalid repair before any independent operation and preserves the pending checkpoint", async () => {
    const setup = await fixture({ pending: true, compound: true, invalidRepair: true });
    await expect(setup.run()).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    expect(setup.calls).toEqual([]);
    expect(await setup.checkpoint()).toEqual(setup.original);
    expect(setup.requests.filter(({ task }) => task === "turn.interpret.repair")).toHaveLength(1);
  });

  it("still rejects unsupported confirmation after input repair rather than turning valid syntax into write consent", async () => {
    const setup = await fixture({ confirmation: "unsupported" });
    await expect(setup.run()).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    expect(setup.calls).toEqual([]);
    expect(await setup.checkpoint()).toEqual(setup.original);
    const tasks = setup.requests.map(({ task }) => task);
    expect(tasks.indexOf("turn.interpret.repair")).toBeLessThan(tasks.indexOf("interaction-answer.review"));
    expect(tasks.filter(task => task === "turn.interpret.repair")).toHaveLength(1);
  });

  it("preserves an explicit confirmation and its separate repaired request using the server-owned write input", async () => {
    const setup = await fixture({ confirmation: "supported" });
    const result = await setup.run();
    expect(result.response.message).toContain("Registro consultado.");
    expect(result.response.message).toContain("Publicación realizada.");
    expect(setup.calls).toEqual(expect.arrayContaining([
      { capability: "record.collect", input: { request: "Confirmo publicarlo, y consultá el registro" } },
      { capability: "record.publish", input: { request: "Publicar el registro original" }, answer: true },
    ]));
    expect(setup.calls).toHaveLength(2);
    expect((await setup.checkpoint())?.effects).toEqual([expect.objectContaining({ capabilityId: "record.publish", status: "completed" })]);
  });
});
