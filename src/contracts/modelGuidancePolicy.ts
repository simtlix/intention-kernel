import type { AgendaItem } from "./agenda.js";
import type { FactRecord } from "./facts.js";
import type { CapabilityId, FactType, PolicyId } from "./ids.js";
import type { Interaction } from "./interaction.js";
import type { ProgressionState } from "./progression.js";

/** One auditable example attached to contextual model guidance. */
export interface ModelGuidanceExample {
  /** User wording that illustrates the semantic boundary. */
  readonly input: string;
  /** Expected routing or interpretation behavior, never response copy. */
  readonly expectedBehavior: string;
}

/** Canonical, read-only state available to a host-owned guidance selector. */
export interface ModelGuidancePolicyContext {
  /** Capabilities referenced by current pending work, interactions, or progression. */
  readonly activeCapabilityIds: readonly CapabilityId[];
  /** Complete capability allowlist compiled for the current agent. */
  readonly registeredCapabilityIds: readonly CapabilityId[];
  /** Current confirmed facts, including lineage and model-visibility declarations. */
  readonly facts: readonly FactRecord[];
  /** Distinct fact types currently present in the checkpoint. */
  readonly presentFactTypes: readonly FactType[];
  /** Current unresolved intention agenda. */
  readonly agenda: readonly AgendaItem[];
  /** Current structured interaction, when one is active. */
  readonly interaction?: Interaction;
  /** Current host-declared progression state, when configured. */
  readonly progression?: ProgressionState;
}

/** Result of evaluating one host-owned contextual guidance selector. */
export interface ModelGuidancePolicyMatch {
  /** Whether the policy copy should be projected for the current turn. */
  readonly selected: boolean;
  /** Stable selector names that explain why the policy matched. */
  readonly matchedSelectors: readonly string[];
}

/** Semantic guidance selected before capability routing; it never grants execution authority. */
export interface ModelGuidancePolicyDefinition {
  /** Stable policy identity included in agent fingerprints and trace events. */
  readonly id: PolicyId;
  /** Positive host-controlled contract version. */
  readonly version: number;
  /** Concise explanation of the semantic boundary represented by the policy. */
  readonly description: string;
  /** Instructions supplied only when the selector matches the canonical turn state. */
  readonly instructions: readonly string[];
  /** Positive examples that illustrate expected semantic behavior. */
  readonly examples: readonly ModelGuidanceExample[];
  /** Counterexamples that distinguish nearby but different behavior. */
  readonly counterExamples: readonly ModelGuidanceExample[];
  /**
   * Capabilities whose resolved request must also select the active
   * progression continuation while this policy is selected.
   *
   * This is a model-output invariant, not execution authority: the model
   * still decides whether the current message requests one of these
   * capabilities, and invalid output receives the normal bounded repair.
   */
  readonly continueProgressionForCapabilities?: readonly CapabilityId[];
  /** Pure host function that selects guidance without granting execution authority. */
  readonly select: (context: ModelGuidancePolicyContext) => ModelGuidancePolicyMatch;
}

/** Model-visible projection of one contextual guidance policy selected by the host. */
export interface SelectedModelGuidancePolicy {
  /** Stable policy identity. */
  readonly id: PolicyId;
  /** Selected contract version. */
  readonly version: number;
  /** Model-visible explanation of the semantic boundary. */
  readonly description: string;
  /** Model-visible contextual instructions. */
  readonly instructions: readonly string[];
  /** Model-visible positive examples. */
  readonly examples: readonly ModelGuidanceExample[];
  /** Model-visible counterexamples. */
  readonly counterExamples: readonly ModelGuidanceExample[];
  /** Resolved capabilities that require the active progression continuation. */
  readonly continueProgressionForCapabilities?: readonly CapabilityId[];
  /** Stable selector names recorded for observability. */
  readonly matchedSelectors: readonly string[];
}

/** Define immutable contextual model guidance without coupling it to a provider. */
export function defineModelGuidancePolicy(
  definition: ModelGuidancePolicyDefinition,
): ModelGuidancePolicyDefinition {
  return Object.freeze({
    ...definition,
    instructions: Object.freeze([...definition.instructions]),
    examples: Object.freeze(definition.examples.map((example) => Object.freeze({ ...example }))),
    counterExamples: Object.freeze(definition.counterExamples.map((example) => Object.freeze({ ...example }))),
    ...(definition.continueProgressionForCapabilities === undefined
      ? {}
      : {
          continueProgressionForCapabilities: Object.freeze([
            ...definition.continueProgressionForCapabilities,
          ]),
        }),
  });
}
