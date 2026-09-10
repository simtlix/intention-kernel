import { isDeepStrictEqual } from "node:util";

import type { CapabilityId } from "../contracts/ids.js";
import type { Interaction, InteractionAnswer } from "../contracts/interaction.js";

/** Kernel-private answer not yet consumed because execution awaits a dependency. */
export interface DeferredChoiceAnswer {
  readonly interaction: Interaction;
  readonly answer: InteractionAnswer;
}

type Carrier = { readonly deferredChoiceAnswer?: DeferredChoiceAnswer };

/** Recover only an exact ordinary option owned by the receiving operation. */
export function bindDeferredChoiceAnswer(
  capabilityId: CapabilityId | undefined,
  interaction: Interaction | undefined,
  answer: InteractionAnswer | undefined,
): DeferredChoiceAnswer | undefined {
  if (capabilityId === undefined || interaction?.kind !== "choice" || answer?.interactionId !== interaction.id ||
    (typeof interaction.payload === "object" && interaction.payload !== null &&
      (interaction.payload as Record<string, unknown>)["kind"] === "progression.group")) return undefined;
  const matches = interaction.options?.filter((option) => isDeepStrictEqual(option.value, answer.value)) ?? [];
  if (matches.length !== 1 || (matches[0]?.targetCapabilityId ?? interaction.capabilityId) !== capabilityId) return undefined;
  return { interaction, answer };
}

/** Read private durable metadata, excluded from model-visible agenda projections. */
export function readDeferredChoiceAnswer(value: object): DeferredChoiceAnswer | undefined {
  return (value as Carrier).deferredChoiceAnswer;
}

/** Attach private continuation metadata without changing the public capability input. */
export function withDeferredChoiceAnswer<T extends object>(value: T, binding: DeferredChoiceAnswer | undefined): T {
  return binding === undefined ? value : { ...value, deferredChoiceAnswer: binding };
}
