/** JSON-safe context attached to a public kernel error. */
export type ErrorContext = Readonly<Record<string, string | number | boolean | null>>;

/** Constructor properties for {@link IntentionKernelError}. */
export interface IntentionKernelErrorOptions {
  /** Stable machine-readable failure code. */
  readonly code: string;
  /** Safe human-readable technical explanation. */
  readonly message: string;
  /** Whether a host retry can be safe and meaningful. */
  readonly retryable: boolean;
  /** JSON-safe diagnostic fields that may be logged. */
  readonly context?: ErrorContext;
  /** Original private cause, intentionally omitted by {@link IntentionKernelError.toJSON}. */
  readonly cause?: unknown;
}

/** Base class for exceptional failures exposed by Intention Kernel. */
export class IntentionKernelError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: string;
  /** Whether a host retry can be safe and meaningful. */
  readonly retryable: boolean;
  /** Frozen JSON-safe diagnostic metadata. */
  readonly context: ErrorContext;

  constructor(options: IntentionKernelErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.retryable = options.retryable;
    this.context = Object.freeze({ ...(options.context ?? {}) });
  }

  /** Return only stable, sanitized fields suitable for logs or HTTP responses. */
  toJSON(): Readonly<{
    name: string;
    code: string;
    message: string;
    retryable: boolean;
    context: ErrorContext;
  }> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
    };
  }
}

/** Raised when a public definition cannot be compiled safely. */
export class AgentCompilationError extends IntentionKernelError {}

/** Raised when required kernel adapters or execution limits are invalid. */
export class KernelConfigurationError extends IntentionKernelError {}

/** Raised when data crossing a trust boundary violates its schema. */
export class SchemaValidationError extends IntentionKernelError {}

/** Raised when a model provider cannot produce a usable result. */
export class ModelGatewayError extends IntentionKernelError {}

/** Raised when durable state cannot be read or committed safely. */
export class DurabilityError extends IntentionKernelError {}

/** Raised when an external effect may have happened and cannot be retried safely. */
export class EffectUncertainError extends IntentionKernelError {}

/** Raised by a host adapter only when it knows an external effect was not applied. */
export class EffectNotAppliedError extends IntentionKernelError {}

/** Raised when a bounded turn exceeds its configured execution budget. */
export class ExecutionBudgetExceededError extends IntentionKernelError {}
