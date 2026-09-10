import { isDeepStrictEqual } from "node:util";
import { resolveInteractionAnswerOwner } from "../context/resolveInteractionAnswerOwner.js";
import { bindDeferredChoiceAnswer, readDeferredChoiceAnswer, withDeferredChoiceAnswer, type DeferredChoiceAnswer } from "../context/deferredChoiceAnswer.js";

import type { CompiledAgentDefinition } from "../compiler/compileAgentDefinition.js";
import type { FactRequirement } from "../contracts/facts.js";
import type { CapabilityId, InteractionId, StepId } from "../contracts/ids.js";
import type { IntentionBatch, IntentionRequest } from "../contracts/intention.js";
import type { Interaction } from "../contracts/interaction.js";
import type { PlanReason, PlanStep, TurnPlan } from "../contracts/plan.js";
import type { KernelIdGenerator } from "../contracts/runtime.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import { deepFreeze } from "../context/deepFreeze.js";
import { evaluatePolicies } from "./evaluatePolicies.js";
import { resolveDependencies } from "./resolveDependencies.js";
import { selectInteraction, type InteractionCandidate } from "./selectInteraction.js";

/** Inputs required to validate and plan one interpreted intention batch. */
export interface CreateTurnPlanOptions {
  readonly batch: IntentionBatch;
  readonly snapshot: ContextSnapshot;
  readonly compiled: CompiledAgentDefinition;
  readonly ids: KernelIdGenerator;
}

interface DraftStep {
  readonly intention: IntentionRequest;
  readonly stepId: StepId;
  capabilityId?: CapabilityId;
  input?: unknown;
  continuation?: unknown;
  modelRedactions?: readonly string[];
  interactionAnswer?: IntentionBatch["answerToInteraction"];
  deferredChoiceAnswer?: DeferredChoiceAnswer;
  dependsOn: readonly StepId[];
  missingFacts: readonly FactRequirement[];
  disposition: PlanStep["disposition"];
  reason: PlanReason;
  interaction?: InteractionCandidate;
  effect?: "none" | "read" | "write";
}

