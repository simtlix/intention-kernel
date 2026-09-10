/** Host-supplied clock used for durable timestamps. */
export interface KernelClock {
  /** Return the current time as an ISO timestamp. */
  now(): string;
}

/** Host-supplied source of unique, observable runtime identifiers. */
export interface KernelIdGenerator {
  /** Return a unique opaque value for the requested runtime identity kind. */
  next(kind: "intention" | "step" | "interaction" | "event" | "effect"): string;
}

/** Bounded execution settings. Zero is supported only for recentMessageLimit. */
export interface KernelLimits {
  /** Maximum wall-clock time for one turn, in milliseconds. */
  readonly turnTimeoutMs?: number;
  /** Maximum executable plan steps permitted in one turn. */
  readonly maxSteps?: number;
  /** Number of prior messages projected to models; zero omits prior messages. */
  readonly recentMessageLimit?: number;
}
