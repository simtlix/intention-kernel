import type { CapabilityIssue } from "../contracts/capability.js";
import type { AgentResponseFallbacks } from "../contracts/agent.js";
import type { EvidenceRecord } from "../contracts/facts.js";
import { evidenceId, type CapabilityId } from "../contracts/ids.js";
import type { CanonicalResponse, ResponseBrief } from "../contracts/response.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import { deepFreeze } from "../context/deepFreeze.js";
import type { TurnReduction } from "../reducer/reduceCapabilityResults.js";
import type { TurnPlan } from "../contracts/plan.js";
import { projectFactsForModel, redactModelValue } from "../context/projectModelContext.js";
import type { CapabilitySelection } from "../interpreter/schemas.js";
import type { IntentionBatch } from "../contracts/intention.js";
import { joinCanonicalMessages } from "./joinCanonicalMessages.js";
import { projectProgression } from "../progression/completionLineage.js";

type ResponseInput = {
  readonly plan: TurnPlan;
  readonly reduction: TurnReduction;
  readonly context?: ContextSnapshot;
  readonly decision?: CapabilitySelection;
  readonly batch?: IntentionBatch;
  readonly responseFallbacks?: AgentResponseFallbacks;
};

/** Trusted server delivery; never include this object in a model request. */
export type ResponseDelivery = Pick<ResponseBrief,
  "interaction" | "artifacts" | "canonicalFallback" | "requiredResponses" | "evidence"
> & {
  /** Internal coverage of completed work by server-authored copy; never projected to a model or public brief. */
  readonly completedResponses?: readonly CanonicalResponse[];
};

