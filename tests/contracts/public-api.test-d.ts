import { expectTypeOf, test } from "vitest";

import {
  capabilityId,
  defineCapability,
  defineSchema,
  effectId,
  evidenceId,
  factType,
  interactionId,
  type CapabilityResult,
  type Interaction,
  type InteractionOption,
} from "../../src/index.js";

test("keeps contextual wording opt-in without changing the input contract", () => {
  const input = { id: interactionId("collect-type"), kind: "input" as const, goal: "Which type?", requestedFacts: [] };
  expectTypeOf(input).toExtend<Interaction>();
  expectTypeOf({ ...input, responseMode: "contextual" as const }).toExtend<Interaction>();
  expectTypeOf<Interaction["responseMode"]>().toEqualTypeOf<"contextual" | undefined>();
  expectTypeOf({ ...input, responseMode: "unreviewed" as const }).not.toExtend<Interaction>();
});

test("keeps reference examples optional and readonly without changing existing options", () => {
  expectTypeOf({ id: "a", label: "A", value: 1 }).toExtend<InteractionOption>();
  expectTypeOf({ id: "a", label: "A", value: 1, referenceExamples: [] }).toExtend<InteractionOption>();
  expectTypeOf({ id: "a", label: "A", value: 1, referenceExamples: ["first"] as const }).toExtend<InteractionOption>();
  expectTypeOf<InteractionOption["referenceExamples"]>().toEqualTypeOf<readonly string[] | undefined>();
  expectTypeOf({ id: "a", label: "A", value: 1, referenceExamples: [1] }).not.toExtend<InteractionOption>();
});

test("infers capability input and output without provider types", () => {
  expectTypeOf(evidenceId("catalog-result-1")).toExtend<string>();
  expectTypeOf(effectId("effect-1")).toExtend<string>();
  expectTypeOf(interactionId("choose-catalog-result")).toExtend<string>();
  const input = defineSchema<{ query: string }>({
    vendor: "types",
    validate: () => ({ value: { query: "" } }),
  });
  const output = defineSchema<{ ids: readonly string[] }>({
    vendor: "types",
    validate: () => ({ value: { ids: [] } }),
  });
  const capability = defineCapability({
    id: capabilityId("product.search"),
    version: 1,
    description: "Search products",
    input,
    output,
    requires: [],
    provides: [{ type: factType("product.candidates"), version: 1 }],
    effect: "read",
    execute: (_context, value) => Promise.resolve({
      status: "completed" as const,
      output: { ids: [value.query] },
      facts: [],
      evidence: [],
      artifacts: [],
    }),
  });

  type Execute = typeof capability.execute;
  expectTypeOf(capability).toHaveProperty("execute");
  expectTypeOf<Execute>().parameter(1).toEqualTypeOf<{ query: string }>();
  expectTypeOf<Execute>().returns.toEqualTypeOf<
    Promise<CapabilityResult<{ ids: readonly string[] }>>
  >();
});
