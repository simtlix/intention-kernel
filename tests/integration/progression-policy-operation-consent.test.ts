import { describe, expect, it } from "vitest";
import { agentId, capabilityId, defineAgent, defineCapability, defineModelGuidancePolicy, defineSchema, policyId } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { interpretTurn } from "../../src/interpreter/interpretTurn.js";
import { createTurnPlan } from "../../src/planner/createTurnPlan.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });

describe("policy-authorized progression operation consent", () => {
  it.each([
    { message: "Sí, avancemos con el presupuesto", requested: false },
    { message: "Ahora quiero ver financiación", requested: true },
    { message: "Mostrame financiación y después avancemos con el presupuesto", requested: true },
  ])("does not infer an operation from its declared exit: $message", async ({ message, requested }) => {
    const compiled = await compileAgentDefinition(defineAgent({ id: agentId("policy.operation"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
      capabilities: [defineCapability({ id: capabilityId("credit.discover"), version: 1, description: "Read requested credit options", input: schema, output: schema,
        requires: [], provides: [], effect: "read", execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
      })],
      modelGuidancePolicies: [defineModelGuidancePolicy({ id: policyId("credit.exits-exploration"), version: 1, description: "Explicitly requested credit leaves exploration.",
        instructions: ["When credit is requested, retain credit.discover and answer progression.continue."], examples: [], counterExamples: [],
        continueProgressionForCapabilities: [capabilityId("credit.discover")], select: () => ({ selected: true, matchedSelectors: ["activeExploration"] }),
      })],
    }));
    const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: message, at: "2026-09-06T10:00:00Z" }, checkpoint: {
      schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, facts: [], agenda: [], effects: [], messages: [],
      interaction: { id: "explore" as never, kind: "choice", goal: "More information or continue with the budget?", requestedFacts: [],
        options: [{ id: "continue", label: "Continue with the budget", value: { kind: "progression.continue", occurrenceId: "explore" } }],
        payload: { kind: "progression.group", occurrenceId: "explore" },
      },
    } });
    const evidence = [{ text: message, meaning: "Current request", messageIndex: 0 }];
    const intention = { objective: "Read credit options", references: [], evidence, proposedCapability: "credit.discover", input: {}, resolution: "resolved" };
    const answerToInteraction = { interactionId: "explore", value: "continue", evidence: message };
    const requests: ModelRequest<unknown>[] = [];
    const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
      requests.push(request);
      const kind = (request.input as { reviewKind?: string }).reviewKind;
      const value = request.task === "turn.interpret" ? { intentions: [intention], contradictions: [], answerToInteraction }
        : request.task === "turn.interpret.repair" ? { intentions: [], contradictions: [], answerToInteraction }
          : { verdict: kind === "progression_intention_independence" && !requested ? "unsupported" : "supported", rationale: requested ? "The complete message independently requests credit options." : "The user accepts continuation but never requests credit; the kernel chooses the next step." };
      return Promise.resolve({ value: value as T, provider: "scripted", model: "test", durationMs: 1 });
    } };
    const result = await interpretTurn({ snapshot, gateway, signal: AbortSignal.timeout(1000), selection: { mode: "selected", capabilityIds: [capabilityId("credit.discover")], rationale: "Continue commercial process", evidence } });
    const plan = await createTurnPlan({ batch: result, snapshot, compiled, ids: { next: (kind) => kind } });
    expect(plan.steps.map((step) => step.capabilityId)).toEqual(requested ? ["credit.discover"] : []);
    expect(plan.progressionAction).toEqual({ kind: "continue", occurrenceId: "explore" });
    expect(requests.some((request) => (request.input as { reviewKind?: string }).reviewKind === "progression_intention_independence")).toBe(true);
  });
});