/** Build the only data projection available to the response model. */
export function buildResponseBrief(options: ResponseInput): ResponseBrief {
  const decision = finalResponseDecision(options);
  const redactions = uniqueRedactions([
    ...options.reduction.checkpoint.facts.flatMap((fact) => fact.modelRedactions ?? []),
    ...options.reduction.checkpoint.agenda.flatMap((item) => item.modelRedactions ?? []),
    ...options.reduction.results.flatMap((execution) =>
      execution.status === "invoked" && execution.result.status !== "failed"
        ? execution.result.modelRedactions ?? []
        : [],
    ),
  ]);
  const planIssues: CapabilityIssue[] = options.plan.steps
    .filter((step) => step.disposition === "reject")
    .map((step) => ({ code: step.reason.code, message: step.reason.message, retryable: false }));
  const completed = options.reduction.results.flatMap((execution) => {
    if (execution.status !== "invoked" || execution.result.status !== "completed") return [];
    const step = options.plan.steps.find((candidate) => candidate.id === execution.stepId);
    if (step === undefined) return [];
    return [{
      stepId: execution.stepId,
      capabilityId: execution.capabilityId,
      objective: step.intention.objective,
      output: redactModelValue(execution.result.output, redactions),
      evidenceIds: execution.result.evidence.map((record) => record.id),
    }];
  });
  const projectedFacts = projectFactsForModel(options.reduction.checkpoint.facts);
  const protectedEvidenceIds = new Set(options.reduction.checkpoint.facts
    .filter((fact) => fact.modelVisibility === "hidden" || fact.modelVisibility === "presence")
    .flatMap((fact) => fact.evidenceIds));
  const visibleEvidenceIds = new Set(projectedFacts.flatMap((fact) => fact.evidenceIds));
  const currentTurnEvidenceIds = new Set(completed.flatMap((result) => result.evidenceIds));
  const configuredAgentEvidence: EvidenceRecord[] = options.context === undefined
    ? []
    : [{
        id: evidenceId("agent.configuration"),
        source: "capability",
        content: "Published agent identity and capability descriptions.",
        data: {
          identity: options.context.agent.identity,
          capabilities: options.context.capabilities.map(({ id, description }) => ({ id, description })),
        },
      }];
  const issues = [...options.reduction.issues, ...planIssues];
  const issueEvidence: EvidenceRecord[] = issues.map((issue) => ({
    id: evidenceId(`issue:${issue.code}`),
    source: "capability",
    content: issue.message,
    data: issue,
  }));
  const decisionEvidence: EvidenceRecord[] = decision === undefined
    ? []
    : [{
        id: evidenceId("turn.decision"),
        source: "capability",
        content: `Validated current-turn decision: ${decision.rationale}`,
        data: {
          mode: decision.mode,
          capabilityIds: decision.capabilityIds,
          evidence: decision.evidence,
        },
      }];
  const evidence = uniqueEvidence([
    ...configuredAgentEvidence,
    ...issueEvidence,
    ...decisionEvidence,
    ...options.reduction.evidence.filter((record) =>
      !protectedEvidenceIds.has(record.id) || visibleEvidenceIds.has(record.id) || currentTurnEvidenceIds.has(record.id),
    ),
    ...projectedFacts.flatMap((fact) => fact.evidence),
  ]).map((record) => redactModelValue(record, redactions));
  const allowedActions = uniqueCapabilities(options.plan.steps.flatMap((step) =>
    step.capabilityId === undefined || step.disposition === "reject" ? [] : [step.capabilityId],
  ));
  const context = options.context;
  const delivery = buildResponseDelivery(options);
  const brief: ResponseBrief = {
    responseGoal: options.plan.responseGoal,
    ...(context === undefined ? {} : {
      conversation: {
        currentMessage: redactModelValue(context.currentMessage.content, redactions),
        recentMessages: context.conversation.recentMessages.map((message) => ({
          role: message.role,
          content: redactModelValue(message.content, redactions),
        })),
        agentIdentity: context.agent.identity,
      },
      ...(context.progression === undefined
        ? {}
        : { progression: redactModelValue(projectProgression(context.progression), redactions) }),
    }),
    ...(decision === undefined
      ? {}
      : {
          decision: redactModelValue({
            evidenceId: evidenceId("turn.decision"),
            mode: decision.mode,
            capabilityIds: decision.capabilityIds,
            rationale: decision.rationale,
            evidence: decision.evidence,
          }, redactions),
        }),
    modelGuidance: context === undefined
      ? []
      : redactModelValue(context.selectedModelGuidancePolicies, redactions),
    completed: redactModelValue(completed, redactions),
    capabilities: context === undefined
      ? []
      : context.capabilities.map(({ id, description }) => ({ id, description })),
    pending: redactModelValue(options.reduction.checkpoint.agenda.map((item) => ({
      id: item.id,
      intention: item.intention,
      status: item.status,
      missingFacts: item.missingFacts,
      dependencies: item.dependencies,
    })), redactions),
    issues: redactModelValue(issues, redactions),
    ...redactModelValue({
      ...(delivery.interaction === undefined ? {} : { interaction: delivery.interaction }),
      ...(delivery.requiredResponses === undefined ? {} : { requiredResponses: delivery.requiredResponses }),
      ...(delivery.canonicalFallback === undefined ? {} : { canonicalFallback: delivery.canonicalFallback }),
      artifacts: delivery.artifacts,
    }, redactions),
    allowedActions,
    facts: redactModelValue(projectedFacts, redactions),
    evidence,
  };
  return deepFreeze(structuredClone(brief));
}

// This is a projection of validated state, never another semantic interpretation.
// Selection is only preliminary when a final batch is available.
function finalResponseDecision(options: ResponseInput): CapabilitySelection | undefined {
  const batch = options.batch;
  if (batch === undefined) return options.decision;
  const rejectedIds = new Set(options.plan.steps.filter((step) => step.disposition === "reject").map((step) => step.intentionId));
  const accepted = batch.intentions.filter((intention) => intention.resolution === "resolved" && !rejectedIds.has(intention.id));
  const capabilityIds = [...new Set(accepted.flatMap((intention) => intention.proposedCapability === undefined ? [] : [intention.proposedCapability]))];
  const controls = (batch.lifecycleActions ?? []).filter((action) => action.kind === "cancel_objective"
    ? options.plan.cancelledObjectiveIds?.includes(action.targetId)
    : options.plan.cancelledAgendaItemIds?.includes(action.targetId));
  const hasControl = controls.length > 0;
  const unresolved = batch.intentions.filter((intention) => intention.resolution !== "resolved");
  const rejected = batch.intentions.filter((intention) => rejectedIds.has(intention.id));
  const answer = batch.answerToInteraction;
  const mode = capabilityIds.length > 0
    ? hasControl ? "selected_with_control" : "selected"
    : hasControl ? "control"
    : unresolved.length > 0 || rejected.length > 0 || (answer === undefined && options.decision?.mode === "no_match") ? "no_match"
    : "conversational";
  const evidence = [...batch.intentions.flatMap((intention) => intention.evidence), ...controls.map((action) => action.evidence),
    ...(answer === undefined || options.context === undefined ? [] : [{
      text: answer.evidence, meaning: "The final interpretation accepted this interaction answer.", messageIndex: options.context.currentMessage.index,
    }])];
  const rationale = [
    ...accepted.map((intention) => `Interpreted request (not proof of authorization or completion): ${intention.objective}.`),
    ...unresolved.map((intention) => `Unresolved ${intention.resolution} request: ${intention.objective}.`),
    ...rejected.map((intention) => `The plan rejected this request; it did not execute: ${intention.objective}.`),
    ...(answer === undefined ? [] : ["The final interpretation contains an accepted interaction answer; this is not evidence that an operation completed."]),
    ...controls.map((action) => `Applied lifecycle action: ${action.kind} for ${action.targetId}.`),
  ].join(" ") || "The final interpretation accepted no operation, interaction answer or lifecycle action. Preserve any unresolved interaction and address the current message without claiming completed work.";
  return { mode, capabilityIds, rationale, evidence };
}

