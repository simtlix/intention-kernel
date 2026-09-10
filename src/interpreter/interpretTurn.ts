import { kernelPrompt } from "../prompts/catalog.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { ModelGatewayError } from "../contracts/errors.js";
import type { IntentionBatch } from "../contracts/intention.js";
import type { InteractionOption } from "../contracts/interaction.js";
import type { ModelGateway, ModelRequest } from "../contracts/model.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import type { CompiledAgentDefinition } from "../compiler/compileAgentDefinition.js";
import { projectModelContext } from "../context/projectModelContext.js";
import { resolveInteractionAnswerOwner } from "../context/resolveInteractionAnswerOwner.js";
import type { KernelIdGenerator } from "../contracts/runtime.js";
import { reviewInteractionAnswer } from "./reviewInteractionAnswer.js";
import { reviewOmittedProgressionAnswer } from "./reviewOmittedProgressionAnswer.js";
import { reviewChoiceAnswer } from "./reviewChoiceAnswer.js";
import { reviewOperationInputs } from "./reviewOperationInputs.js";
import { defersOrdinaryChoiceExtras, reviewChoiceIntentions } from "./reviewChoiceIntentions.js";
import { reviewProgressionMemberOperation } from "./reviewProgressionMemberOperation.js";
import { reviewConfirmationIntentions } from "./reviewConfirmationIntentions.js";
import { reviewOmittedChoiceAnswer } from "./reviewOmittedChoiceAnswer.js";
import { reviewLifecycleActions } from "./reviewLifecycleActions.js";
import { createIntentionBatchSchema, type CapabilitySelection } from "./schemas.js";
import { selectCapabilities } from "./selectCapabilities.js";

/** Inputs for one provider-neutral semantic interpretation request. */
export interface InterpretTurnOptions {
  readonly snapshot: ContextSnapshot;
  /** Runtime contracts used to validate admitted resolved operation inputs before bounded repair. */
  readonly compiled?: CompiledAgentDefinition;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
  /** Kernel-owned identifier source; model output never supplies durable intention IDs. */
  readonly ids?: KernelIdGenerator;
  /** Previously selected capability set when the runtime exposes selection as its own stage. */
  readonly selection?: CapabilitySelection;
  /** Server-owned selection already resolved against the active interaction by the runtime. */
  readonly validatedInteractionAnswer?: IntentionBatch["answerToInteraction"];
}

