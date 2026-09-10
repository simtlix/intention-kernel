import { kernelPrompt } from "../prompts/catalog.js";
import { z } from "zod";

import type { IntentionBatch } from "../contracts/intention.js";
import type { ModelGateway, ModelRequest } from "../contracts/model.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import { projectModelContext } from "../context/projectModelContext.js";
import { defineSchema } from "../schema/runtimeSchema.js";
import type { InterpretationIssue } from "./reviewLifecycleActions.js";

const reviewSchema = defineSchema<Readonly<{
  verdict: "supported" | "unsupported";
  rationale: string;
}>>({
  vendor: "zod",
  validate: (value) => {
    const parsed = z.strictObject({
      verdict: z.enum(["supported", "unsupported"]),
      rationale: z.string().min(1),
    }).safeParse(value);
    return parsed.success
      ? { value: parsed.data }
      : { issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
  },
  jsonSchema: () => z.toJSONSchema(z.strictObject({
    verdict: z.enum(["supported", "unsupported"]),
    rationale: z.string().min(1),
  })),
});

/** Verify evidence before a model-proposed answer confirms or advances an interaction. */
export async function reviewInteractionAnswer(options: {
  readonly batch: IntentionBatch;
  readonly snapshot: ContextSnapshot;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
}): Promise<readonly InterpretationIssue[]> {
  const answer = options.batch.answerToInteraction;
  if (answer === undefined) return [];
  const interaction = options.snapshot.interaction;
  const confirmation = interaction?.kind === "confirmation" && typeof answer.value === "boolean";
  const progression = interaction?.kind === "choice" &&
    typeof interaction.payload === "object" && interaction.payload !== null &&
    (interaction.payload as Record<string, unknown>)["kind"] === "progression.group" &&
    typeof answer.value === "object" && answer.value !== null &&
    (answer.value as Record<string, unknown>)["kind"] === "progression.continue";
  if (!confirmation && !progression) return [];
  let reusedProgressionEvidence = false;
  const authorized = new Set(options.snapshot.selectedModelGuidancePolicies.flatMap((policy) =>
    policy.continueProgressionForCapabilities ?? []));
  const policyAuthorizedProgression = progression && options.batch.intentions.some((intention) =>
    intention.resolution === "resolved" && intention.proposedCapability !== undefined && authorized.has(intention.proposedCapability));
  if (progression && !policyAuthorizedProgression) {
    const continuationEvidence = answer.evidence.trim();
    const overlappingIntentions = continuationEvidence.length === 0 ? [] : options.batch.intentions.filter((intention) =>
      intention.evidence.some((entry) => {
        const operationEvidence = entry.text.trim();
        return operationEvidence.length > 0 && (operationEvidence.includes(continuationEvidence) || continuationEvidence.includes(operationEvidence));
      }));
    reusedProgressionEvidence = overlappingIntentions.length > 0;
    const memberCapabilities = new Set(interaction.options?.map((option) => option.targetCapabilityId));
    // Shared wording for a current menu action must not manufacture its exit.
    // An external/downstream intention can instead be inferred from a genuine
    // exit request, so review that answer before deciding what repair retains.
    if (overlappingIntentions.some((intention) => intention.proposedCapability !== undefined &&
      memberCapabilities.has(intention.proposedCapability))) return [{
      message: "Progression continuation and a separately requested operation reuse overlapping evidence. Preserve the independently requested intentions. If the user also explicitly asks to leave the active group, cite separate exact current-message spans for that exit and the operation; otherwise remove answerToInteraction and keep the active group open. An agreement introducing an information request is not a separate exit request.",
      path: ["answerToInteraction"],
    }];
  }

  const model = options.snapshot.agent.modelPolicy["interaction-answer.review"] ??
    options.snapshot.agent.modelPolicy["turn.interpret.repair"] ??
    options.snapshot.agent.modelPolicy["turn.interpret"];
  const reviewInput = {
    context: projectModelContext(options.snapshot),
    proposedAnswer: answer,
    intentions: options.batch.intentions,
  };
  const request: ModelRequest<Readonly<{ verdict: "supported" | "unsupported"; rationale: string }>> = {
    task: "interaction-answer.review",
    ...(model === undefined ? {} : { model }),
    ...kernelPrompt(progression ? "kernel.review-interaction-answer.progression-answer-review-system-prompt" : "kernel.review-interaction-answer.confirmation-answer-review-system-prompt"),
    input: reviewInput,
    outputSchema: reviewSchema,
    capabilities: [],
    signal: options.signal,
  };
  // A declared transition authorizes only the exit consequence. Its operation
  // still passes the semantic independence review below, including shared spans.
  if (!policyAuthorizedProgression) {
    const result = await options.gateway.invoke(request);
    const validation = await reviewSchema.validate(result.value);
    if (!validation.ok) {
      return validation.issues.map((issue) => ({
        message: `Interaction-answer review output was invalid: ${issue.message}`,
        path: ["answerToInteraction"],
      }));
    }
    if (validation.value.verdict === "unsupported") return [{
        ...(progression ? { code: "UNSUPPORTED_PROGRESSION_EXIT" } : {}),
        message: `The current message does not explicitly answer the active ${progression ? "progression" : "confirmation"}: ${validation.value.rationale}. Remove answerToInteraction and preserve the pending interaction and any independently requested intentions.`,
        path: ["answerToInteraction"],
      }];
  }
  if (!progression || options.batch.intentions.length === 0) return [];
  if (reusedProgressionEvidence) return [{
    message: "The continuation answer is semantically supported, but an additional operation reuses its evidence. Preserve answerToInteraction. Remove any intention inferred solely from the continuation or its destination; the kernel schedules the next step. Retain an independently requested operation only with separate exact current-message evidence. A pure continuation is valid with empty intentions even when capability selection predicted an operation.",
    path: ["intentions"],
  }];
  const independent = await options.gateway.invoke({
    ...request,
    ...kernelPrompt("kernel.review-interaction-answer.progression-intentions-review-system-prompt"),
    input: { ...reviewInput, reviewKind: "progression_intention_independence" },
    capabilities: options.snapshot.capabilities.filter((capability) =>
      options.batch.intentions.some((intention) => intention.proposedCapability === capability.id))
      .map((capability) => ({ ...capability, detail: "contract" as const })),
  });
  const independentValidation = await reviewSchema.validate(independent.value);
  if (!independentValidation.ok) return [{
    message: "Progression intention-independence review output was invalid.", path: ["intentions"],
  }];
  return independentValidation.value.verdict === "supported" ? [] : [{
    message: `The continuation answer is supported but a capability operation was inferred from the next workflow step: ${independentValidation.value.rationale}. Preserve answerToInteraction and remove intentions that have no independent current-message evidence. A pure continuation is valid with empty intentions even when capability selection predicted an operation.`,
    path: ["intentions"],
  }];
}
