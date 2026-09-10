import { kernelPrompt } from "../prompts/catalog.js";
import { z } from "zod";

import type { IntentionBatch } from "../contracts/intention.js";
import type { ModelGateway, ModelRequest } from "../contracts/model.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import { projectModelContext } from "../context/projectModelContext.js";
import { defineSchema } from "../schema/runtimeSchema.js";
import type { CapabilitySelection } from "./schemas.js";

const lifecycleReviewItemSchema = z.strictObject({
  actionIndex: z.number().int().nonnegative(),
  verdict: z.enum(["supported", "unsupported"]),
  rationale: z.string().min(1),
});

interface LifecycleReview {
  readonly reviews: readonly Readonly<{
    actionIndex: number;
    verdict: "supported" | "unsupported";
    rationale: string;
  }>[];
}

export interface LifecycleReviewOptions {
  readonly batch: IntentionBatch;
  readonly selection: CapabilitySelection;
  readonly snapshot: ContextSnapshot;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
}

export type InterpretationIssue = Readonly<{
  code?: string;
  message: string;
  path: readonly (string | number)[];
}>;

const lifecycleSelectionReviewSchema = defineSchema<Readonly<{
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

export interface LifecycleSelectionReviewOptions {
  readonly selection: CapabilitySelection;
  readonly snapshot: ContextSnapshot;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
}

/** Verify a control shortlist before it can hide ordinary capability contracts. */
export async function reviewLifecycleSelection(
  options: LifecycleSelectionReviewOptions,
): Promise<readonly InterpretationIssue[]> {
  const exposesControl = options.selection.mode === "control" || options.selection.mode === "selected_with_control";
  const activeProgressionChoice = options.snapshot.progression?.objective?.status === "active" &&
    options.snapshot.interaction?.kind === "choice" &&
    typeof options.snapshot.interaction.payload === "object" &&
    options.snapshot.interaction.payload !== null &&
    (options.snapshot.interaction.payload as Record<string, unknown>)["kind"] === "progression.group";
  if (!exposesControl && !activeProgressionChoice) return [];
  const model = options.snapshot.agent.modelPolicy["lifecycle-selection.review"] ??
    options.snapshot.agent.modelPolicy["lifecycle.review"] ??
    options.snapshot.agent.modelPolicy["turn.interpret"];
  const request: ModelRequest<Readonly<{ verdict: "supported" | "unsupported"; rationale: string }>> = {
    task: "lifecycle-selection.review",
    ...(model === undefined ? {} : { model }),
    ...kernelPrompt("kernel.review-lifecycle-actions.lifecycle-selection-review-system-prompt"),
    input: {
      context: projectModelContext(options.snapshot),
      controlContract: { actions: ["cancel_objective", "cancel_agenda_item"], interactionAnswersAreLifecycleActions: false },
      proposedSelection: {
        mode: options.selection.mode,
        rationale: options.selection.rationale,
        evidence: options.selection.evidence,
      },
    },
    outputSchema: lifecycleSelectionReviewSchema,
    capabilities: [],
    signal: options.signal,
  };
  const result = await options.gateway.invoke(request);
  const validation = await lifecycleSelectionReviewSchema.validate(result.value);
  if (!validation.ok) {
    return validation.issues.map((issue) => ({
      message: `Lifecycle selection review output was invalid: ${issue.message}`,
      path: ["mode"],
    }));
  }
  return validation.value.verdict === "supported"
    ? []
    : [{
        message: exposesControl
          ? `Lifecycle control was not explicitly supported by the user: ${validation.value.rationale}. Select ordinary capability operations instead.`
          : `The selection omitted lifecycle control even though the active objective may have been explicitly declined: ${validation.value.rationale}. Re-evaluate control mode.`,
        path: ["mode"],
      }];
}

/** Semantically verify the rare, destructive lifecycle actions before planning them. */
export async function reviewLifecycleActions(
  options: LifecycleReviewOptions,
): Promise<readonly InterpretationIssue[]> {
  const actions = options.batch.lifecycleActions ?? [];
  if (actions.length === 0) return [];

  const outputSchema = createLifecycleReviewSchema(actions.length);
  const request: ModelRequest<LifecycleReview> = {
    task: "lifecycle.review",
    ...(options.snapshot.agent.modelPolicy["lifecycle.review"] === undefined &&
      options.snapshot.agent.modelPolicy["turn.interpret"] === undefined
      ? {}
      : {
          model: options.snapshot.agent.modelPolicy["lifecycle.review"] ??
            options.snapshot.agent.modelPolicy["turn.interpret"],
        }),
    ...kernelPrompt("kernel.review-lifecycle-actions.lifecycle-review-system-prompt"),
    input: {
      context: projectModelContext(options.snapshot),
      selection: options.selection,
      proposedActions: actions,
    },
    outputSchema,
    capabilities: [],
    signal: options.signal,
  };
  const result = await options.gateway.invoke(request);
  const validation = await outputSchema.validate(result.value);
  if (!validation.ok) {
    return validation.issues.map((issue) => ({
      message: `Lifecycle review output was invalid: ${issue.message}`,
      path: ["lifecycleActions"],
    }));
  }
  return validation.value.reviews.flatMap((review) =>
    review.verdict === "supported"
      ? []
      : [{
          message: `Lifecycle cancellation was not explicitly supported by the user: ${review.rationale}`,
          path: ["lifecycleActions", review.actionIndex],
        }]);
}

function createLifecycleReviewSchema(actionCount: number) {
  const rawSchema = z.strictObject({
    reviews: z.array(lifecycleReviewItemSchema).length(actionCount),
  }).superRefine((value, context) => {
    const indexes = value.reviews.map(({ actionIndex }) => actionIndex);
    for (let index = 0; index < actionCount; index += 1) {
      if (!indexes.includes(index)) {
        context.addIssue({
          code: "custom",
          message: "Every proposed lifecycle action must be reviewed exactly once.",
          path: ["reviews"],
        });
      }
    }
    if (new Set(indexes).size !== indexes.length || indexes.some((index) => index >= actionCount)) {
      context.addIssue({
        code: "custom",
        message: "Lifecycle review indexes must be unique and reference proposed actions.",
        path: ["reviews"],
      });
    }
  });
  return defineSchema<LifecycleReview>({
    vendor: "zod",
    validate: (value) => {
      const parsed = rawSchema.safeParse(value);
      return parsed.success
        ? { value: parsed.data }
        : { issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
    },
    jsonSchema: () => z.toJSONSchema(rawSchema),
  });
}
