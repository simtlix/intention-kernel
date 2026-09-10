import type { CapabilityId, FactType, InteractionId } from "./ids.js";

/** A single user-facing information or confirmation request. */
export interface Interaction {
  /** Stable identity required when a host submits a clicked answer. */
  readonly id: InteractionId;
  /** Shape of user input requested by this interaction. */
  readonly kind: "input" | "confirmation" | "choice" | "clarification";
  /** Optional follow-ups may be replaced by required progression or a different user intention. */
  readonly mode?: "required" | "optional";
  /**
   * Opt into reviewed conversational framing instead of direct canonical delivery.
   * Required interactions retain their exact goal once; options and input authority
   * never change. Protected or model-redacted delivery still takes precedence.
   * Omission preserves the canonical fast path when it applies.
   */
  readonly responseMode?: "contextual";
  /** Capability that owns continuation state, when applicable. */
  readonly capabilityId?: CapabilityId;
  /** Facts the interaction is intended to collect. */
  readonly requestedFacts: readonly FactType[];
  /** Natural-language goal used by the response composer. */
  readonly goal: string;
  /** Server-owned options that may be rendered as controls. */
  readonly options?: readonly InteractionOption[];
  /** Opaque host or capability metadata not interpreted as authority. */
  readonly payload?: unknown;
  /** Trusted response text used without a model call and omitted from later model context. */
  readonly protectedCanonicalMessage?: string;
}

/** Server-owned selectable option. */
export interface InteractionOption {
  /** Stable identifier returned by a clicked selection. */
  readonly id: string;
  /** User-visible option text. */
  readonly label: string;
  /**
   * Optional exact reference examples, never selection authority or defaults.
   *
   * @remarks
   * At most 32 non-blank strings of at most 256 characters each; an empty array
   * is valid. An exact text reference competing with another current display
   * position requires clarification. Examples never bypass semantic review,
   * while a validated structured click remains authoritative. Hosts persist
   * this field losslessly with the interaction; model redactions also apply.
   */
  readonly referenceExamples?: readonly string[];
  /** Capability authorized to consume this option, when it differs from the interaction owner. */
  readonly targetCapabilityId?: CapabilityId;
  /** Trusted structured value recovered by the kernel. */
  readonly value: unknown;
}

/** Structured answer to the currently active interaction. */
export interface InteractionAnswer {
  /** Interaction being answered. */
  readonly interactionId: InteractionId;
  /** Structured selected value or model-interpreted free-text answer. */
  readonly value: unknown;
  /** User-visible text that supports the answer. */
  readonly evidence: string;
  /** Concise explanation of why the cited words answer this exact interaction. */
  readonly rationale?: string;
}