/** Validate model proposals and build an executable DAG without mutating state. */
export async function createTurnPlan(options: CreateTurnPlanOptions): Promise<TurnPlan> {
  const resumed = resumeConfirmedIntention(options);
  const confirmedIntentions = mergeConfirmedIntention(
    resumed,
    options.batch.intentions,
    options.batch.answerToInteraction,
  );
  const intentions = mergePendingInputAnswer(options, confirmedIntentions);
  const answerTargetCapability = resolveAnswerTargetCapability(options, intentions);
  const drafts: DraftStep[] = intentions.map((intention) => ({
    intention,
    stepId: options.ids.next("step") as StepId,
    dependsOn: [],
    missingFacts: [],
    disposition: "reject",
    reason: reason("UNASSESSED", "The intention has not been assessed yet.", intention),
  }));

  const stepByCapability = new Map<CapabilityId, StepId>();
  const runtimeStepByCapability = new Map<CapabilityId, StepId>();
  for (const draft of drafts) {
    if (draft.intention.resolution === "resolved" && draft.intention.proposedCapability !== undefined) {
      stepByCapability.set(draft.intention.proposedCapability, draft.stepId);
      // An input answer can resume its collector without independently asking
      // for that collector's output. Do not force an optional dependency onto
      // a separate explicit operation merely because this continuation exists.
      if (confirmedIntentions.includes(draft.intention)) {
        runtimeStepByCapability.set(draft.intention.proposedCapability, draft.stepId);
      }
    }
  }

  for (const [index, draft] of drafts.entries()) {
    const intention = draft.intention;
    if (intention.resolution === "ambiguous") {
      draft.disposition = "clarify";
      draft.reason = reason("AMBIGUOUS_INTENTION", "The user request has more than one supported interpretation.", intention);
      draft.interaction = {
        priority: 100,
        order: index,
        interaction: interaction(options.ids, "clarification", intention.objective, [], undefined,
          (intention.alternatives ?? []).map((alternative, optionIndex) => ({
            id: `alternative-${String(optionIndex + 1)}`,
            label: alternative,
            value: alternative,
          }))),
      };
      continue;
    }
    if (intention.resolution === "unsupported" || intention.proposedCapability === undefined) {
      draft.disposition = "reject";
      draft.reason = reason("UNSUPPORTED_INTENTION", "No registered capability represents this request.", intention);
      continue;
    }

    const capability = options.compiled.capabilities.get(intention.proposedCapability);
    if (capability === undefined) {
      draft.disposition = "reject";
      draft.capabilityId = intention.proposedCapability;
      draft.reason = reason("CAPABILITY_NOT_REGISTERED", "The proposed capability is not registered for this agent.", intention);
      continue;
    }
    draft.capabilityId = capability.id;
    draft.effect = capability.effect;
    const pending = findPendingAgendaItem(options, capability.id);
    if (pending?.continuation !== undefined) draft.continuation = pending.continuation;
    if (pending?.modelRedactions !== undefined) draft.modelRedactions = pending.modelRedactions;
    if (answerTargetCapability === capability.id && options.batch.answerToInteraction !== undefined) {
      draft.interactionAnswer = options.batch.answerToInteraction;
      const binding = bindDeferredChoiceAnswer(capability.id, options.snapshot.interaction, draft.interactionAnswer);
      if (binding !== undefined) draft.deferredChoiceAnswer = binding;
    } else if (pending?.status === "waiting_facts" && pending.intention.id === intention.id) {
      const stored = readDeferredChoiceAnswer(pending);
      const active = options.snapshot.interaction;
      // Only resume the same suspended intention. A fresh interaction owned by
      // this capability supersedes its unconsumed historical answer.
      const binding = stored === undefined || (active?.capabilityId === capability.id &&
        !isDeepStrictEqual(active, stored.interaction)) ? undefined
        : bindDeferredChoiceAnswer(capability.id, stored.interaction, stored.answer);
      if (binding !== undefined) {
        draft.interactionAnswer = binding.answer;
        draft.deferredChoiceAnswer = binding;
      }
    }

    if (resumed?.accepted === false && resumed.intention.id === intention.id) {
      draft.input = intention.input;
      draft.disposition = "reject";
      draft.reason = reason("CONFIRMATION_DECLINED", "The user declined the pending effect.", intention);
      continue;
    }

    const validatedInput = await capability.input.validate(intention.input);
    if (!validatedInput.ok) {
      draft.disposition = "clarify";
      draft.input = intention.input;
      draft.reason = reason("INVALID_CAPABILITY_INPUT", "The proposed input does not satisfy the capability contract.", intention);
      draft.interaction = {
        priority: 80,
        order: index,
        interaction: interaction(options.ids, "clarification", `Clarify the information required to ${intention.objective}.`, [], capability.id, undefined, {
          issues: validatedInput.issues,
          proposedInput: intention.input,
        }),
      };
      continue;
    }
    draft.input = validatedInput.value;

    const policy = await evaluatePolicies(options.compiled.definition.policies, {
      capabilityId: capability.id,
      capability,
      intention,
      input: validatedInput.value,
      snapshot: options.snapshot,
    });
    if (policy.verdict === "deny") {
      draft.disposition = "reject";
      draft.reason = reason("POLICY_DENIED", policy.reason, intention);
      continue;
    }
    if (policy.verdict === "clarify") {
      draft.disposition = "clarify";
      draft.reason = reason("POLICY_REQUIRES_CLARIFICATION", "A host policy requires clarification.", intention);
      draft.interaction = { priority: 90, order: index, interaction: policy.interaction };
      continue;
    }

    const dependencies = resolveDependencies({
      capability,
      currentFacts: options.snapshot.facts,
      dependencyGraph: options.compiled.dependencyGraph,
      stepByCapability,
      runtimeStepByCapability,
    });
    draft.dependsOn = dependencies.dependsOn;
    draft.missingFacts = dependencies.missingFacts;
    if (dependencies.missingFacts.length > 0) {
      draft.disposition = "defer";
      draft.reason = reason("MISSING_REQUIRED_FACTS", "Required facts are not available yet.", intention);
      draft.interaction = {
        priority: 70,
        order: index,
        interaction: interaction(
          options.ids,
          "input",
          `Gather the prerequisites needed to ${intention.objective}.`,
          dependencies.missingFacts.map((requirement) => requirement.type),
          capability.id,
        ),
      };
      continue;
    }

    if (!(resumed?.accepted === true && resumed.intention.id === intention.id) &&
      (policy.verdict === "confirm" || capability.confirmation === "required")) {
      draft.disposition = "defer";
      draft.reason = reason("CONFIRMATION_REQUIRED", policy.verdict === "confirm" ? policy.reason : "Explicit confirmation is required before this effect.", intention);
      draft.interaction = {
        priority: 60,
        order: index,
        interaction: interaction(options.ids, "confirmation", `Confirm before I ${intention.objective}.`, [], capability.id, undefined, {
          intention,
          input: validatedInput.value,
        }),
      };
      continue;
    }

    draft.disposition = "execute";
    draft.reason = resumed?.accepted === true && resumed.intention.id === intention.id
      ? reason("CONFIRMATION_ACCEPTED", "The active interaction explicitly confirmed this effect.", intention)
      : reason("READY", "Capability, input, policy and prerequisites are valid.", intention);
  }

  const eligibleWrites = drafts.filter((draft) =>
    draft.effect === "write" && (draft.disposition === "execute" || draft.reason.code === "CONFIRMATION_REQUIRED"),
  );
  if (eligibleWrites.length > 1 && hasUnorderedPair(eligibleWrites)) {
    for (const draft of eligibleWrites) {
      draft.disposition = "clarify";
      draft.reason = reason("WRITE_CONFLICT", "Multiple unrelated writes require an explicit execution choice.", draft.intention);
      delete draft.interaction;
    }
    const firstWrite = eligibleWrites[0];
    if (firstWrite === undefined) throw new Error("Expected at least one eligible write.");
    const firstWriteIndex = drafts.indexOf(firstWrite);
    firstWrite.interaction = {
      priority: 110,
      order: firstWriteIndex,
      interaction: interaction(
        options.ids,
        "choice",
        "Choose which state-changing operation to perform first.",
        [],
        undefined,
        eligibleWrites.map((draft, index) => ({
          id: `write-${String(index + 1)}`,
          label: draft.intention.objective,
          value: draft.intention.id,
        })),
      ),
    };
  }

  const steps: PlanStep[] = drafts.map((draft) => withDeferredChoiceAnswer({
    id: draft.stepId,
    intentionId: draft.intention.id,
    intention: draft.intention,
    ...(draft.capabilityId === undefined ? {} : { capabilityId: draft.capabilityId }),
    ...(draft.input === undefined ? {} : { input: draft.input }),
    ...(draft.continuation === undefined ? {} : { continuation: draft.continuation }),
    ...(draft.modelRedactions === undefined ? {} : { modelRedactions: draft.modelRedactions }),
    ...(draft.interactionAnswer === undefined ? {} : { interactionAnswer: draft.interactionAnswer }),
    dependsOn: draft.dependsOn,
    missingFacts: draft.missingFacts,
    disposition: draft.disposition,
    reason: draft.reason,
  }, draft.deferredChoiceAnswer));
  const primaryInteraction = selectInteraction(drafts.flatMap((draft) => draft.interaction === undefined ? [] : [draft.interaction]));
  const selectedProgressionAction = progressionAction(options.batch.answerToInteraction);
  const cancelledAgendaItemIds = (options.batch.lifecycleActions ?? [])
    .filter((action) => action.kind === "cancel_agenda_item")
    .map((action) => action.targetId)
    .filter((id, index, values) => values.indexOf(id) === index &&
      options.snapshot.agenda.some((item) => item.id === id));
  const cancelledObjectiveIds = (options.batch.lifecycleActions ?? [])
    .filter((action) => action.kind === "cancel_objective")
    .map((action) => action.targetId)
    .filter((id, index, values) => values.indexOf(id) === index &&
      options.snapshot.progression?.objective?.id === id);
  const cancelledObjectives = options.snapshot.agenda
    .filter((item) => cancelledAgendaItemIds.includes(item.id))
    .map((item) => item.intention.objective);
  const cancelledPrimaryObjectives = cancelledObjectiveIds.map((id) => `configured objective ${id}`);
  const plan: TurnPlan = {
    steps,
    ...(primaryInteraction === undefined ? {} : { interaction: primaryInteraction }),
    ...(options.batch.answerToInteraction === undefined || options.snapshot.interaction?.capabilityId === undefined
      ? {}
      : { answeredInteractionCapabilityId: options.snapshot.interaction.capabilityId }),
    responseGoal: primaryInteraction?.goal ??
      ([...intentions.map((intention) => intention.objective),
        ...cancelledObjectives.map((objective) => `Acknowledge that this pending operation was cancelled: ${objective}`),
        ...cancelledPrimaryObjectives.map((objective) => `Acknowledge that the complete ${objective} was cancelled`)]
        .join("; ") ||
        (options.snapshot.interaction === undefined
          ? "Respond naturally to the conversational message using only the configured agent identity and capabilities."
          : "Continue the active interaction.")),
    ...(selectedProgressionAction === undefined ? {} : { progressionAction: selectedProgressionAction }),
    ...(cancelledAgendaItemIds.length === 0 ? {} : { cancelledAgendaItemIds }),
    ...(cancelledObjectiveIds.length === 0 ? {} : { cancelledObjectiveIds }),
  };
  return deepFreeze(structuredClone(plan));
}

