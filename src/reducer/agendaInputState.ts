import type { AgendaItem } from "../contracts/agenda.js";
import type { Interaction } from "../contracts/interaction.js";

// Durable kernel lineage, not capability state or model-supplied authority.
type FollowUpAgendaItem = AgendaItem & { readonly completedFollowUp?: true; readonly optionalInput?: true };

/** Retain a completed operation's follow-up without treating it as unfinished work. */
export function withCompletedFollowUp(item: AgendaItem, completed: boolean): AgendaItem {
  return completed ? { ...item, completedFollowUp: true } as FollowUpAgendaItem : item;
}

/** Preserve optional read input without marking its unfinished operation completed. */
export function withOptionalInput(item: AgendaItem, interaction: Interaction | undefined): AgendaItem {
  return interaction?.mode === "optional" && interaction.kind !== "confirmation" &&
    interaction.protectedCanonicalMessage === undefined
    ? { ...item, optionalInput: true } as FollowUpAgendaItem : item;
}

/** Missing legacy lineage remains conservative: unfinished input still blocks automation. */
export function waitsForOperationInput(item: AgendaItem): boolean {
  const lineage = item as FollowUpAgendaItem;
  return item.status === "waiting_input" && lineage.completedFollowUp !== true && lineage.optionalInput !== true;
}
