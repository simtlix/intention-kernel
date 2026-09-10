import { factKey, type CapabilityDependencyGraph } from "../compiler/buildDependencyGraph.js";
import type { CapabilityDefinition } from "../contracts/capability.js";
import type { FactRecord, FactRequirement } from "../contracts/facts.js";
import type { CapabilityId, StepId } from "../contracts/ids.js";

/** Dependency steps and unresolved facts computed for one planned operation. */
export interface ResolvedStepDependencies {
  readonly dependsOn: readonly StepId[];
  readonly missingFacts: readonly FactRequirement[];
}

/** Resolve prerequisites from current facts or explicit provider steps in this turn. */
export function resolveDependencies(options: {
  readonly capability: CapabilityDefinition<unknown, unknown>;
  readonly currentFacts: readonly FactRecord[];
  readonly dependencyGraph: CapabilityDependencyGraph;
  readonly stepByCapability: ReadonlyMap<CapabilityId, StepId>;
  /** Explicit operations only; input-only continuations do not activate optional prerequisites. */
  readonly runtimeStepByCapability?: ReadonlyMap<CapabilityId, StepId>;
}): ResolvedStepDependencies {
  const current = new Set(options.currentFacts.map(factKey));
  const dependencies = new Set<StepId>();
  const missingFacts: FactRequirement[] = [];

  for (const requirement of options.capability.requires) {
    const key = factKey(requirement);
    if (current.has(key)) continue;
    const provider = options.dependencyGraph.providersByFact.get(key);
    const providers = requirement.resolution === "runtime"
      ? options.runtimeStepByCapability ?? options.stepByCapability : options.stepByCapability;
    const providerStep = provider === undefined ? undefined : providers.get(provider);
    if (providerStep !== undefined) {
      dependencies.add(providerStep);
      continue;
    }
    if (requirement.resolution !== "runtime") missingFacts.push(requirement);
  }

  return {
    dependsOn: Object.freeze([...dependencies]),
    missingFacts: Object.freeze(missingFacts),
  };
}