/** Capture original capability-owned delivery separately from model redaction. */
export function buildResponseDelivery(options: ResponseInput): ResponseDelivery {
  const canonicalFallbacks = options.reduction.results.flatMap((execution) =>
    execution.status === "invoked" && execution.result.status === "completed" &&
      options.plan.steps.some((step) => step.id === execution.stepId) &&
      execution.result.canonicalResponse !== undefined
      ? [execution.result.canonicalResponse]
      : [],
  );
  const interactionFallback = options.reduction.checkpoint.interaction === undefined
    ? undefined
    : {
        message: options.reduction.checkpoint.interaction.goal,
        claims: [],
      };
  const requiredResponses = canonicalFallbacks.filter((response) => response.required === true);
  const requiredFallback = requiredResponses.length === 0 ? undefined : {
    message: joinCanonicalMessages([
      // A required result must not hide other completed capability-authored answers.
      ...canonicalFallbacks.map((response) => response.message),
      ...(interactionFallback === undefined || options.reduction.checkpoint.interaction?.mode === "optional"
        ? [] : [interactionFallback.message]),
    ]),
    claims: canonicalFallbacks.flatMap((response) => response.claims),
  };
  const unsupportedFallback = options.plan.steps.some((step) => step.disposition === "reject" && step.reason.code === "UNSUPPORTED_INTENTION") &&
    options.responseFallbacks?.unsupportedIntention !== undefined
    ? { message: options.responseFallbacks.unsupportedIntention, claims: [] }
    : undefined;
  // Protected confirmation copy is supplied separately to the composer.
  const interaction = options.reduction.checkpoint.interaction === undefined
    ? undefined
    : { ...options.reduction.checkpoint.interaction };
  if (interaction !== undefined) delete interaction.protectedCanonicalMessage;
  const completedCount = options.reduction.results.filter((execution) =>
    execution.status === "invoked" && execution.result.status === "completed" &&
    options.plan.steps.some((step) => step.id === execution.stepId),
  ).length;
  return deepFreeze(structuredClone({
    completedResponses: canonicalFallbacks,
    ...(interaction === undefined ? {} : { interaction }),
    evidence: options.reduction.evidence,
    artifacts: options.reduction.artifacts,
    ...(requiredResponses.length === 0 ? {} : { requiredResponses }),
    ...(requiredFallback !== undefined
      ? { canonicalFallback: requiredFallback }
      : completedCount === 1 && canonicalFallbacks.length === 1 && canonicalFallbacks[0] !== undefined
      ? { canonicalFallback: canonicalFallbacks[0] }
      : interactionFallback !== undefined
        ? { canonicalFallback: interactionFallback }
        : unsupportedFallback === undefined
          ? {}
          : { canonicalFallback: unsupportedFallback }),
  } satisfies ResponseDelivery));
}

function uniqueEvidence(records: readonly EvidenceRecord[]): EvidenceRecord[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function uniqueCapabilities(ids: readonly CapabilityId[]): CapabilityId[] {
  return [...new Set(ids)];
}

function uniqueRedactions(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length >= 3))];
}
