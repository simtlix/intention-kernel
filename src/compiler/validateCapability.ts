import type { CapabilityDefinition } from "../contracts/capability.js";
import { AgentCompilationError } from "../contracts/errors.js";

/** Validate compile-time invariants for one capability. */
export async function validateCapability(
  capability: CapabilityDefinition<unknown, unknown>,
): Promise<void> {
  if (capability.effect === "write" && capability.confirmation === "none") {
    throw new AgentCompilationError({
      code: "WRITE_CONFIRMATION_REQUIRED",
      message: `Write capability ${capability.id} must use kernel-owned or capability-owned confirmation.`,
      retryable: false,
      context: { capabilityId: capability.id },
    });
  }
  if (capability.input.jsonSchema === undefined || capability.output.jsonSchema === undefined) {
    throw new AgentCompilationError({
      code: "MODEL_SCHEMA_REQUIRED",
      message: `Capability ${capability.id} must expose input and output JSON Schema.`,
      retryable: false,
      context: { capabilityId: capability.id },
    });
  }
  if (capability.automation !== undefined &&
    (!Number.isInteger(capability.automation.version) || capability.automation.version < 1)) {
    throw new AgentCompilationError({
      code: "INVALID_CAPABILITY_AUTOMATION_VERSION",
      message: `Capability ${capability.id} automation version must be a positive integer.`,
      retryable: false,
      context: { capabilityId: capability.id, version: capability.automation.version },
    });
  }
  if (capability.referenceRequirements !== undefined && (
    !Number.isInteger(capability.referenceRequirements.minimum) ||
    !Number.isInteger(capability.referenceRequirements.maximum) ||
    capability.referenceRequirements.minimum < 1 ||
    capability.referenceRequirements.maximum < capability.referenceRequirements.minimum
  )) {
    throw new AgentCompilationError({
      code: "INVALID_CAPABILITY_REFERENCE_REQUIREMENTS",
      message: `Capability ${capability.id} reference requirements must use positive ordered bounds.`,
      retryable: false,
      context: { capabilityId: capability.id },
    });
  }
  await capability.input.jsonSchema();
  await capability.output.jsonSchema();
}
