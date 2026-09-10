import type { CompiledAgentDefinition } from "../compiler/compileAgentDefinition.js";
import { fingerprint } from "../compiler/fingerprint.js";
import type { KernelCheckpoint } from "../contracts/checkpoint.js";
import type { FactRecord } from "../contracts/facts.js";
import type { CapabilityId, InteractionId } from "../contracts/ids.js";
import type { Interaction } from "../contracts/interaction.js";
import type { TurnPlan, StepExecutionResult } from "../contracts/plan.js";
import type {
  CapabilityGroupDefinition,
  ProgressionOccurrence,
  ProgressionState,
} from "../contracts/progression.js";
import { deepFreeze } from "../context/deepFreeze.js";
import { waitsForOperationInput } from "../reducer/agendaInputState.js";
import { activeInteractionSuspension, suspendedInteraction, withoutSuspendedInteraction } from "../reducer/suspendedInteraction.js";
import { completionRevalidationFacts, factPublicationKey, reconcileCompletionLineage } from "./completionLineage.js";

/** Result of reconciling fact-triggered progression at a safe turn boundary. */
export interface ProgressionReconciliation {
  readonly checkpoint: KernelCheckpoint;
  readonly interactionRequested: boolean;
  readonly occurrenceId?: string;
  readonly activation?: Readonly<{
    readonly occurrenceId: string;
    readonly capabilityId: CapabilityId;
  }>;
}

