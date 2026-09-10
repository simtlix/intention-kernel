import { expect, it } from "vitest";
import { z } from "zod";
import { agentId, capabilityId, defineAgent, defineCapability, defineSchema } from "../../src/index.js";
import { compileAgentDefinition } from "../../src/compiler/compileAgentDefinition.js";
import { buildContextSnapshot } from "../../src/context/buildContextSnapshot.js";
import { reviewOmittedChoiceAnswer } from "../../src/interpreter/reviewOmittedChoiceAnswer.js";
import type { IntentionBatch } from "../../src/contracts/intention.js";
import type { ModelGateway, ModelRequest, ModelResult } from "../../src/contracts/model.js";

it("redacts omitted-choice review proposals without changing their durable inputs or option bindings", async () => {
  const marker = "synthetic-private-target";
  const owner = capabilityId("choice.owner");
  const extra = capabilityId("independent.operation");
  const schema = defineSchema<Record<string, unknown>>({ vendor: "privacy-test", validate: value => ({ value: value as Record<string, unknown> }),
    jsonSchema: () => ({ type: "object" }) });
  const compiled = await compileAgentDefinition(defineAgent({ id: agentId("omitted-choice-privacy"), version: 1,
    identity: "Test agent", policies: [], modelPolicy: {}, capabilities: [owner, extra].map(id => defineCapability({
      id, version: 1, description: id, input: schema, output: schema, requires: [], provides: [], effect: "read",
      execute: () => { throw new Error("This review must not execute capabilities"); },
    })),
  }));
  const intention = (id: typeof owner): IntentionBatch["intentions"][number] => ({ id: `request-${id}` as never,
    objective: `Review ${marker}`, proposedCapability: id, input: { nested: { target: marker } }, resolution: "resolved",
    evidence: [{ text: marker, meaning: "Synthetic private evidence", messageIndex: 0 }], references: [],
  });
  const snapshot = buildContextSnapshot({ compiled, currentMessage: { role: "user", content: "Choose the first option", at: "2026-09-06T00:00:00Z" },
    checkpoint: { schemaVersion: 1, revision: 0, agentFingerprint: compiled.fingerprint, facts: [], effects: [], messages: [],
      agenda: [{ id: "pending-owner" as never, status: "waiting_input", dependencies: [], missingFacts: [],
        modelRedactions: [marker], intention: intention(owner) }],
      interaction: { id: "current-choice" as never, kind: "choice", capabilityId: owner, goal: "Which option?", requestedFacts: [],
        options: [{ id: "option-one", label: "First option", value: { target: marker }, targetCapabilityId: owner },
          { id: "option-two", label: "Second option", value: { target: "public-other" }, targetCapabilityId: owner }] },
    },
  });
  const batch: IntentionBatch = { intentions: [intention(owner), intention(extra)], contradictions: [] };
  const original = structuredClone({ batch, interaction: snapshot.interaction });
  const requests: ModelRequest<unknown>[] = [];
  const gateway: ModelGateway = { invoke: <T>(request: ModelRequest<T>): Promise<ModelResult<T>> => {
    requests.push(request);
    return Promise.resolve({ value: { verdict: "supported", optionId: "option-one", rationale: "The first current option was requested." } as T,
      provider: "scripted", model: "test", durationMs: 0 });
  } };
  const issues = await reviewOmittedChoiceAnswer({ batch, snapshot, gateway, signal: AbortSignal.timeout(1000) });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.task).toBe("interaction-answer.review");
  expect(JSON.stringify(requests[0]?.input)).not.toContain(marker);
  expect(requests[0]?.input).toMatchObject({ reviewKind: "omitted_choice_answer", intentions: [
    { proposedCapability: owner, input: { nested: { target: "[redacted]" } } },
    { proposedCapability: extra, input: { nested: { target: "[redacted]" } } },
  ], currentChoice: { options: [{ id: "option-one" }, { id: "option-two" }] } });
  expect(issues).toHaveLength(1);
  expect(issues[0]?.message).toContain("option-one");
  expect({ batch, interaction: snapshot.interaction }).toEqual(original);
  expect(batch.answerToInteraction).toBeUndefined();
  const outputSchema = requests[0]?.outputSchema;
  const json = await outputSchema?.jsonSchema?.();
  if (!json || !outputSchema) throw Error("Missing omitted-choice schema");
  const generated = z.fromJSONSchema(json);
  for (const invalid of [
    { verdict: "supported", optionId: null, rationale: "Cannot bind a selected option." },
    { verdict: "unsupported", optionId: "option-one", rationale: "No selection with a contradictory ID." },
    { verdict: "supported", optionId: "unpublished", rationale: "Unknown current option." },
  ]) {
    expect(generated.safeParse(invalid).success).toBe(false);
    expect((await outputSchema.validate(invalid)).ok).toBe(false);
  }
  expect(generated.safeParse({ verdict: "unsupported", optionId: null, rationale: "Independent refinement." }).success).toBe(true);
});
