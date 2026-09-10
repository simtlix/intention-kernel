import { kernelPrompt } from "../prompts/catalog.js";
import { ModelGatewayError } from "../contracts/errors.js";
import type { ModelCapabilitySummary, ModelGateway, ModelRequest } from "../contracts/model.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import { projectModelContext } from "../context/projectModelContext.js";
import type { InterpretationIssue } from "./reviewLifecycleActions.js";
import { reviewLifecycleSelection } from "./reviewLifecycleActions.js";
import { defersOrdinaryChoiceExtras } from "./reviewChoiceIntentions.js";
import {
  requiresActiveInteractionDiversionReview,
  requiresChoiceSelectionReview,
  requiresUnboundSelectionReview,
  reviewActiveInteractionDiversion,
  reviewChoiceCapabilitySelection,
  reviewUnboundCapabilitySelection,
} from "./reviewCapabilitySelection.js";
import { createCapabilitySelectionSchema, type CapabilitySelection } from "./schemas.js";

/** Inputs for compact, provider-neutral capability selection. */
export interface SelectCapabilitiesOptions {
  readonly snapshot: ContextSnapshot;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
}

/** Select the minimal relevant capability set and permit one structural repair. */
export async function selectCapabilities(
  options: SelectCapabilitiesOptions,
): Promise<CapabilitySelection> {
  const capabilities: readonly ModelCapabilitySummary[] = options.snapshot.capabilities.map((capability) => ({
    detail: "summary",
    id: capability.id,
    description: capability.description,
    availability: capability.availability,
    blockedBy: capability.blockedBy,
  }));
  const schema = createCapabilitySelectionSchema(capabilities.map((capability) => capability.id));
  const model = options.snapshot.agent.modelPolicy["capability.select"] ??
    options.snapshot.agent.modelPolicy["turn.interpret"];
  const initialRequest: ModelRequest<CapabilitySelection> = {
    task: "capability.select",
    ...(model === undefined ? {} : { model }),
    ...kernelPrompt("kernel.capability.select"),
    input: projectModelContext(options.snapshot),
    outputSchema: schema,
    capabilities,
    signal: options.signal,
  };
  const initial = await options.gateway.invoke(initialRequest);
  const initialValidation = await schema.validate(initial.value);
  const initialSelection = initialValidation.ok
    ? retainInteractionContracts(initialValidation.value, options.snapshot)
    : undefined;
  const initialReview: Awaited<ReturnType<typeof selectionIssues>> = initialValidation.ok
    ? await selectionIssues({
        selection: initialSelection as CapabilitySelection,
        snapshot: options.snapshot,
        gateway: options.gateway,
        signal: options.signal,
      })
    : { issues: initialValidation.issues };
  const initialIssues = initialReview.issues;
  if (initialSelection !== undefined && initialIssues.length === 0) return { ...initialSelection, ...(initialReview.reviewedChoice === undefined ? {} : { reviewedChoice: initialReview.reviewedChoice }) };

  const repairModel = options.snapshot.agent.modelPolicy["capability.select.repair"] ?? model;
  const repairRequest: ModelRequest<CapabilitySelection> = {
    ...initialRequest,
    task: "capability.select.repair",
    ...(repairModel === undefined ? {} : { model: repairModel }),
    ...kernelPrompt("kernel.capability.select.repair"),
    input: {
      context: projectModelContext(options.snapshot),
      invalidOutput: initial.value,
      validationIssues: initialIssues,
    },
  };
  const repaired = await options.gateway.invoke(repairRequest);
  const repairedValidation = await schema.validate(repaired.value);
  const repairedSelection = repairedValidation.ok
    ? retainInteractionContracts(repairedValidation.value, options.snapshot)
    : undefined;
  const repairedReview: Awaited<ReturnType<typeof selectionIssues>> = repairedValidation.ok
    ? await selectionIssues({
        selection: repairedSelection as CapabilitySelection,
        snapshot: options.snapshot,
        gateway: options.gateway,
        signal: options.signal,
      })
    : { issues: repairedValidation.issues };
  const repairedIssues = repairedReview.issues;
  if (repairedSelection !== undefined && repairedIssues.length === 0) return { ...repairedSelection, ...(repairedReview.reviewedChoice === undefined ? {} : { reviewedChoice: repairedReview.reviewedChoice }) };
  if (
    unboundScalarSelection(options.snapshot) ||
    (repairedSelection !== undefined && (
      requiresUnboundSelectionReview(options.snapshot, repairedSelection) ||
      requiresChoiceSelectionReview(options.snapshot, repairedSelection) ||
      requiresActiveInteractionDiversionReview(options.snapshot, repairedSelection)
    ))
  ) {
    const diversion = repairedSelection !== undefined &&
      requiresActiveInteractionDiversionReview(options.snapshot, repairedSelection);
    return {
      source: "kernel_boundary",
      mode: "conversational",
      capabilityIds: [],
      rationale: diversion
        ? "The proposed diversion was not supported, so the active interaction remains unchanged."
        : "The isolated value does not answer active work or explicitly request an operation.",
      evidence: [{
        text: options.snapshot.currentMessage.content,
        meaning: diversion
          ? "Unsupported diversion from the active interaction"
          : "Unbound value without an operational request",
        messageIndex: options.snapshot.currentMessage.index,
      }],
    };
  }

  throw new ModelGatewayError({
    code: "CAPABILITY_SELECTION_INVALID",
    message: "The model did not select valid capabilities after one structural repair.",
    retryable: false,
    context: { task: "capability.select", attempts: 2, issues: JSON.stringify(repairedIssues) },
  });
}

