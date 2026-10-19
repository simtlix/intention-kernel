import { describe, expect, it } from "vitest";

import {
  agentId,
  capabilityId,
  compileAgentDefinition,
  defineAgent,
  defineCapability,
  defineSchema,
  factType,
  type FactRecord,
} from "../../src/internal.js";
import type { KernelCheckpoint } from "../../src/contracts/checkpoint.js";
import { reconcileProgression } from "../../src/progression/reconcileProgression.js";

const schema = defineSchema<Record<string, unknown>>({
  vendor: "progression-alternative-activation",
  validate: (value) => ({ value: value as Record<string, unknown> }),
  jsonSchema: () => ({ type: "object" }),
});

const facts = {
  selected: factType("catalog.selectedVehicle"),
  quote: factType("tradeIn.quotationReceipt"),
  financing: factType("financing.options"),
  payment: factType("budget.paymentDecision"),
  tradeIn: factType("budget.tradeInDecision"),
};

function provider(type: string) {
  return defineCapability({
    id: capabilityId(`provide.${type}`),
    version: 1,
    description: `Provide ${type}`,
    input: schema,
    output: schema,
    requires: [],
    provides: [{ type: factType(type), version: 1 }],
    effect: "read" as const,
    execute: () => Promise.resolve({ status: "completed" as const, output: {}, facts: [], evidence: [], artifacts: [] }),
  });
}

const contact = defineCapability({
  id: capabilityId("customer.collectContact"),
  version: 1,
  description: "Collect contact details",
  input: schema,
  output: schema,
  requires: [],
  provides: [],
  effect: "read",
  automation: { version: 1, createInput: () => ({}) },
  execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
});

const providers = Object.values(facts).map((type) => provider(type));

function definition() {
  return defineAgent({
    id: agentId("alternative-progression"),
    version: 1,
    identity: "Test agent",
    capabilities: [...providers, contact],
    policies: [],
    modelPolicy: {},
    progression: {
      groups: [],
      rules: [{
        id: "contact.when-commercial-branches-resolve",
        version: 1,
        target: { capabilityId: contact.id },
        mode: "required",
        priority: 100,
        activateWhen: [{ type: facts.selected, version: 1 }],
        activateWhenAnyOf: [
          [{ type: facts.quote, version: 1 }, { type: facts.financing, version: 1 }],
          [{ type: facts.quote, version: 1 }, { type: facts.payment, version: 1 }],
          [{ type: facts.financing, version: 1 }, { type: facts.tradeIn, version: 1 }],
        ],
      }],
    },
  });
}

function publication(type: string, serial = type): FactRecord {
  return {
    type: factType(type),
    version: 1,
    value: { serial },
    evidenceIds: [],
    dependsOn: [],
    evidence: [],
    producedBy: {
      capabilityId: capabilityId(`provide.${type}`),
      capabilityVersion: 1,
      turnId: `turn-${serial}` as never,
      stepId: `step-${serial}` as never,
    },
  };
}

function checkpoint(agentFingerprint: string, present: readonly FactRecord[]): KernelCheckpoint {
  return {
    schemaVersion: 1,
    revision: 1,
    agentFingerprint,
    messages: [],
    facts: present,
    agenda: [],
    effects: [],
  };
}

