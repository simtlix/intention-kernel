import { describe, expect, it } from "vitest";
import { agentId, capabilityId, defineAgent, defineCapability, defineSchema } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { interpretTurn } from "../../src/interpreter/interpretTurn.js";
import { createTurnPlan } from "../../src/planner/createTurnPlan.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";

class Gateway implements ModelGateway {
  readonly requests: ModelRequest<unknown>[] = [];
  constructor(readonly responses: unknown[], readonly approveReviews = false) {}
  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.requests.push(request);
    if (this.approveReviews && request.task === "interaction-answer.review") return Promise.resolve({
      value: { verdict: "supported", rationale: "Agreement and information are both approved." } as T,
      provider: "scripted", model: "test", durationMs: 1,
    });
    if (this.responses.length === 0) throw new Error(`Unexpected model task: ${request.task}`);
    return Promise.resolve({ value: this.responses.shift() as T, provider: "scripted", model: "test", durationMs: 1 });
  }
}

const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });

describe("progression continuation evidence", () => {
  it.each([
    { name: "whole phrase reused", message: "Dale quero mas infotmacion", actionEvidence: "Dale quero mas infotmacion", answerEvidence: "Dale quero mas infotmacion", accepted: false, review: false },
    { name: "agreement belongs to information request", message: "Dale quero mas infotmacion", actionEvidence: "quero mas infotmacion", answerEvidence: "Dale", accepted: false, review: true },
    { name: "explicit compound action and exit", message: "Show details and then continue to checkout", actionEvidence: "Show details", answerEvidence: "then continue to checkout", accepted: true, review: true },
    { name: "pure agreement to current exit offer", message: "Dale", actionEvidence: undefined, answerEvidence: "Dale", accepted: true, review: true },
    { name: "compound exit lost after repairing overlapping spans", message: "Show details and then continue to checkout", actionEvidence: "Show details and then continue to checkout", answerEvidence: "Show details and then continue to checkout", accepted: true, review: false, droppedExit: true },
  ])("handles $name without losing the independently requested action", async (scenario) => {
    const compiled = await compileAgentDefinition(defineAgent({ id: agentId("progression.evidence"), version: 1, identity: "Product assistant", policies: [], modelPolicy: {},
      capabilities: [defineCapability({ id: capabilityId("product.details"), version: 1, description: "Show verified product details", input: schema, output: schema,
        requires: [], provides: [], effect: "read", execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
      })],
    }));
    const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: scenario.message, at: "2026-09-06T10:00:00Z" }, checkpoint: {
      schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, facts: [], agenda: [], effects: [], messages: [],
      interaction: { id: "explore" as never, kind: "choice", goal: scenario.actionEvidence === undefined ? "Would you like to continue to checkout?" : "Show more product details or continue to checkout?", requestedFacts: [],
        options: [
          { id: "details", label: "Show product details", value: { kind: "progression.member", capabilityId: "product.details", occurrenceId: "explore" }, targetCapabilityId: capabilityId("product.details") },
          { id: "continue", label: "Continue to checkout", value: { kind: "progression.continue", occurrenceId: "explore" } },
        ],
        payload: { kind: "progression.group", occurrenceId: "explore" },
      },
    } });
    const intentions = scenario.actionEvidence === undefined ? [] : [{ id: "details", objective: "Show details", references: [],
      evidence: [{ text: scenario.actionEvidence, meaning: "Ask for product information", messageIndex: 0 }],
      proposedCapability: "product.details", input: {}, resolution: "resolved",
    }];
    const batch = { intentions, contradictions: [], answerToInteraction: { interactionId: "explore", evidence: scenario.answerEvidence,
      value: { kind: "progression.continue", occurrenceId: "explore" },
    } };
    const review = { verdict: scenario.accepted ? "supported" : "unsupported", rationale: scenario.accepted
      ? "The user separately requests the exact exit offered by the current interaction."
      : "Agreement modifies the requested information; it does not authorize leaving the group for checkout.",
    };
    const gateway = new Gateway(scenario.droppedExit ? [batch, { intentions, contradictions: [] },
      { continuation: "requested", evidence: "then continue to checkout", rationale: "The current message explicitly requests details and then continuing to checkout; omitting the exit loses that request." },
    ] : [batch, ...(scenario.review ? [review] : []),
      ...(scenario.accepted ? intentions.length === 0 ? [] : [{ verdict: "supported", rationale: "The details request has independent current wording." }]
        : [{ intentions, contradictions: [] }, ...(!scenario.review ? [{ continuation: "not_requested", evidence: "", rationale: "The complete message requests information only; omitting continuation preserves that request." }] : []),
          { verdict: "supported", rationale: "The current wording explicitly asks for more information, independently of the rejected continuation." }]),
    ]);
    const interpretation = interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000), selection: {
      mode: "selected", capabilityIds: [capabilityId("product.details")], rationale: "Inspect current request", evidence: [],
    } });
    if (scenario.droppedExit) {
      await expect(interpretation).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
      expect(gateway.requests.map((request) => request.task)).toEqual([
        "turn.interpret", "turn.interpret.repair", "interaction-answer.review",
      ]);
      expect(gateway.requests.at(-1)?.input).toMatchObject({ reviewKind: "omitted_progression_answer" });
      return;
    }
    const result = await interpretation;
    expect(result.intentions.map((item) => item.proposedCapability)).toEqual(scenario.actionEvidence === undefined ? [] : ["product.details"]);
    if (scenario.accepted) expect(result.answerToInteraction?.value).toEqual(batch.answerToInteraction.value);
    else {
      expect(result.answerToInteraction).toBeUndefined();
      expect(gateway.requests.at(-1)?.task).toBe("interaction-answer.review");
      expect(gateway.requests.at(-1)?.input).toMatchObject({ reviewKind: "progression_member_operation" });
      if (!scenario.review) expect(gateway.requests.at(-2)?.input).toMatchObject({ reviewKind: "omitted_progression_answer" });
    }
    expect(snapshot.interaction?.id).toBe("explore");
  });

  it.each([true, false])("reviews continuation before repairing an external operation with shared evidence (exit supported: %s)", async (exitSupported) => {
    const compiled = await compileAgentDefinition(defineAgent({ id: agentId("progression.downstream"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
      capabilities: [defineCapability({ id: capabilityId("purchase.create"), version: 1, description: "Create the completed purchase", input: schema, output: schema,
        requires: [], provides: [], effect: "write", confirmation: "kernel", execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
      })],
    }));
    const message = "Yes, continue with the purchase";
    const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: message, at: "2026-09-06T10:00:00Z" }, checkpoint: {
      schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, facts: [], agenda: [], effects: [], messages: [],
      interaction: { id: "explore" as never, kind: "choice", goal: "More information or continue with the purchase?", requestedFacts: [],
        options: [{ id: "continue", label: "Continue with the purchase", value: { kind: "progression.continue", occurrenceId: "explore" } }],
        payload: { kind: "progression.group", occurrenceId: "explore" },
      },
    } });
    const answerToInteraction = { interactionId: "explore", evidence: message, value: { kind: "progression.continue", occurrenceId: "explore" } };
    const initial = { intentions: [{ id: "purchase", objective: "Create purchase", references: [],
      evidence: [{ text: message, meaning: "Continue with purchase", messageIndex: 0 }],
      proposedCapability: "purchase.create", input: {}, resolution: "resolved" }], contradictions: [], answerToInteraction };
    const gateway = new Gateway([initial,
      { verdict: exitSupported ? "supported" : "unsupported", rationale: exitSupported
        ? "The user explicitly accepts the exact continuation offered by the active menu."
        : "The wording requests the operation directly, without independently accepting this menu exit." },
      exitSupported ? { intentions: [], contradictions: [], answerToInteraction } : { intentions: initial.intentions, contradictions: [] },
      ...(exitSupported ? [{ verdict: "supported", rationale: "The repaired answer still accepts the exact continuation, without an inferred write." }] : []),
    ]);
    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1_000), selection: {
      mode: "selected", capabilityIds: [capabilityId("purchase.create")], rationale: "Continue purchase", evidence: [],
    } });
    expect(result.intentions.map((intention) => intention.proposedCapability)).toEqual(exitSupported ? [] : ["purchase.create"]);
    expect(result.answerToInteraction?.value).toEqual(exitSupported ? answerToInteraction.value : undefined);
    expect(gateway.requests.map((request) => request.task)).toEqual([
      "turn.interpret", "interaction-answer.review", "turn.interpret.repair", ...(exitSupported ? ["interaction-answer.review"] : []),
    ]);
    if (exitSupported) {
      const plan = await createTurnPlan({ batch: result, snapshot, compiled, ids: { next: (kind) => kind } });
      expect(plan.steps).toEqual([]);
      expect(plan.progressionAction).toEqual({ kind: "continue", occurrenceId: "explore" });
    }
  });
});