function progressionAction(answer: IntentionBatch["answerToInteraction"]): TurnPlan["progressionAction"] {
  if (answer === undefined || typeof answer.value !== "object" || answer.value === null) return undefined;
  const value = answer.value as Record<string, unknown>;
  if (value["kind"] === "progression.continue" && typeof value["occurrenceId"] === "string") {
    return { kind: "continue", occurrenceId: value["occurrenceId"] };
  }
  if (
    value["kind"] === "progression.member" &&
    typeof value["occurrenceId"] === "string" &&
    typeof value["capabilityId"] === "string"
  ) {
    return {
      kind: "member",
      occurrenceId: value["occurrenceId"],
      capabilityId: value["capabilityId"] as CapabilityId,
    };
  }
  return undefined;
}

function resolveAnswerTargetCapability(
  options: CreateTurnPlanOptions,
  intentions: readonly IntentionRequest[],
): CapabilityId | undefined {
  if (options.batch.answerToInteraction === undefined || options.snapshot.interaction === undefined) return undefined;
  const capabilities = intentions.flatMap((intention) =>
    intention.resolution === "resolved" && intention.proposedCapability !== undefined
      ? [intention.proposedCapability]
      : [],
  );
  const collectionOwner = resolveInteractionAnswerOwner(options.snapshot, options.batch.answerToInteraction);
  if (collectionOwner !== undefined) {
    // A missing selected operation never transfers its answer to a companion.
    return capabilities.includes(collectionOwner.capabilityId) ? collectionOwner.capabilityId : undefined;
  }
  const selectedTargets = selectedAnswerTargetCapabilities(
    options.snapshot.interaction,
    options.batch.answerToInteraction.value,
  );
  if (selectedTargets.length === 1 && capabilities.includes(selectedTargets[0] as CapabilityId)) {
    return selectedTargets[0];
  }
  const owner = options.snapshot.interaction.capabilityId;
  if (owner !== undefined && capabilities.includes(owner)) return owner;
  return capabilities.length === 1 ? capabilities[0] : undefined;
}

