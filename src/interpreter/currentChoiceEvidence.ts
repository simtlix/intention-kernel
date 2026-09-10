import type { ModelContextProjection } from "../context/projectModelContext.js";
import type { Interaction } from "../contracts/interaction.js";

/** Detect only an exact current example conflicting with a different one-based position. */
export function conflictingChoiceReferences(interaction: Interaction | undefined, text: string): boolean {
  if (interaction?.kind !== "choice") return false;
  const reference = text.trim();
  const options = interaction.options ?? [];
  const position = options.findIndex((_, index) => String(index + 1) === reference);
  return position !== -1 && options.some((option, index) =>
    index !== position && option.referenceExamples?.includes(reference));
}

/** Project current display order from already privacy-filtered context, never from historical lists. */
export function currentChoiceEvidence(context: ModelContextProjection) {
  const interaction = context.interaction;
  if (interaction?.kind !== "choice") return undefined;
  return {
    id: interaction.id,
    goal: interaction.goal,
    options: interaction.options?.map((option, index) => ({ ...option, position: index + 1 })) ?? [],
  };
}
