import { describe, expect, it } from "vitest";
import { agentId, capabilityId, createKernel, defineAgent, defineCapability, defineSchema, factType } from "../../src/index.js";
import { createMemoryDurability } from "../../src/testing/createMemoryDurability.js";
import type { ModelGateway, ModelResult } from "../../src/contracts/model.js";
import type { KernelCheckpoint } from "../../src/contracts/checkpoint.js";
import type { KernelEvent } from "../../src/contracts/events.js";
import { updateAgenda } from "../../src/reducer/updateAgenda.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });

describe("same-turn consumers of interactive fact providers", () => {
  it.each(["static", "runtime", "shared"])("waits across three turns then executes once (%s)", async (mode) => {
    let writes = 0;
    let providerCalls = 0;
    let otherCalls = 0;
    const requirement = { type: factType("identity.confirmed"), version: 1, description: "Confirmed identity",
      ...(mode === "runtime" ? { resolution: "runtime" as const } : {}),
    };
    const provider = defineCapability({ id: capabilityId("identity.collect"), version: 1, description: "Collect identity", input: schema, output: schema,
      requires: [], provides: [{ type: factType("identity.confirmed"), version: 1 }], effect: "read",
      execute: (context) => {
        providerCalls += 1;
        if (context.turn.interactionAnswer?.value === "done") return Promise.resolve({ status: "completed" as const,
          output: {}, facts: [{ type: factType("identity.confirmed"), version: 1, value: { id: "identity-1" }, evidenceIds: [], dependsOn: [] }], evidence: [], artifacts: [],
        });
        return Promise.resolve({ status: "needs_input" as const, partialInput: { phase: "details" }, interaction: {
          id: "identity-input" as never, capabilityId: capabilityId("identity.collect"), kind: "choice" as const,
          goal: "Complete the identity", requestedFacts: [factType("identity.confirmed")],
          options: [{ id: "more", label: "More", value: "more" }, { id: "done", label: "Done", value: "done" }],
        } });
      },
    });
    const consumer = defineCapability({ id: capabilityId("quotation.create"), version: 1, description: "Create quotation", input: schema, output: schema,
      requires: [requirement], provides: [], effect: "write", confirmation: "capability",
      execute: async (context) => {
        expect(context.facts.some((fact) => fact.type === "identity.confirmed")).toBe(true);
        await context.runEffect("quote-one", () => { writes += 1; return Promise.resolve({ id: "quote-1" }); });
        return { status: "completed", output: {}, facts: [], evidence: [], artifacts: [] };
      },
    });
    const shared = defineCapability({ id: capabilityId("identity.audit"), version: 1, description: "Audit identity", input: schema, output: schema,
      requires: [requirement], provides: [], effect: "read", execute: () => {
        otherCalls += 1;
        return Promise.resolve({ status: "completed" as const, output: {}, facts: [], evidence: [], artifacts: [] });
      },
    });
    const ids = ["quotation.create", "identity.collect", ...(mode === "shared" ? ["identity.audit"] : [])];
    const text = "Collect identity and create quotation";
    const evidence = [{ text, meaning: "Requested operations", messageIndex: 0 }];
    const responses: Record<string, unknown> = {
      "capability.select": { mode: "selected", capabilityIds: ids, rationale: "Requested operations", evidence },
      "turn.interpret": { intentions: ids.map((id) => ({ objective: id, evidence, references: [], proposedCapability: id, input: {}, resolution: "resolved" })), contradictions: [] },
      "response.compose": { parts: [{ text: "Continue", evidenceIds: [] }] },
      "response.grounding-review": { verdict: "supported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: [] },
    };
    const gateway: ModelGateway = { invoke: <T>(request: { task: string }): Promise<ModelResult<T>> => {
      if (!(request.task in responses)) throw new Error(`Unexpected task: ${request.task}`);
      return Promise.resolve({ value: responses[request.task] as T, provider: "scripted", model: "test", durationMs: 1 });
    } };
    let sequence = 0;
    const durability = createMemoryDurability();
    const events: KernelEvent[] = [];
    const agent = await createKernel({ modelGateway: gateway, durability, eventSink: { emit: (event) => { events.push(event); return Promise.resolve(); } }, idGenerator: { next: (kind) => `${kind}-${String(++sequence)}` } })
      .compile(defineAgent({ id: agentId("same-turn-provider"), version: 1, identity: "Assistant", capabilities: [consumer, provider, ...(mode === "shared" ? [shared] : [])], policies: [], modelPolicy: {} }));
    const threadId = `same-turn-${mode}` as never;
    const first = await agent.run({ threadId, turnId: "one" as never, input: { text } });
    expect(events.find((event) => event.type === "capability.skipped")?.data).toMatchObject({ capabilityId: "quotation.create", status: "skipped", reasonCode: "DEPENDENCY_PENDING" });
    expect(events.some((event) => event.type === "capability.failed")).toBe(false);
    expect(first.checkpoint.agenda.find((item) => item.intention.proposedCapability === "quotation.create"))
      .toMatchObject({ status: "waiting_facts", missingFacts: [requirement] });
    expect(writes).toBe(0);
    const roundTrip = JSON.parse(JSON.stringify(first.checkpoint)) as KernelCheckpoint;
    const waitingQuote = roundTrip.agenda.find((item) => item.intention.proposedCapability === "quotation.create");
    if (waitingQuote === undefined) throw new Error("Missing quotation agenda fixture");
    expect(waitingQuote.dependencies).toHaveLength(1);
    // Explicitly requested providers remain independent, including when shared.
    expect(updateAgenda(roundTrip.agenda, { steps: [], responseGoal: "Cancel quotation", cancelledAgendaItemIds: [waitingQuote.id] }, [])
      .map((item) => item.intention.proposedCapability)).toEqual(["identity.collect", ...(mode === "shared" ? ["identity.audit"] : [])]);
    expect(updateAgenda(roundTrip.agenda, { steps: [], responseGoal: "Cancel objective", cancelledObjectiveIds: ["purchase"] }, [])).toEqual([]);
    await durability.withTurn({ threadId, turnId: "serialized" as never }, async (scope) => {
      await scope.commit({ value: null, checkpoint: { ...roundTrip, revision: roundTrip.revision + 1 } });
    });
    for (const [index, optionId] of ["more", "done"].entries()) {
      const answerEvidence = [{ text: optionId, meaning: "Answer identity", messageIndex: first.checkpoint.messages.length + index * 2 }];
      responses["capability.select"] = { mode: "selected", capabilityIds: ["identity.collect"], rationale: "Answer identity", evidence: answerEvidence };
      responses["turn.interpret"] = { intentions: [{ objective: "Answer identity", evidence: answerEvidence, references: [], proposedCapability: "identity.collect", input: {}, resolution: "resolved" }], contradictions: [] };
      const result = await agent.run({ threadId, turnId: `next-${String(index)}` as never, input: { text: optionId }, selection: { interactionId: "identity-input" as never, optionId } });
      if (index === 0) {
        expect(writes).toBe(0);
        expect(result.checkpoint.agenda.find((item) => item.intention.proposedCapability === "quotation.create")?.status).toBe("waiting_facts");
        const providerItem = result.checkpoint.agenda.find((item) => item.intention.proposedCapability === "identity.collect");
        expect(result.checkpoint.agenda.find((item) => item.intention.proposedCapability === "quotation.create")?.dependencies).toEqual([providerItem?.id]);
      } else {
        expect(result.checkpoint.agenda).toEqual([]);
        expect(result.checkpoint.effects).toHaveLength(1);
      }
    }
    expect(providerCalls).toBe(3);
    expect(writes).toBe(1);
    expect(otherCalls).toBe(mode === "shared" ? 1 : 0);
    await agent.run({ threadId, turnId: "next-1" as never, input: { text: "done" }, selection: { interactionId: "identity-input" as never, optionId: "done" } });
    expect(writes).toBe(1);
  });
});