/** Interpret a turn and permit at most one repair of malformed structured output. */
export async function interpretTurn(options: InterpretTurnOptions): Promise<IntentionBatch> {
  const selection = options.selection ?? await selectCapabilities(options);
  const reviewedAnswer = bindReviewedChoice(selection, options.snapshot);
  if (options.validatedInteractionAnswer === undefined && reviewedAnswer !== undefined) {
    options = { ...options, validatedInteractionAnswer: reviewedAnswer };
  }
  const collection = resolveInteractionAnswerOwner(options.snapshot, reviewedAnswer);
  // A bound answer to one durable collector is a continuation, not a new operation.
  // Keep interpreting cross-owner selections, lifecycle requests and additional work.
  if (reviewedAnswer !== undefined && collection?.pending !== undefined &&
    selection.mode === "selected" && selection.capabilityIds.length === 1 &&
    selection.capabilityIds[0] === collection.capabilityId &&
    (options.validatedInteractionAnswer === undefined || isDeepStrictEqual(options.validatedInteractionAnswer, reviewedAnswer))) {
    return { intentions: [], contradictions: [], answerToInteraction: reviewedAnswer };
  }
  if (selection.mode === "conversational" && options.snapshot.interaction === undefined) {
    return { intentions: [], contradictions: [] };
  }
  const selected = new Set(selection.capabilityIds);
  const capabilities = options.snapshot.capabilities
    .filter((capability) => selected.has(capability.id))
    .map((capability) => ({
    detail: "contract" as const,
    id: capability.id,
    description: capability.description,
    inputSchema: capability.inputSchema,
    availability: capability.availability,
    blockedBy: capability.blockedBy,
    ...(capability.guidance === undefined ? {} : { guidance: capability.guidance }),
    ...(capability.referenceRequirements === undefined
      ? {}
      : { referenceRequirements: capability.referenceRequirements }),
  }));
  const intentionBatchSchema = createIntentionBatchSchema(
    options.ids ?? { next: () => randomUUID() },
    selection.capabilityIds.length === 1 ? selection.capabilityIds[0] : undefined,
    options.snapshot.interaction,
    selection.mode,
  );
  const initialRequest: ModelRequest<IntentionBatch> = {
    task: "turn.interpret",
    ...(options.snapshot.agent.modelPolicy["turn.interpret"] === undefined
      ? {}
      : { model: options.snapshot.agent.modelPolicy["turn.interpret"] }),
    ...kernelPrompt("kernel.turn.interpret"),
    input: {
      context: projectModelContext(options.snapshot),
      selection,
    },
    outputSchema: intentionBatchSchema,
    capabilities,
    signal: options.signal,
  };
  const initial = await options.gateway.invoke(initialRequest);
  const initialValidation = await intentionBatchSchema.validate(initial.value);
  const initialBatch = initialValidation.ok
    ? canonicalizeInteractionAnswer(withValidatedAnswer(initialValidation.value, options), options.snapshot)
    : undefined;
  const initialIssues = initialValidation.ok
    ? await validatedInterpretationIssues(initialBatch as IntentionBatch, selection, options)
    : initialValidation.issues;
  if (initialBatch !== undefined && initialIssues.length === 0) return initialBatch;

  const repairRequest: ModelRequest<IntentionBatch> = {
    ...initialRequest,
    task: "turn.interpret.repair",
    ...(options.snapshot.agent.modelPolicy["turn.interpret.repair"] === undefined
      ? {}
      : { model: options.snapshot.agent.modelPolicy["turn.interpret.repair"] }),
    ...kernelPrompt("kernel.turn.interpret.repair"),
    input: {
      context: projectModelContext(options.snapshot),
      selection,
      invalidOutput: initial.value,
      validationIssues: initialIssues,
    },
  };
  const repaired = await options.gateway.invoke(repairRequest);
  const repairedValidation = await intentionBatchSchema.validate(repaired.value);
  const repairedBatch = repairedValidation.ok
    ? canonicalizeInteractionAnswer(withValidatedAnswer(repairedValidation.value, options), options.snapshot)
    : undefined;
  const activeCapabilities = new Set([
    options.snapshot.interaction?.capabilityId,
    ...(options.snapshot.interaction?.options ?? []).map((option) => option.targetCapabilityId),
  ]);
  // A semantic rejection can leave no operation to perform. Admit abstention
  // only in this bounded repair, never for malformed reviews or lost requests.
  const reviewedChoiceAbstention = repairedBatch !== undefined && initialBatch !== undefined &&
    options.validatedInteractionAnswer === undefined && selection.mode === "selected" &&
    options.snapshot.interaction?.kind === "choice" &&
    initialIssues.some((issue) => "code" in issue &&
      (issue.code === "UNSUPPORTED_CHOICE_ANSWER" || issue.code === "UNSUPPORTED_PROGRESSION_MEMBER_OPERATION")) &&
    selection.capabilityIds.every((id) => activeCapabilities.has(id)) &&
    initialBatch.intentions.every((intention) => intention.resolution === "resolved" &&
      intention.proposedCapability !== undefined && activeCapabilities.has(intention.proposedCapability)) &&
    repairedBatch.intentions.length === 0 && repairedBatch.answerToInteraction === undefined &&
    // Reporting a conflict does not authorize an operation or cancel the choice.
    // Preserve that evidence while allowing the already-reviewed abstention.
    (repairedBatch.lifecycleActions?.length ?? 0) === 0;
  const reviewedExtrasAbstention = repairedBatch !== undefined && initialBatch !== undefined &&
    options.validatedInteractionAnswer === undefined && selection.mode === "selected" &&
    defersOrdinaryChoiceExtras(options.snapshot, selection) && initialBatch.answerToInteraction === undefined &&
    initialIssues.some(issue => "code" in issue && issue.code === "UNSUPPORTED_UNANSWERED_CHOICE_EXTRAS") &&
    initialBatch.intentions.every(intention => intention.resolution === "resolved" &&
      intention.proposedCapability !== undefined && !activeCapabilities.has(intention.proposedCapability)) &&
    repairedBatch.intentions.length === 0 && repairedBatch.answerToInteraction === undefined &&
    repairedBatch.contradictions.length === 0 && (repairedBatch.lifecycleActions?.length ?? 0) === 0;
  const repairSelection: CapabilitySelection = reviewedChoiceAbstention || reviewedExtrasAbstention
    ? { ...selection, mode: "conversational", capabilityIds: [] }
    : selection;
  const retainSupportedAnswer = initialIssues.some((issue) => "code" in issue &&
    (issue.code === "UNSUPPORTED_CONFIRMATION_INTENTIONS" || issue.code === "UNSUPPORTED_CHOICE_INTENTIONS"));
  const changedSupportedAnswer = retainSupportedAnswer && initialBatch?.answerToInteraction !== undefined &&
    (repairedBatch?.answerToInteraction?.interactionId !== initialBatch.answerToInteraction.interactionId ||
      !sameStructuredValue(repairedBatch.answerToInteraction.value, initialBatch.answerToInteraction.value));
  const repairedIssues = changedSupportedAnswer
    ? [{ message: "Repair must preserve the already-supported interaction ID and answer value while removing unsupported additional operations.", path: ["answerToInteraction"] }]
    : repairedValidation.ok
    ? await validatedInterpretationIssues(repairedBatch as IntentionBatch, repairSelection, options,
      initialIssues.some((issue) => "code" in issue && issue.code === "UNSUPPORTED_PROGRESSION_EXIT"))
    : repairedValidation.issues;
  if (repairedBatch !== undefined && repairedIssues.length === 0) return repairedBatch;

  throw new ModelGatewayError({
    code: "MODEL_OUTPUT_INVALID",
    message: "The model did not produce a valid turn interpretation after one structural repair.",
    retryable: false,
    context: { task: "turn.interpret", attempts: 2, issues: JSON.stringify(repairedIssues) },
  });
}

