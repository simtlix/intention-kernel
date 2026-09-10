/** JSON-safe value stored in definitions, observations and portable reports. */
export type EvaluationValue = null | boolean | number | string | readonly EvaluationValue[] | { readonly [key: string]: EvaluationValue };
/** Named JSON fields supplied by the host; never executable source code. */
export type EvaluationData = Readonly<Record<string, EvaluationValue>>;
/** Safe own-property path. Numeric segments address array indexes. */
export type EvaluationPath = readonly (string | number)[];
/** Built-in operators compare structured evidence, not model-generated judgments. */
export type EvaluationOperator = "equals" | "matches" | "contains" | "exists" | "absent" | "gte" | "lte" | "length";
/** A declarative assertion or explicitly registered host evaluator. */
export type EvaluationAssertion = Readonly<{ id: string; label?: string }> & (
  | Readonly<{ kind: "check"; path: EvaluationPath; operator: EvaluationOperator; value?: EvaluationValue }>
  | Readonly<{ kind: "all" | "any"; assertions: readonly EvaluationAssertion[] }>
  | Readonly<{ kind: "not"; assertion: EvaluationAssertion }>
  | Readonly<{ kind: "custom"; evaluator: string; parameters: EvaluationData }>
);
/** Alternative input for one step. Variants replace the full input, not individual fields. */
export interface EvaluationVariant {
  /** Stable variant identity, unique within its step. */
  readonly id: string;
  /** Full adapter input for this alternative. */
  readonly input: EvaluationData;
}
/** One sequential exchange in a scenario. */
export interface EvaluationStep {
  /** Stable step identity, unique within the scenario. */
  readonly id: string;
  /** Input understood by the selected transport adapter. */
  readonly input: EvaluationData;
  /** Assertions against this step's observation. */
  readonly assertions?: readonly EvaluationAssertion[];
  /** Optional alternatives; when present these replace the baseline input in the case matrix. */
  readonly variants?: readonly EvaluationVariant[];
}
/** Portable, independently executable conversation definition. */
export interface EvaluationScenario {
  /** Stable identity used for selection and resume validation. */
  readonly id: string;
  /** Human-readable label. */
  readonly name: string;
  /** Optional description of intended behavior. */
  readonly description?: string;
  /** Labels for filtering; no business semantics are interpreted by the runner. */
  readonly tags?: readonly string[];
  /** External effects are blocked unless the run explicitly authorizes them. */
  readonly writePolicy: "read_only" | "external";
  /** Reviewed exclusion; skipped cases never count as passed. */
  readonly skipReason?: string;
  /** Host-owned provenance or domain configuration. */
  readonly metadata?: EvaluationData;
  /** Ordered conversation exchanges. */
  readonly steps: readonly EvaluationStep[];
  /** Final assertions receive the last observation and the complete turn history. */
  readonly assertions?: readonly EvaluationAssertion[];
}
/** Versioned suite shared by CLI, services and management interfaces. */
export interface EvaluationSuite {
  /** Serialization contract version. */
  readonly schemaVersion: 1;
  /** Stable suite identity. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Host-owned source provenance. */
  readonly metadata?: EvaluationData;
  /** Complete scenario definitions, including explicit exclusions. */
  readonly scenarios: readonly EvaluationScenario[];
  /** Cross-case checks run after scheduling ends, including partial runs. Inspect context.cases for evidence. */
  readonly assertions?: readonly EvaluationAssertion[];
}
/** Evidence and outcome of a single assertion. */
export interface EvaluationAssertionResult {
  /** Definition identity. */
  readonly id: string;
  /** Optional readable assertion label. */
  readonly label?: string;
  /** False for both assertion failure and evaluator error; inspect errorCode to distinguish. */
  readonly passed: boolean;
  /** Own-property presence distinguishes a missing value from explicit null. */
  readonly actual?: Readonly<{ present: boolean; value?: EvaluationValue }>;
  /** Expected value, when applicable. */
  readonly expected?: EvaluationValue;
  /** Stable evaluator error; raw exception messages are never captured. */
  readonly errorCode?: string;
  /** Host evaluator explanation or evidence, already safe for the report audience. */
  readonly evidence?: EvaluationData;
  /** Composite results, retained even if a sibling passed. */
  readonly children?: readonly EvaluationAssertionResult[];
}
/** Immutable input to registered domain or semantic evaluators. */
export interface EvaluationContext {
  /** Current adapter output including any facts, decisions and events. */
  readonly observation: EvaluationData;
  /** Prior exchanges; final scenario assertions receive every completed exchange. */
  readonly history: readonly EvaluationTurnResult[];
  /** Available only to suite assertions; includes pending and blocked cases in partial runs. */
  readonly cases?: readonly EvaluationCaseResult[];
  /** Optional evaluator cancellation signal. */
  readonly signal?: AbortSignal;
}
/** Explicitly injected evaluator; the framework never evaluates source strings or calls a model itself. */
export type EvaluationEvaluator = (
  context: EvaluationContext,
  parameters: EvaluationData,
) => Readonly<{ passed: boolean; evidence?: EvaluationData }> | Promise<Readonly<{ passed: boolean; evidence?: EvaluationData }>>;
/** Separate domain evaluators keyed by public identifiers. */
export type EvaluationEvaluators = Readonly<Record<string, EvaluationEvaluator>>;
/** One evaluated exchange, including complete host-approved evidence. */
export interface EvaluationTurnResult {
  /** Scenario step identity. */
  readonly stepId: string;
  /** Stable request identity, suitable for idempotent transport. */
  readonly turnId: string;
  /** Exact adapter input used by the case. */
  readonly input: EvaluationData;
  /** Final status; evaluator and transport errors are distinct from failed expectations. */
  readonly status: "passed" | "failed" | "error" | "cancelled";
  /** Complete structured observation, absent if transport failed before producing one. */
  readonly observation?: EvaluationData;
  /** All evaluated assertion results. */
  readonly assertions: readonly EvaluationAssertionResult[];
  /** Stable failure code, never an upstream exception body. */
  readonly errorCode?: string;
  /** Measured duration including assertions. */
  readonly durationMs: number;
  /** Serializable session state for adapters that support turn-level resume. Must not contain secrets. */
  readonly checkpoint?: EvaluationData;
}
/** Execution state of a matrix case. */
export type EvaluationCaseStatus = "pending" | "running" | "passed" | "failed" | "error" | "cancelled" | "skipped" | "blocked";
/** One scenario variant and repetition, isolated from every other case. */
export interface EvaluationCaseResult {
  /** Stable identity derived from scenario, variants and repetition. */
  readonly id: string;
  /** Source scenario identity. */
  readonly scenarioId: string;
  /** Display name from the source scenario. */
  readonly name: string;
  /** Zero-based repetition index. */
  readonly repetition: number;
  /** Chosen variant identities by step. */
  readonly variants: Readonly<Record<string, string>>;
  /** Durable conversation identity, never reused across cases. */
  readonly threadId: string;
  /** Aggregate case status. */
  readonly status: EvaluationCaseStatus;
  /** Measured exchanges in order. */
  readonly turns: readonly EvaluationTurnResult[];
  /** Assertions over the final conversation. */
  readonly assertions: readonly EvaluationAssertionResult[];
  /** Stable infrastructure, policy or interruption code. */
  readonly errorCode?: string;
  /** Human-readable reviewed skip reason. */
  readonly skipReason?: string;
}
/** Counts cover every scheduled matrix case; omitted/error/blocked cases cannot inflate passes. */
export type EvaluationSummary = Readonly<Record<EvaluationCaseStatus | "total", number>>;
/** Portable incremental run snapshot. Store in a host-authorized location. */
export interface EvaluationReport {
  /** Report serialization version. */
  readonly schemaVersion: 1;
  /** Identity of this execution; resume produces a new report linked to the prior run. */
  readonly runId: string;
  /** Prior run identity, when resuming. */
  readonly resumedFrom?: string;
  /** Definition snapshot makes history independent of later edits. */
  readonly suite: EvaluationSuite;
  /** Definition, selected cases, runtime and evaluator compatibility hash. */
  readonly fingerprint: string;
  /** Explicit target identity and version hash. Include model, configuration and evaluator versions. */
  readonly target: Readonly<{ id: string; fingerprint: string }>;
  /** ISO start time. */
  readonly startedAt: string;
  /** ISO completion time, absent while running. */
  readonly finishedAt?: string;
  /** Completed means scheduling finished, not that assertions passed. */
  readonly status: "running" | "completed" | "cancelled" | "limited";
  /** Full ordered case inventory, including pending cases. */
  readonly cases: readonly EvaluationCaseResult[];
  /** Counts for all case statuses. */
  readonly summary: EvaluationSummary;
  /** Cross-case results. A run passes only when cases AND these assertions pass. */
  readonly assertions?: readonly EvaluationAssertionResult[];
}
/** Event emitted after a corresponding snapshot has been persisted. */
export interface EvaluationEvent {
  /** Ordered position within this evaluation run. */
  readonly sequence: number;
  /** Event identity suitable for a UI timeline. */
  readonly type: "run.started" | "case.started" | "turn.completed" | "case.completed" | "run.completed";
  /** Owning evaluation run. */
  readonly runId: string;
  /** Related case identity, when applicable. */
  readonly caseId?: string;
  /** Related step identity, when applicable. */
  readonly stepId?: string;
}
/** Context passed once to the transport when opening an isolated case. */
export interface EvaluationSessionContext {
  /** Current run identity. */
  readonly runId: string;
  /** Stable matrix case identity. */
  readonly caseId: string;
  /** Durable conversation identity. */
  readonly threadId: string;
  /** Scenario including host-owned metadata. */
  readonly scenario: EvaluationScenario;
  /** Prior safe checkpoint; supplied only for an explicitly resumable adapter. */
  readonly checkpoint?: EvaluationData;
  /** Cancellation/timeout signal for session creation. */
  readonly signal: AbortSignal;
}
/** Isolated transport; credentials remain here, never in report/checkpoint data. */
export interface EvaluationSession {
  /** Execute once using the supplied idempotent identity. Never auto-retry writes. */
  send(input: EvaluationData, context: Readonly<{ turnId: string; stepId: string; signal: AbortSignal }>): Promise<Readonly<{
    observation: EvaluationData;
    checkpoint?: EvaluationData;
    stop?: Readonly<{ status: "skipped" | "completed"; reason: string }>;
  }>>;
  /** Release resources after success, failure or cancellation. */
  close?(): Promise<void>;
}
/** Host boundary for direct agents, HTTP chat or another conversation protocol. */
export interface EvaluationAdapter {
  /** Stable adapter identity. */
  readonly id: string;
  /** Contract version included in resume compatibility. */
  readonly version: string;
  /** True only if open() restores exactly the state represented by checkpoint. */
  readonly supportsResume?: boolean;
  /** Create or restore one isolated session. */
  open(context: EvaluationSessionContext): Promise<EvaluationSession>;
}
/** Runner dependencies and bounded execution controls. */
export interface EvaluationOptions {
  /** Validated again at the public execution boundary. */
  readonly suite: EvaluationSuite;
  /** Explicit model/agent/domain-evaluator compatibility identity. */
  readonly target: Readonly<{ id: string; fingerprint: string }>;
  /** Application-owned transport. */
  readonly adapter: EvaluationAdapter;
  /** Optional domain checks; identifiers are validated before any session opens. */
  readonly evaluators?: EvaluationEvaluators;
  /** Select scenario IDs; unknown IDs fail before execution. */
  readonly scenarioIds?: readonly string[];
  /** Select scenarios matching any requested tag. */
  readonly tags?: readonly string[];
  /** Independent concurrent cases; default 1, maximum 32. */
  readonly concurrency?: number;
  /** Number of isolated runs per variant; default 1. */
  readonly repetitions?: number;
  /** Maximum expanded case count; default 1000. */
  readonly maxCases?: number;
  /** Stop scheduling after this many failed/error cases; already-running cases finish. */
  readonly maxFailures?: number;
  /** Per-operation/evaluator deadline in milliseconds; default 120000. */
  readonly timeoutMs?: number;
  /** Explicit effect authorization passed to the host adapter through the scenario boundary. */
  readonly allowExternalWrites?: boolean;
  /** Cooperative cancellation, with bounded waiting even if an adapter ignores it. */
  readonly signal?: AbortSignal;
  /** Compatible snapshot for continuing unfinished cases. */
  readonly resume?: EvaluationReport;
  /** Rerun failed/error cases in new sessions; preserves the prior run through resumedFrom. */
  readonly retryFailed?: boolean;
  /** Persist a deeply immutable snapshot; unchanged cases retain identity. Rejection stops further scheduling. */
  readonly onCheckpoint?: (report: EvaluationReport) => void | Promise<void>;
  /** Ordered observer invoked only after checkpoint persistence. */
  readonly onEvent?: (event: EvaluationEvent) => void | Promise<void>;
}