function findPendingAgendaItem(options: CreateTurnPlanOptions, capabilityId: CapabilityId) {
  const items = options.snapshot.agenda.filter((item) => item.intention.proposedCapability === capabilityId);
  return items.at(-1);
}

function mergeConfirmedIntention(
  resumed: ReturnType<typeof resumeConfirmedIntention>,
  interpreted: readonly IntentionRequest[],
  answer: IntentionBatch["answerToInteraction"],
): IntentionRequest[] {
  if (resumed === undefined) return [...interpreted];
  const remaining = [...interpreted];
  const restatement = remaining.findIndex((candidate) =>
    candidate.resolution === "resolved" &&
    candidate.proposedCapability === resumed.intention.proposedCapability &&
    (isDeepStrictEqual(candidate.input, resumed.intention.input) ||
      isConfirmationRestatement(candidate, resumed.intention, answer)),
  );
  if (restatement >= 0) remaining.splice(restatement, 1);
  return [resumed.intention, ...remaining];
}

function isConfirmationRestatement(
  candidate: IntentionRequest,
  resumed: IntentionRequest,
  answer: IntentionBatch["answerToInteraction"],
): boolean {
  if (answer === undefined || candidate.objective !== resumed.objective || candidate.evidence.length === 0) {
    return false;
  }
  const answerEvidence = answer.evidence.trim();
  return answerEvidence.length > 0 && candidate.evidence.every((entry) => entry.text.trim() === answerEvidence);
}

