import { describe, expect, it } from "vitest";
import { agentId, capabilityId, defineAgent, defineCapability, defineSchema } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { selectCapabilities } from "../../src/interpreter/selectCapabilities.js";
import { interpretTurn } from "../../src/interpreter/interpretTurn.js";
import { createTurnPlan } from "../../src/planner/createTurnPlan.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";

class Gateway implements ModelGateway {
  readonly requests: ModelRequest<unknown>[] = [];
  constructor(readonly responses: unknown[]) {}
  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.requests.push(request);
    if (this.responses.length === 0) throw new Error(`Unexpected model task: ${request.task}`);
    return Promise.resolve({ value: this.responses.shift() as T, provider: "scripted", model: "test", durationMs: 1 });
  }
}

const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });
const activeId = capabilityId("finance.select");
const extraId = capabilityId("exchange.decide");

describe("active choice with additional capability selection", () => {
  it.each([{ explicitExtra: false, position: 1 }, { explicitExtra: true, position: 1 }, { explicitExtra: false, position: 2 }])(
    "reviews the additional operation independently: %j", async ({ explicitExtra, position }) => {
    const compiled = await compileAgentDefinition(defineAgent({ id: agentId("mixed.choice"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
      capabilities: [activeId, extraId].map((id) => defineCapability({ id, version: 1, description: id, input: schema, output: schema,
        requires: [], provides: [], effect: "read", execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
      })),
    }));
    const message = explicitExtra ? "1 y quiero incluir mi usado" : `${String(position)} y quiero financiar 15 millones`;
    const evidence = [{ text: message, meaning: "Current selection", messageIndex: 0 }];
    const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: message, at: "2026-09-06T10:00:00Z" }, checkpoint: {
      schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, facts: [], effects: [], messages: [],
      agenda: [{ id: "old-exchange" as never, status: "waiting_input", dependencies: [], missingFacts: [], intention: {
        id: "old-intention" as never, proposedCapability: extraId, objective: "Decide whether to include exchange", input: {}, evidence: [], references: [], resolution: "resolved",
      } }],
      interaction: { id: "finance-options" as never, kind: "choice", capabilityId: activeId, goal: "Which financing option?", requestedFacts: [],
        options: [{ id: "first", label: "First option", value: "first", targetCapabilityId: activeId }, { id: "second", label: "Second option", value: "second", targetCapabilityId: activeId }],
      },
    } });
    const proposed = { mode: "selected", capabilityIds: [activeId, extraId], rationale: "Selection and prior pending decision", evidence };
    const unique = { meaning: "unique_option", optionId: position === 1 ? "first" : "second", position,
      label: position === 1 ? "First option" : "Second option", rationale: "The user identifies one current option of the active financing interaction." };
    const independent = { verdict: explicitExtra ? "supported" : "unsupported", rationale: explicitExtra
      ? "The user separately requests inclusion of their owned vehicle."
      : "The ordinal answers only the current financing interaction; the old exchange question was not answered.",
    };
    const selectedValue = position === 1 ? "first" : "second";
    const answerToInteraction = { interactionId: "finance-options", value: selectedValue, evidence: message };
    const intentions = [activeId, extraId].map(proposedCapability => ({ proposedCapability, objective: proposedCapability, input: { request: message }, resolution: "resolved", evidence, references: [] }));
    const gateway = new Gateway([proposed, unique, { intentions, contradictions: [], answerToInteraction }, independent,
      ...(explicitExtra ? [] : [{ intentions: [intentions[0]], contradictions: [], answerToInteraction }])]);
    const result = await selectCapabilities({ snapshot, gateway, signal: AbortSignal.timeout(1_000) });
    expect(result.capabilityIds).toEqual([activeId, extraId]);
    const batch = await interpretTurn({ snapshot, compiled, selection: result, gateway, signal: AbortSignal.timeout(1_000) });
    const plan = await createTurnPlan({ batch, snapshot, compiled, ids: { next: kind => kind } });
    expect(plan.steps.map(step => step.capabilityId)).toEqual(explicitExtra ? [activeId, extraId] : [activeId]);
    expect(plan.steps[0]?.input).toEqual({ request: message });
    expect(batch.answerToInteraction?.value).toBe(selectedValue);
    expect(gateway.requests.map((request) => request.task)).toEqual(explicitExtra
      ? ["capability.select", "capability-selection.choice-review", "turn.interpret", "interaction-answer.review"]
      : ["capability.select", "capability-selection.choice-review", "turn.interpret", "interaction-answer.review", "turn.interpret.repair"]);
    expect(snapshot.agenda[0]?.id).toBe("old-exchange");
    expect(snapshot.interaction?.id).toBe("finance-options");
  });
});
