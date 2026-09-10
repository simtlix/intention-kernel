import { kernelPrompt } from "../prompts/catalog.js";
import { z } from "zod";

import type { ModelGateway, ModelRequest } from "../contracts/model.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import { projectModelContext } from "../context/projectModelContext.js";
import { defineSchema } from "../schema/runtimeSchema.js";
import { conflictingChoiceReferences, currentChoiceEvidence } from "./currentChoiceEvidence.js";
import type { InterpretationIssue } from "./reviewLifecycleActions.js";
import type { CapabilitySelection } from "./schemas.js";

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

export interface ReviewUnboundSelectionOptions {
  readonly selection: CapabilitySelection;
  readonly snapshot: ContextSnapshot;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
}

function createChoiceReviewSchema(registeredCapabilityIds: readonly string[]) {
  const rationale = z.string().min(1);
  const choiceReviewShape = z.discriminatedUnion("meaning", [
    z.strictObject({ meaning: z.literal("unique_option"), rationale }),
    z.strictObject({ meaning: z.literal("ambiguous_or_unrelated"), rationale }),
    z.strictObject({ meaning: z.literal("operation_request"), rationale,
      operationCapabilityIds: z.array(z.enum(registeredCapabilityIds)).min(1).max(registeredCapabilityIds.length)
        .refine(ids => new Set(ids).size === ids.length, "Operation bindings must identify distinct registered capabilities."),
    }),
  ]);
  return defineSchema<z.infer<typeof choiceReviewShape>>({
    vendor: "zod",
    validate: value => {
      const parsed = choiceReviewShape.safeParse(value);
      return parsed.success ? { value: parsed.data }
        : { issues: parsed.error.issues.map(issue => ({ message: issue.message, path: issue.path })) };
    },
    jsonSchema: () => z.toJSONSchema(choiceReviewShape),
  });
}

/** Verify that a post-cancellation selection is a new operation, not data left over from cancelled work. */
export async function reviewUnboundCapabilitySelection(
  options: ReviewUnboundSelectionOptions,
): Promise<readonly InterpretationIssue[]> {
  if (!requiresUnboundSelectionReview(options.snapshot, options.selection)) return [];
  const model = options.snapshot.agent.modelPolicy["capability-selection.review"] ??
    options.snapshot.agent.modelPolicy["capability.select"] ??
    options.snapshot.agent.modelPolicy["turn.interpret"];
  const request: ModelRequest<Readonly<{ verdict: "supported" | "unsupported"; rationale: string }>> = {
    task: "capability-selection.review",
    ...(model === undefined ? {} : { model }),
    ...kernelPrompt("kernel.review-capability-selection.unbound-selection-review-system-prompt"),
    input: {
      context: projectModelContext(options.snapshot),
      proposedSelection: options.selection,
    },
    outputSchema: reviewSchema,
    capabilities: [],
    signal: options.signal,
  };
  const result = await options.gateway.invoke(request);
  const validation = await reviewSchema.validate(result.value);
  if (!validation.ok) {
    return validation.issues.map((issue) => ({
      message: `Capability selection review output was invalid: ${issue.message}`,
      path: ["mode"],
    }));
  }
  return validation.value.verdict === "supported"
    ? []
    : [{
        message: `The selected capability is not a new explicit operation: ${validation.value.rationale}. Route the turn as conversational.`,
        path: ["mode"],
      }];
}

/** Verify a unique choice or an independent operational request without assuming an arbitrary option. */
export async function reviewChoiceCapabilitySelection(
  options: ReviewUnboundSelectionOptions,
): Promise<readonly InterpretationIssue[]> {
  if (!requiresChoiceSelectionReview(options.snapshot, options.selection)) return [];
  if (conflictingChoiceReferences(options.snapshot.interaction, options.snapshot.currentMessage.content)) {
    return [{
      message: "The exact current reference matches a registered example of one option and the display position of a different option. Use mode conversational with no capability IDs and preserve the pending choice for clarification; neither option is authorized.",
      path: ["mode"],
    }];
  }
  const model = options.snapshot.agent.modelPolicy["capability-selection.review"] ??
    options.snapshot.agent.modelPolicy["capability.select"] ??
    options.snapshot.agent.modelPolicy["turn.interpret"];
  const context = projectModelContext(options.snapshot);
  const registeredCapabilityIds = [...new Set(options.snapshot.capabilities.map(capability => capability.id))];
  if (registeredCapabilityIds.length === 0) return [{ message: "Choice operation review requires registered capability contracts.", path: ["capabilityIds"] }];
  const choiceReviewSchema = createChoiceReviewSchema(registeredCapabilityIds);
  const request = {
    task: "capability-selection.choice-review",
    ...(model === undefined ? {} : { model }),
    ...kernelPrompt("kernel.review-capability-selection.choice-selection-review-system-prompt"),
    input: {
      context,
      currentChoice: currentChoiceEvidence(context),
      proposedSelection: options.selection,
    },
    outputSchema: choiceReviewSchema,
    capabilities: options.snapshot.capabilities
      .filter((capability) => options.selection.capabilityIds.includes(capability.id))
      .map((capability) => ({ detail: "contract" as const, ...capability })),
    signal: options.signal,
  };
  const result = await options.gateway.invoke(request);
  const validation = await choiceReviewSchema.validate(result.value);
  if (!validation.ok) {
    return validation.issues.map((issue) => ({
      message: `Choice capability selection review output was invalid: ${issue.message}`,
      path: ["mode"],
    }));
  }
  if (validation.value.meaning === "operation_request") {
    const missing = validation.value.operationCapabilityIds.filter(id => !options.selection.capabilityIds.some(selected => selected === id));
    if (missing.length > 0) return [{
      message: `The reviewed current operation is not represented by the proposed capability set: ${missing.join(", ")}. Re-evaluate selection against the current message and registered contracts. Do not substitute the current option-selection capability for a refinement or a different requested operation. Reviewer bindings do not authorize execution or automatic additions to the shortlist.`,
      path: ["capabilityIds"],
    }];
    return [];
  }
  return validation.value.meaning !== "ambiguous_or_unrelated"
    ? []
    : [{
        message: `The active multi-option interaction does not uniquely support the selected capability: ${validation.value.rationale}. If there is no independent operational request, use mode conversational with no capability IDs to preserve the interaction. Do not turn an unanswered question into a new request for its owner capability.`,
        path: ["mode"],
      }];
}

