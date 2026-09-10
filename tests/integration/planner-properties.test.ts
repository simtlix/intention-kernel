import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  buildDependencyGraph,
  capabilityId,
  defineCapability,
  defineSchema,
  factType,
} from "../../src/internal.js";

const schema = defineSchema<Record<string, never>>({
  vendor: "property-test",
  validate: () => ({ value: {} }),
  jsonSchema: () => ({ type: "object" }),
});

describe("planner graph invariants", () => {
  it("never orders an acyclic dependency before its provider", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (size) => {
        const capabilities = Array.from({ length: size }, (_, index) =>
          defineCapability({
            id: capabilityId(`node.${String(index)}`),
            version: 1,
            description: `Node ${String(index)}`,
            input: schema,
            output: schema,
            requires: index === 0
              ? []
              : [{ type: factType(`fact.${String(index - 1)}`), version: 1, description: "Previous node" }],
            provides: [{ type: factType(`fact.${String(index)}`), version: 1 }],
            effect: "read",
            execute: () => Promise.resolve({ status: "completed", output: {}, facts: [], evidence: [], artifacts: [] }),
          }),
        );

        const graph = buildDependencyGraph([...capabilities].reverse());
        for (let index = 1; index < size; index += 1) {
          expect(graph.order.indexOf(capabilityId(`node.${String(index - 1)}`)))
            .toBeLessThan(graph.order.indexOf(capabilityId(`node.${String(index)}`)));
        }
      }),
      { numRuns: 50 },
    );
  });
});
