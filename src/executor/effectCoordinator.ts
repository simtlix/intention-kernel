import type { CapabilityId, StepId, TurnId } from "../contracts/ids.js";
import type { DurableTurnScope } from "../contracts/durability.js";
import type { EffectAuthority, EffectExecution, EffectReceipt } from "../contracts/effects.js";
import { IntentionKernelError } from "../contracts/errors.js";

/** Step-scoped coordinator that records all durable external effects. */
export interface EffectCoordinator {
  readonly receipts: readonly EffectReceipt[];
  readonly calls: number;
  run<T>(idempotencyKey: string, operation: (authority: EffectAuthority) => Promise<T>): Promise<EffectExecution<T>>;
}

/** Bind capability effect calls to durable step metadata. */
export function createEffectCoordinator(options: {
  readonly scope: DurableTurnScope;
  readonly capabilityId: CapabilityId;
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly allowEffects: boolean;
}): EffectCoordinator {
  const receipts: EffectReceipt[] = [];
  let calls = 0;
  return {
    get receipts() {
      return receipts;
    },
    get calls() {
      return calls;
    },
    async run<T>(idempotencyKey: string, operation: (authority: EffectAuthority) => Promise<T>): Promise<EffectExecution<T>> {
      if (!options.allowEffects) {
        throw new IntentionKernelError({
          code: "EFFECT_NOT_ALLOWED",
          message: "A non-write capability cannot execute an external effect.",
          retryable: false,
          context: { capabilityId: options.capabilityId, stepId: options.stepId },
        });
      }
      if (idempotencyKey.trim().length === 0) {
        throw new IntentionKernelError({
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "An effect idempotency key must not be empty.",
          retryable: false,
          context: { capabilityId: options.capabilityId, stepId: options.stepId },
        });
      }
      calls += 1;
      const scopedIdempotencyKey = `${options.capabilityId}:${idempotencyKey}`;
      const completed = await options.scope.runEffect({
        idempotencyKey: scopedIdempotencyKey,
        capabilityId: options.capabilityId,
        stepId: options.stepId,
      }, operation);
      receipts.push(completed.receipt);
      return completed;
    },
  };
}
