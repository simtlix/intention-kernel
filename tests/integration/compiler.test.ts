import { describe, expect, it } from "vitest";

import {
  agentId,
  capabilityId,
  compileAgentDefinition,
  defineAgent,
  defineCapability,
  defineModelGuidancePolicy,
  defineSchema,
  factType,
  policyId,
  type CapabilityDefinition,
} from "../../src/internal.js";

const emptyObject = defineSchema<Record<string, never>>({
  vendor: "compiler-test",
  validate: (value) =>
    typeof value === "object" && value !== null
      ? { value: {} }
      : { issues: [{ message: "Expected object" }] },
  jsonSchema: () => ({ type: "object", additionalProperties: false }),
});

function capability(
  id: string,
  options: {
    requires?: readonly string[];
    provides?: readonly string[];
    effect?: "none" | "read" | "write";
    confirmation?: "none" | "required";
    includeJsonSchema?: boolean;
  } = {},
): CapabilityDefinition<Record<string, never>, Record<string, never>> {
  const schema =
    options.includeJsonSchema === false
      ? defineSchema<Record<string, never>>({
          vendor: "compiler-test",
          validate: () => ({ value: {} }),
        })
      : emptyObject;
  return defineCapability({
    id: capabilityId(id),
    version: 1,
    description: `Execute ${id}`,
    input: schema,
    output: emptyObject,
    requires: (options.requires ?? []).map((type) => ({
      type: factType(type),
      version: 1,
      description: `Required ${type}`,
    })),
    provides: (options.provides ?? []).map((type) => ({ type: factType(type), version: 1 })),
    effect: options.effect ?? "read",
    confirmation: options.confirmation ?? "none",
    execute: () =>
      Promise.resolve({
        status: "completed",
        output: {},
        facts: [],
        evidence: [],
        artifacts: [],
      }),
  });
}

function agent(capabilities: readonly CapabilityDefinition<Record<string, never>, Record<string, never>>[]) {
  return defineAgent({
    id: agentId("compiler-test"),
    version: 1,
    identity: "A compiler test agent",
    capabilities,
    policies: [],
    modelPolicy: { "turn.interpret": "test-model" },
  });
}

describe("agent compiler", () => {
  it("builds a deterministic dependency order and fingerprint", async () => {
    const search = capability("product.search", { provides: ["product.candidates"] });
    const select = capability("product.select", {
      requires: ["product.candidates"],
      provides: ["product.selected"],
    });

    const first = await compileAgentDefinition(agent([select, search]));
    const second = await compileAgentDefinition(agent([search, select]));

    expect(first.capabilityOrder).toEqual(["product.search", "product.select"]);
    expect(second.capabilityOrder).toEqual(first.capabilityOrder);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it.each([
    {
      name: "duplicate capability",
      capabilities: [capability("product.search"), capability("product.search")],
      code: "DUPLICATE_CAPABILITY",
    },
    {
      name: "missing provider",
      capabilities: [capability("product.select", { requires: ["product.candidates"] })],
      code: "MISSING_FACT_PROVIDER",
    },
    {
      name: "ambiguous provider",
      capabilities: [
        capability("product.search", { provides: ["product.candidates"] }),
        capability("product.recommend", { provides: ["product.candidates"] }),
      ],
      code: "AMBIGUOUS_FACT_PROVIDER",
    },
    {
      name: "dependency cycle",
      capabilities: [
        capability("product.search", {
          requires: ["product.selection"],
          provides: ["product.candidates"],
        }),
        capability("product.select", {
          requires: ["product.candidates"],
          provides: ["product.selection"],
        }),
      ],
      code: "CAPABILITY_DEPENDENCY_CYCLE",
    },
    {
      name: "write without confirmation",
      capabilities: [capability("quote.create", { effect: "write" })],
      code: "WRITE_CONFIRMATION_REQUIRED",
    },
    {
      name: "missing model schema",
      capabilities: [capability("product.search", { includeJsonSchema: false })],
      code: "MODEL_SCHEMA_REQUIRED",
    },
  ])("rejects $name", async ({ capabilities, code }) => {
    await expect(compileAgentDefinition(agent(capabilities))).rejects.toMatchObject({ code });
  });

  it("rejects an invalid agent version", async () => {
    const definition = agent([capability("product.search")]);

    await expect(
      compileAgentDefinition({ ...definition, version: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_AGENT_VERSION" });
  });

  it("rejects duplicate contextual model guidance policies", async () => {
    const guidance = defineModelGuidancePolicy({
      id: policyId("product.context"),
      version: 1,
      description: "Product context guidance.",
      instructions: ["Use the active product context."],
      examples: [],
      counterExamples: [],
      select: () => ({ selected: true, matchedSelectors: ["activeCapabilityIds"] }),
    });
    const definition = agent([capability("product.search")]);

    await expect(compileAgentDefinition({
      ...definition,
      modelGuidancePolicies: [guidance, guidance],
    })).rejects.toMatchObject({ code: "INVALID_MODEL_GUIDANCE_POLICY" });
  });

  it("rejects progression continuation guidance for an unregistered capability", async () => {
    const guidance = defineModelGuidancePolicy({
      id: policyId("product.context"),
      version: 1,
      description: "Product context guidance.",
      instructions: ["Use the active product context."],
      examples: [],
      counterExamples: [],
      continueProgressionForCapabilities: [capabilityId("product.compare")],
      select: () => ({ selected: true, matchedSelectors: ["activeCapabilityIds"] }),
    });

    await expect(compileAgentDefinition({
      ...agent([capability("product.search")]),
      modelGuidancePolicies: [guidance],
    })).rejects.toMatchObject({ code: "INVALID_MODEL_GUIDANCE_POLICY" });
  });
});
