import { describe, expect, it } from "vitest";
import {
  buildResponseBrief, buildResponseDelivery, capabilityId, composeResponse,
  type CanonicalResponse, type Interaction, type ModelGateway, type ModelRequest,
  type ModelResult, type ResponseBrief, type TurnPlan, type TurnReduction,
} from "../../src/internal.js";

const amount = "The estimated value is ARS 12.367.000.";
const identified = "The supplied product and its usage were identified.";
const question = "Would you like to include this value?";
const supported = { verdict: "supported", continuityVerdict: "supported", decisionVerdict: "supported", unsupportedClaims: [], approvedClaimIndexes: [] };
const choice: Interaction = {
  id: "inclusion-choice" as never, kind: "choice", capabilityId: capabilityId("value.include"),
  requestedFacts: [], goal: question,
  options: [{ id: "include", label: "Include", value: true }, { id: "exclude", label: "Exclude", value: false }],
};
class Gateway implements ModelGateway {
  readonly requests: ModelRequest<unknown>[] = [];
  constructor(readonly values: unknown[] = []) {}
  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    this.requests.push(request);
    return Promise.resolve({ value: this.values.shift() as T, provider: "scripted", model: "scripted", durationMs: 0 });
  }
}
const draft = (text: string, evidenceIds: readonly string[] = []) => ({ parts: [{ text, evidenceIds }] });
function canonical(message: string, id: string, required = false): CanonicalResponse {
  return { message, claims: [{ text: message, evidenceIds: [id as never] }], ...(required ? { required: true } : {}) };
}
function input(completions: readonly Readonly<{ message: string; canonical?: CanonicalResponse }>[], interaction?: Interaction) {
  const steps: TurnPlan["steps"] = completions.map((_entry, index) => {
    const id = `step-${String(index)}` as never;
    const owner = capabilityId(`result.${String(index)}`);
    const intention = { id, objective: "Return the requested result", evidence: [], references: [], proposedCapability: owner, input: {}, resolution: "resolved" as const };
    return { id, intentionId: id, intention, capabilityId: owner, input: {}, dependsOn: [], missingFacts: [], disposition: "execute", reason: { code: "READY", message: "Ready", evidence: [] } };
  });
  const evidence = completions.map((entry, index) => ({ id: `proof-${String(index)}` as never, source: "capability" as const, content: entry.message }));
  const reduction: TurnReduction = {
    checkpoint: { schemaVersion: 1, revision: 1, agentFingerprint: "canonical-delivery", messages: [], facts: [], agenda: [], effects: [], ...(interaction === undefined ? {} : { interaction }) },
    results: completions.map((entry, index) => ({
      status: "invoked", stepId: steps[index]?.id as never, capabilityId: steps[index]?.capabilityId as never,
      result: { status: "completed", output: { message: entry.message }, facts: [], evidence: evidence[index] === undefined ? [] : [evidence[index]], artifacts: [], ...(entry.canonical === undefined ? {} : { canonicalResponse: entry.canonical }) },
    })),
    evidence, publishedFacts: [], invalidatedFacts: [], artifacts: [], issues: [],
  };
  return { plan: { steps, responseGoal: "Deliver the current results and any pending interaction" }, reduction };
}
function compose(source: ReturnType<typeof input>, gateway: Gateway, briefOverride?: ResponseBrief) {
  return composeResponse({ brief: briefOverride ?? buildResponseBrief(source), delivery: buildResponseDelivery(source), gateway, signal: AbortSignal.timeout(1_000) });
}

