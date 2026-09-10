import type { CapabilityDefinition } from "../contracts/capability.js";
import type { IntentionRequest } from "../contracts/intention.js";
import type { PolicyDecision, PolicyDefinition } from "../contracts/policy.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";

/** Complete host-policy context for one proposed capability execution. */
export interface PlannerPolicyContext {
  readonly capabilityId: string;
  readonly capability: CapabilityDefinition<unknown, unknown>;
  readonly intention: IntentionRequest;
  readonly input: unknown;
  readonly snapshot: ContextSnapshot;
}

/** Evaluate host policies in declaration order and return the first constraint. */
export async function evaluatePolicies(
  policies: readonly PolicyDefinition[],
  context: PlannerPolicyContext,
): Promise<PolicyDecision> {
  for (const policy of policies) {
    const decision = await policy.evaluate(context);
    if (decision.verdict !== "allow") return decision;
  }
  return { verdict: "allow" };
}
