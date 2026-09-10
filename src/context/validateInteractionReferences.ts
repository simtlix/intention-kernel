import { IntentionKernelError } from "../contracts/errors.js";
import type { Interaction } from "../contracts/interaction.js";

/** Validate interaction presentation options at checkpoint and capability-result boundaries. */
export function validateInteractionReferences(interaction: Interaction | undefined): void {
  if (interaction === undefined) return;
  const responseMode: unknown = interaction.responseMode;
  if (responseMode !== undefined && responseMode !== "contextual") {
    throw new IntentionKernelError({
      code: "INVALID_INTERACTION_RESPONSE_MODE",
      message: "Interaction response mode must be contextual or omitted.",
      retryable: false,
      context: { interactionId: interaction.id },
    });
  }
  for (const option of interaction.options ?? []) {
    const examples = option.referenceExamples;
    if (examples === undefined) continue;
    if (!Array.isArray(examples) || examples.length > 32 || Array.from(examples).some((example: unknown) =>
      typeof example !== "string" || example.trim().length === 0 || example.length > 256)) {
      throw new IntentionKernelError({
        code: "INVALID_INTERACTION_REFERENCE_EXAMPLES",
        message: "Interaction reference examples must be a bounded array of non-blank strings.",
        retryable: false,
        context: { interactionId: interaction.id, optionId: option.id },
      });
    }
  }
}
