import { describe, expect, it } from "vitest";

import {
  IntentionKernelError,
  capabilityId,
  defineCapability,
  defineSchema,
  factType,
} from "../../src/index.js";

describe("public contracts", () => {
  it("rejects malformed public identifiers with a stable typed error", () => {
    expect(() => capabilityId("Vehicle Search")).toThrow(
      expect.objectContaining({
        code: "INVALID_IDENTIFIER",
        retryable: false,
      }),
    );
  });

  it("normalizes schema failures without leaking vendor errors", async () => {
    const schema = defineSchema<string>({
      vendor: "contract-test",
      validate: (value) =>
        typeof value === "string" && value.length > 0
          ? { value }
          : { issues: [{ message: "Expected a non-empty string", path: ["name"] }] },
      jsonSchema: () => ({ type: "string", minLength: 1 }),
    });

    await expect(schema.validate(42)).resolves.toEqual({
      ok: false,
      issues: [{ message: "Expected a non-empty string", path: ["name"] }],
    });
  });

  it("defines an immutable capability without executing it", async () => {
    const input = defineSchema<{ query: string }>({
      vendor: "contract-test",
      validate: (value) =>
        typeof value === "object" &&
        value !== null &&
        "query" in value &&
        typeof value.query === "string"
          ? { value: { query: value.query } }
          : { issues: [{ message: "query is required", path: ["query"] }] },
      jsonSchema: () => ({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      }),
    });
    const output = defineSchema<{ ids: string[] }>({
      vendor: "contract-test",
      validate: (value) =>
        typeof value === "object" && value !== null && "ids" in value && Array.isArray(value.ids)
          ? { value: { ids: value.ids.filter((entry): entry is string => typeof entry === "string") } }
          : { issues: [{ message: "ids are required", path: ["ids"] }] },
      jsonSchema: () => ({ type: "object" }),
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
      execute: () => Promise.resolve({
        status: "completed",
        output: { ids: [] },
        facts: [],
        evidence: [],
        artifacts: [],
      }),
    });

    expect(Object.isFrozen(capability)).toBe(true);
    expect(capability.id).toBe("product.search");
    await expect(capability.input.validate({ query: "phone" })).resolves.toEqual({
      ok: true,
      value: { query: "phone" },
    });
  });

  it("exposes typed errors with sanitized serializable fields", () => {
    const error = new IntentionKernelError({
      code: "TEST_FAILURE",
      message: "Safe message",
      retryable: true,
      context: { component: "contracts" },
    });

    expect(error.toJSON()).toEqual({
      name: "IntentionKernelError",
      code: "TEST_FAILURE",
      message: "Safe message",
      retryable: true,
      context: { component: "contracts" },
    });
  });
});
