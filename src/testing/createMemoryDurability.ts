import type {
  DurableEffectIdentity,
  Durability,
  DurableTurnResult,
  DurableTurnScope,
} from "../contracts/durability.js";
import type { EffectAuthority, EffectReceipt } from "../contracts/effects.js";
import type { KernelEvent } from "../contracts/events.js";
import {
  DurabilityError,
  EffectNotAppliedError,
  EffectUncertainError,
} from "../contracts/errors.js";
import type { EffectId, ThreadId, TurnId } from "../contracts/ids.js";
import { deepFreeze } from "../context/deepFreeze.js";

interface StoredEffect {
  receipt: EffectReceipt;
  value?: unknown;
}

/**
 * Create an in-memory durability adapter for conformance tests and local examples.
 * It implements serialization, replay and effect semantics, but it does not
 * survive process restarts and is not production persistence.
 * @param options - Optional deterministic clock used by receipt assertions.
 * @returns A fresh isolated durability adapter.
 */
export function createMemoryDurability(options: {
  /** ISO timestamp source used for effect receipts. */
  readonly now?: () => string;
} = {}): Durability {
  const now = options.now ?? (() => new Date().toISOString());
  const checkpoints = new Map<string, DurableTurnResult["checkpoint"]>();
  const turns = new Map<string, DurableTurnResult>();
  const outboxes = new Map<string, readonly KernelEvent[]>();
  const effects = new Map<string, StoredEffect>();
  const locks = new Map<string, Promise<void>>();
  let effectSequence = 0;

  return {
    async withTurn<T>(
      identity: { readonly threadId: ThreadId; readonly turnId: TurnId },
      operation: (scope: DurableTurnScope) => Promise<T>,
    ): Promise<T> {
      const threadKey = String(identity.threadId);
      const previous = locks.get(threadKey) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queued = previous.then(() => gate);
      locks.set(threadKey, queued);
      await previous;
      try {
        const turnKey = `${threadKey}:${identity.turnId}`;
        const loaded = checkpoints.get(threadKey) ?? null;
        const priorResult = turns.get(turnKey) ?? null;
        let committed = false;
        const scope: DurableTurnScope = {
          checkpoint: clone(loaded),
          priorResult: clone(priorResult),
          runEffect: async <TValue>(
            effect: DurableEffectIdentity,
            effectOperation: (authority: EffectAuthority) => Promise<TValue>,
          ) => {
            const effectKey = `${threadKey}:${effect.idempotencyKey}`;
            const stored = effects.get(effectKey);
            if (stored !== undefined && stored.receipt.capabilityId !== effect.capabilityId) {
              throw new DurabilityError({
                code: "IDEMPOTENCY_KEY_COLLISION",
                message: "An idempotency key was reused for a different effect identity.",
                retryable: false,
                context: { idempotencyKey: effect.idempotencyKey },
              });
            }
            if (stored?.receipt.status === "completed") {
              return { value: clone(stored.value) as TValue, receipt: clone(stored.receipt) as EffectReceipt<TValue> };
            }
            if (stored?.receipt.status === "uncertain" || stored?.receipt.status === "prepared") {
              if (stored.receipt.status === "prepared") {
                stored.receipt = { ...stored.receipt, status: "uncertain", updatedAt: now() };
              }
              throw uncertain(effect.idempotencyKey);
            }

            const createdAt = stored?.receipt.createdAt ?? now();
            const prepared: EffectReceipt = {
              id: stored?.receipt.id ?? (`effect-${String(++effectSequence)}` as EffectId),
              idempotencyKey: effect.idempotencyKey,
              capabilityId: effect.capabilityId,
              turnId: identity.turnId,
              stepId: effect.stepId,
              status: "prepared",
              createdAt,
              updatedAt: now(),
            };
            effects.set(effectKey, { receipt: prepared });
            try {
              const value = await effectOperation({
                idempotencyKey: prepared.idempotencyKey,
                receiptId: prepared.id,
              });
              const completed: EffectReceipt<TValue> = {
                ...prepared,
                status: "completed",
                data: value,
                updatedAt: now(),
              };
              effects.set(effectKey, { receipt: completed, value: clone(value) });
              return { value, receipt: completed };
            } catch (error) {
              if (error instanceof EffectNotAppliedError) {
                effects.set(effectKey, {
                  receipt: { ...prepared, status: "failed", updatedAt: now() },
                });
                throw error;
              }
              effects.set(effectKey, {
                receipt: { ...prepared, status: "uncertain", updatedAt: now() },
              });
              throw uncertain(effect.idempotencyKey, error);
            }
          },
          commit: <TValue>(result: DurableTurnResult<TValue>, outbox?: readonly KernelEvent[]): Promise<void> => {
            if (committed) {
              throw new DurabilityError({
                code: "TURN_ALREADY_COMMITTED",
                message: "A durable turn can only be committed once.",
                retryable: false,
              });
            }
            const expectedRevision = (loaded?.revision ?? 0) + 1;
            if (result.checkpoint.revision !== expectedRevision) {
              throw new DurabilityError({
                code: "CHECKPOINT_REVISION_CONFLICT",
                message: "The checkpoint revision is not the expected successor.",
                retryable: true,
                context: { expectedRevision, actualRevision: result.checkpoint.revision },
              });
            }
            const durable = clone(result);
            checkpoints.set(threadKey, durable.checkpoint);
            turns.set(turnKey, durable);
            outboxes.set(turnKey, clone(outbox ?? []));
            committed = true;
            return Promise.resolve();
          },
        };
        return await operation(scope);
      } finally {
        release();
        if (locks.get(threadKey) === queued) locks.delete(threadKey);
      }
    },
  };
}

function uncertain(idempotencyKey: string, cause?: unknown): EffectUncertainError {
  return new EffectUncertainError({
    code: "EFFECT_UNCERTAIN",
    message: "The external effect may have happened and cannot be retried automatically.",
    retryable: false,
    context: { idempotencyKey },
    ...(cause === undefined ? {} : { cause }),
  });
}

function clone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return deepFreeze(structuredClone(value));
}
