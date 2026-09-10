import type { KernelCheckpoint } from "./checkpoint.js";
import type { EffectAuthority, EffectExecution } from "./effects.js";
import type { KernelEvent } from "./events.js";
import type { CapabilityId, StepId, ThreadId, TurnId } from "./ids.js";

/** Stable identity supplied when coordinating an external effect. */
export interface DurableEffectIdentity {
  /** Capability-prefixed logical-operation key; deduplicate across turns within the thread. */
  readonly idempotencyKey: string;
  /** Capability requesting the external operation. */
  readonly capabilityId: CapabilityId;
  /** Plan step requesting the external operation. */
  readonly stepId: StepId;
}

/** Result stored for duplicate turn replay. */
export interface DurableTurnResult<T = unknown> {
  /** Exact result returned for duplicate turn replay. */
  readonly value: T;
  /** Successor checkpoint committed atomically with the result. */
  readonly checkpoint: KernelCheckpoint;
}

/** Scope held while one thread is serialized by a durability adapter. */
export interface DurableTurnScope {
  /** Latest checkpoint loaded while holding the thread lease. */
  readonly checkpoint: KernelCheckpoint | null;
  /** Previously committed value for the same turn identity, when duplicated. */
  readonly priorResult: DurableTurnResult | null;
  /** Coordinate and durably record one potentially external effect. */
  runEffect<T>(
    effect: DurableEffectIdentity,
    operation: (authority: EffectAuthority) => Promise<T>,
  ): Promise<EffectExecution<T>>;
  /** Atomically store the turn result, checkpoint and optional event outbox. */
  commit<T>(result: DurableTurnResult<T>, outbox?: readonly KernelEvent[]): Promise<void>;
}

/** Host-owned persistence, locking, deduplication and effect ledger contract. */
export interface Durability {
  /**
   * Serialize work for one thread and deduplicate the supplied turn identity.
   *
   * @remarks
   * Production adapters must hold an exclusive thread lease for the complete
   * callback and guarantee atomic commit of result, checkpoint and outbox.
   */
  withTurn<T>(
    identity: { readonly threadId: ThreadId; readonly turnId: TurnId },
    operation: (scope: DurableTurnScope) => Promise<T>,
  ): Promise<T>;
}
