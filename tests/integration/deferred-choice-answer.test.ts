import { describe, expect, it } from "vitest";
import { agentId, capabilityId, createKernel, defineAgent, defineCapability, defineSchema, factType } from "../../src/index.js";
import type { KernelCheckpoint } from "../../src/contracts/checkpoint.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";
import type { ResponseBrief } from "../../src/contracts/response.js";
import { createMemoryDurability } from "../../src/testing/createMemoryDurability.js";
import { updateAgenda } from "../../src/reducer/updateAgenda.js";

const schema = defineSchema<Record<string, unknown>>({ vendor: "test", validate: (value) => ({ value: value as Record<string, unknown> }), jsonSchema: () => ({ type: "object" }) });

async function fixture(protectedWrite = false, secondDependency = false) {
  const owner = capabilityId("purchase.decide");
  const provider = capabilityId("asset.quote");
  const quoted = factType("asset.quoted");
  const audited = factType("asset.audited");
  const choice = { id: "purchase-choice" as never, kind: "choice" as const, capabilityId: owner, requestedFacts: [],
    goal: "¿Incluimos el bien cotizado?", payload: { serverOnlyMarker: "original-choice-payload" },
    options: [{ id: "include", label: "Incluir", value: { decision: "include" } }, { id: "exclude", label: "Excluir", value: { decision: "exclude" } }],
  };
  const providerChoice = { id: "quote-input" as never, kind: "choice" as const, capabilityId: provider, requestedFacts: [quoted],
    goal: "¿Terminaste de aportar los datos?", options: [{ id: "more", label: "Más datos", value: "more" }, { id: "done", label: "Listo", value: "done" }],
  };
  const responses: Record<string, unknown> = {};
  const requests: ModelRequest<unknown>[] = [];
  const calls: { capability: string; answer: unknown; interactionId: unknown; input: unknown }[] = [];
  const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
    requests.push(request);
    let value = responses[request.task];
    if (request.task.startsWith("response.compose")) {
      const input = request.input as ResponseBrief & { brief?: ResponseBrief };
      const brief = input.brief ?? input;
      value = { parts: [...(brief.requiredResponses ?? []).map((response) => ({ text: response.message, evidenceIds: response.claims.flatMap((claim) => claim.evidenceIds) })),
        ...(brief.interaction === undefined ? [] : [{ text: brief.interaction.goal, evidenceIds: [] }]),
      ] };
    } else if (request.task === "response.grounding-review") {
      const input = request.input as { response: { claims: readonly unknown[] } };
      value = { verdict: "supported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: input.response.claims.map((_, index) => index) };
    } else if (request.task.includes("review")) value = { verdict: "supported", rationale: "Both explicitly requested operations and exact current choice are supported." };
    if (value === undefined) throw new Error(`Unexpected task: ${request.task}`);
    return Promise.resolve({ value: value as T, provider: "scripted", model: "offline", durationMs: 1 });
  } };
  const fact = { type: quoted, version: 1, value: { receipt: "quote-1" }, evidenceIds: [], dependsOn: [] };
  const quote = defineCapability({ id: provider, version: 1, description: "Quote the owned asset", input: schema, output: schema,
    requires: [], provides: [{ type: quoted, version: 1 }], effect: "read", execute: (context, input) => {
      calls.push({ capability: provider, answer: context.turn.interactionAnswer?.value, interactionId: context.turn.interaction?.id, input });
      if (context.turn.interactionAnswer?.value !== "done") return Promise.resolve({ status: "needs_input" as const, interaction: providerChoice, partialInput: { stage: "collecting" } });
      const message = "Cotización obtenida.";
      return Promise.resolve({ status: "completed" as const, output: {}, facts: [fact], artifacts: [], evidence: [{ id: "quote-evidence" as never, source: "capability" as const, content: message }],
        canonicalResponse: { message, claims: [{ text: message, evidenceIds: ["quote-evidence" as never] }], required: true },
      });
    },
  });
  const decision = defineCapability({ id: owner, version: 1, description: "Decide whether to include the quoted asset", input: schema, output: schema,
    requires: [{ type: quoted, version: 1, description: "Quoted asset", resolution: "runtime" }], provides: [],
    effect: protectedWrite ? "write" : "read", ...(protectedWrite ? { confirmation: "required" as const } : {}),
    execute: (context, input) => {
      calls.push({ capability: owner, answer: context.turn.interactionAnswer?.value, interactionId: context.turn.interaction?.id, input });
      const answer = context.turn.interactionAnswer?.value as { decision?: string } | undefined;
      const selected = answer?.decision ?? input["decision"] ?? (context.turn.continuation as { decision?: string } | undefined)?.decision;
      if (selected !== "include" && selected !== "exclude") return Promise.resolve({ status: "needs_input" as const, interaction: choice });
      if (secondDependency && !context.facts.some((fact) => fact.type === audited)) return Promise.resolve({
        status: "needs_dependency" as const, requirement: { type: audited, version: 1, description: "Audited asset" },
        provider: { capabilityId: capabilityId("asset.audit"), input: {} }, continuation: { decision: selected },
      });
      const message = selected === "include" ? "El bien quedó incluido." : "El bien quedó excluido.";
      return Promise.resolve({ status: "completed" as const, output: { decision: selected }, facts: [], artifacts: [], evidence: [{ id: "decision-evidence" as never, source: "capability" as const, content: message }],
        canonicalResponse: { message, claims: [{ text: message, evidenceIds: ["decision-evidence" as never] }], required: true },
      });
    },
  });
  const audit = defineCapability({ id: capabilityId("asset.audit"), version: 1, description: "Audit asset", input: schema, output: schema,
    requires: [], provides: [{ type: audited, version: 1 }], effect: "read", execute: (context) => {
      expect(context.turn.interactionAnswer).toBeUndefined();
      return Promise.resolve({ status: "completed" as const, output: {}, facts: [{ type: audited, version: 1, value: true, evidenceIds: [], dependsOn: [] }], evidence: [], artifacts: [] });
    },
  });
  const durability = createMemoryDurability();
  const agent = await createKernel({ modelGateway: gateway, durability }).compile(defineAgent({ id: agentId("deferred-choice"), version: 1,
    identity: "Asesor", capabilities: [decision, quote, ...(secondDependency ? [audit] : [])], policies: [], modelPolicy: {},
  }));
  const intention = (id: typeof owner, text: string) => ({ id: `intention-${id}` as never, objective: id, resolution: "resolved" as const, proposedCapability: id,
    input: { request: text }, references: [], evidence: [{ text, meaning: "Explicit request", messageIndex: 0 }],
  });
  const checkpoint: KernelCheckpoint = { schemaVersion: 1, revision: 1, agentFingerprint: agent.fingerprint, messages: [], facts: [], effects: [], interaction: choice,
    agenda: [{ id: "pending-owner" as never, intention: intention(owner, "Original request"), status: "waiting_input", missingFacts: [], dependencies: [] }],
  };
  const threadId = "deferred-choice" as never;
  const commit = (next: KernelCheckpoint) => durability.withTurn({ threadId, turnId: `seed-${String(next.revision)}` as never }, async (scope) => {
    await scope.commit({ value: null, checkpoint: JSON.parse(JSON.stringify(next)) as KernelCheckpoint });
  });
  await commit(checkpoint);
  const run = async (turn: string, ids: readonly typeof owner[], interactionId: string, optionId: string) => {
    const text = optionId;
    responses["capability.select"] = { mode: "selected", capabilityIds: ids, rationale: "Explicit operations", evidence: intention(owner, text).evidence };
    responses["turn.interpret"] = { intentions: ids.map((id) => intention(id, text)), contradictions: [] };
    return agent.run({ threadId, turnId: turn as never, input: { text }, selection: { interactionId: interactionId as never, optionId } });
  };
  const first = () => run("one", [owner, provider], choice.id, "include");
  const rejectWithNewRequest = () => {
    const text = "No quiero incluirlo";
    responses["capability.select"] = { mode: "selected", capabilityIds: [owner], rationale: "Explicit replacement", evidence: intention(owner, text).evidence };
    responses["turn.interpret"] = { intentions: [{ ...intention(owner, text), input: { decision: "exclude" } }], contradictions: [] };
    return agent.run({ threadId, turnId: "replacement" as never, input: { text } });
  };
  return { first, run, commit, rejectWithNewRequest, calls, requests, owner, provider, choice, fact };
}