/** Bind only a review of this exact message and current server-owned choice. */
function bindReviewedChoice(selection: CapabilitySelection, snapshot: ContextSnapshot): IntentionBatch["answerToInteraction"] {
  const reviewed = selection.reviewedChoice;
  if (reviewed === undefined) return undefined;
  const interaction = snapshot.interaction;
  const matches = interaction?.options?.filter(option => option.id === reviewed.optionId) ?? [];
  const option = matches[0];
  if (interaction?.kind !== "choice" || interaction.id !== reviewed.interactionId || matches.length !== 1 || option === undefined ||
    snapshot.currentMessage.index !== reviewed.messageIndex || snapshot.currentMessage.content !== reviewed.evidence) {
    throw new ModelGatewayError({ code: "CAPABILITY_SELECTION_INVALID", message: "Choice review does not bind the current message and interaction.", retryable: false });
  }
  return { interactionId: interaction.id, value: structuredClone(option.value), evidence: reviewed.evidence, rationale: reviewed.rationale };
}

function withValidatedAnswer(batch: IntentionBatch, options: InterpretTurnOptions): IntentionBatch {
  return options.validatedInteractionAnswer === undefined
    ? batch
    : { ...batch, answerToInteraction: options.validatedInteractionAnswer };
}

function canonicalizeInteractionAnswer(batch: IntentionBatch, snapshot: ContextSnapshot): IntentionBatch {
  const interaction = snapshot.interaction;
  const answer = batch.answerToInteraction;
  if (
    interaction?.kind === "confirmation" &&
    answer !== undefined &&
    answer.interactionId !== interaction.id &&
    typeof answer.value === "boolean" &&
    interaction.capabilityId !== undefined &&
    (batch.intentions.length === 0 || batch.intentions.some((intention) =>
      intention.resolution === "resolved" && intention.proposedCapability === interaction.capabilityId))
  ) {
    return {
      ...batch,
      answerToInteraction: { ...answer, interactionId: interaction.id },
    };
  }
  if (
    interaction?.kind !== "choice" ||
    interaction.options === undefined
  ) return batch;

  // A model may reconstruct the container ID incorrectly while referring to one
  // exact current option. Recover only from that server-owned option, never from
  // an ordinal against a different interaction or the capability alone.
  const option = exactStructuredValueOption(answer?.value, interaction.options)
    ?? selectedInteractionOption(batch, answer?.value, interaction.options);
  if (option === undefined) {
    return batch;
  }
  return {
    ...batch,
    answerToInteraction: {
      interactionId: interaction.id,
      value: structuredClone(option.value),
      evidence: answer?.evidence ?? uniqueReferencedOptionEvidence(batch, option.id) ?? snapshot.currentMessage.content,
      ...(answer?.rationale === undefined ? {} : { rationale: answer.rationale }),
    },
  };
}

