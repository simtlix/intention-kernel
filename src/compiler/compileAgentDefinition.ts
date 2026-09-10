import type { AgentDefinition } from "../contracts/agent.js";
import type { CapabilityDefinition } from "../contracts/capability.js";
import { AgentCompilationError } from "../contracts/errors.js";
import type { CapabilityId } from "../contracts/ids.js";
import type { JsonSchema } from "../schema/runtimeSchema.js";
import { buildDependencyGraph, factKey, type CapabilityDependencyGraph } from "./buildDependencyGraph.js";
import { fingerprint } from "./fingerprint.js";
import { validateCapability } from "./validateCapability.js";

/** Immutable agent definition produced after all compile-time checks pass. */
export interface CompiledAgentDefinition {
  readonly definition: AgentDefinition;
  readonly capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition<unknown, unknown>>;
  readonly dependencyGraph: CapabilityDependencyGraph;
  readonly capabilityOrder: readonly CapabilityId[];
  readonly inputSchemas: ReadonlyMap<CapabilityId, JsonSchema>;
  readonly fingerprint: string;
}

class ReadonlyMapView<TKey, TValue> implements ReadonlyMap<TKey, TValue> {
  readonly #source: Map<TKey, TValue>;

  constructor(source: Map<TKey, TValue>) {
    this.#source = source;
    Object.freeze(this);
  }

  get size(): number {
    return this.#source.size;
  }

  get(key: TKey): TValue | undefined {
    return this.#source.get(key);
  }

  has(key: TKey): boolean {
    return this.#source.has(key);
  }

  forEach(callbackfn: (value: TValue, key: TKey, map: ReadonlyMap<TKey, TValue>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#source) callbackfn.call(thisArg, value, key, this);
  }

  entries(): MapIterator<[TKey, TValue]> {
    return this.#source.entries();
  }

  keys(): MapIterator<TKey> {
    return this.#source.keys();
  }

  values(): MapIterator<TValue> {
    return this.#source.values();
  }

  [Symbol.iterator](): MapIterator<[TKey, TValue]> {
    return this.entries();
  }
}

/** Compile and validate one agent definition before any conversation starts. */
export async function compileAgentDefinition(
  definition: AgentDefinition,
): Promise<CompiledAgentDefinition> {
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new AgentCompilationError({
      code: "INVALID_AGENT_VERSION",
      message: "Agent version must be a positive integer.",
      retryable: false,
      context: { agentId: definition.id, version: definition.version },
    });
  }

  const capabilities = new Map<CapabilityId, CapabilityDefinition<unknown, unknown>>();
  for (const capability of definition.capabilities) {
    if (capabilities.has(capability.id)) {
      throw new AgentCompilationError({
        code: "DUPLICATE_CAPABILITY",
        message: `Capability ${capability.id} is registered more than once.`,
        retryable: false,
        context: { capabilityId: capability.id },
      });
    }
    await validateCapability(capability);
    capabilities.set(capability.id, capability);
  }

