/** Stable versioned instruction contract, independent of provider and storage. */
export interface ModelPromptDefinition {
  /** Stable unique identifier for this exact instruction variant. */
  readonly id: string;
  /** Positive contract version; change when interpolation requirements change. */
  readonly contractVersion: number;
  /** Default instructions with optional exact `{{variable}}` placeholders. */
  readonly template: string;
  /** Allowlisted names, each required in the reference values. */
  readonly variables: readonly string[];
}

/** Exact instruction definition and execution values for one model request. */
export interface ModelPromptReference {
  /** Immutable contract selected by the call site. */
  readonly definition: ModelPromptDefinition;
  /** Literal execution values; inserted once without evaluation. */
  readonly values: Readonly<Record<string, string>>;
}

/** Pinned host revision resolved from an already loaded snapshot. */
export interface ResolvedModelPrompt {
  /** Replacement template constrained to the definition's declared variables. */
  readonly template: string;
  /** Nonempty immutable revision identifier recorded with the invocation. */
  readonly revision: string;
}

/** Synchronous instance-scoped resolver; storage loading belongs to the host. */
export interface ModelPromptResolver {
  /** Resolve a pinned revision. Failure aborts the invocation without fallback. */
  resolve(reference: ModelPromptReference): ResolvedModelPrompt;
}
