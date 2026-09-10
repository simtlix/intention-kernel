import { factKey } from "../compiler/buildDependencyGraph.js";
import type { FactRecord, FactReference } from "../contracts/facts.js";

/** Partition produced after transitive lineage invalidation. */
export interface FactInvalidation {
  readonly kept: readonly FactRecord[];
  readonly removed: readonly FactRecord[];
}

/** Remove roots and every fact whose lineage transitively depends on them. */
export function invalidateFacts(
  facts: readonly FactRecord[],
  roots: readonly FactReference[],
): FactInvalidation {
  const invalid = new Set(roots.map(factKey));
  let changed = true;
  while (changed) {
    changed = false;
    for (const fact of facts) {
      const key = factKey(fact);
      if (!invalid.has(key) && fact.dependsOn.some((reference) => invalid.has(factKey(reference)))) {
        invalid.add(key);
        changed = true;
      }
    }
  }

  return {
    kept: facts.filter((fact) => !invalid.has(factKey(fact))),
    removed: facts.filter((fact) => invalid.has(factKey(fact))),
  };
}
