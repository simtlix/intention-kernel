import type { CapabilityId, EvidenceId, FactType, StepId, TurnId } from "./ids.js";

/** Evidence that supports an interpreted request or business claim. */
export interface EvidenceRecord {
  /** Stable identity cited by facts and response claims. */
  readonly id: EvidenceId;
  /** Authority that produced this evidence. */
  readonly source: "user" | "fact" | "capability" | "external";
  /** Human-readable statement whose meaning supports downstream claims. */
  readonly content: string;
  /** Optional structured source value for host rendering or review. */
  readonly data?: unknown;
}

/** Reference to a versioned fact. */
export interface FactReference {
  /** Stable semantic fact name. */
  readonly type: FactType;
  /** Exact schema or meaning version required by the reference. */
  readonly version: number;
}

/** Fact required before a capability can execute. */
export interface FactRequirement extends FactReference {
  /** Model-visible explanation of why the fact is required. */
  readonly description: string;
  /**
   * Controls whether an absent prerequisite blocks planning immediately or may
   * be requested conditionally by the capability at execution time.
   *
   * Runtime requirements still create an ordering edge when their provider is
   * explicitly requested in the same turn. An input-only continuation does not
   * activate an optional prerequisite of a separate requested operation.
   * When no provider was requested, the consumer runs
   * and may return `needs_dependency` only if that prerequisite is actually
   * needed for the current input.
   */
  readonly resolution?: "runtime";
}

/** Controls how a persisted fact is exposed to model tasks. */
export type FactModelVisibility = "full" | "presence" | "hidden";

/** Fact a capability promises to publish. */
export interface FactDeclaration extends FactReference {
  /** Degree to which the confirmed value may be shown to model tasks. */
  readonly modelVisibility?: FactModelVisibility;
  /** Sensitive string values that must be removed from later model context. */
  readonly deriveModelRedactions?: (value: unknown) => readonly string[];
}

/** Candidate fact returned by a capability before reducer validation. */
export interface FactCandidate<T = unknown> extends FactReference {
  /** Proposed confirmed value validated during reduction. */
  readonly value: T;
  /** Evidence identities returned by the same completed capability. */
  readonly evidenceIds: readonly EvidenceId[];
  /** Parent facts whose replacement must invalidate this fact. */
  readonly dependsOn: readonly FactReference[];
}

/** Confirmed fact persisted in the conversation checkpoint. */
export interface FactRecord<T = unknown> extends FactCandidate<T> {
  /** Visibility copied from the capability fact declaration. */
  readonly modelVisibility?: FactModelVisibility;
  /** Kernel-private values used to redact conversation history before model calls. */
  readonly modelRedactions?: readonly string[];
  /** Complete evidence embedded for durable grounding after restarts. */
  readonly evidence: readonly EvidenceRecord[];
  /** Provenance of the capability execution that confirmed the fact. */
  readonly producedBy: {
    readonly capabilityId: CapabilityId;
    readonly capabilityVersion: number;
    readonly turnId: TurnId;
    readonly stepId: StepId;
  };
}
