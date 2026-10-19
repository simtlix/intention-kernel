import { describe, expect, it } from "vitest";
import { agentId, capabilityId, compileAgentDefinition, defineAgent, defineCapability, defineSchema, factType, type FactRecord } from "../../src/internal.js";
import { reconcileProgression } from "../../src/progression/reconcileProgression.js";

const schema = defineSchema({ vendor: "availability-test", validate: (value: unknown) => ({ value }), jsonSchema: () => ({ type: "object" }) });
const selected = { type: factType("item.selected"), version: 1 };
const operation = defineCapability({
  id: capabilityId("item.preview"), version: 1, description: "Preview an item", input: schema, output: schema,
  requires: [], provides: [selected], effect: "read", automation: { version: 1, createInput: () => ({}) },
  execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
});
function definition(filteredPrompt = "Continue?") {
  return defineAgent({
    id: agentId("conditional-offer"), version: 1, identity: "Test", capabilities: [operation], policies: [], modelPolicy: {},
    progression: {
      groups: [{ id: "inspect", label: "Inspect", prompt: "Preview or continue?", filteredPrompt,
        continueLabel: "Continue", repeatAfterMember: true,
        members: [{ capabilityId: operation.id, label: "Preview", examples: ["preview it"], availableWhen: { fact: selected, path: ["previewAvailable"], equals: true } }] }],
      rules: [{ id: "inspect-selected", version: 1, target: { groupId: "inspect" }, mode: "required", priority: 1, activateWhen: [selected] }],
    },
  });
}
function publication(value: unknown, serial: string): FactRecord {
  return { ...selected, value, evidenceIds: [], evidence: [], dependsOn: [], producedBy: {
    capabilityId: operation.id, capabilityVersion: 1, turnId: `turn-${serial}` as never, stepId: `step-${serial}` as never,
  } };
}
describe("fact-conditioned progression offers", () => {
  it.each([false, null, undefined, "true", 1])("hides unverified members and their semantic examples for %s", async value => {
    const compiled = await compileAgentDefinition(definition());
    const result = reconcileProgression({ compiled, checkpoint: { schemaVersion: 1, revision: 1, agentFingerprint: compiled.fingerprint,
      messages: [], facts: [publication({ previewAvailable: value }, "a")], agenda: [], effects: [] } });
    expect(result.checkpoint.interaction?.goal).toBe("Continue?");
    expect(result.checkpoint.interaction?.options?.map(option => option.label)).toEqual(["Continue"]);
    expect(result.checkpoint.interaction?.payload).toMatchObject({ memberExamples: [] });
  });

  it("reevaluates a new selection instead of retaining availability from a different item", async () => {
    const compiled = await compileAgentDefinition(definition());
    const first = reconcileProgression({ compiled, checkpoint: { schemaVersion: 1, revision: 1, agentFingerprint: compiled.fingerprint,
      messages: [], facts: [publication({ previewAvailable: true }, "a")], agenda: [], effects: [] } });
    expect(first.checkpoint.interaction?.goal).toBe("Preview or continue?");
    expect(first.checkpoint.interaction?.options?.map(option => option.label)).toEqual(["Preview", "Continue"]);
    const checkpoint = { ...first.checkpoint };
    delete checkpoint.interaction;
    const second = reconcileProgression({ compiled, checkpoint: { ...checkpoint, facts: [publication({ previewAvailable: false }, "b")] } });
    expect(second.checkpoint.interaction?.options?.map(option => option.label)).toEqual(["Continue"]);
  });

  it("rejects conditional groups without safe filtered copy", async () => {
    await expect(compileAgentDefinition(definition(""))).rejects.toMatchObject({ code: "INVALID_PROGRESSION_MEMBER_AVAILABILITY" });
  });
});