describe("canonical delivery authority", () => {
  it.each(["same", "suffix"])("delivers a result whose authoritative invitation is already its %s exactly once", async (mode) => {
    const message = mode === "same" ? question : `No current options were found. ${question}`;
    const source = input([{ message, canonical: canonical(message, "proof-0", true) }],
      { ...choice, goal: mode === "same" ? message : question });
    const gateway = new Gateway();
    const response = await compose(source, gateway);
    expect(response).toMatchObject({ source: "canonical", grounded: true, message });
    expect(response.message.split(question)).toHaveLength(2);
    expect(response.claims).toEqual(canonical(message, "proof-0").claims);
    expect(gateway.requests).toEqual([]);
  });

  it.each([false, true])("retains overlapping canonical answers once with all citations (reversed=%s)", async (reversed) => {
    const short = "The balance is 50 USD.";
    const long = `${short} The account is active.`;
    const entries = [short, long];
    if (reversed) entries.reverse();
    const source = input(entries.map((message, index) => ({
      message, canonical: canonical(message, `proof-${String(index)}`, message === short),
    })));
    const gateway = new Gateway();
    const response = await compose(source, gateway);
    expect(response).toMatchObject({ source: "canonical", grounded: true, message: long });
    expect(response.claims).toEqual(entries.flatMap((message, index) => canonical(message, `proof-${String(index)}`).claims));
    expect(gateway.requests).toEqual([]);
  });

  it("composes distinct overlapping answers when joining them cannot preserve required copy once", async () => {
    const balance = "The balance is 50 USD.";
    const active = "The account is active.";
    const transfer = "The transfer is available.";
    const source = input([balance, `${balance} ${active}`, `${balance} ${transfer}`].map((message, index) => ({
      message, canonical: canonical(message, `proof-${String(index)}`, index === 0),
    })));
    const gateway = new Gateway([{ parts: [
      { text: balance, evidenceIds: ["proof-0"] },
      { text: ` ${active}`, evidenceIds: ["proof-1"] },
      { text: ` ${transfer}`, evidenceIds: ["proof-2"] },
    ] }, { ...supported, approvedClaimIndexes: [0, 1, 2] }]);
    const response = await compose(source, gateway);
    expect(response).toMatchObject({ source: "model", grounded: true, message: `${balance} ${active} ${transfer}` });
    expect(response.claims.flatMap(claim => claim.evidenceIds)).toEqual(["proof-0", "proof-1", "proof-2"]);
    expect(gateway.requests.map(request => request.task)).toEqual(["response.compose", "response.grounding-review"]);
  });

  it("does not invite an undeclared operation after a required result even if both models would approve", async () => {
    const source = input([{ message: amount, canonical: canonical(amount, "proof-0", true) }]);
    const gateway = new Gateway([
      { parts: [{ text: amount, evidenceIds: ["proof-0"] }, { text: ` ${question}`, evidenceIds: [] }] },
      { ...supported, approvedClaimIndexes: [0] },
    ]);
    const response = await compose(source, gateway);
    expect(response).toMatchObject({ source: "canonical", grounded: true, message: amount });
    expect(response.interaction).toBeUndefined();
    expect(response.claims).toEqual(canonical(amount, "proof-0").claims);
    expect(gateway.requests).toEqual([]);
  });

  it("retains the real required interaction once after every current canonical result", async () => {
    const source = input([
      { message: identified, canonical: canonical(identified, "proof-0") },
      { message: amount, canonical: canonical(amount, "proof-1", true) },
    ], choice);
    const gateway = new Gateway([draft("It is already included."), supported]);
    const response = await compose(source, gateway);
    expect(response).toMatchObject({ source: "canonical", grounded: true, message: `${identified}\n\n${amount}\n\n${question}`, interaction: choice });
    expect(response.claims).toEqual([...canonical(identified, "proof-0").claims, ...canonical(amount, "proof-1").claims]);
    expect(gateway.requests).toEqual([]);
  });

  it("keeps an optional interaction available without requiring its invitation after a result", async () => {
    const optional = { ...choice, mode: "optional" as const };
    const source = input([{ message: amount, canonical: canonical(amount, "proof-0", true) }], optional);
    const gateway = new Gateway([draft(amount, ["proof-0"]), { ...supported, approvedClaimIndexes: [0] }]);
    const response = await compose(source, gateway);
    expect(response).toMatchObject({ source: "canonical", message: amount, interaction: optional });
    expect(gateway.requests).toEqual([]);
  });

  it("never calls composition or review to invent a completion while only collecting input", async () => {
    const source = input([], choice);
    const gateway = new Gateway([draft("The value is already included and the request is registered."), supported]);
    const response = await compose(source, gateway);
    expect(response).toMatchObject({ source: "canonical", grounded: true, message: question, interaction: choice, claims: [] });
    expect(source.reduction.checkpoint.facts).toEqual([]);
    expect(gateway.requests).toEqual([]);
  });

  it("uses reviewed contextual wording when requested without changing the pending input", async () => {
    const interaction = { ...choice, kind: "input" as const, responseMode: "contextual" as const };
    const source = input([], interaction);
    const brief: ResponseBrief = { ...buildResponseBrief(source), conversation: {
      currentMessage: "Used.", agentIdentity: "A concise product adviser.",
      recentMessages: [{ role: "user", content: "I want something for city driving and care about its design." }],
    } };
    const message = `Got it, you're looking for a used product for city driving and care about its design. ${question}`;
    const gateway = new Gateway([draft(message), supported]);
    const response = await compose(source, gateway, brief);
    expect(response).toMatchObject({ source: "model", grounded: true, message, interaction, claims: [] });
    expect(source.reduction.checkpoint.facts).toEqual([]);
    expect(gateway.requests.map(({ task }) => task)).toEqual(["response.compose", "response.grounding-review"]);
    expect(gateway.requests[0]?.input).toMatchObject({ conversation: brief.conversation });
  });

  it.each(["omitted", "duplicated"])("repairs a %s contextual invitation even when the model reviewer accepts it", async (failure) => {
    const source = input([], { ...choice, responseMode: "contextual" as const });
    const message = `Thanks for explaining your priorities. ${question}`;
    const invalid = failure === "omitted" ? "Thanks. What else do you need?" : `${question} ${question}`;
    const gateway = new Gateway([draft(invalid), supported, draft(message), supported]);
    const response = await compose(source, gateway);
    expect(response).toMatchObject({ source: "model", message });
    expect(gateway.requests.map(({ task }) => task)).toEqual([
      "response.compose", "response.grounding-review", "response.compose.repair", "response.grounding-review",
    ]);
  });

  it("falls back to the pending question after contextual claims remain unsupported", async () => {
    const source = input([], { ...choice, responseMode: "contextual" as const });
    const rejected = { ...supported, verdict: "unsupported", unsupportedClaims: ["No completed result supports registration."] };
    const gateway = new Gateway([draft(`Your request was registered. ${question}`), rejected,
      draft(`Your request was registered. ${question}`), rejected]);
    const response = await compose(source, gateway);
    expect(response).toMatchObject({ source: "canonical", message: question, claims: [] });
    expect(gateway.requests).toHaveLength(4);
  });

  it("retains natural composition for non-required informational completions", async () => {
    const source = input([{ message: identified, canonical: canonical(identified, "proof-0") }]);
    const gateway = new Gateway([draft(identified, ["proof-0"]), { ...supported, approvedClaimIndexes: [0] }]);
    const response = await compose(source, gateway);
    expect(response).toMatchObject({ source: "model", message: identified });
    expect(gateway.requests.map(({ task }) => task)).toEqual(["response.compose", "response.grounding-review"]);
    expect(gateway.requests[0]?.input).not.toHaveProperty("completedResponses");
  });

  it("does not discard an independent completed answer without canonical copy in a mixed turn", async () => {
    const hours = "The office opens at 9 AM.";
    const source = input([{ message: amount, canonical: canonical(amount, "proof-0", true) }, { message: hours }]);
    const gateway = new Gateway([
      { parts: [{ text: amount, evidenceIds: ["proof-0"] }, { text: ` ${hours}`, evidenceIds: ["proof-1"] }] },
      { ...supported, approvedClaimIndexes: [0, 1] },
    ]);
    const response = await compose(source, gateway);
    expect(response.message).toContain(amount);
    expect(response.message).toContain(hours);
    expect(response.claims).toHaveLength(2);
    expect(response.source).toBe("model");
  });

  it("does not fall back to a partial result after mixed work cannot be composed", async () => {
    const source = input([{ message: amount, canonical: canonical(amount, "proof-0", true) }, { message: "The office opens at 9 AM." }]);
    const rejected = { ...supported, verdict: "unsupported", unsupportedClaims: ["Missing completed result"] };
    const gateway = new Gateway([draft("Done."), rejected, draft("Done."), rejected]);
    await expect(compose(source, gateway)).rejects.toMatchObject({ code: "UNGROUNDED_RESPONSE" });
    expect(gateway.requests).toHaveLength(4);
  });

  it("retains optional conversational framing and issue explanations", async () => {
    for (const mode of ["optional", "issue"] as const) {
      const source = input([], mode === "optional" ? { ...choice, mode } : choice);
      if (mode === "issue") source.reduction = { ...source.reduction, issues: [{ code: "INPUT_NOT_ACCEPTED", message: "That input was not accepted.", retryable: false }] };
      const gateway = new Gateway([draft("Please choose how you would like to continue."), supported]);
      const response = await compose(source, gateway);
      expect(response.source).toBe("model");
      expect(gateway.requests).toHaveLength(2);
    }
  });

  it.each([undefined, "contextual"] as const)("retains protected confirmation without exposing it to models (responseMode=%s)", async (responseMode) => {
    const source = input([
      { message: identified, canonical: canonical(identified, "proof-0") },
      { message: amount, canonical: canonical(amount, "proof-1", true) },
    ], { ...choice, ...(responseMode === undefined ? {} : { responseMode }) });
    const gateway = new Gateway();
    const response = await composeResponse({
      brief: buildResponseBrief(source), delivery: buildResponseDelivery(source), gateway,
      protectedCanonicalMessage: "Private profile. Confirm?", signal: AbortSignal.timeout(1_000),
    });
    expect(response.message).toBe(`${identified}\n\n${amount}\n\nPrivate profile. Confirm?`);
    expect(response.claims).toHaveLength(2);
    expect(gateway.requests).toEqual([]);
  });

  it("does not expose a redacted contextual question to composition or repair", async () => {
    const source = input([], { ...choice, responseMode: "contextual" });
    const brief = buildResponseBrief(source);
    const gateway = new Gateway();
    const response = await compose(source, gateway, { ...brief,
      interaction: { ...choice, responseMode: "contextual", goal: "[redacted]" } });
    expect(response).toMatchObject({ source: "canonical", message: question });
    expect(gateway.requests).toEqual([]);
  });

  it("retains a validated lifecycle acknowledgement when another interaction remains", async () => {
    const source = input([], choice);
    const brief = buildResponseBrief(source);
    const cancellation = "The previous task was cancelled.";
    const decisionBrief: ResponseBrief = {
      ...brief,
      decision: { mode: "control", evidenceId: "turn.decision" as never, capabilityIds: [], rationale: "Applied cancellation", evidence: [] },
      evidence: [{ id: "turn.decision" as never, source: "capability", content: cancellation }],
    };
    const gateway = new Gateway([
      { parts: [{ text: cancellation, evidenceIds: ["turn.decision"] }, { text: ` ${question}`, evidenceIds: [] }] },
      { ...supported, approvedClaimIndexes: [0] },
    ]);
    const response = await compose(source, gateway, decisionBrief);
    expect(response).toMatchObject({ source: "model", message: `${cancellation} ${question}`, interaction: choice });
  });

  it.each(["missing", "invalid-citation", "missing-invitation"])("fails closed without a model when required delivery is %s", async (failure) => {
    const source = input([{ message: amount, canonical: canonical(amount, "proof-0", true) }], choice);
    const brief = buildResponseBrief(source);
    const { canonicalFallback, ...withoutFallback } = buildResponseDelivery(source);
    const delivery = failure === "missing" ? withoutFallback : {
      ...withoutFallback,
      canonicalFallback: failure === "invalid-citation"
        ? { message: `${amount}\n\n${question}`, claims: [{ text: amount, evidenceIds: ["unknown" as never] }] }
        : { message: amount, claims: canonicalFallback?.claims ?? [] },
    };
    const gateway = new Gateway([draft(amount, ["proof-0"]), { ...supported, approvedClaimIndexes: [0] }]);
    await expect(composeResponse({ brief, delivery, gateway, signal: AbortSignal.timeout(1_000) })).rejects.toMatchObject({ code: "UNGROUNDED_RESPONSE" });
    expect(gateway.requests).toEqual([]);
  });

  it("rejects a stale completed statement masquerading as a collecting fallback", async () => {
    const source = input([], choice);
    const gateway = new Gateway([draft(question), supported]);
    await expect(composeResponse({
      brief: buildResponseBrief(source), gateway, signal: AbortSignal.timeout(1_000),
      delivery: { ...buildResponseDelivery(source), canonicalFallback: { message: "The value is already included.", claims: [] } },
    })).rejects.toMatchObject({ code: "UNGROUNDED_RESPONSE" });
    expect(gateway.requests).toEqual([]);
  });
});
