import { describe, expect, it } from "vitest";
import { agentId, capabilityId, createKernel, defineAgent, defineCapability, defineSchema } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { interpretTurn } from "../../src/interpreter/interpretTurn.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";
import { createMemoryDurability } from "../../src/testing/createMemoryDurability.js";
import { createTurnPlan } from "../../src/planner/createTurnPlan.js";

class Gateway implements ModelGateway {
  readonly requests: ModelRequest<unknown>[] = [];
  constructor(readonly responses: unknown[]) {}
  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.requests.push(request);
    if (this.responses.length === 0) throw new Error(`Unexpected task: ${request.task}`);
    return Promise.resolve({ value: this.responses.shift() as T, provider: "scripted", model: "test", durationMs: 1 });
  }
}
const activeId = capabilityId("term.select");
const otherId = capabilityId("details.show");
const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });
async function fixture(message = "2 y 15.000.000") {
  const compiled = await compileAgentDefinition(defineAgent({ id: agentId("choice.repair"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
    capabilities: [activeId, otherId].map((id) => defineCapability({ id, version: 1, description: id, input: schema, output: schema, requires: [], provides: [], effect: "read",
      execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
    })),
  }));
  const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: message, at: "2026-09-06T10:00:00Z" }, checkpoint: {
    schemaVersion: 1, revision: 1, agentFingerprint: compiled.fingerprint, facts: [], agenda: [], effects: [],
    messages: [{ role: "assistant", content: "Previously: 1. Provider A, 2. Provider B", at: "2026-09-06T09:00:00Z" }],
    interaction: { id: "current-terms" as never, kind: "choice", capabilityId: activeId, goal: "Choose an installment term", requestedFacts: [],
      options: [{ id: "term-12", label: "12 installments", value: { term: 12 } }, { id: "term-18", label: "18 installments", value: { term: 18 } }],
    },
  } });
  const intention = { id: "term", objective: "Choose term and amount", references: [], proposedCapability: activeId, input: {}, resolution: "resolved",
    evidence: [{ text: message, meaning: "Term selection", messageIndex: 1 }],
  };
  return { compiled, snapshot, intention, batch: { intentions: [intention], contradictions: [],
    answerToInteraction: { interactionId: "current-terms", value: "term-18", evidence: message },
  }, selection: { mode: "selected" as const, capabilityIds: [activeId], rationale: "Select current term", evidence: [] } };
}

