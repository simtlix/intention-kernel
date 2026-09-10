import { kernelPrompt } from "../prompts/catalog.js";
import { z } from "zod";

import type { IntentionBatch } from "../contracts/intention.js";
import type { ModelGateway } from "../contracts/model.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import { modelRedactionsFor, projectModelContext, redactModelValue } from "../context/projectModelContext.js";
import { defineSchema } from "../schema/runtimeSchema.js";
import type { InterpretationIssue } from "./reviewLifecycleActions.js";

const reviewValue = z.strictObject({
  verdict: z.enum(["supported", "unsupported"]),
  rationale: z.string().min(1),
});
const reviewSchema = defineSchema<z.infer<typeof reviewValue>>({
  vendor: "zod",
  validate: (value) => {
    const parsed = reviewValue.safeParse(value);
    return parsed.success
      ? { value: parsed.data }
      : { issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
  },
  jsonSchema: () => z.toJSONSchema(reviewValue),
});

/** Review operations proposed alongside an already-supported confirmation answer. */
export async function reviewConfirmationIntentions(options: {
  readonly batch: IntentionBatch;
  readonly snapshot: ContextSnapshot;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
}): Promise<readonly InterpretationIssue[]> {
  const answer = options.batch.answerToInteraction;
  const interaction = options.snapshot.interaction;
  if (interaction?.kind !== "confirmation" || answer?.interactionId !== interaction.id ||
    typeof answer.value !== "boolean" || options.batch.intentions.length === 0) return [];

  const model = options.snapshot.agent.modelPolicy["interaction-answer.review"] ??
    options.snapshot.agent.modelPolicy["turn.interpret.repair"] ??
    options.snapshot.agent.modelPolicy["turn.interpret"];
  const redactions = modelRedactionsFor(options.snapshot);
  const result = await options.gateway.invoke({
    task: "interaction-answer.review",
    ...(model === undefined ? {} : { model }),
    ...kernelPrompt("kernel.review-confirmation-intentions.review-system-prompt"),
    input: {
      reviewKind: "confirmation_intention_independence",
      context: projectModelContext(options.snapshot),
      proposedAnswer: redactModelValue(answer, redactions),
      intentions: redactModelValue(options.batch.intentions, redactions),
    },
    outputSchema: reviewSchema,
    capabilities: options.snapshot.capabilities.filter((capability) =>
      options.batch.intentions.some((intention) => intention.proposedCapability === capability.id))
      .map((capability) => ({ ...capability, detail: "contract" as const })),
    signal: options.signal,
  });
  const validation = await reviewSchema.validate(result.value);
  if (!validation.ok) return [{
    message: "Confirmation intention-independence review output was invalid.",
    path: ["intentions"],
  }];
  return validation.value.verdict === "supported" ? [] : [{
    code: "UNSUPPORTED_CONFIRMATION_INTENTIONS",
    message: `The confirmation answer is supported but an accompanying operation is not independently requested: ${validation.value.rationale}. Preserve the exact answerToInteraction, including its boolean value. Remove intentions that only repeat the already-owned confirmed operation or infer other work from the answer. A pure confirmation or rejection is valid with empty intentions even when capability selection predicted an operation. Retain every independently requested additional operation; do not deduplicate by capability ID.`,
    path: ["intentions"],
  }];
}
