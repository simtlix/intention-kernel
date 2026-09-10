import { kernelPrompt } from "../prompts/catalog.js";
import { z } from "zod";
import type { IntentionBatch } from "../contracts/intention.js";
import type { ModelGateway } from "../contracts/model.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import { projectModelContext } from "../context/projectModelContext.js";
import { defineSchema } from "../schema/runtimeSchema.js";
import type { InterpretationIssue } from "./reviewLifecycleActions.js";

const rawSchema = z.strictObject({ continuation: z.enum(["requested", "not_requested", "ambiguous"]), evidence: z.string(), rationale: z.string().min(1) });
const reviewSchema = defineSchema<z.infer<typeof rawSchema>>({
  vendor: "zod",
  validate: (value) => {
    const parsed = rawSchema.safeParse(value);
    return parsed.success ? { value: parsed.data } : { issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
  },
  jsonSchema: () => z.toJSONSchema(rawSchema),
});

/** Detect a missing group-continuation answer without predicting its next capability. */
export async function reviewOmittedProgressionAnswer(options: {
  readonly batch: IntentionBatch;
  readonly snapshot: ContextSnapshot;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
}): Promise<readonly InterpretationIssue[]> {
  const { batch, snapshot } = options;
  const interaction = snapshot.interaction;
  if (batch.answerToInteraction !== undefined || (batch.lifecycleActions?.length ?? 0) > 0 ||
    batch.intentions.some((intention) => intention.resolution !== "resolved") || interaction?.kind !== "choice" ||
    typeof interaction.payload !== "object" || interaction.payload === null ||
    (interaction.payload as Record<string, unknown>)["kind"] !== "progression.group") return [];
  const continuation = interaction.options?.find((option) => typeof option.value === "object" && option.value !== null &&
    (option.value as Record<string, unknown>)["kind"] === "progression.continue");
  if (continuation === undefined) return [];
  const model = snapshot.agent.modelPolicy["interaction-answer.review"] ??
    snapshot.agent.modelPolicy["turn.interpret.repair"] ?? snapshot.agent.modelPolicy["turn.interpret"];
  const result = await options.gateway.invoke({
    task: "interaction-answer.review", ...(model === undefined ? {} : { model }), ...kernelPrompt("kernel.review-omitted-progression-answer.system"),
    input: { reviewKind: "omitted_progression_answer", context: projectModelContext(snapshot),
      proposedIntentions: batch.intentions.map((intention) => ({ capabilityId: intention.proposedCapability, evidence: intention.evidence })),
      omittedAnswer: { interactionId: interaction.id, optionId: continuation.id, value: continuation.value },
    },
    outputSchema: reviewSchema,
    capabilities: snapshot.capabilities.filter((capability) => batch.intentions.some((intention) => intention.proposedCapability === capability.id))
      .map((capability) => ({ ...capability, detail: "contract" as const })),
    signal: options.signal,
  });
  const validation = await reviewSchema.validate(result.value);
  if (!validation.ok) return [{ message: "Omitted progression-answer review output was invalid.", path: ["answerToInteraction"] }];
  if (validation.value.continuation !== "requested") return [];
  if (validation.value.evidence.trim().length === 0 || !snapshot.currentMessage.content.includes(validation.value.evidence)) {
    return [{ message: "A requested progression continuation requires a non-empty literal excerpt of the current user message.", path: ["answerToInteraction"] }];
  }
  return [{
    message: `The user answered the active progression but the proposal omitted that answer: ${validation.value.rationale}. Set answerToInteraction for ${interaction.id} to the exact server-owned option ID ${continuation.id}. Remove any intention inferred solely from the continuation's downstream step; the kernel schedules it. Preserve independently requested operations with their own current-message evidence. A pure continuation has empty intentions even if capability selection predicted a next operation.`,
    path: ["answerToInteraction"],
  }];
}
