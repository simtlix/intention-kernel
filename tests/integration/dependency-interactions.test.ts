import { describe, expect, it } from "vitest";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { defineAgent, defineCapability, defineSchema, agentId, capabilityId, factType } from "../../src/index.js";
import { reduceCapabilityResults } from "../../src/reducer/reduceCapabilityResults.js";
import { reconcileProgression } from "../../src/progression/reconcileProgression.js";
import type { KernelCheckpoint } from "../../src/contracts/checkpoint.js";
import type { Interaction } from "../../src/contracts/interaction.js";
import type { PlanStep, StepExecutionResult, TurnPlan } from "../../src/contracts/plan.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });
const parentId = capabilityId("order.method");
const browseId = capabilityId("options.browse");
const selectId = capabilityId("options.select");
const nextId = capabilityId("contact.collect");

function step(id: string, capability: typeof parentId, text: string): PlanStep {
  const intention = { id: id as never, objective: "Continue", references: [], evidence: [{ text, meaning: "Current request", messageIndex: 0 }],
    proposedCapability: capability, input: {}, resolution: "resolved" as const };
  return { id: id as never, intentionId: intention.id, intention, capabilityId: capability, input: {}, dependsOn: [], missingFacts: [],
    disposition: "execute", reason: { code: "READY", message: "Ready", evidence: [text] } };
}

function complete(item: PlanStep, interaction?: Interaction | null): StepExecutionResult {
  if (item.capabilityId === undefined) throw new Error("Missing fixture capability");
  return { stepId: item.id, capabilityId: item.capabilityId, status: "invoked", result: {
    status: "completed", output: {}, facts: [], evidence: [], artifacts: [], ...(interaction === undefined ? {} : { interaction }),
  } };
}

async function compiledAgent(withObjective = false) {
  return compileAgentDefinition(defineAgent({ id: agentId("dependency-interactions"), version: 1, identity: "Assistant", policies: [], modelPolicy: {},
    progression: { ...(withObjective ? { objective: { id: "order.complete", activation: "conversation_start" as const,
      completionFact: { type: factType("method.selected"), version: 1 } } } : {}),
      groups: [], rules: [{ id: "after-method", version: 1, target: { capabilityId: nextId }, mode: "required", priority: 1,
      activateWhen: [{ type: factType("method.selected"), version: 1 }],
    }] },
    capabilities: [parentId, browseId, selectId, nextId].map((id) => defineCapability({ id, version: 1, description: id,
      input: schema, output: schema, requires: [], provides: id === selectId ? [{ type: factType("option.selected"), version: 1 }]
        : id === parentId ? [{ type: factType("method.selected"), version: 1 }] : [],
      ...(id === nextId ? { automation: { version: 1, createInput: () => ({}) } } : {}),
      effect: "read", execute: () => Promise.resolve({ status: "completed" as const, output: {}, facts: [], evidence: [], artifacts: [] }),
    })),
  }));
}

