import type { CapabilityId, EffectId, StepId, TurnId } from "./ids.js";

/** Durable lifecycle of an external mutation. */
export type EffectStatus = "prepared" | "completed" | "failed" | "uncertain";

/** Durable evidence for an idempotent external effect. */
export interface EffectReceipt<T = unknown> {
  /** Durability-owned unique receipt identity. */
  readonly id: EffectId;
  /** Capability-prefixed logical-operation key, deduplicated across turns in the ledger's thread scope. */
  readonly idempotencyKey: string;
  /** Capability that requested the effect. */
  readonly capabilityId: CapabilityId;
  /** Turn recorded for the latest provider attempt; replay preserves this identity. */
  readonly turnId: TurnId;
  /** Plan step that requested the effect. */
  readonly stepId: StepId;
  /** Current durable lifecycle status. */
  readonly status: EffectStatus;
  /** Successful provider value when the effect completed. */
  readonly data?: T;
  /** ISO timestamp when the receipt was first prepared. */
  readonly createdAt: string;
  /** ISO timestamp of the latest durable status change. */
  readonly updatedAt: string;
}

/** Stable authority passed only to the external operation being coordinated. */
export interface EffectAuthority {
  /** Capability-prefixed operation key; the host must also satisfy the provider's tenant or global namespace. */
  readonly idempotencyKey: string;
  /** Durable receipt identity allocated before the provider is called. */
  readonly receiptId: EffectId;
}

/** Completed effect value together with its durable receipt. */
export interface EffectExecution<T> {
  /** Provider result admitted by the capability contract. */
  readonly value: T;
  /** Durable receipt proving how the external mutation was coordinated. */
  readonly receipt: EffectReceipt<T>;
}