function exactStructuredValueOption(
  answerValue: unknown,
  options: readonly InteractionOption[],
): InteractionOption | undefined {
  if (answerValue === undefined) return undefined;
  const matching = options.filter((option) => sameStructuredValue(option.value, answerValue));
  return matching.length === 1 ? matching[0] : undefined;
}

function uniqueReferencedOptionEvidence(batch: IntentionBatch, optionId: string): string | undefined {
  const matching = batch.intentions.filter((intention) => intention.resolution === "resolved")
    .flatMap((intention) => intention.references)
    .filter((reference) => reference.target === optionId);
  return matching.length === 1 ? matching[0]?.evidence : undefined;
}

function selectedInteractionOption(
  batch: IntentionBatch,
  answerValue: unknown,
  options: readonly InteractionOption[],
): InteractionOption | undefined {
  const requestedOptionId = typeof answerValue === "string"
    ? answerValue
    : typeof answerValue === "object" && answerValue !== null &&
      typeof (answerValue as Record<string, unknown>)["optionId"] === "string"
      ? (answerValue as Record<string, unknown>)["optionId"] as string
      : undefined;
  // A mentioned candidate is not a commitment when interpretation explicitly
  // leaves the request unresolved, including after removing an unsafe answer.
  const referencedOptionIds = batch.intentions.filter((intention) => intention.resolution === "resolved").flatMap((intention) =>
    intention.references.map((reference) => reference.target))
    .filter((target) => options.some((option) => option.id === target))
    .filter((target, index, values) => values.indexOf(target) === index);
  const candidates = requestedOptionId === undefined
    ? referencedOptionIds
    : [requestedOptionId, ...referencedOptionIds.filter((target) => target !== requestedOptionId)];
  if (candidates.length !== 1) return undefined;
  return options.find((option) => option.id === candidates[0]);
}