  const dependencyGraph = buildDependencyGraph([...capabilities.values()]);
  validateProgression(definition, capabilities, dependencyGraph);
  validateModelGuidancePolicies(definition);
  validateResponseFallbacks(definition);
  const inputSchemas = new Map<CapabilityId, JsonSchema>();
  const manifestCapabilities: unknown[] = [];
  for (const capability of [...capabilities.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const inputSchema = await capability.input.jsonSchema?.();
    const outputSchema = await capability.output.jsonSchema?.();
    if (inputSchema === undefined || outputSchema === undefined) {
      throw new AgentCompilationError({
        code: "MODEL_SCHEMA_REQUIRED",
        message: `Capability ${capability.id} must expose JSON Schema.`,
        retryable: false,
        context: { capabilityId: capability.id },
      });
    }
    inputSchemas.set(capability.id, inputSchema);
    manifestCapabilities.push({
      id: capability.id,
      version: capability.version,
      description: capability.description,
      inputSchema,
      outputSchema,
      requires: [...capability.requires].sort(compareFactReference),
      provides: [...capability.provides].sort(compareFactReference),
      invalidates: [...capability.invalidates].sort(compareFactReference),
      effect: capability.effect,
      confirmation: capability.confirmation,
      guidance: capability.guidance,
      referenceRequirements: capability.referenceRequirements,
      automationVersion: capability.automation?.version,
    });
  }

  const compiledFingerprint = fingerprint({
    id: definition.id,
    version: definition.version,
    identity: definition.identity,
    capabilities: manifestCapabilities,
    policies: [...definition.policies]
      .map((policy) => ({ id: policy.id, version: policy.version }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    modelGuidancePolicies: [...(definition.modelGuidancePolicies ?? [])]
      .map((policy) => ({
        id: policy.id,
        version: policy.version,
        description: policy.description,
        instructions: policy.instructions,
        examples: policy.examples,
        counterExamples: policy.counterExamples,
        continueProgressionForCapabilities: policy.continueProgressionForCapabilities ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    modelPolicy: definition.modelPolicy,
    progression: definition.progression === undefined
      ? null
      : {
          objective: definition.progression.objective ?? null,
          groups: definition.progression.groups,
          rules: definition.progression.rules,
        },
    responseFallbacks: definition.responseFallbacks ?? null,
  });

  return Object.freeze({
    definition,
    capabilities: new ReadonlyMapView(capabilities),
    dependencyGraph,
    capabilityOrder: dependencyGraph.order,
    inputSchemas: new ReadonlyMapView(inputSchemas),
    fingerprint: compiledFingerprint,
  });
}

function validateModelGuidancePolicies(definition: AgentDefinition): void {
  const ids = new Set<string>();
  const capabilityIds = new Set(definition.capabilities.map((capability) => capability.id));
  for (const policy of definition.modelGuidancePolicies ?? []) {
    const continuationCapabilities = policy.continueProgressionForCapabilities ?? [];
    if (ids.has(policy.id) || policy.id.trim().length === 0 ||
      !Number.isInteger(policy.version) || policy.version < 1 ||
      policy.description.trim().length === 0 || policy.description.length > 4_000 ||
      policy.instructions.length === 0 || policy.instructions.length > 50 ||
      policy.instructions.some((instruction) => instruction.trim().length === 0 || instruction.length > 4_000) ||
      policy.examples.length > 50 || policy.counterExamples.length > 50 ||
      continuationCapabilities.length > 50 ||
      new Set(continuationCapabilities).size !== continuationCapabilities.length ||
      continuationCapabilities.some((capabilityId) => !capabilityIds.has(capabilityId)) ||
      [...policy.examples, ...policy.counterExamples].some((example) =>
        example.input.trim().length === 0 || example.input.length > 2_000 ||
        example.expectedBehavior.trim().length === 0 || example.expectedBehavior.length > 4_000) ||
      typeof policy.select !== "function") {
      throw new AgentCompilationError({
        code: "INVALID_MODEL_GUIDANCE_POLICY",
        message: "Model guidance policies require unique IDs, positive versions, bounded copy and a selector.",
        retryable: false,
        context: { policyId: policy.id },
      });
    }
    ids.add(policy.id);
  }
}

function validateResponseFallbacks(definition: AgentDefinition): void {
  const unsupported = definition.responseFallbacks?.unsupportedIntention;
  if (unsupported === undefined) return;
  if (unsupported.trim() !== unsupported || unsupported.length === 0 || unsupported.length > 4_000) {
    throw new AgentCompilationError({
      code: "INVALID_RESPONSE_FALLBACK",
      message: "Response fallbacks must be non-empty, trimmed and bounded.",
      retryable: false,
      context: { target: "unsupportedIntention" },
    });
  }
}

function validateProgression(
  definition: AgentDefinition,
  capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition<unknown, unknown>>,
  dependencyGraph: CapabilityDependencyGraph,
): void {
  const progression = definition.progression;
  if (progression === undefined) return;
  const groupIds = new Set<string>();
  for (const group of progression.groups) {
    if (group.id.trim().length === 0 || groupIds.has(group.id) || group.label.trim().length === 0 ||
      group.prompt.trim().length === 0 || group.continueLabel.trim().length === 0 || group.members.length === 0) {
      throw progressionError("INVALID_PROGRESSION_GROUP", "Progression groups require unique IDs, copy and at least one member.", group.id);
    }
    groupIds.add(group.id);
    const members = new Set<CapabilityId>();
    for (const member of group.members) {
      const capability = capabilities.get(member.capabilityId);
      if (capability === undefined || capability.automation === undefined || members.has(member.capabilityId) ||
        member.label.trim().length === 0) {
        throw progressionError("INVALID_PROGRESSION_GROUP_MEMBER", "Progression members must be unique registered capabilities with automatic input.", member.capabilityId);
      }
      members.add(member.capabilityId);
    }
  }
  const ruleIds = new Set<string>();
  for (const rule of progression.rules) {
    if (rule.id.trim().length === 0 || ruleIds.has(rule.id) || !Number.isInteger(rule.version) || rule.version < 1 ||
      !Number.isInteger(rule.priority) || rule.priority < 0) {
      throw progressionError("INVALID_PROGRESSION_RULE", "Progression rules require unique IDs, positive versions and non-negative priorities.", rule.id);
    }
    ruleIds.add(rule.id);
    if ("groupId" in rule.target) {
      if (!groupIds.has(rule.target.groupId)) {
        throw progressionError("PROGRESSION_TARGET_NOT_REGISTERED", "A progression rule references an unknown group.", rule.target.groupId);
      }
    } else {
      const capability = capabilities.get(rule.target.capabilityId);
      if (capability === undefined || capability.automation === undefined) {
        throw progressionError("PROGRESSION_TARGET_NOT_AUTOMATABLE", "A progression rule target must be a registered capability with automatic input.", rule.target.capabilityId);
      }
    }
    for (const reference of rule.activateWhen) {
      if (!dependencyGraph.providersByFact.has(factKey(reference))) {
        throw progressionError("PROGRESSION_ACTIVATION_FACT_NOT_PROVIDED", "A progression activation fact has no registered provider.", factKey(reference));
      }
    }
  }
  if (progression.objective !== undefined &&
    !dependencyGraph.providersByFact.has(factKey(progression.objective.completionFact))) {
    throw progressionError("PROGRESSION_OBJECTIVE_FACT_NOT_PROVIDED", "The objective completion fact has no registered provider.", factKey(progression.objective.completionFact));
  }
}

function progressionError(code: string, message: string, target: string): AgentCompilationError {
  return new AgentCompilationError({ code, message, retryable: false, context: { target } });
}

function compareFactReference(
  left: { readonly type: string; readonly version: number },
  right: { readonly type: string; readonly version: number },
): number {
  return left.type.localeCompare(right.type) || left.version - right.version;
}
