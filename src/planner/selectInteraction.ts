import type { Interaction } from "../contracts/interaction.js";

/** Ranked internal proposal for the single interaction visible in a response. */
export interface InteractionCandidate {
  readonly priority: number;
  readonly order: number;
  readonly interaction: Interaction;
}

/** Select at most one primary interaction by explicit priority and source order. */
export function selectInteraction(candidates: readonly InteractionCandidate[]): Interaction | undefined {
  return [...candidates].sort((left, right) => right.priority - left.priority || left.order - right.order)[0]?.interaction;
}