async function validatedInterpretationIssues(
  batch: IntentionBatch,
  selection: CapabilitySelection,
  options: InterpretTurnOptions,
  progressionExitAlreadyRejected = false,
) {
  const interaction = options.snapshot.interaction;
  const answer = batch.answerToInteraction;
  // Resolve consent before using the single repair to fill a member operation.
  // A supported answer still reaches the unchanged missing-intention boundary.
  if (selection.mode === "selected" && batch.intentions.length === 0 &&
    interaction?.kind === "choice" && isProgressionGroup(interaction.payload) &&
    answer?.interactionId === interaction.id && interaction.options?.some(option =>
      typeof option.value === "object" && option.value !== null &&
      (option.value as Record<string, unknown>)["kind"] === "progression.member" &&
      sameStructuredValue(option.value, answer.value))) {
    const emptyMemberIssues = await reviewChoiceAnswer({
      batch, snapshot: options.snapshot, gateway: options.gateway, signal: options.signal,
      ...(options.validatedInteractionAnswer === undefined ? {} : { validatedInteractionAnswer: options.validatedInteractionAnswer }),
    });
    if (emptyMemberIssues.length > 0) return emptyMemberIssues;
  }
  const boundaryIssues = interpretationBoundaryIssues(batch, selection, options.snapshot);
  if (boundaryIssues.length > 0) return boundaryIssues;
  const inputIssues = options.compiled === undefined ? [] : await reviewOperationInputs({
    batch, compiled: options.compiled, snapshot: options.snapshot,
  });
  if (inputIssues.length > 0) return inputIssues;
  // Reusing this same-turn semantic rejection avoids asking the inverse
  // question again after repair correctly removes the unsupported answer.
  const omittedAnswerIssues = progressionExitAlreadyRejected ? [] : await reviewOmittedProgressionAnswer({
    batch, snapshot: options.snapshot, gateway: options.gateway, signal: options.signal,
  });
  if (omittedAnswerIssues.length > 0) return omittedAnswerIssues;
  const omittedChoiceIssues = await reviewOmittedChoiceAnswer({
    batch, snapshot: options.snapshot, gateway: options.gateway, signal: options.signal,
  });
  if (omittedChoiceIssues.length > 0) return omittedChoiceIssues;
  const memberOperationIssues = await reviewProgressionMemberOperation({
    batch, snapshot: options.snapshot, gateway: options.gateway, signal: options.signal,
  });
  if (memberOperationIssues.length > 0) return memberOperationIssues;
  const interactionIssues = await reviewInteractionAnswer({
    batch,
    snapshot: options.snapshot,
    gateway: options.gateway,
    signal: options.signal,
  });
  if (interactionIssues.length > 0) return interactionIssues;
  const confirmationIntentionIssues = await reviewConfirmationIntentions({
    batch, snapshot: options.snapshot, gateway: options.gateway, signal: options.signal,
  });
  if (confirmationIntentionIssues.length > 0) return confirmationIntentionIssues;
  const choiceIssues = await reviewChoiceAnswer({
    batch, snapshot: options.snapshot, gateway: options.gateway, signal: options.signal,
    ...(options.validatedInteractionAnswer === undefined ? {} : { validatedInteractionAnswer: options.validatedInteractionAnswer }),
  });
  if (choiceIssues.length > 0) return choiceIssues;
  const choiceIntentionIssues = await reviewChoiceIntentions({
    batch, selection, snapshot: options.snapshot, gateway: options.gateway, signal: options.signal,
  });
  if (choiceIntentionIssues.length > 0) return choiceIntentionIssues;
  return reviewLifecycleActions({
    batch,
    selection,
    snapshot: options.snapshot,
    gateway: options.gateway,
    signal: options.signal,
  });
}