function mergePendingInputAnswer(
  options: CreateTurnPlanOptions,
  interpreted: readonly IntentionRequest[],
): IntentionRequest[] {
  const answer = options.batch.answerToInteraction;
  const active = options.snapshot.interaction;
  if (
    answer === undefined ||
    active === undefined ||
    answer.interactionId !== active.id ||
    active.kind === "confirmation" ||
    active.capabilityId === undefined
  ) {
    return [...interpreted];
  }
  const [explicitTarget] = selectedAnswerTargetCapabilities(active, answer.value);
  if (active.kind === "choice" && explicitTarget !== undefined && explicitTarget !== active.capabilityId) {
    return [...interpreted];
  }
  const alreadyInterpreted = interpreted.some((candidate) =>
    candidate.resolution === "resolved" && candidate.proposedCapability === active.capabilityId,
  );
  if (alreadyInterpreted) return [...interpreted];
  const collectionOwner = resolveInteractionAnswerOwner(options.snapshot, answer);
  if (collectionOwner !== undefined) {
    return collectionOwner.pending === undefined ? [...interpreted] : [collectionOwner.pending.intention, ...interpreted];
  }
  const pending = findPendingAgendaItem(options, active.capabilityId);
  return pending === undefined ? [...interpreted] : [pending.intention, ...interpreted];
}

function selectedAnswerTargetCapabilities(interaction: Interaction, value: unknown): readonly CapabilityId[] {
  return [...new Set((interaction.options ?? [])
    .filter((option) => isDeepStrictEqual(option.value, value))
    .flatMap((option) => option.targetCapabilityId === undefined ? [] : [option.targetCapabilityId]))];
}

function resumeConfirmedIntention(options: CreateTurnPlanOptions): {
  readonly intention: IntentionRequest;
  readonly accepted: boolean;
} | undefined {
  const answer = options.batch.answerToInteraction;
  const active = options.snapshot.interaction;
  if (answer === undefined || active === undefined || answer.interactionId !== active.id || active.kind !== "confirmation") {
    return undefined;
  }
  if ((answer.value !== true && answer.value !== false) || typeof active.payload !== "object" || active.payload === null) return undefined;
  const payload = active.payload as Record<string, unknown>;
  const candidate = payload["intention"];
  const input = payload["input"];
  if (!isIntentionRequest(candidate)) return undefined;
  const intention: IntentionRequest = { ...candidate, input };
  return { intention, accepted: answer.value };
}

function isIntentionRequest(value: unknown): value is IntentionRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["id"] === "string" &&
    typeof candidate["objective"] === "string" &&
    Array.isArray(candidate["evidence"]) &&
    Array.isArray(candidate["references"]) &&
    (candidate["resolution"] === "resolved" || candidate["resolution"] === "ambiguous" || candidate["resolution"] === "unsupported");
}

function interaction(
  ids: KernelIdGenerator,
  kind: Interaction["kind"],
  goal: string,
  requestedFacts: Interaction["requestedFacts"],
  capabilityId?: CapabilityId,
  options?: Interaction["options"],
  payload?: unknown,
): Interaction {
  return {
    id: ids.next("interaction") as InteractionId,
    kind,
    ...(capabilityId === undefined ? {} : { capabilityId }),
    requestedFacts,
    goal,
    ...(options === undefined ? {} : { options }),
    ...(payload === undefined ? {} : { payload }),
  };
}

function reason(code: string, message: string, intention: IntentionRequest): PlanReason {
  return { code, message, evidence: intention.evidence.map((entry) => entry.text) };
}

function hasUnorderedPair(writes: readonly DraftStep[]): boolean {
  return writes.some((left, leftIndex) => writes.slice(leftIndex + 1).some((right) =>
    !left.dependsOn.includes(right.stepId) && !right.dependsOn.includes(left.stepId),
  ));
}
