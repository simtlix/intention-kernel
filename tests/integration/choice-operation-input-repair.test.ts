import { describe, expect, it } from "vitest";
import { z } from "zod";

import { agentId, capabilityId, createKernel, defineAgent, defineCapability, defineSchema, evidenceId, interactionId, threadId, turnId } from "../../src/index.js";
import type { CapabilityResult } from "../../src/contracts/capability.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";
import type { ResponseBrief } from "../../src/contracts/response.js";
import { createMemoryDurability } from "../../src/testing/createMemoryDurability.js";

const rawInput = z.strictObject({ request: z.string().min(1) });
const requestSchema = defineSchema<{ request: string }>({
  vendor: "zod",
  validate: (value) => {
    const parsed = rawInput.safeParse(value);
    return parsed.success ? { value: parsed.data } : { issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
  },
  jsonSchema: () => z.toJSONSchema(rawInput),
});
const resultSchema = defineSchema<Record<string, unknown>>({
  vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }),
});

async function fixture({ missingAmount = false, compound = false, invalidRepair = false, emptyValidationIssues = false } = {}) {
  const message = compound ? "La de 24 cuotas y decime el horario" : "La de 24 cuotas";
  const quoteId = capabilityId("credit.quote");
  const hoursId = capabilityId("office.hours");
  const choice = { id: interactionId("current-term"), kind: "choice" as const, capabilityId: quoteId,
    goal: "¿En cuántas cuotas querés financiar?", requestedFacts: [],
    options: [{ id: "term-12", label: "12 cuotas", value: { term: 12 } }, { id: "term-24", label: "24 cuotas", value: { term: 24 } }],
  };
  const answerToInteraction = { interactionId: choice.id, value: "term-24", evidence: "La de 24 cuotas" };
  const intention = { objective: "Calcular la cotización", proposedCapability: quoteId, input: null, references: [], resolution: "resolved",
    evidence: [{ text: "La de 24 cuotas", meaning: "Select the current term", messageIndex: 1 }],
  };
  const independent = { objective: "Consultar el horario", proposedCapability: hoursId, input: { request: "decime el horario" }, references: [], resolution: "resolved",
    evidence: [{ text: "decime el horario", meaning: "Independent opening-hours request", messageIndex: 1 }],
  };
  const requests: ModelRequest<unknown>[] = [];
  const calls: { capability: string; input: unknown; answer?: unknown }[] = [];
  const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
    requests.push(request);
    let value: unknown;
    if (request.task === "capability.select") value = { mode: "selected", capabilityIds: compound ? [quoteId, hoursId] : [quoteId], rationale: "Current exact choice and independently requested operations", evidence: intention.evidence };
    else if (request.task === "turn.interpret" || request.task === "turn.interpret.repair") value = {
      intentions: [{ ...intention, input: request.task === "turn.interpret.repair" && !invalidRepair ? { request: message } : null }, ...(compound ? [independent] : [])],
      contradictions: [], answerToInteraction,
    };
    else if ((request.input as { proposedOption?: { id: string } }).proposedOption !== undefined) value = { decision: "selected", optionId: (request.input as { proposedOption: { id: string } }).proposedOption.id, rationale: "The current message explicitly selects the offered term." };
    else if (request.task === "interaction-answer.review" || request.task === "capability-selection.interaction-review") value = { verdict: "supported", rationale: "The current message explicitly selects the offered 24-installment term and independently asks for opening hours when proposed." };
    else if (request.task.startsWith("response.compose")) {
      const input = request.input as ResponseBrief & { brief?: ResponseBrief };
      const brief = input.brief ?? input;
      const required = brief.requiredResponses ?? [];
      value = { parts: [
        ...required.map((entry) => ({ text: entry.message, evidenceIds: entry.claims.flatMap((claim) => claim.evidenceIds) })),
        ...(brief.interaction === undefined ? [] : [{ text: brief.interaction.goal, evidenceIds: [] }]),
      ] };
    } else if (request.task === "response.grounding-review") {
      const input = request.input as { response: { claims: readonly unknown[] } };
      value = { verdict: "supported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: input.response.claims.map((_, index) => index) };
    } else throw new Error(`Unexpected model task: ${request.task}`);
    return Promise.resolve({ value: value as T, provider: "scripted", model: "offline", durationMs: 1 });
  } };
  const inputSchema = { ...requestSchema, validate: async (value: unknown) => {
    const result = await requestSchema.validate(value);
    return !result.ok && emptyValidationIssues ? { ok: false as const, issues: [] } : result;
  } };
  const quote = defineCapability({ id: quoteId, version: 1, description: "Calculate the quote using a term selected from the active choice", input: inputSchema, output: resultSchema,
    requires: [], provides: [], effect: "read", execute: (context, input): Promise<CapabilityResult<Record<string, unknown>>> => {
      calls.push({ capability: quoteId, input, answer: context.turn.interactionAnswer?.value });
      if (missingAmount) return Promise.resolve({ status: "needs_input", interaction: {
        id: interactionId("missing-amount"), kind: "input", capabilityId: quoteId, requestedFacts: [], goal: "¿Qué importe querés financiar?",
      } });
      const content = "Cotización verificada: 24 cuotas.";
      const source = evidenceId("quoted-term");
      return Promise.resolve({ status: "completed", output: { term: 24 }, facts: [], artifacts: [], evidence: [{ id: source, source: "capability", content }],
        canonicalResponse: { message: content, claims: [{ text: content, evidenceIds: [source] }], required: true },
      });
    },
  });
  const hours = defineCapability({ id: hoursId, version: 1, description: "Read verified opening hours", input: requestSchema, output: resultSchema,
    requires: [], provides: [], effect: "read", execute: (_context, input): Promise<CapabilityResult<Record<string, unknown>>> => {
      calls.push({ capability: hoursId, input });
      const content = "Horario verificado: de 9 a 18.";
      const source = evidenceId("office-hours");
      return Promise.resolve({ status: "completed", output: { hours: "9 a 18" }, facts: [], artifacts: [], evidence: [{ id: source, source: "capability", content }],
        canonicalResponse: { message: content, claims: [{ text: content, evidenceIds: [source] }], required: true },
      });
    },
  });
  const durability = createMemoryDurability();
  const agent = await createKernel({ modelGateway: gateway, durability }).compile(defineAgent({ id: agentId("choice-input-repair"), version: 1,
    identity: "Asesor", capabilities: [quote, hours], policies: [], modelPolicy: {},
  }));
  await durability.withTurn({ threadId: threadId("choice-input"), turnId: turnId("seed") }, async (scope) => {
    await scope.commit({ value: null, checkpoint: { schemaVersion: 1, revision: 1, agentFingerprint: agent.fingerprint,
      facts: [], agenda: [], effects: [], interaction: choice,
      messages: [{ role: "assistant", content: choice.goal, at: "2026-09-06T09:00:00Z" }],
    } });
  });
  const run = () => agent.run({ threadId: threadId("choice-input"), turnId: turnId("answer"), input: { text: message } });
  return { run, calls, requests, message };
}