describe("interaction delivery for superseded dynamic dependencies", () => {
  it("does not treat an already-completed follow-up as unfinished input after its control yields", async () => {
    const compiled = await compiledAgent();
    const initial: KernelCheckpoint = { schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint,
      facts: [], agenda: [], effects: [], messages: [] };
    const browse = step("independent-browse", browseId, "Show available options");
    const browsed = await reduceCapabilityResults({ checkpoint: initial, compiled, turnId: "browse" as never,
      plan: { steps: [browse], responseGoal: "Show options" }, results: [complete(browse, {
        id: "browse-more" as never, kind: "choice", mode: "optional", capabilityId: browseId, requestedFacts: [], goal: "See more?",
      })] });
    const choose = step("choose", parentId, "Use an independent method");
    const selected = complete(choose);
    if (selected.status !== "invoked" || selected.result.status !== "completed") throw Error("Invalid fixture");
    const reduced = await reduceCapabilityResults({ checkpoint: JSON.parse(JSON.stringify(browsed.checkpoint)) as KernelCheckpoint,
      compiled, turnId: "choose" as never, plan: { steps: [choose], responseGoal: "Continue" }, results: [{ ...selected, result: {
        ...selected.result, facts: [{ type: factType("method.selected"), version: 1, value: "chosen", evidenceIds: [], dependsOn: [] }],
      } }] });
    expect(reduced.checkpoint.interaction).toBeUndefined();
    expect(reduced.checkpoint.agenda.map(item => item.intention.proposedCapability)).toEqual([browseId]);
    expect(reconcileProgression({ checkpoint: reduced.checkpoint, compiled }).activation?.capabilityId).toBe(nextId);
  });

  it("does not activate remaining automatic work once the configured objective is completed", async () => {
    const compiled = await compiledAgent(true);
    const initial: KernelCheckpoint = { schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint,
      facts: [{ type: factType("method.selected"), version: 1, value: "done", evidenceIds: [], evidence: [], dependsOn: [],
        producedBy: { capabilityId: parentId, capabilityVersion: 1, turnId: "seed" as never, stepId: "seed" as never } }],
      agenda: [], effects: [], messages: [] };
    const finished = reconcileProgression({ checkpoint: initial, compiled });
    expect(finished.checkpoint.progression?.objective?.status).toBe("completed");
    expect(finished.activation).toBeUndefined();
    expect(finished.interactionRequested).toBe(false);
    // Completion does not prohibit a separately requested capability read.
    const read = step("read-after-completion", browseId, "Show details");
    const readResult = await reduceCapabilityResults({ checkpoint: finished.checkpoint, compiled, turnId: "later" as never,
      plan: { steps: [read], responseGoal: "Show details" }, results: [complete(read)] });
    expect(reconcileProgression({ checkpoint: readResult.checkpoint, compiled }).activation).toBeUndefined();
    expect(readResult.checkpoint.facts).toEqual(initial.facts);
  });

  it("does not recreate a dismissed control by activating later progression before its pending input is answered", async () => {
    const compiled = await compiledAgent();
    const pending = step("pending", parentId, "Choose an order method");
    const initial: KernelCheckpoint = { schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint,
      facts: [{ type: factType("method.selected"), version: 1, value: "context", evidenceIds: [], evidence: [], dependsOn: [],
        producedBy: { capabilityId: parentId, capabilityVersion: 1, turnId: "seed" as never, stepId: "seed" as never } }],
      agenda: [{ id: "agenda:pending" as never, intention: pending.intention, status: "waiting_input", missingFacts: [], dependencies: [] }],
      effects: [], messages: [], interaction: { id: "old-control" as never, kind: "choice", capabilityId: parentId,
        requestedFacts: [], goal: "Choose a method" } };
    const dismiss = step("dismiss", browseId, "Check whether options exist");
    const dismissed = await reduceCapabilityResults({ checkpoint: initial, compiled, turnId: "lookup" as never,
      plan: { steps: [dismiss], responseGoal: "Report no options" }, results: [complete(dismiss, null)] });
    const first = reconcileProgression({ checkpoint: dismissed.checkpoint, compiled });
    expect(first.checkpoint.interaction).toBeUndefined();
    expect(first.checkpoint.agenda).toEqual(initial.agenda);
    expect(first.activation).toBeUndefined();
    expect(first.checkpoint.progression?.occurrences[0]?.status).toBe("pending");

    // A checkpoint reload and another explicit read do not turn missing UI into consent to advance.
    const read = step("read", browseId, "Explain another topic");
    const interrupted = await reduceCapabilityResults({ checkpoint: JSON.parse(JSON.stringify(first.checkpoint)) as KernelCheckpoint,
      compiled, turnId: "read" as never, plan: { steps: [read], responseGoal: "Explain" }, results: [complete(read)] });
    expect(reconcileProgression({ checkpoint: interrupted.checkpoint, compiled }).activation).toBeUndefined();
    expect(interrupted.checkpoint.agenda).toEqual(initial.agenda);

    const answer = step("answer", parentId, "Use my explicit alternative");
    const answered = await reduceCapabilityResults({ checkpoint: interrupted.checkpoint, compiled, turnId: "answer" as never,
      plan: { steps: [answer], responseGoal: "Continue" }, results: [complete(answer)] });
    const resumed = reconcileProgression({ checkpoint: answered.checkpoint, compiled });
    expect(answered.checkpoint.agenda).toEqual([]);
    expect(resumed.activation?.capabilityId).toBe(nextId);
    expect(reconcileProgression({ checkpoint: resumed.checkpoint, compiled }).activation).toBeUndefined();
    expect(answered.checkpoint.effects).toEqual([]);
    expect(initial.interaction?.id).toBe("old-control");
  });

  it("still permits automatic progression while an explicitly optional control is visible", async () => {
    const compiled = await compiledAgent();
    const pending = step("optional", browseId, "Browse more");
    const checkpoint: KernelCheckpoint = { schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint,
      facts: [{ type: factType("method.selected"), version: 1, value: "context", evidenceIds: [], evidence: [], dependsOn: [],
        producedBy: { capabilityId: parentId, capabilityVersion: 1, turnId: "seed" as never, stepId: "seed" as never } }],
      agenda: [{ id: "agenda:optional" as never, intention: pending.intention, status: "waiting_input", missingFacts: [], dependencies: [] }],
      effects: [], messages: [], interaction: { id: "optional-control" as never, kind: "choice", mode: "optional", capabilityId: browseId,
        requestedFacts: [], goal: "Browse more?" } };
    expect(reconcileProgression({ checkpoint, compiled }).activation?.capabilityId).toBe(nextId);
  });

  it.each([false, true])("keeps a new question when another completed step dismisses only the previous question (dismiss first: %s)", async (dismissFirst) => {
    const compiled = await compiledAgent();
    const previous: Interaction = { id: "previous" as never, kind: "input", capabilityId: parentId, requestedFacts: [], goal: "Previous question" };
    const fresh: Interaction = { id: "fresh" as never, kind: "input", capabilityId: selectId, requestedFacts: [], goal: "New question" };
    const initial: KernelCheckpoint = { schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint,
      facts: [], agenda: [], effects: [], messages: [], interaction: previous };
    const dismiss = step("dismiss", browseId, "Check availability");
    const collect = step("collect", selectId, "Make another selection");
    const steps = dismissFirst ? [dismiss, collect] : [collect, dismiss];
    const results = steps.map(item => complete(item, item.id === dismiss.id ? null : fresh));
    const reduced = await reduceCapabilityResults({ checkpoint: initial, compiled, turnId: "turn" as never,
      plan: { steps, responseGoal: "Continue" }, results });
    expect(reduced.checkpoint.interaction).toEqual(fresh);
    expect(reduced.checkpoint.agenda.map(item => item.intention.proposedCapability)).toEqual([selectId]);
    expect(reduced.checkpoint.effects).toEqual([]);
  });
  it.each(["owned", "independent-request", "preexisting-browser", "shared-owner", "unrelated-target", "protected-confirmation"])(
    "handles the active dependency interaction after its parent takes an alternative (%s)", async (scenario) => {
      const compiled = await compiledAgent();
      const initial: KernelCheckpoint = { schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, facts: [],
        agenda: scenario === "preexisting-browser" ? [{ id: "independent" as never, intention: step("independent", browseId, "independent browsing").intention,
          status: "waiting_input", missingFacts: [], dependencies: [] }] : [], effects: [], messages: [] };
      const first = step("first", parentId, "start order");
      const parentInteraction: Interaction = { id: "parent-question" as never, kind: "choice", capabilityId: parentId, goal: "Use options?", requestedFacts: [] };
      const turn1 = await reduceCapabilityResults({ checkpoint: initial, compiled, turnId: "one" as never,
        plan: { steps: [first], responseGoal: "Ask" }, results: [complete(first, parentInteraction)] });
      const answer = "yes, use options";
      const parent = { ...step("parent", parentId, answer), interactionAnswer: { interactionId: parentInteraction.id, value: true, evidence: answer } };
      const browse = step("browse", browseId, scenario === "independent-request" ? "also browse unrelated alternatives for me" : answer);
      const active: Interaction = scenario === "protected-confirmation"
        ? { id: "protected" as never, kind: "confirmation", capabilityId: browseId, goal: "Confirm private details", requestedFacts: [], protectedCanonicalMessage: "Private confirmation" }
        : { id: "options" as never, kind: "choice", capabilityId: browseId, goal: "Which option?", requestedFacts: [], options: [
            { id: "option-1", label: "Option 1", value: "one", targetCapabilityId: scenario === "unrelated-target" ? parentId : selectId },
          ] };
      const turn2Plan: TurnPlan = { steps: [parent, browse], answeredInteractionCapabilityId: parentId, responseGoal: "Choose" };
      const turn2 = await reduceCapabilityResults({ checkpoint: turn1.checkpoint, compiled, turnId: "two" as never, plan: turn2Plan,
        results: [{ status: "invoked", stepId: parent.id, capabilityId: parentId, result: {
          status: "needs_dependency", requirement: { type: factType("option.selected"), version: 1, description: "Chosen option" },
          provider: { capabilityId: selectId, input: {} },
        } }, complete(browse, active)],
      });
      const alternate = step("alternate", parentId, "use the alternative");
      const thirdResult = complete(alternate);
      if (thirdResult.status !== "invoked" || thirdResult.result.status !== "completed") throw new Error("Fixture result missing");
      const finalResults: StepExecutionResult[] = [{ ...thirdResult, result: { ...thirdResult.result,
        facts: [{ type: factType("method.selected"), version: 1, value: "alternative", evidenceIds: [], dependsOn: [] }],
      } }];
      const shared = { id: "shared" as never, intention: step("shared", selectId, "separate request").intention,
        status: "waiting_facts" as const, missingFacts: [{ type: factType("option.selected"), version: 1, description: "Selection" }],
        dependencies: ["agenda:browse" as never], ownedDependencyIds: ["agenda:browse"],
      };
      const thirdPlan: TurnPlan = { steps: [alternate], responseGoal: "Continue" };
      const checkpoint = { ...turn2.checkpoint, agenda: [...turn2.checkpoint.agenda, ...(scenario === "shared-owner" ? [shared] : [])] };
      const turn3 = await reduceCapabilityResults({ checkpoint: JSON.parse(JSON.stringify(checkpoint)) as KernelCheckpoint,
        compiled, turnId: "three" as never, plan: thirdPlan, results: finalResults });
      const progression = reconcileProgression({ checkpoint: turn3.checkpoint, compiled, plan: thirdPlan, results: finalResults });
      if (scenario === "owned") {
        expect(turn3.checkpoint.agenda).toEqual([]);
        expect(turn3.checkpoint.interaction).toBeUndefined();
        expect(progression.activation?.capabilityId).toBe(nextId);
      } else {
        expect(turn3.checkpoint.agenda.map((item) => item.intention.proposedCapability)).toEqual(scenario === "shared-owner" ? [browseId, selectId] : [browseId]);
        expect(turn3.checkpoint.interaction).toEqual(active);
        expect(progression.activation).toBeUndefined();
      }
    },
  );
});