function interpretationBoundaryIssues(
  batch: IntentionBatch,
  selection: CapabilitySelection,
  snapshot: ContextSnapshot,
): readonly Readonly<{ message: string; path: readonly (string | number)[] }>[] {
  const answerOwner = interactionAnswerOwner(batch, snapshot);
  const collectionOwner = resolveInteractionAnswerOwner(snapshot, batch.answerToInteraction);
  const resumesPendingInput = collectionOwner?.pending !== undefined;
  const answersConfirmation = snapshot.interaction?.kind === "confirmation" &&
    batch.answerToInteraction?.interactionId === snapshot.interaction.id &&
    typeof batch.answerToInteraction.value === "boolean";
  const answersProgression = snapshot.interaction?.kind === "choice" &&
    batch.answerToInteraction?.interactionId === snapshot.interaction.id &&
    typeof snapshot.interaction.payload === "object" && snapshot.interaction.payload !== null &&
    (snapshot.interaction.payload as Record<string, unknown>)["kind"] === "progression.group" &&
    typeof batch.answerToInteraction.value === "object" && batch.answerToInteraction.value !== null &&
    (batch.answerToInteraction.value as Record<string, unknown>)["kind"] === "progression.continue";
  const emptySelectionIssues = selection.mode === "conversational" && batch.intentions.some((intention) =>
    answerOwner === undefined || intention.resolution !== "resolved" || intention.proposedCapability !== answerOwner)
    ? [{
        message: "No independent capability operation was selected. Only the owner of a valid active interaction answer may be invoked; otherwise return empty intentions.",
        path: ["intentions"],
      }]
    : selection.mode === "selected" && batch.intentions.length === 0 && !answersConfirmation && !answersProgression && !resumesPendingInput
    ? [{
        message: snapshot.interaction?.kind === "confirmation"
          ? "The proposal omits an answer or independently requested operation for the active confirmation. Re-evaluate the complete current message against that exact confirmation: if it unambiguously accepts or rejects, return answerToInteraction with the exact active interaction ID and the supported boolean value. A pure acceptance OR rejection is valid with empty intentions; the kernel resumes or rejects the already-owned operation. Do not add a duplicate intention to satisfy capability selection. Preserve separately explicit additional requests. If the message does not actually answer the confirmation, do not invent consent or rejection; retain only operations independently supported by the current message."
          : "A selected capability set requires at least one interpreted intention.",
        path: ["intentions"],
      }]
    : selection.mode === "selected_with_control" &&
        batch.intentions.length === 0 &&
        !resumesPendingInput &&
        (batch.lifecycleActions?.length ?? 0) === 0
      ? [{
          message: "A selected-with-control capability set requires an intention or a lifecycle action.",
          path: ["intentions"],
        }]
      : [];
  const selected = new Set(selection.capabilityIds);
  const interaction = snapshot.interaction;
  const answer = batch.answerToInteraction;
  const answerIssues = answer === undefined ? []
    : interaction === undefined || answer.interactionId !== interaction.id
      ? [{ message: "An interaction answer must target the exact active interaction ID.", path: ["answerToInteraction", "interactionId"] }]
      : interaction.kind === "choice" && !interaction.options?.some((option) => sameStructuredValue(option.value, answer.value))
        ? [{ message: "The answer does not identify one active option. Copy exactly one server-owned option ID or its exact value. If the user's words are ambiguous, omit answerToInteraction; do not invent a selection.", path: ["answerToInteraction", "value"] }]
        : [];
  if ((selection.mode === "conversational" || collectionOwner !== undefined) && !answersConfirmation &&
    !resumesPendingInput && answerOwner !== undefined && !batch.intentions.some((intention) =>
    intention.resolution === "resolved" && intention.proposedCapability === answerOwner)) {
    answerIssues.push({
      message: `This interaction answer must be processed by ${answerOwner}. Include its resolved intention using the supplied contract and actual message/context evidence; preserve independently requested operations. An answer alone or an unrelated operation must not discard the selected operation. Do not fabricate input or borrow another pending operation's authority.`,
      path: ["intentions"],
    });
  }
  const capabilityIssues = batch.intentions.flatMap((intention, index) => {
    if (intention.resolution !== "resolved" || intention.proposedCapability === undefined) return [];
    return selected.has(intention.proposedCapability)
      ? []
      : [{
          message: "Resolved intention proposed a capability outside the selected contract set.",
          path: ["intentions", index, "proposedCapability"],
        }];
  });
  const optionIds = snapshot.interaction?.options?.map((option) => option.id) ?? [];
  const referenceIssues = batch.intentions.flatMap((intention, intentionIndex) =>
    intention.references.flatMap((reference, referenceIndex) => {
      const embeddedOptionIds = optionIds.filter((optionId) => reference.target.includes(optionId));
      if (embeddedOptionIds.length === 0 || (embeddedOptionIds.length === 1 && reference.target === embeddedOptionIds[0])) {
        return [];
      }
      return [{
        message: "A context reference must identify exactly one active option; emit one reference per target.",
        path: ["intentions", intentionIndex, "references", referenceIndex, "target"],
      }];
    }),
  );
  const requirementIssues = batch.intentions.flatMap((intention, intentionIndex) => {
    if (intention.resolution !== "resolved" || intention.proposedCapability === undefined) return [];
    const requirement = snapshot.capabilities.find(({ id }) => id === intention.proposedCapability)
      ?.referenceRequirements;
    if (requirement === undefined) return [];
    const targets = intention.references.map((reference) => reference.target);
    if (
      targets.length < requirement.minimum ||
      targets.length > requirement.maximum ||
      new Set(targets).size !== targets.length ||
      targets.some((target) => !optionIds.includes(target))
    ) {
      return [{
        message: `Capability requires ${String(requirement.minimum)} to ${String(requirement.maximum)} distinct active option references.`,
        path: ["intentions", intentionIndex, "references"],
      }];
    }
    return [];
  });
  const agendaIds = new Set(snapshot.agenda.map((item) => item.id));
  const objectiveId = snapshot.progression?.objective?.id;
  const seenTargets = new Set<string>();
  const lifecycleActionIssues = (batch.lifecycleActions ?? []).flatMap((action, actionIndex) => {
    const validTarget = action.kind === "cancel_agenda_item"
      ? agendaIds.has(action.targetId)
      : action.targetId === objectiveId;
    if (!validTarget) {
      return [{
        message: "A lifecycle cancellation must target an exact pending agenda item or configured objective identifier.",
        path: ["lifecycleActions", actionIndex, "targetId"],
      }];
    }
    const targetKey = `${action.kind}:${action.targetId}`;
    if (seenTargets.has(targetKey)) {
      return [{
        message: "A lifecycle target may be cancelled only once per turn.",
        path: ["lifecycleActions", actionIndex, "targetId"],
      }];
    }
    seenTargets.add(targetKey);
    return [];
  });
  const lifecycleControlAuthorized = selection.mode === "control" || selection.mode === "selected_with_control";
  const lifecycleActionCount = batch.lifecycleActions?.length ?? 0;
  const controlIssues = selection.mode === "control" && lifecycleActionCount === 0
    ? [{ message: "Control-only selection requires at least one valid lifecycle action.", path: ["lifecycleActions"] }]
    : !lifecycleControlAuthorized && lifecycleActionCount > 0
      ? [{ message: "Capability selection did not authorize lifecycle cancellation. Remove lifecycleActions and preserve the selected capability operation.", path: ["lifecycleActions"] }]
      : [];
  const progressionContinuationIssues = requiredProgressionContinuationIssues(batch, snapshot);
  return [
    ...emptySelectionIssues,
    ...answerIssues,
    ...capabilityIssues,
    ...referenceIssues,
    ...requirementIssues,
    ...lifecycleActionIssues,
    ...controlIssues,
    ...progressionContinuationIssues,
  ];
}