describe("active choice operation input repair", () => {
  it("delivers the selected quote instead of asking a redundant clarification for a null request wrapper", async () => {
    const setup = await fixture();
    const result = await setup.run();
    expect(result.response.message).toContain("Cotización verificada: 24 cuotas.");
    expect(result.response.interaction).toBeUndefined();
    expect(result.response.grounded).toBe(true);
    expect(setup.calls).toEqual([{ capability: "credit.quote", input: { request: "La de 24 cuotas" }, answer: { term: 24 } }]);
    expect(setup.requests.filter(({ task }) => task === "turn.interpret.repair")).toHaveLength(1);
    const replay = await setup.run();
    expect(replay.replayed).toBe(true);
    expect(replay.response.message).toBe(result.response.message);
    expect(setup.calls).toHaveLength(1);
  });

  it("lets the capability ask for genuinely missing business data without inventing an amount", async () => {
    const setup = await fixture({ missingAmount: true });
    const result = await setup.run();
    expect(result.response.message).toContain("¿Qué importe querés financiar?");
    expect(result.response.interaction?.kind).toBe("input");
    expect(setup.calls).toEqual([{ capability: "credit.quote", input: { request: "La de 24 cuotas" }, answer: { term: 24 } }]);
  });

  it("still repairs when the runtime validator rejects input without detailed issues", async () => {
    const setup = await fixture({ emptyValidationIssues: true });
    const result = await setup.run();
    expect(result.response.message).toContain("Cotización verificada: 24 cuotas.");
    expect(result.response.interaction).toBeUndefined();
    expect(setup.calls).toEqual([{ capability: "credit.quote", input: { request: "La de 24 cuotas" }, answer: { term: 24 } }]);
  });

  it("rejects a still-invalid repair before invoking either requested operation", async () => {
    const setup = await fixture({ compound: true, invalidRepair: true });
    await expect(setup.run()).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    expect(setup.calls).toEqual([]);
    expect(setup.requests.filter(({ task }) => task === "turn.interpret.repair")).toHaveLength(1);
  });

  it("delivers the independently requested hours along with the repaired selected quote", async () => {
    const setup = await fixture({ compound: true });
    const result = await setup.run();
    expect(result.response.message).toContain("Cotización verificada: 24 cuotas.");
    expect(result.response.message).toContain("Horario verificado: de 9 a 18.");
    expect(result.response.interaction).toBeUndefined();
    expect(setup.calls).toEqual(expect.arrayContaining([
      { capability: "credit.quote", input: { request: "La de 24 cuotas y decime el horario" }, answer: { term: 24 } },
      { capability: "office.hours", input: { request: "decime el horario" } },
    ]));
    expect(setup.calls).toHaveLength(2);
  });
});
