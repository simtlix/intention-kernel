import { AgentCompilationError } from "../contracts/errors.js";
import type { CapabilityDefinition } from "../contracts/capability.js";
import type { CapabilityId, FactType } from "../contracts/ids.js";

/** Immutable dependency information derived from capability fact contracts. */
export interface CapabilityDependencyGraph {
  readonly providersByFact: ReadonlyMap<string, CapabilityId>;
  readonly dependenciesByCapability: ReadonlyMap<CapabilityId, readonly CapabilityId[]>;
  readonly order: readonly CapabilityId[];
}

/** Build and validate a deterministic capability dependency graph. */
export function buildDependencyGraph(
  capabilities: readonly CapabilityDefinition<unknown, unknown>[],
): CapabilityDependencyGraph {
  const providers = new Map<string, CapabilityId[]>();
  for (const capability of capabilities) {
    for (const publication of capability.provides) {
      const key = factKey(publication);
      const current = providers.get(key) ?? [];
      current.push(capability.id);
      providers.set(key, current);
    }
  }

  for (const [key, candidateProviders] of providers) {
    if (candidateProviders.length > 1) {
      throw compilationError(
        "AMBIGUOUS_FACT_PROVIDER",
        `Fact ${key} has more than one provider.`,
        { fact: key, providers: candidateProviders.sort().join(",") },
      );
    }
  }

  const providersByFact = new Map<string, CapabilityId>(
    [...providers].map(([key, values]) => [key, values[0] as CapabilityId]),
  );
  const dependenciesByCapability = new Map<CapabilityId, readonly CapabilityId[]>();
  for (const capability of capabilities) {
    const dependencies = new Set<CapabilityId>();
    for (const requirement of capability.requires) {
      const provider = providersByFact.get(factKey(requirement));
      if (provider === undefined) {
        throw compilationError(
          "MISSING_FACT_PROVIDER",
          `No capability provides required fact ${requirement.type}.`,
          { capabilityId: capability.id, factType: requirement.type },
        );
      }
      if (provider !== capability.id) dependencies.add(provider);
    }
    dependenciesByCapability.set(capability.id, Object.freeze([...dependencies].sort()));
  }

  const incoming = new Map<CapabilityId, number>();
  const consumers = new Map<CapabilityId, CapabilityId[]>();
  for (const capability of capabilities) {
    incoming.set(capability.id, 0);
    consumers.set(capability.id, []);
  }
  for (const [consumer, dependencies] of dependenciesByCapability) {
    incoming.set(consumer, dependencies.length);
    for (const provider of dependencies) consumers.get(provider)?.push(consumer);
  }

  const ready = [...incoming]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const order: CapabilityId[] = [];
  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) break;
    order.push(next);
    for (const consumer of (consumers.get(next) ?? []).sort()) {
      const remaining = (incoming.get(consumer) ?? 0) - 1;
      incoming.set(consumer, remaining);
      if (remaining === 0) {
        ready.push(consumer);
        ready.sort();
      }
    }
  }

  if (order.length !== capabilities.length) {
    const cycleMembers = [...incoming]
      .filter(([, count]) => count > 0)
      .map(([id]) => id)
      .sort();
    throw compilationError(
      "CAPABILITY_DEPENDENCY_CYCLE",
      "Capability fact dependencies contain a cycle.",
      { capabilities: cycleMembers.join(",") },
    );
  }

  return Object.freeze({
    providersByFact,
    dependenciesByCapability,
    order: Object.freeze(order),
  });
}

/** Stable key for a versioned fact contract. */
export function factKey(reference: { readonly type: FactType; readonly version: number }): string {
  return `${reference.type}@${String(reference.version)}`;
}

function compilationError(
  code: string,
  message: string,
  context: Readonly<Record<string, string>>,
): AgentCompilationError {
  return new AgentCompilationError({ code, message, retryable: false, context });
}