/** Derive objective status, activation occurrences and the next bounded group interaction. */
export function reconcileProgression(options: {
  readonly checkpoint: KernelCheckpoint;
  readonly compiled: CompiledAgentDefinition;
  readonly plan?: TurnPlan;
  readonly results?: readonly StepExecutionResult[];
  /** Reducer-validated publications accumulated in this turn, independent of result settlement. */
  readonly turnPublications?: readonly FactRecord[];
  /** Exact reducer-retired publications; absence alone never reopens a completed operation. */
  readonly turnInvalidations?: readonly FactRecord[];
  /** Occurrences already attempted during the current turn. */
  readonly skippedActivationIds?: ReadonlySet<string>;
  /** Apply accepted actions and settled results without selecting new work while a dependency takes priority. */
  readonly deferActivation?: boolean;
}): ProgressionReconciliation {
  const definition = options.compiled.definition.progression;
  if (definition === undefined) return { checkpoint: options.checkpoint, interactionRequested: false };

  const previous = options.checkpoint.progression ?? { occurrences: [] };
  let occurrences = reconcileOccurrences(previous.occurrences, definition.rules, options.checkpoint.facts);
  occurrences = applyProgressionAction(
    occurrences,
    options.plan,
    options.results ?? [],
    definition.groups,
  );
  occurrences = reconcileCompletionLineage({ occurrences, checkpoint: options.checkpoint, compiled: options.compiled,
    results: options.results ?? [], invalidatedFacts: options.turnInvalidations ?? [] });
  const objective = definition.objective === undefined
    ? previous.objective
    : {
        id: definition.objective.id,
        status: hasFact(options.checkpoint.facts, definition.objective.completionFact)
          ? "completed" as const
          : previous.objective?.status === "cancelled"
            ? "cancelled" as const
            : "active" as const,
      };
  const state: ProgressionState = {
    ...(objective === undefined ? {} : { objective }),
    occurrences,
  };
  const reconciledCheckpoint = { ...options.checkpoint, progression: state };
  const suspended = options.checkpoint.agenda.flatMap(item => {
    const control = suspendedInteraction(item, reconciledCheckpoint, options.compiled);
    return control === undefined ? [] : [{ item, ...control }];
  }).sort((left, right) => left.priority - right.priority || left.item.id.localeCompare(right.item.id));
  const suspendedIds = new Set(suspended.map(entry => entry.item.id));
  let checkpoint: KernelCheckpoint = { ...reconciledCheckpoint, agenda: reconciledCheckpoint.agenda.map(item =>
    suspendedIds.has(item.id) ? item : withoutSuspendedInteraction(item)) };

  // Dismissing a displayed control does not answer its outstanding operation.
  // Explicit requests and ready dependencies are handled before this automatic
  // scheduler; do not recreate the old question through a later objective.
  const waitingForInput = options.checkpoint.interaction === undefined &&
    options.checkpoint.agenda.some(item => waitsForOperationInput(item) && !suspendedIds.has(item.id));
  if (objective?.status === "completed" || options.deferActivation === true || waitingForInput) {
    return frozenResult({
      checkpoint,
      interactionRequested: false,
    });
  }

  const restore = suspended[0];
  const active = activeInteractionSuspension(checkpoint, options.compiled);
  const boundary = active ?? restore;
  const candidate = [...occurrences]
    .filter((occurrence) => occurrence.status === "pending" && occurrence.mode === "required" &&
      !options.skippedActivationIds?.has(occurrence.id) &&
      (boundary === undefined || (occurrence.priority < boundary.priority &&
        "capabilityId" in occurrence.target && options.compiled.capabilities.get(occurrence.target.capabilityId)?.effect !== "write" &&
        hasFreshActivation({ ...occurrence, activationFacts: [...occurrence.activationFacts,
          ...completionRevalidationFacts(occurrence, checkpoint, options.compiled)] }, options.checkpoint.facts, options.results ?? [], options.turnPublications))))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))[0];
  if (checkpoint.interaction !== undefined && checkpoint.interaction.mode !== "optional") {
    if (active === undefined || candidate === undefined) return frozenResult({ checkpoint, interactionRequested: false });
    checkpoint = { ...withoutInteraction(checkpoint), agenda: active.agenda };
  }
  if (candidate === undefined && restore !== undefined) {
    return frozenResult({ checkpoint: { ...checkpoint, interaction: restore.interaction,
      agenda: checkpoint.agenda.map(item => item.id === restore.item.id ? withoutSuspendedInteraction(item) : item) },
      interactionRequested: true, occurrenceId: restore.occurrenceId });
  }
  if (candidate === undefined) {
    return frozenResult({
      checkpoint,
      interactionRequested: false,
    });
  }
  if ("capabilityId" in candidate.target) {
    const capabilityId = candidate.target.capabilityId;
    occurrences = occurrences.map((occurrence) => occurrence.id === candidate.id
      ? { ...occurrence, status: "active", activeMember: capabilityId }
      : occurrence);
    return frozenResult({
      checkpoint: {
        ...withoutInteraction(checkpoint),
        progression: { ...(objective === undefined ? {} : { objective }), occurrences },
      },
      interactionRequested: false,
      activation: { occurrenceId: candidate.id, capabilityId },
    });
  }
  const groupId = candidate.target.groupId;
  const group = definition.groups.find((entry) => entry.id === groupId);
  if (group === undefined) throw new TypeError("PROGRESSION_GROUP_NOT_COMPILED");
  const interaction = groupInteraction(candidate, group);
  occurrences = occurrences.map((occurrence) => occurrence.id === candidate.id
    ? { ...occurrence, presented: true }
    : occurrence);
  return frozenResult({
    checkpoint: {
      ...checkpoint,
      progression: { ...(objective === undefined ? {} : { objective }), occurrences },
      interaction,
    },
    interactionRequested: true,
    occurrenceId: candidate.id,
  });
}

function hasFreshActivation(occurrence: ProgressionOccurrence, facts: readonly FactRecord[], results: readonly StepExecutionResult[],
  turnPublications?: readonly FactRecord[]): boolean {
  return occurrence.activationFacts.some(reference => facts.some(fact => fact.type === reference.type &&
    fact.version === reference.version && publicationKey(fact) === reference.publication && (turnPublications === undefined ? results.some(result =>
      result.status === "invoked" && result.result.status === "completed" && result.stepId === fact.producedBy.stepId &&
      result.capabilityId === fact.producedBy.capabilityId && result.result.facts.some(publication =>
        publication.type === fact.type && publication.version === fact.version)) : turnPublications.some(publication =>
          publication.type === fact.type && publication.version === fact.version && publicationKey(publication) === reference.publication))));
}

function withoutInteraction(checkpoint: KernelCheckpoint): Omit<KernelCheckpoint, "interaction"> {
  const copy = { ...checkpoint } as { -readonly [Key in keyof KernelCheckpoint]: KernelCheckpoint[Key] };
  delete copy.interaction;
  return copy;
}

