import type { CapabilityId } from "./ids.js";
import type { ModelPromptReference } from "./prompt.js";
import type { CapabilityGuidance, CapabilityReferenceRequirements } from "./capability.js";
import type { JsonSchema, RuntimeSchema } from "../schema/runtimeSchema.js";

/** Compact capability entry used only to select relevant operations. */
export interface ModelCapabilitySummary {
  /** Projection level; summaries intentionally omit schemas and detailed guidance. */
  readonly detail: "summary";
  /** Stable semantic operation identifier. */
  readonly id: CapabilityId;
  /** Model-facing description supplied by the capability manifest. */
  readonly description: string;
  /** Whether current confirmed facts satisfy all prerequisites. */
  readonly availability: "ready" | "blocked";
  /** Human-readable prerequisites preventing immediate execution. */
  readonly blockedBy: readonly string[];
}

/** Expanded capability contract supplied only after the operation was selected. */
export interface ModelCapabilityContract {
  /** Projection level identifying a complete operation contract. */
  readonly detail: "contract";
  /** Stable semantic operation identifier. */
  readonly id: CapabilityId;
  /** Model-facing description supplied by the capability manifest. */
  readonly description: string;
  /** Whether current confirmed facts satisfy all prerequisites. */
  readonly availability: "ready" | "blocked";
  /** Human-readable prerequisites preventing immediate execution. */
  readonly blockedBy: readonly string[];
  /** Provider-neutral JSON Schema for proposed operation input. */
  readonly inputSchema: JsonSchema;
  /** Capability-specific semantic rules and examples, when declared. */
  readonly guidance?: CapabilityGuidance;
  /** Required references to active server-owned options, when declared. */
  readonly referenceRequirements?: CapabilityReferenceRequirements;
}

/** Task-specific capability projection supplied to a model gateway. */
export type ModelCapability = ModelCapabilitySummary | ModelCapabilityContract;

/** Provider-neutral structured model request. */
export interface ModelRequest<T> {
  /** Stable semantic task such as `turn.interpret` or `response.compose`. */
  readonly task: string;
  /** Optional provider model name or host-defined alias. */
  readonly model?: string;
  /** Complete task instruction owned by the kernel. */
  readonly system: string;
  /** Identified instruction contract; optional for host adapter compatibility. */
  readonly prompt?: ModelPromptReference;
  /** Immutable task-specific projection derived from canonical context. */
  readonly input: unknown;
  /** Runtime validator for the expected structured result. */
  readonly outputSchema: RuntimeSchema<T>;
  /** Capabilities visible to this model task. */
  readonly capabilities: readonly ModelCapability[];
  /** Cancellation and timeout signal that adapters must honor. */
  readonly signal: AbortSignal;
}

/** Provider metadata returned for observability and cost accounting. */
export interface ModelUsage {
  /** Provider-reported input token count, when available. */
  readonly inputTokens?: number;
  /** Provider-reported generated token count, when available. */
  readonly outputTokens?: number;
}

/** Validated provider response before kernel schema validation. */
export interface ModelResult<T> {
  /** Parsed provider value; the kernel validates it again. */
  readonly value: T;
  /** Stable provider identifier used for observability. */
  readonly provider: string;
  /** Actual model version used for this request. */
  readonly model: string;
  /** Optional provider usage metadata. */
  readonly usage?: ModelUsage;
  /** End-to-end adapter duration in milliseconds. */
  readonly durationMs: number;
}

/** Adapter contract for any structured-output model provider. */
export interface ModelGateway {
  /** Invoke one structured model task without executing any capability. */
  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>>;
}
