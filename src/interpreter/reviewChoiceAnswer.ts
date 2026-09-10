import { kernelPrompt } from "../prompts/catalog.js";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import type { IntentionBatch } from "../contracts/intention.js";
import type { ModelGateway, ModelRequest } from "../contracts/model.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import { modelRedactionsFor, projectModelContext, redactModelValue } from "../context/projectModelContext.js";
import { defineSchema } from "../schema/runtimeSchema.js";
import { conflictingChoiceReferences, currentChoiceEvidence } from "./currentChoiceEvidence.js";
import type { InterpretationIssue } from "./reviewLifecycleActions.js";

type ChoiceAnswerReview =
  | { readonly decision: "selected"; readonly optionId: string; readonly rationale: string }
  | { readonly decision: "ambiguous"; readonly optionIds: readonly string[]; readonly rationale: string }
  | { readonly decision: "not_selection"; readonly rationale: string };

function choiceReviewSchema(optionIds: readonly string[]) {
  const id = z.enum(optionIds);
  const selected = z.strictObject({ decision: z.literal("selected"), optionId: id, rationale: z.string().min(1) });
  const notSelection = z.strictObject({ decision: z.literal("not_selection"), rationale: z.string().min(1) });
  const ambiguous = z.strictObject({ decision: z.literal("ambiguous"),
    optionIds: z.array(id).min(2).max(optionIds.length).refine(ids => new Set(ids).size === ids.length,
      "Ambiguous references must identify distinct current options."), rationale: z.string().min(1) });
  const valueSchema = optionIds.length > 1
    ? z.discriminatedUnion("decision", [selected, ambiguous, notSelection])
    : z.discriminatedUnion("decision", [selected, notSelection]);
  return defineSchema<ChoiceAnswerReview>({
    vendor: "zod",
    validate: value => {
      const parsed = valueSchema.safeParse(value);
      return parsed.success ? { value: parsed.data }
        : { issues: parsed.error.issues.map(issue => ({ message: issue.message, path: issue.path })) };
    },
    jsonSchema: () => z.toJSONSchema(valueSchema),
  });
}

function unsupportedChoice(message: string): readonly (InterpretationIssue & { readonly code: "UNSUPPORTED_CHOICE_ANSWER" })[] {
  return [{ code: "UNSUPPORTED_CHOICE_ANSWER", path: ["answerToInteraction"],
    message: `${message} Remove answerToInteraction and intentions inferred solely from that answer; preserve independently requested intentions and the pending choice.` }];
}

/** Review free-text choice commitments while retaining trusted structured selections. */
export async function reviewChoiceAnswer(options: {
  readonly batch: IntentionBatch;
  readonly snapshot: ContextSnapshot;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
  readonly validatedInteractionAnswer?: IntentionBatch["answerToInteraction"];
}): Promise<readonly InterpretationIssue[]> {
  const answer = options.batch.answerToInteraction;
  const interaction = options.snapshot.interaction;
  if (answer === undefined || interaction?.kind !== "choice") return [];
  if (
    typeof interaction.payload === "object" && interaction.payload !== null &&
    (interaction.payload as Record<string, unknown>)["kind"] === "progression.group" &&
    !(typeof answer.value === "object" && answer.value !== null &&
      (answer.value as Record<string, unknown>)["kind"] === "progression.member")
  ) return [];

  const validated = options.validatedInteractionAnswer;
  if (
    validated !== undefined && validated.interactionId === interaction.id &&
    answer.interactionId === validated.interactionId && isDeepStrictEqual(answer.value, validated.value)
  ) return [];

  if (conflictingChoiceReferences(interaction, options.snapshot.currentMessage.content)) {
    return [{
      code: "UNSUPPORTED_CHOICE_ANSWER",
      message: "The exact current reference matches a registered example of one option and the display position of a different option. Neither choice is authorized. Remove answerToInteraction and intentions inferred solely from it; preserve independently requested work and the pending choice for clarification.",
      path: ["answerToInteraction"],
    }];
  }

  // Identity is resolved against server-owned values before privacy projection.
  // Equal redacted values neither destroy nor establish an option binding.
  const matchedOptions = answer.interactionId === interaction.id
    ? (interaction.options ?? []).filter(option => isDeepStrictEqual(option.value, answer.value))
    : [];
  const serverOption = matchedOptions.length === 1 ? matchedOptions[0] : undefined;
  if (serverOption === undefined) return unsupportedChoice("The answer does not uniquely bind a current server-owned option.");

  const model = options.snapshot.agent.modelPolicy["interaction-answer.review"] ??
    options.snapshot.agent.modelPolicy["turn.interpret.repair"] ??
    options.snapshot.agent.modelPolicy["turn.interpret"];
  const context = projectModelContext(options.snapshot);
  const currentChoice = currentChoiceEvidence(context);
  const currentOptions = currentChoice?.options ?? [];
  const projectedMatches = currentOptions.filter(option => option.id === serverOption.id);
  const proposedOption = projectedMatches.length === 1 ? projectedMatches[0] : undefined;
  const optionIds = currentOptions.map(option => option.id);
  if (proposedOption === undefined || new Set(optionIds).size !== optionIds.length) {
    return unsupportedChoice("The current privacy-filtered choice does not preserve a unique option identity.");
  }
  const reviewSchema = choiceReviewSchema(optionIds);
  const redactions = modelRedactionsFor(options.snapshot);
  const request: ModelRequest<ChoiceAnswerReview> = {
    task: "interaction-answer.review",
    ...(model === undefined ? {} : { model }),
    ...kernelPrompt("kernel.review-choice-answer.choice-answer-review-system-prompt"),
    input: {
      context,
      currentChoice,
      proposedOption,
      proposedAnswer: redactModelValue(answer, redactions),
      intentions: redactModelValue(options.batch.intentions, redactions),
    },
    outputSchema: reviewSchema,
    capabilities: [],
    signal: options.signal,
  };
  const result = await options.gateway.invoke(request);
  const validation = await reviewSchema.validate(result.value);
  if (!validation.ok) {
    return validation.issues.map((issue) => ({
      message: `Choice-answer review output was invalid: ${issue.message}`,
      path: ["answerToInteraction"],
    }));
  }
  if (validation.value.decision === "selected") {
    if (validation.value.optionId === serverOption.id) return [];
    return [{
      code: "MISMATCHED_CHOICE_ANSWER",
      path: ["answerToInteraction"],
      message: `The semantic review identifies current option ID ${validation.value.optionId}, not the proposed option. Re-evaluate the current message against that exact current option and repair its answer binding using the server-owned ID. Preserve independently requested operations. This mismatch is not a rejection or permission to discard the user's selection. The repaired answer remains subject to canonical binding and semantic review.`,
    }];
  }
  return unsupportedChoice(`The current message does not unambiguously select the proposed active option: ${validation.value.rationale}.`);
}