function applyProgressionAction(
  occurrences: readonly ProgressionOccurrence[],
  plan: TurnPlan | undefined,
  results: readonly StepExecutionResult[],
  groups: readonly CapabilityGroupDefinition[],
): readonly ProgressionOccurrence[] {
  const settled = occurrences.map((occurrence) => settleActiveOccurrence(occurrence, results, groups));
  const action = plan?.progressionAction;
  if (action === undefined) return settled;
  return settled.map((occurrence) => {
    if (occurrence.id !== action.occurrenceId || isTerminal(occurrence.status)) return occurrence;
    if (action.kind === "continue") {
      return {
        ...clearActiveMember(occurrence),
        status: occurrence.completedMembers.length > 0 ? "satisfied" as const : "declined" as const,
      };
    }
    if (action.kind === "automatic") {
      if (action.capabilityId === undefined || !("capabilityId" in occurrence.target) ||
        occurrence.target.capabilityId !== action.capabilityId) return occurrence;
      const result = results.find((candidate) => candidate.capabilityId === action.capabilityId);
      if (result?.status !== "invoked") return occurrence;
      if (result.result.status === "completed") {
        return { ...clearActiveMember(occurrence), status: "satisfied" };
      }
      if (result.result.status === "failed") {
        return settleFailedMember(occurrence, action.capabilityId, result.result.issue.retryable);
      }
      return occurrence;
    }
    if (action.capabilityId === undefined || !("groupId" in occurrence.target)) return occurrence;
    const groupId = occurrence.target.groupId;
    const group = groups.find((candidate) => candidate.id === groupId);
    if (group === undefined || !group.members.some((member) => member.capabilityId === action.capabilityId)) return occurrence;
    const result = results.find((candidate) => candidate.capabilityId === action.capabilityId);
    if (result?.status !== "invoked") return { ...occurrence, status: "active", activeMember: action.capabilityId };
    if (result.result.status === "completed") {
      return {
        ...clearActiveMember(occurrence),
        status: group.repeatAfterMember ? "pending" as const : "satisfied" as const,
        completedMembers: occurrence.completedMembers.includes(action.capabilityId)
          ? occurrence.completedMembers
          : [...occurrence.completedMembers, action.capabilityId],
      };
    }
    if (result.result.status === "failed") {
      return settleFailedMember(occurrence, action.capabilityId, result.result.issue.retryable);
    }
    return { ...occurrence, status: "active", activeMember: action.capabilityId };
  });
}

function settleActiveOccurrence(
  occurrence: ProgressionOccurrence,
  results: readonly StepExecutionResult[],
  groups: readonly CapabilityGroupDefinition[],
): ProgressionOccurrence {
  if (occurrence.status === "pending" && "capabilityId" in occurrence.target) {
    const capabilityId = occurrence.target.capabilityId;
    const completed = results.some((result) => result.capabilityId === capabilityId &&
      result.status === "invoked" && result.result.status === "completed");
    if (completed) return { ...clearActiveMember(occurrence), status: "satisfied" };
    const failed = results.find((result) => result.capabilityId === capabilityId &&
      result.status === "invoked" && result.result.status === "failed" && !result.result.issue.retryable);
    if (failed !== undefined) return settleFailedMember(occurrence, capabilityId, false);
  }
  if (occurrence.status !== "active" || occurrence.activeMember === undefined) return occurrence;
  const result = results.find((candidate) => candidate.capabilityId === occurrence.activeMember);
  if (result?.status !== "invoked") return occurrence;
  if (result.result.status === "failed") {
    return settleFailedMember(occurrence, occurrence.activeMember, result.result.issue.retryable);
  }
  if (result.result.status !== "completed") return occurrence;
  const { activeMember, ...rest } = occurrence;
  const target = occurrence.target;
  if ("capabilityId" in target) return { ...rest, status: "satisfied" };
  const group = groups.find((candidate) => candidate.id === target.groupId);
  if (group === undefined || !group.members.some((member) => member.capabilityId === activeMember)) return occurrence;
  return {
    ...rest,
    status: group.repeatAfterMember ? "pending" : "satisfied",
    completedMembers: occurrence.completedMembers.includes(activeMember)
      ? occurrence.completedMembers
      : [...occurrence.completedMembers, activeMember],
  };
}

function settleFailedMember(
  occurrence: ProgressionOccurrence,
  capabilityId: CapabilityId,
  retryable: boolean,
): ProgressionOccurrence {
  // The agenda retains this operation as blocked. Keep its occurrence bound to
  // that unresolved member instead of manufacturing fresh automatic consent.
  // A new activating fact publication or an explicit request remains separate.
  return retryable
    ? { ...clearActiveMember(occurrence), status: "pending" }
    : { ...occurrence, status: "active", activeMember: capabilityId };
}