function interactionAnswerOwner(batch: IntentionBatch, snapshot: ContextSnapshot): string | undefined {
  const interaction = snapshot.interaction;
  const answer = batch.answerToInteraction;
  if (interaction === undefined || answer?.interactionId !== interaction.id) return undefined;
  if (interaction.kind !== "choice") return interaction.capabilityId;
  const option = interaction.options?.find((candidate) => sameStructuredValue(candidate.value, answer.value));
  return option === undefined ? undefined : option.targetCapabilityId ?? interaction.capabilityId;
}

function requiredProgressionContinuationIssues(
  batch: IntentionBatch,
  snapshot: ContextSnapshot,
): readonly Readonly<{ message: string; path: readonly (string | number)[] }>[] {
  const interaction = snapshot.interaction;
  if (
    interaction?.kind !== "choice" ||
    !isProgressionGroup(interaction.payload) ||
    interaction.options === undefined
  ) return [];

  const requestedCapabilities = new Set(batch.intentions.flatMap((intention) =>
    intention.resolution === "resolved" && intention.proposedCapability !== undefined
      ? [intention.proposedCapability]
      : []));
  const requiredCapabilities = new Set(snapshot.selectedModelGuidancePolicies.flatMap((policy) =>
    policy.continueProgressionForCapabilities ?? []));
  const matchedCapabilities = [...requestedCapabilities]
    .filter((capabilityId) => requiredCapabilities.has(capabilityId));
  if (matchedCapabilities.length === 0) return [];

  const continuation = interaction.options.find((option) => isProgressionContinuation(option.value));
  if (continuation === undefined) {
    return [{
      message: "Selected model guidance requires progression continuation, but the active interaction exposes no progression.continue option.",
      path: ["answerToInteraction"],
    }];
  }
  if (
    batch.answerToInteraction?.interactionId === interaction.id &&
    sameStructuredValue(batch.answerToInteraction.value, continuation.value)
  ) return [];

  return [{
    message: `Resolved capability ${matchedCapabilities.join(", ")} requires answering active progression interaction ${interaction.id} with server-owned option ID ${continuation.id}; retain the capability intention and set answerToInteraction to that exact option.`,
    path: ["answerToInteraction"],
  }];
}

function isProgressionGroup(value: unknown): value is Readonly<{ kind: "progression.group" }> {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)["kind"] === "progression.group";
}

function isProgressionContinuation(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)["kind"] === "progression.continue";
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