/** Verify that leaving an active interaction is supported by a distinct current request. */
export async function reviewActiveInteractionDiversion(
  options: ReviewUnboundSelectionOptions,
): Promise<readonly InterpretationIssue[]> {
  if (!requiresActiveInteractionDiversionReview(options.snapshot, options.selection)) return [];
  const model = options.snapshot.agent.modelPolicy["capability-selection.review"] ??
    options.snapshot.agent.modelPolicy["capability.select"] ??
    options.snapshot.agent.modelPolicy["turn.interpret"];
  const activeIds = activeInteractionCapabilityIds(options.snapshot);
  const additionalCapabilityIds = options.selection.capabilityIds.filter((id) => !activeIds.has(id));
  const mixedSelection = options.selection.capabilityIds.some((id) => activeIds.has(id));
  const relevantIds = new Set([
    ...options.selection.capabilityIds,
    ...activeInteractionCapabilityIds(options.snapshot),
  ]);
  const capabilities = options.snapshot.capabilities
    .filter((capability) => relevantIds.has(capability.id))
    .map((capability) => ({
      detail: "summary" as const,
      id: capability.id,
      description: capability.description,
      availability: capability.availability,
      blockedBy: capability.blockedBy,
    }));
  const request: ModelRequest<Readonly<{ verdict: "supported" | "unsupported"; rationale: string }>> = {
    task: "capability-selection.interaction-review",
    ...(model === undefined ? {} : { model }),
    ...kernelPrompt(mixedSelection ? "kernel.review-capability-selection.mixed" : "kernel.review-capability-selection.active-interaction-diversion-review-system-prompt"),
    input: {
      context: projectModelContext(options.snapshot),
      proposedSelection: options.selection,
      ...(mixedSelection ? { additionalCapabilityIds } : {}),
    },
    outputSchema: reviewSchema,
    capabilities,
    signal: options.signal,
  };
  const result = await options.gateway.invoke(request);
  const validation = await reviewSchema.validate(result.value);
  if (!validation.ok) {
    return validation.issues.map((issue) => ({
      message: `Active-interaction capability review output was invalid: ${issue.message}`,
      path: ["mode"],
    }));
  }
  return validation.value.verdict === "supported"
    ? []
    : [{
        message: mixedSelection
          ? `An additional capability lacks an independent current-message request: ${validation.value.rationale}. Preserve the capabilities supported by the active choice and remove only the additional operations without separate request evidence. Do not turn a valid active selection into conversation or resolve an older pending question with the same answer.`
          : `The proposed capability diversion is not supported by the active interaction context: ${validation.value.rationale}. Preserve the active interaction or include every meaningful capability candidate.`,
        path: ["capabilityIds"],
      }];
}

/** Whether the current selection crosses the post-cancellation semantic boundary. */
export function requiresUnboundSelectionReview(
  snapshot: ContextSnapshot,
  selection: CapabilitySelection,
): boolean {
  return snapshot.interaction === undefined &&
    snapshot.agenda.length === 0 &&
    snapshot.progression?.objective?.status === "cancelled" &&
    (selection.mode === "selected" || selection.mode === "selected_with_control");
}

/** Whether a capability proposal claims one of several active choices without server-owned selection evidence. */
export function requiresChoiceSelectionReview(
  snapshot: ContextSnapshot,
  selection: CapabilitySelection,
): boolean {
  if (
    snapshot.interaction?.kind !== "choice" ||
    (snapshot.interaction.options?.length ?? 0) < 2 ||
    (selection.mode !== "selected" && selection.mode !== "selected_with_control")
  ) return false;
  const optionCapabilities = new Set((snapshot.interaction.options ?? [])
    .flatMap((option) => option.targetCapabilityId === undefined ? [] : [option.targetCapabilityId]));
  return selection.capabilityIds.some((id) => optionCapabilities.has(id));
}

/** Whether selected capabilities divert from active work or add operations to an active choice. */
export function requiresActiveInteractionDiversionReview(
  snapshot: ContextSnapshot,
  selection: CapabilitySelection,
): boolean {
  if (
    snapshot.interaction === undefined ||
    (selection.mode !== "selected" && selection.mode !== "selected_with_control") ||
    selection.capabilityIds.length === 0
  ) return false;
  const active = activeInteractionCapabilityIds(snapshot);
  return active.size > 0 && (selection.capabilityIds.every((id) => !active.has(id)) ||
    (snapshot.interaction.kind === "choice" && selection.capabilityIds.some((id) => !active.has(id))));
}

function activeInteractionCapabilityIds(snapshot: ContextSnapshot): Set<string> {
  const active = new Set<string>();
  if (snapshot.interaction?.capabilityId !== undefined) active.add(snapshot.interaction.capabilityId);
  for (const option of snapshot.interaction?.options ?? []) {
    if (option.targetCapabilityId !== undefined) active.add(option.targetCapabilityId);
  }
  return active;
}