function clearActiveMember(occurrence: ProgressionOccurrence): ProgressionOccurrence {
  const next = { ...occurrence };
  delete next.activeMember;
  return next;
}

function reconcileOccurrences(
  previous: readonly ProgressionOccurrence[],
  rules: NonNullable<CompiledAgentDefinition["definition"]["progression"]>["rules"],
  facts: readonly FactRecord[],
): readonly ProgressionOccurrence[] {
  const next = previous.map((occurrence) => ({ ...occurrence }));
  for (const rule of rules) {
    const activationFacts = rule.activateWhen.map((reference) => {
      const fact = facts.find((candidate) => candidate.type === reference.type && candidate.version === reference.version);
      return fact === undefined ? null : {
        type: fact.type,
        version: fact.version,
        publication: publicationKey(fact),
      };
    });
    const resolvedActivationFacts = activationFacts.filter(
      (fact): fact is ProgressionOccurrence["activationFacts"][number] => fact !== null,
    );
    const active = resolvedActivationFacts.length === activationFacts.length;
    const currentId = active ? occurrenceId(rule.id, resolvedActivationFacts) : null;
    for (let index = 0; index < next.length; index += 1) {
      const occurrence = next[index];
      if (occurrence?.ruleId !== rule.id || isTerminal(occurrence.status)) continue;
      if (currentId === null || occurrence.id !== currentId) next[index] = { ...occurrence, status: "superseded" };
    }
    if (currentId === null || next.some((occurrence) => occurrence.id === currentId)) continue;
    next.push({
      id: currentId,
      ruleId: rule.id,
      target: rule.target,
      mode: rule.mode,
      priority: rule.priority,
      activationFacts: resolvedActivationFacts,
      status: "pending",
      presented: false,
      completedMembers: [],
    });
  }
  return Object.freeze(next.map((occurrence) => Object.freeze({
    ...occurrence,
    activationFacts: Object.freeze(occurrence.activationFacts.map((fact) => Object.freeze({ ...fact }))),
    completedMembers: Object.freeze([...occurrence.completedMembers]),
  })));
}

function groupInteraction(
  occurrence: ProgressionOccurrence,
  group: CapabilityGroupDefinition,
): Interaction {
  const hidden = group.completedMemberVisibility === "hide" ? new Set(occurrence.completedMembers) : new Set<CapabilityId>();
  const prompt = occurrence.presented && group.repeatPrompt !== undefined ? group.repeatPrompt : group.prompt;
  return {
    id: `progression:${occurrence.id}` as InteractionId,
    kind: "choice",
    requestedFacts: [],
    goal: prompt,
    options: [
      ...group.members
        .filter((member) => !hidden.has(member.capabilityId))
        .map((member) => ({
          id: `progression:${occurrence.id}:${member.capabilityId}`,
          label: member.label,
          targetCapabilityId: member.capabilityId,
          value: {
            kind: "progression.member",
            occurrenceId: occurrence.id,
            capabilityId: member.capabilityId,
          },
        })),
      {
        id: `progression:${occurrence.id}:continue`,
        label: group.continueLabel,
        value: { kind: "progression.continue", occurrenceId: occurrence.id },
      },
    ],
    payload: {
      kind: "progression.group",
      occurrenceId: occurrence.id,
      groupId: group.id,
      groupLabel: group.label,
      memberExamples: group.members.map((member) => ({
        capabilityId: member.capabilityId,
        examples: member.examples,
      })),
      continueExamples: group.continueExamples ?? [],
    },
  };
}

function hasFact(facts: readonly FactRecord[], reference: { readonly type: string; readonly version: number }): boolean {
  return facts.some((fact) => fact.type === reference.type && fact.version === reference.version);
}

const publicationKey = factPublicationKey;

function occurrenceId(ruleId: string, facts: ProgressionOccurrence["activationFacts"]): string {
  return fingerprint({ ruleId, facts });
}

function isTerminal(status: ProgressionOccurrence["status"]): boolean {
  return status === "declined" || status === "satisfied" || status === "superseded";
}

function frozenResult(value: ProgressionReconciliation): ProgressionReconciliation {
  return deepFreeze(structuredClone(value));
}
