import type { AgendaItem } from "../contracts/agenda.js";
import type { AgendaItemId } from "../contracts/ids.js";
import type { StepExecutionResult, TurnPlan } from "../contracts/plan.js";
import { readDeferredChoiceAnswer, withDeferredChoiceAnswer } from "../context/deferredChoiceAnswer.js";
import { withCompletedFollowUp, withOptionalInput } from "./agendaInputState.js";
import type { Interaction } from "../contracts/interaction.js";

// Private durable lineage. Public dependencies also include independently
// requested static prerequisites, which must never be treated as owned work.
type DependencyAgendaItem = AgendaItem & {
  readonly ownedDependencyIds?: readonly AgendaItemId[];
};

/** Merge unresolved plan work into the durable agenda. */
export function updateAgenda(
  previous: readonly AgendaItem[],
  plan: TurnPlan,
  results: readonly StepExecutionResult[],
  dependencyParentId?: AgendaItemId,
): readonly AgendaItem[] {
  const currentIntentions = new Set(plan.steps.map((step) => step.intentionId));
  const currentCapabilities = new Set(plan.steps.flatMap((step) => step.capabilityId === undefined ? [] : [step.capabilityId]));
  const cancelled = new Set(plan.cancelledAgendaItemIds ?? []);
  // Objective cancellation retires the previous agenda, not independent work
  // explicitly admitted in this same turn (including its pending dependencies).
  const retained = (plan.cancelledObjectiveIds?.length ?? 0) > 0 ? [] : previous;
  const next = retained.filter((item) =>
    !cancelled.has(item.id) &&
    !currentIntentions.has(item.intention.id) &&
    item.intention.proposedCapability !== plan.answeredInteractionCapabilityId &&
    (item.intention.proposedCapability === undefined || !currentCapabilities.has(item.intention.proposedCapability)),
  );
  const resultByStep = new Map(results.map((result) => [result.stepId, result]));

  for (const step of plan.steps) {
    if (step.disposition === "reject") continue;
    let status: AgendaItem["status"] | undefined;
    let completedFollowUp = false;
    let optionalInput: Interaction | undefined;
    let continuation = step.continuation;
    let modelRedactions: readonly string[] | undefined = step.modelRedactions;
    if (step.disposition === "defer") {
      status = step.reason.code === "CONFIRMATION_REQUIRED" ? "waiting_confirmation" : "waiting_facts";
    } else if (step.disposition === "clarify") {
      status = "waiting_input";
    } else {
      const execution = resultByStep.get(step.id);
      if (execution?.status === "skipped") status = execution.reason.code === "DEPENDENCY_PENDING" &&
        (execution.pendingFacts?.length ?? 0) > 0 ? "waiting_facts" : "blocked";
      if (execution?.status === "invoked") {
        if (execution.result.status === "needs_input") {
          status = "waiting_input";
          continuation = execution.result.partialInput;
          modelRedactions = execution.result.modelRedactions;
          optionalInput = execution.result.interaction;
        }
        if (execution.result.status === "needs_dependency") {
          status = "waiting_facts";
          continuation = execution.result.continuation;
          modelRedactions = execution.result.modelRedactions;
        }
        if (execution.result.status === "needs_confirmation") {
          status = "waiting_confirmation";
          continuation = execution.result.continuation ?? execution.result.proposedInput;
          modelRedactions = execution.result.modelRedactions;
        }
        if (execution.result.status === "completed" && execution.result.interaction != null) {
          status = "waiting_input";
          completedFollowUp = true;
          continuation = execution.result.continuation;
          modelRedactions = execution.result.modelRedactions;
        }
        if (execution.result.status === "failed") status = "blocked";
      }
    }
    if (status === undefined) continue;
    const stepResult = resultByStep.get(step.id);
    const missingFacts = stepResult?.status === "invoked" && stepResult.result.status === "needs_dependency"
      ? [stepResult.result.requirement]
      : stepResult?.status === "skipped" && stepResult.reason.code === "DEPENDENCY_PENDING"
        ? stepResult.pendingFacts ?? step.missingFacts : step.missingFacts;
    // Retain an answer only when the operation has not consumed it. Once the
    // capability is invoked, continuation belongs to its own result contract.
    const deferredAnswer = status === "waiting_facts" && stepResult?.status !== "invoked"
      ? readDeferredChoiceAnswer(step) : undefined;
    next.push(withOptionalInput(withCompletedFollowUp(withDeferredChoiceAnswer({
      id: `agenda:${step.id}` as AgendaItemId,
      intention: step.intention,
      status,
      missingFacts,
      dependencies: step.dependsOn.map((dependency) => `agenda:${dependency}` as AgendaItemId),
      ...(continuation === undefined ? {} : { continuation }),
      ...(modelRedactions === undefined ? {} : { modelRedactions }),
    }, deferredAnswer), completedFollowUp), optionalInput));
  }

  const replacements = new Map<AgendaItemId, AgendaItem>();
  for (const previousItem of previous) {
    const replacement = next.find((item) => item.id !== previousItem.id && (
      item.intention.id === previousItem.intention.id ||
      (item.intention.proposedCapability !== undefined && item.intention.proposedCapability === previousItem.intention.proposedCapability)
    ));
    if (replacement !== undefined) replacements.set(previousItem.id, replacement);
  }
  const remap = (ids: readonly AgendaItemId[]): AgendaItemId[] => ids.flatMap((id) => {
    if (next.some((item) => item.id === id)) return [id];
    const replacement = replacements.get(id);
    const old = previous.find((item) => item.id === id);
    // A new explicit intention owns its work independently of the old parent.
    return replacement !== undefined && (replacement.intention.id === old?.intention.id || dependencyParentId !== undefined ||
      replacement.intention.proposedCapability === plan.answeredInteractionCapabilityId)
      ? [replacement.id] : [];
  });
  let linked: DependencyAgendaItem[] = next.map((item) => {
    const { ownedDependencyIds: priorOwned = [], ...base } = item as DependencyAgendaItem;
    const old = previous.find((candidate) => candidate.id === item.id || replacements.get(candidate.id)?.id === item.id) as DependencyAgendaItem | undefined;
    const sameRequirement = old !== undefined && item.status === "waiting_facts" &&
      item.missingFacts.length === old.missingFacts.length && item.missingFacts.every((requirement) =>
        old.missingFacts.some((prior) => prior.type === requirement.type && prior.version === requirement.version));
    const owned = remap(sameRequirement ? old.ownedDependencyIds ?? [] : []);
    return { ...base, dependencies: [...new Set([...remap(item.dependencies.filter((id) => !priorOwned.includes(id))), ...owned])],
      ...(owned.length === 0 ? {} : { ownedDependencyIds: owned }) };
  });
  if (dependencyParentId !== undefined) {
    const childIds = plan.steps.flatMap((step) => {
      const child = linked.find((item) => item.id === `agenda:${step.id}`);
      if (child === undefined) return [];
      const prior = previous.find((item) => item.intention.proposedCapability === child.intention.proposedCapability);
      const alreadyOwned = prior !== undefined && previous.some((item) =>
        ((item as DependencyAgendaItem).ownedDependencyIds ?? []).includes(prior.id));
      // Reusing an independent provider does not transfer ownership to this parent.
      return prior === undefined || alreadyOwned ? [child.id] : [];
    });
    linked = linked.map((item) => item.id !== dependencyParentId ? item : {
      ...item,
      dependencies: [...new Set([...item.dependencies, ...childIds])],
      ownedDependencyIds: [...new Set([...(item.ownedDependencyIds ?? []), ...childIds])],
    });
  }
  // An answered parent can request a dependency while another step in the same
  // turn already renders that provider's choices. That path never enters the
  // automatic-provider loop, but its choice still belongs to the parent answer.
  for (const parent of plan.steps) {
    const execution = resultByStep.get(parent.id);
    const answer = parent.interactionAnswer?.evidence.trim();
    if (parent.capabilityId !== plan.answeredInteractionCapabilityId || !answer ||
      execution?.status !== "invoked" || execution.result.status !== "needs_dependency") continue;
    const providerId = execution.result.provider.capabilityId;
    const childIds = plan.steps.flatMap((child) => {
      if (child.id === parent.id || child.intention.evidence.length === 0 ||
        !child.intention.evidence.every((entry) => entry.text.trim().length > 0 && answer.includes(entry.text.trim()))) return [];
      const childExecution = resultByStep.get(child.id);
      if (childExecution?.status !== "invoked" || childExecution.result.status !== "completed") return [];
      const interaction = childExecution.result.interaction;
      if (interaction?.kind !== "choice" || interaction.protectedCanonicalMessage !== undefined ||
        (interaction.options?.length ?? 0) === 0 ||
        !interaction.options?.every((option) => option.targetCapabilityId === providerId)) return [];
      // A historical independently requested browser is not made exclusive.
      const prior = previous.find((item) => item.intention.proposedCapability === child.capabilityId);
      if (prior !== undefined && !previous.some((item) =>
        ((item as DependencyAgendaItem).ownedDependencyIds ?? []).includes(prior.id))) return [];
      return [`agenda:${child.id}` as AgendaItemId];
    });
    if (childIds.length > 0) linked = linked.map((item) => item.id !== `agenda:${parent.id}` ? item : {
      ...item,
      dependencies: [...new Set([...item.dependencies, ...childIds])],
      ownedDependencyIds: [...new Set([...(item.ownedDependencyIds ?? []), ...childIds])],
    });
  }
  const formerlyOwned = new Set(previous.flatMap((item) => remap((item as DependencyAgendaItem).ownedDependencyIds ?? [])));
  for (;;) {
    const referenced = new Set(linked.flatMap((item) => item.dependencies));
    const orphan = linked.find((item) => formerlyOwned.has(item.id) && !referenced.has(item.id));
    if (orphan === undefined) break;
    for (const child of orphan.ownedDependencyIds ?? []) formerlyOwned.add(child);
    linked = linked.filter((item) => item.id !== orphan.id);
  }
  return linked;
}