describe("current choice ordinal review and bounded abstention", () => {
  it.each(["corrected", "dropped", "unchanged"])("repairs a mismatched current option without treating it as abstention: %s", async (repair) => {
    const setup = await fixture("the second");
    const wrong = { ...setup.batch, answerToInteraction: { ...setup.batch.answerToInteraction, value: "term-12" } };
    const review = { decision: "selected", optionId: "term-18", rationale: "The user selects current position two." };
    const repaired = repair === "corrected" ? setup.batch : repair === "dropped" ? { intentions: [], contradictions: [] } : wrong;
    const gateway = new Gateway([wrong, review, repaired, ...(repair === "dropped" ? [] : [review])]);
    const result = interpretTurn({ ...setup, gateway, signal: AbortSignal.timeout(1_000) });
    if (repair === "corrected") {
      expect((await result).answerToInteraction?.value).toEqual({ term: 18 });
    } else {
      await expect(result).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    }
    const repairInput = gateway.requests[2]?.input as { validationIssues: { code: string; message: string }[] };
    expect(repairInput.validationIssues[0]?.code).toBe("MISMATCHED_CHOICE_ANSWER");
    expect(repairInput.validationIssues[0]?.message).toContain("term-18");
    expect(setup.snapshot.interaction?.options?.[0]?.value).toEqual({ term: 12 });
  });

  it("supplies explicit current positions for an ordinal with a companion amount", async () => {
    const setup = await fixture();
    const gateway = new Gateway([setup.batch, { decision: "selected", optionId: "term-18", rationale: "2 identifies position two of the current terms; the amount is companion data." }]);
    const result = await interpretTurn({ ...setup, gateway, signal: AbortSignal.timeout(1_000) });
    expect(result.answerToInteraction?.value).toEqual({ term: 18 });
    expect((gateway.requests[1]?.input as { currentChoice?: unknown }).currentChoice).toEqual({
      id: "current-terms", goal: "Choose an installment term", options: [
        { position: 1, id: "term-12", label: "12 installments", value: { term: 12 } },
        { position: 2, id: "term-18", label: "18 installments", value: { term: 18 } },
      ],
    });
  });

  it("constrains generated choice answers to current public IDs without copying their structured values", async () => {
    const setup = await fixture();
    const gateway = new Gateway([setup.batch, { decision: "selected", optionId: "term-18", rationale: "The second current option is selected." }]);
    await interpretTurn({ ...setup, gateway, signal: AbortSignal.timeout(1_000) });
    const output = await gateway.requests[0]?.outputSchema.jsonSchema?.();
    expect(output).toMatchObject({ properties: { answerToInteraction: { anyOf: [
      { properties: { interactionId: { const: "current-terms" }, value: { type: "string", enum: ["term-12", "term-18"] } } },
      { type: "null" },
    ] } } });
    expect(JSON.stringify(output)).not.toContain('"term":18');
  });

  it.each([false, true])("accepts bounded abstention with reported contradictions=%s after semantic rejection", async (reportContradiction) => {
    const setup = await fixture();
    const contradictions = reportContradiction
      ? [{ description: "The requested term conflicts with the proposed option.", evidence: ["2 y 15.000.000"] }]
      : [];
    const gateway = new Gateway([setup.batch, { decision: "ambiguous", optionIds: ["term-12", "term-18"], rationale: "The proposed selection is ambiguous." }, { intentions: [], contradictions, answerToInteraction: null }]);
    const result = await interpretTurn({ ...setup, gateway, signal: AbortSignal.timeout(1_000) });
    expect(result.intentions).toEqual([]);
    expect(result.answerToInteraction).toBeUndefined();
    expect(result.contradictions).toEqual(contradictions);
    expect(setup.snapshot.interaction?.id).toBe("current-terms");
    expect(gateway.requests.map((request) => request.task)).toEqual(["turn.interpret", "interaction-answer.review", "turn.interpret.repair"]);
  });

  it("does not reconstruct a removed choice answer from an ambiguous repaired reference", async () => {
    const setup = await fixture("the installment term");
    const ambiguous = { id: "uncertain", objective: "Choose one of the terms", resolution: "ambiguous",
      evidence: setup.intention.evidence, references: [{ target: "term-18", expression: "the term", evidence: "the installment term" }],
      alternatives: ["12 installments", "18 installments"],
    };
    const gateway = new Gateway([setup.batch,
      { decision: "not_selection", rationale: "The current wording does not identify one option." },
      { intentions: [ambiguous], contradictions: [], answerToInteraction: null },
    ]);
    const result = await interpretTurn({ ...setup, gateway, signal: AbortSignal.timeout(1_000) });
    expect(result.answerToInteraction).toBeUndefined();
    expect(result.intentions[0]?.resolution).toBe("ambiguous");
    expect(gateway.requests.map((request) => request.task)).toEqual(["turn.interpret", "interaction-answer.review", "turn.interpret.repair"]);
    const plan = await createTurnPlan({ batch: result, snapshot: setup.snapshot, compiled: setup.compiled, ids: { next: (kind) => kind } });
    expect(plan.steps.map((step) => step.disposition)).toEqual(["clarify"]);
    expect(plan.interaction?.kind).toBe("clarification");
    expect(plan.answeredInteractionCapabilityId).toBeUndefined();
  });

  it.each([false, true])("retains the durable choice without executing the rejected operation, contradictions=%s", async (reportContradiction) => {
    const setup = await fixture();
    let executions = 0;
    const gateway = new Gateway([
      { ...setup.selection, evidence: [{ text: "2 y 15.000.000", meaning: "Current term and amount", messageIndex: 1 }] },
      setup.batch,
      { decision: "not_selection", rationale: "The wording does not safely commit to the proposed term." },
      { intentions: [], contradictions: reportContradiction
        ? [{ description: "The current wording does not establish the proposed term.", evidence: ["2 y 15.000.000"] }]
        : [] },
    ]);
    const durability = createMemoryDurability();
    const agent = await createKernel({ modelGateway: gateway, durability }).compile({
      ...setup.compiled.definition,
      capabilities: setup.compiled.definition.capabilities.map((capability) => ({ ...capability, execute: () => {
        executions++;
        return Promise.resolve({ status: "completed" as const, output: {}, facts: [], evidence: [], artifacts: [] });
      } })),
    });
    await durability.withTurn({ threadId: "abstention" as never, turnId: "seed" as never }, async (scope) => {
      await scope.commit({ value: null, checkpoint: { schemaVersion: 1, revision: 1, agentFingerprint: agent.fingerprint,
        facts: [], agenda: [{ id: "pending-term" as never, status: "waiting_input", dependencies: [], missingFacts: [],
          intention: { ...setup.intention, id: "pending-intention" as never, resolution: "resolved", evidence: [] },
        }], effects: [], messages: [{ role: "assistant", content: "Which installment term?", at: "2026-09-06T09:00:00Z" }],
        ...(setup.snapshot.interaction === undefined ? {} : { interaction: setup.snapshot.interaction }),
      } });
    });
    const result = await agent.run({ threadId: "abstention" as never, turnId: "answer" as never, input: { text: "2 y 15.000.000" } });
    expect(result.response.status).toBe("completed");
    expect(result.response.interaction).toEqual(setup.snapshot.interaction);
    expect(result.checkpoint.interaction).toEqual(setup.snapshot.interaction);
    expect(result.response.source).toBe("canonical");
    expect(result.response.message).toBe(setup.snapshot.interaction?.goal);
    expect(gateway.requests.some(({ task }) => task.startsWith("response."))).toBe(false);
    expect(executions).toBe(0);
    expect(gateway.responses).toEqual([]);
  });

  it.each(["initial-empty", "invalid-review", "independent-operation"])("does not authorize empty interpretation for %s", async (mode) => {
    const setup = await fixture();
    const empty = { intentions: [], contradictions: [] };
    const batch = mode === "independent-operation" ? { ...setup.batch, intentions: [setup.intention, { ...setup.intention, proposedCapability: otherId, objective: "Show details" }] } : setup.batch;
    const gateway = new Gateway(mode === "initial-empty" ? [empty, empty] : [batch,
      mode === "invalid-review" ? { invalid: true } : { decision: "not_selection", rationale: "Choice not supported; keep the separately requested details." }, empty]);
    await expect(interpretTurn({ ...setup, gateway, signal: AbortSignal.timeout(1_000),
      selection: { ...setup.selection, capabilityIds: mode === "independent-operation" ? [activeId, otherId] : [activeId] },
    })).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  });
});
