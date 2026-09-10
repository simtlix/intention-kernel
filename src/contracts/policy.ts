import type { Interaction } from "./interaction.js";
import type { PolicyId } from "./ids.js";

/** Decision returned by a pure policy. */
export type PolicyDecision =
  | { readonly verdict: "allow" }
  | { readonly verdict: "deny"; readonly reason: string }
  | { readonly verdict: "confirm"; readonly reason: string }
  | { readonly verdict: "clarify"; readonly interaction: Interaction };

/** Pure extension point for host-owned business constraints. */
export interface PolicyDefinition<TContext = unknown> {
  /** Stable semantic policy identifier. */
  readonly id: PolicyId;
  /** Positive policy contract version. */
  readonly version: number;
  /** Pure decision function evaluated against planner-owned context. */
  readonly evaluate: (context: TContext) => PolicyDecision | Promise<PolicyDecision>;
}

/**
 * Define and freeze a host-owned policy.
 *
 * @returns An immutable policy definition suitable for an agent manifest.
 */
export function definePolicy<TContext>(
  definition: PolicyDefinition<TContext>,
): PolicyDefinition<TContext> {
  return Object.freeze({ ...definition });
}
