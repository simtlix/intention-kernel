import { describe, expect, it } from "vitest";
import { agentId, capabilityId, interactionId, defineAgent, defineCapability, defineSchema } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { interpretTurn } from "../../src/interpreter/interpretTurn.js";
import { createTurnPlan } from "../../src/planner/createTurnPlan.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });

describe("ordinary choice independent operation consent", () => {
  it.each([
    { message: "Sí, la opción 1 y necesito financiar quince millones", extraRequested: false, structured: false, stubborn: false },
    { message: "La opción 1 y además quiero consultar horarios", extraRequested: true, structured: false, stubborn: false },
    { message: "Quince millones", extraRequested: false, structured: true, stubborn: false },
    { message: "La opción 1", extraRequested: false, structured: false, stubborn: true },
    { message: "Elijo la primera", extraRequested: false, structured: false, stubborn: true, dropAnswer: true },
  ])("keeps only requested work alongside $message (structured=$structured, stubborn=$stubborn)", async ({ message, extraRequested, structured, stubborn, dropAnswer }) => {
    const owner = capabilityId("credit.selectOption");
    const extra = capabilityId(extraRequested ? "business.hours" : "purchase.decidePayment");
    const compiled = await compileAgentDefinition(defineAgent({ id: agentId("choice.operations"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
      capabilities: [owner, extra].map((id) => defineCapability({ id, version: 1, description: id === owner ? "Select the published credit option and collect companion amount" : id === extra && extraRequested ? "Read business hours" : "Decide payment before collecting a credit option", input: schema, output: schema,
        requires: [], provides: [], effect: "read", execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
      })),
    }));
    const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: message, at: "2026-09-06T10:00:00Z" }, checkpoint: {
      schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, facts: [], agenda: [], effects: [], messages: [],
      interaction: { id: "credit-choice" as never, kind: "choice", capabilityId: capabilityId("credit.discover"), goal: "Choose a financing option", requestedFacts: [],
        options: [{ id: "credit-one", label: "First bank", targetCapabilityId: owner, value: { optionId: "credit-one" } }],
      },
    } });
    const evidence = [{ text: message, meaning: "Current request", messageIndex: 0 }];
    const intentions = [owner, extra].map((proposedCapability) => ({ objective: proposedCapability, references: [], evidence, proposedCapability, input: { request: message }, resolution: "resolved" }));
    const answerToInteraction = { interactionId: "credit-choice", value: { optionId: "credit-one" }, evidence: message };
    const requests: ModelRequest<unknown>[] = [];
    const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
      requests.push(request);
      const kind = (request.input as { reviewKind?: string }).reviewKind;
      const value = request.task === "turn.interpret" ? { intentions, contradictions: [], answerToInteraction }
        : request.task === "turn.interpret.repair" ? { intentions: stubborn ? intentions : [intentions[0]], contradictions: [], ...(dropAnswer ? {} : { answerToInteraction }) }
          : (request.input as { proposedOption?: unknown }).proposedOption !== undefined
            ? { decision: "selected", optionId: "credit-one", rationale: "The current first credit option is selected." }
          : { verdict: kind === "choice_intention_independence" && !extraRequested ? "unsupported" : "supported", rationale: extraRequested ? "The user separately requests business hours." : "The current words select the offered credit option and supply its amount, not a separate parent payment decision." };
      return Promise.resolve({ value: value as T, provider: "scripted", model: "test", durationMs: 1 });
    } };
    const result = interpretTurn({ snapshot, compiled, gateway, signal: AbortSignal.timeout(1000), selection: { mode: "selected", capabilityIds: [owner, extra], rationale: "Choice and possible additional operation", evidence },
      ...(structured ? { validatedInteractionAnswer: { ...answerToInteraction, interactionId: interactionId("credit-choice") } } : {}),
    });
    if (stubborn) {
      await expect(result).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    } else {
      const batch = await result;
      const plan = await createTurnPlan({ batch, snapshot, compiled, ids: { next: (kind) => kind } });
      expect(plan.steps.map((step) => step.capabilityId)).toEqual(extraRequested ? [owner, extra] : [owner]);
      expect(batch.answerToInteraction?.value).toEqual({ optionId: "credit-one" });
      expect(plan.steps[0]?.input).toEqual({ request: message });
    }
    expect(requests.some((request) => (request.input as { reviewKind?: string }).reviewKind === "choice_intention_independence")).toBe(true);
  });
});