function retainInteractionContracts(
  selection: CapabilitySelection,
  snapshot: ContextSnapshot,
): CapabilitySelection {
  if (selection.mode === "conversational" && snapshot.interaction !== undefined) {
    const targets = new Set([
      snapshot.interaction.capabilityId,
      ...(snapshot.interaction.options ?? []).map((option) => option.targetCapabilityId),
    ]);
    const available = snapshot.capabilities.filter((capability) => targets.has(capability.id))
      .map((capability) => capability.id);
    return {
      ...selection,
      capabilityIds: available,
      adjustments: available.map((id) => ({ code: "ACTIVE_INTERACTION_CONTRACT_AVAILABLE", capabilityId: id })),
    };
  }
  const activeCapability = snapshot.interaction?.kind === "confirmation"
    ? snapshot.interaction.capabilityId
    : undefined;
  if (
    activeCapability === undefined ||
    (selection.mode !== "selected" && selection.mode !== "selected_with_control") ||
    selection.capabilityIds.includes(activeCapability)
  ) return selection;
  return {
    ...selection,
    capabilityIds: [...selection.capabilityIds, activeCapability],
    adjustments: [...selection.adjustments ?? [], {
      code: "ACTIVE_CONFIRMATION_OWNER_RETAINED", capabilityId: activeCapability,
    }],
  };
}

async function selectionIssues(options: {
  readonly selection: CapabilitySelection;
  readonly snapshot: ContextSnapshot;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
}): Promise<{ readonly issues: readonly InterpretationIssue[]; readonly reviewedChoice?: NonNullable<CapabilitySelection["reviewedChoice"]> }> {
  const boundary = unboundScalarSelection(options.snapshot) &&
    (options.selection.mode === "selected" || options.selection.mode === "selected_with_control")
    ? [{
        message: "An isolated scalar cannot select a capability without an active interaction, pending agenda item or explicit operation.",
        path: ["mode"],
      }]
    : [];
  if (boundary.length > 0) return { issues: boundary };
  const unboundIssues = await reviewUnboundCapabilitySelection(options);
  if (unboundIssues.length > 0) return { issues: unboundIssues };
  const choiceReview = await reviewChoiceCapabilitySelection(options);
  if (choiceReview.issues.length > 0) return choiceReview;
  // A mixed ordinary-choice shortlist exposes contracts, not operation consent.
  // Interpretation reviews the actual extras, including batches without an answer.
  const interactionIssues = defersOrdinaryChoiceExtras(options.snapshot, options.selection)
    ? [] : await reviewActiveInteractionDiversion(options);
  if (interactionIssues.length > 0) return { issues: interactionIssues };
  const issues = await reviewLifecycleSelection(options);
  return { ...choiceReview, issues };
}

function unboundScalarSelection(snapshot: ContextSnapshot): boolean {
  if (snapshot.interaction !== undefined || snapshot.agenda.length > 0) return false;
  const text = snapshot.currentMessage.content.trim();
  if (text.length === 0) return false;
  const value = Number(text);
  return Number.isFinite(value) && String(value) === text;
}
