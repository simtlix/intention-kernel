import { isDeepStrictEqual } from "node:util";

import type { AgendaItem } from "../contracts/agenda.js";
import type { CapabilityId } from "../contracts/ids.js";
import type { IntentionBatch } from "../contracts/intention.js";
import type { ContextSnapshot } from "./buildContextSnapshot.js";

/** Resolve an ordinary input/choice owner and its unambiguous durable collection continuation. */
export function resolveInteractionAnswerOwner(
  snapshot: ContextSnapshot,
  answer: IntentionBatch["answerToInteraction"],
): Readonly<{ capabilityId: CapabilityId; pending?: AgendaItem }> | undefined {
  const interaction = snapshot.interaction;
  if ((interaction?.kind !== "choice" && interaction?.kind !== "input") || answer?.interactionId !== interaction.id ||
    (typeof interaction.payload === "object" && interaction.payload !== null &&
      (interaction.payload as Record<string, unknown>)["kind"] === "progression.group")) return undefined;
  const options = interaction.kind === "choice"
    ? interaction.options?.filter((option) => isDeepStrictEqual(option.value, answer.value)) ?? [] : [];
  if (interaction.kind === "choice" && options.length !== 1) return undefined;
  const capabilityId = options[0]?.targetCapabilityId ?? interaction.capabilityId;
  if (capabilityId === undefined) return undefined;

  // A published action targeting another capability needs an explicit model
  // intention. Only the current collection owner may reuse its existing input;
  // an unrelated pending operation or confirmation is not answer authority.
  const candidates = interaction.capabilityId === capabilityId
    ? snapshot.agenda.filter((item) => item.intention.proposedCapability === capabilityId)
    : [];
  const pending = candidates.length === 1 && candidates[0]?.status === "waiting_input" &&
    candidates[0].intention.resolution === "resolved" ? candidates[0] : undefined;
  return { capabilityId, ...(pending === undefined ? {} : { pending }) };
}
