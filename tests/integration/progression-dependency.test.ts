import { describe, expect, it } from "vitest";
import { agentId, capabilityId, createKernel, defineAgent, defineCapability, defineSchema, factType } from "../../src/index.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";
import { createMemoryDurability } from "../../src/testing/createMemoryDurability.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });
const publication = (name: string) => ({ type: factType(name), version: 1, value: true, evidenceIds: [], dependsOn: [] });

describe("progression actions across automatic dependencies", () => {
  it("durably closes the accepted group before collecting a dependency and activates the next decision after completion", async () => {
    const executions: string[] = [];
    const begin = defineCapability({ id: capabilityId("product.select"), version: 1, description: "Select product", input: schema, output: schema,
      requires: [], provides: [{ type: factType("product.selected"), version: 1 }], effect: "read",
      automation: { version: 1, createInput: () => ({}) },
      execute: () => Promise.resolve({ status: "completed", output: {}, facts: [publication("product.selected")], evidence: [], artifacts: [] }),
    });
    const provider = defineCapability({ id: capabilityId("identity.collect"), version: 1, description: "Collect identity", input: schema, output: schema,
      requires: [], provides: [{ type: factType("identity.confirmed"), version: 1 }], effect: "read", execute: (context) => {
        executions.push("identity.collect");
        return Promise.resolve(context.turn.interactionAnswer?.value === "done"
          ? { status: "completed" as const, output: {}, facts: [publication("identity.confirmed")], evidence: [], artifacts: [] }
          : { status: "needs_input" as const, partialInput: {}, interaction: { id: "identity" as never, kind: "choice" as const,
            capabilityId: capabilityId("identity.collect"), goal: "Confirm identity", requestedFacts: [], options: [{ id: "done", label: "Done", value: "done" }],
          } });
      },
    });
    const quote = defineCapability({ id: capabilityId("item.quote"), version: 1, description: "Value item", input: schema, output: schema,
      requires: [], provides: [{ type: factType("item.quoted"), version: 1 }], effect: "read", execute: (context) => {
        executions.push("item.quote");
        return Promise.resolve(context.facts.some((fact) => fact.type === "identity.confirmed")
          ? { status: "completed" as const, output: {}, facts: [publication("item.quoted")], evidence: [], artifacts: [] }
          : { status: "needs_dependency" as const, requirement: { type: factType("identity.confirmed"), version: 1, description: "Confirmed identity" },
            provider: { capabilityId: provider.id, input: {} }, continuation: {},
          });
      },
    });
    const decision = defineCapability({ id: capabilityId("item.decide"), version: 1, description: "Decide whether to include item", input: schema, output: schema,
      requires: [], provides: [], effect: "read", automation: { version: 1, createInput: () => ({}) }, execute: () => {
        executions.push("item.decide");
        return Promise.resolve({ status: "needs_input" as const, partialInput: {}, interaction: { id: "include" as never, kind: "choice" as const,
          capabilityId: capabilityId("item.decide"), goal: "Include the quoted item?", requestedFacts: [], options: [{ id: "yes", label: "Yes", value: true }],
        } });
      },
    });
    let phase = 0;
    let occurrenceId = "";
    const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
      const capability = [begin.id, quote.id, provider.id][phase];
      const text = ["select product", "Value item and continue", "done"][phase];
      const evidence = [{ text: phase === 1 ? "Value item" : text, meaning: "Current request", messageIndex: phase * 2 }];
      const responses: Record<string, unknown> = {
        "capability.select": { mode: "selected", capabilityIds: [capability], rationale: "Current request", evidence },
        "capability-selection.interaction-review": { verdict: "supported", rationale: "Separate current item valuation request." },
        "interaction-answer.review": { verdict: "supported", rationale: "Separate explicit item valuation and continuation requests." },
        "turn.interpret": { intentions: [{ id: `request-${String(phase)}`, objective: "Current request", evidence, references: [], proposedCapability: capability, input: {}, resolution: "resolved" }], contradictions: [],
          ...(phase === 1 ? { answerToInteraction: { interactionId: `progression:${occurrenceId}`, value: { kind: "progression.continue", occurrenceId }, evidence: "continue" } } : {}),
        },
        "response.compose": { parts: [{ text: "Which option would you like?", evidenceIds: [] }] },
        "response.grounding-review": { verdict: "supported", decisionVerdict: "supported", continuityVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: [] },
      };
      if (!(request.task in responses)) throw new Error(`Unexpected task ${request.task}`);
      return Promise.resolve({ value: responses[request.task] as T, provider: "scripted", model: "test", durationMs: 1 });
    } };
    const agent = await createKernel({ modelGateway: gateway, durability: createMemoryDurability() }).compile(defineAgent({
      id: agentId("progression.dependency"), version: 1, identity: "Assistant", policies: [], modelPolicy: {}, capabilities: [begin, provider, quote, decision],
      progression: { groups: [{ id: "explore", label: "Explore product", prompt: "More details or continue?", continueLabel: "Continue",
        repeatAfterMember: true, completedMemberVisibility: "show", members: [{ capabilityId: begin.id, label: "Select another product", examples: [] }],
      }], rules: [
        { id: "explore.selected", version: 1, target: { groupId: "explore" }, mode: "required", priority: 100, activateWhen: [{ type: factType("product.selected"), version: 1 }] },
        { id: "decide.quoted", version: 1, target: { capabilityId: decision.id }, mode: "required", priority: 200, activateWhen: [{ type: factType("item.quoted"), version: 1 }] },
      ] },
    }));
    const first = await agent.run({ threadId: "thread" as never, turnId: "first" as never, input: { text: "select product" } });
    occurrenceId = first.checkpoint.progression?.occurrences[0]?.id ?? "";
    expect(occurrenceId).not.toBe("");
    phase = 1;
    const collecting = await agent.run({ threadId: "thread" as never, turnId: "collect" as never, input: { text: "Value item and continue" } });
    expect(collecting.checkpoint.interaction?.id).toBe("identity");
    expect(collecting.checkpoint.progression?.occurrences.find((occurrence) => occurrence.id === occurrenceId)?.status).toBe("declined");
    phase = 2;
    const completed = await agent.run({ threadId: "thread" as never, turnId: "complete" as never, input: { text: "done" }, selection: { interactionId: "identity" as never, optionId: "done" } });
    expect(completed.checkpoint.interaction?.id).toBe("include");
    expect(completed.response.interaction?.id).toBe("include");
    expect(completed.checkpoint.progression?.occurrences.find((occurrence) => occurrence.id === occurrenceId)?.status).toBe("declined");
    expect(executions).toEqual(["item.quote", "identity.collect", "identity.collect", "item.quote", "item.decide"]);
  });
});