describe("alternative progression activation", () => {
  it("requires a complete alternative and records its supporting publications separately from the common scope", async () => {
    const compiled = await compileAgentDefinition(definition());
    const selected = publication(facts.selected);
    const quote = publication(facts.quote);
    const incomplete = reconcileProgression({
      compiled,
      checkpoint: checkpoint(compiled.fingerprint, [selected, quote]),
    });

    expect(incomplete.activation).toBeUndefined();
    expect(incomplete.checkpoint.progression?.occurrences).toEqual([]);

    const financing = publication(facts.financing);
    const ready = reconcileProgression({
      compiled,
      checkpoint: checkpoint(compiled.fingerprint, [selected, quote, financing]),
    });
    const occurrence = ready.checkpoint.progression?.occurrences[0];

    expect(ready.activation?.capabilityId).toBe(contact.id);
    expect(occurrence?.activationFacts.map((entry) => entry.type)).toEqual([facts.selected]);
    expect(occurrence?.activationSupportFacts?.map((entry) => entry.type)).toEqual([
      facts.quote,
      facts.financing,
    ]);
  });

  it("updates support without creating or reactivating an occurrence when another alternative later becomes true", async () => {
    const compiled = await compileAgentDefinition(definition());
    const initialFacts = [
      publication(facts.selected),
      publication(facts.quote),
      publication(facts.payment),
    ];
    const first = reconcileProgression({
      compiled,
      checkpoint: checkpoint(compiled.fingerprint, initialFacts),
    });
    const firstOccurrence = first.checkpoint.progression?.occurrences[0];
    if (firstOccurrence === undefined) throw new Error("Expected an activated occurrence");

    const completed = reconcileProgression({
      compiled,
      checkpoint: first.checkpoint,
      results: [{
        status: "invoked",
        stepId: "contact-completed" as never,
        capabilityId: contact.id,
        result: { status: "completed", output: {}, facts: [], evidence: [], artifacts: [] },
      }],
    });
    expect(completed.checkpoint.progression?.occurrences[0]?.status).toBe("satisfied");

    const later = reconcileProgression({
      compiled,
      checkpoint: {
        ...completed.checkpoint,
        facts: [
          ...completed.checkpoint.facts,
          publication(facts.financing),
          publication(facts.tradeIn),
        ],
      },
    });
    const occurrences = later.checkpoint.progression?.occurrences ?? [];

    expect(later.activation).toBeUndefined();
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.id).toBe(firstOccurrence.id);
    expect(occurrences[0]?.status).toBe("satisfied");
    expect(new Set(occurrences[0]?.activationSupportFacts?.map((entry) => entry.type))).toEqual(new Set([
      facts.quote,
      facts.financing,
      facts.payment,
      facts.tradeIn,
    ]));
  });

  it("validates providers referenced only by an activation alternative", async () => {
    const invalid = defineAgent({
      ...definition(),
      progression: {
        groups: [],
        rules: [{
          id: "contact.when-missing-fact",
          version: 1,
          target: { capabilityId: contact.id },
          mode: "required",
          priority: 100,
          activateWhen: [{ type: facts.selected, version: 1 }],
          activateWhenAnyOf: [[{ type: factType("missing.alternative"), version: 1 }]],
        }],
      },
    });

    await expect(compileAgentDefinition(invalid)).rejects.toMatchObject({
      code: "PROGRESSION_ACTIVATION_FACT_NOT_PROVIDED",
      context: { target: "missing.alternative@1" },
    });
  });

  it.each([
    { name: "no alternatives", activateWhenAnyOf: [] },
    { name: "an empty alternative", activateWhenAnyOf: [[]] },
  ])("rejects $name", async ({ activateWhenAnyOf }) => {
    const invalid = defineAgent({
      ...definition(),
      progression: {
        groups: [],
        rules: [{
          id: "contact.when-invalid-alternatives",
          version: 1,
          target: { capabilityId: contact.id },
          mode: "required",
          priority: 100,
          activateWhen: [{ type: facts.selected, version: 1 }],
          activateWhenAnyOf,
        }],
      },
    });

    await expect(compileAgentDefinition(invalid)).rejects.toMatchObject({
      code: "INVALID_PROGRESSION_RULE",
    });
  });

  it("deep-freezes alternative activation groups and their fact references", () => {
    const frozen = definition();
    const alternatives = frozen.progression?.rules[0]?.activateWhenAnyOf;

    expect(Object.isFrozen(alternatives)).toBe(true);
    expect(Object.isFrozen(alternatives?.[0])).toBe(true);
    expect(Object.isFrozen(alternatives?.[0]?.[0])).toBe(true);
  });
});