describe("unconsumed choice answers waiting for a fact provider", () => {
  it("delivers the original decision after three turns and serialized checkpoints without asking again", async () => {
    const setup = await fixture();
    const first = await setup.first();
    expect(setup.calls.filter(({ capability }) => capability === setup.owner)).toEqual([]);
    expect(first.checkpoint.agenda.find((item) => item.intention.proposedCapability === setup.owner)?.status).toBe("waiting_facts");
    await setup.commit({ ...first.checkpoint, revision: first.checkpoint.revision + 1 });
    const requestOffset = setup.requests.length;
    const middle = await setup.run("two", [setup.provider], "quote-input", "more");
    expect(middle.response.interaction?.id).toBe("quote-input");
    expect(setup.calls.filter(({ capability }) => capability === setup.owner)).toEqual([]);
    const last = await setup.run("three", [setup.provider], "quote-input", "done");
    expect(last.response.message).toContain("Cotización obtenida.");
    expect(last.response.message).toContain("El bien quedó incluido.");
    expect(last.response.interaction).toBeUndefined();
    expect(setup.calls.filter(({ capability }) => capability === setup.owner)).toEqual([
      { capability: setup.owner, answer: { decision: "include" }, interactionId: "purchase-choice", input: { request: "include" } },
    ]);
    expect(setup.calls.filter(({ capability }) => capability === setup.provider).map(({ answer }) => answer)).toEqual([undefined, "more", "done"]);
    expect(JSON.stringify(setup.requests.slice(requestOffset))).not.toContain("original-choice-payload");
    expect(last.checkpoint.agenda).toEqual([]);
    const replay = await setup.run("three", [setup.provider], "quote-input", "done");
    expect(replay.replayed).toBe(true);
    expect(setup.calls).toHaveLength(4);
  });

  it("honors a newer choice instead of replaying the suspended original decision", async () => {
    const setup = await fixture();
    const first = await setup.first();
    await setup.commit({ ...first.checkpoint, revision: first.checkpoint.revision + 1,
      facts: [{ ...setup.fact, evidence: [], producedBy: { capabilityId: setup.provider, capabilityVersion: 1, turnId: "fresh" as never, stepId: "fresh" as never } }],
      interaction: { ...setup.choice, id: "new-choice" as never },
    });
    const result = await setup.run("new", [setup.owner], "new-choice", "exclude");
    expect(result.response.message).toContain("El bien quedó excluido.");
    expect(setup.calls.filter(({ capability }) => capability === setup.owner).map(({ answer, interactionId }) => ({ answer, interactionId })))
      .toEqual([{ answer: { decision: "exclude" }, interactionId: "new-choice" }]);
  });

  it("does not resurrect the retained decision after cancellation while its independent provider completes", async () => {
    const setup = await fixture();
    const first = await setup.first();
    const pending = first.checkpoint.agenda.find((item) => item.intention.proposedCapability === setup.owner);
    if (pending === undefined) throw new Error("Missing pending owner");
    await setup.commit({ ...first.checkpoint, revision: first.checkpoint.revision + 1,
      agenda: updateAgenda(first.checkpoint.agenda, { steps: [], responseGoal: "Cancel decision", cancelledAgendaItemIds: [pending.id] }, []),
    });
    const result = await setup.run("finish", [setup.provider], "quote-input", "done");
    expect(result.response.message).toContain("Cotización obtenida.");
    expect(setup.calls.filter(({ capability }) => capability === setup.owner)).toEqual([]);
  });

  it("does not override a new explicit negative request while the provider interaction is active", async () => {
    const setup = await fixture();
    await setup.first();
    const result = await setup.rejectWithNewRequest();
    expect(result.response.message).toContain("El bien quedó excluido.");
    expect(setup.calls.filter(({ capability }) => capability === setup.owner)).toEqual([
      { capability: setup.owner, answer: undefined, interactionId: undefined, input: { decision: "exclude" } },
    ]);
    expect(result.checkpoint.agenda.some((item) => item.intention.proposedCapability === setup.owner)).toBe(false);
  });

  it("does not treat an ordinary choice as confirmation for a protected write", async () => {
    const setup = await fixture(true);
    const first = await setup.first();
    expect(first.checkpoint.effects).toEqual([]);
    // The planner's protected confirmation takes priority over provider input.
    expect(setup.calls.filter(({ capability }) => capability === setup.owner)).toEqual([]);
    expect(first.checkpoint.agenda.find((item) => item.intention.proposedCapability === setup.owner)?.status).toBe("waiting_confirmation");
  });

  it("consumes the retained answer on invocation and lets the capability own a later dependency continuation", async () => {
    const setup = await fixture(false, true);
    await setup.first();
    const result = await setup.run("finish", [setup.provider], "quote-input", "done");
    expect(result.response.message).toContain("El bien quedó incluido.");
    expect(result.response.interaction).toBeUndefined();
    expect(setup.calls.filter(({ capability }) => capability === setup.owner).map(({ answer }) => answer))
      .toEqual([{ decision: "include" }, undefined]);
    expect(result.checkpoint.agenda).toEqual([]);
  });
});
