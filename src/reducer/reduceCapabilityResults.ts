import { factKey } from "../compiler/buildDependencyGraph.js";
import type { CompiledAgentDefinition } from "../compiler/compileAgentDefinition.js";
import type { Artifact, CapabilityIssue } from "../contracts/capability.js";
import { SchemaValidationError } from "../contracts/errors.js";
import type { EvidenceRecord, FactRecord } from "../contracts/facts.js";
import type { AgendaItemId, StepId, TurnId } from "../contracts/ids.js";
import type { StepExecutionResult, TurnPlan } from "../contracts/plan.js";
import type { KernelCheckpoint } from "../contracts/checkpoint.js";
import type { EffectReceipt } from "../contracts/effects.js";
import type { CanonicalResponse } from "../contracts/response.js";
import { deepFreeze } from "../context/deepFreeze.js";
import { invalidateFacts } from "./invalidateFacts.js";
import { updateAgenda } from "./updateAgenda.js";
import { retainSuspendedInteractions } from "./suspendedInteraction.js";

/** Fully validated logical state transition and response material for one turn. */
export interface TurnReduction {
  readonly checkpoint: KernelCheckpoint;
  readonly publishedFacts: readonly FactRecord[];
  readonly invalidatedFacts: readonly FactRecord[];
  readonly evidence: readonly EvidenceRecord[];
  readonly artifacts: readonly Artifact[];
  readonly issues: readonly CapabilityIssue[];
  readonly results: readonly StepExecutionResult[];
}

/** Inputs required for the reducer's single authoritative state transition. */
export interface ReduceCapabilityResultsOptions {
  /** Internal dynamic-provider lineage; never inferred from capability identity. */
  readonly dependencyParentId?: AgendaItemId;
  readonly checkpoint: KernelCheckpoint;
  readonly plan: TurnPlan;
  readonly results: readonly StepExecutionResult[];
  readonly compiled: CompiledAgentDefinition;
  readonly turnId: TurnId;
  readonly effects?: readonly EffectReceipt[];
}

/** Validate capability outputs and atomically derive the next logical state. */
export async function reduceCapabilityResults(options: ReduceCapabilityResultsOptions): Promise<TurnReduction> {
  let facts = [...options.checkpoint.facts];
  const publishedFacts: FactRecord[] = [];
  const invalidatedFacts: FactRecord[] = [];
  const evidence: EvidenceRecord[] = [];
  const artifacts: Artifact[] = [];
  const issues: CapabilityIssue[] = [];
  const resultByStep = new Map(options.results.map((result) => [result.stepId, result]));

  for (const step of options.plan.steps) {
    const execution = resultByStep.get(step.id);
    if (execution?.status === "skipped") {
      if (execution.reason.code !== "DEPENDENCY_PENDING" || (execution.pendingFacts?.length ?? 0) === 0) {
        issues.push({ code: execution.reason.code, message: execution.reason.message, retryable: false });
      }
      continue;
    }
    if (execution?.status !== "invoked") continue;
    const capability = options.compiled.capabilities.get(execution.capabilityId);
    if (capability === undefined) {
      throw schemaError("CAPABILITY_NOT_REGISTERED", "Execution result references an unregistered capability.", step.id);
    }
    if (execution.result.status === "failed") {
      issues.push(execution.result.issue);
      continue;
    }
    if (execution.result.status === "needs_input" && execution.result.invalidates !== undefined) {
      const allowedInvalidations = new Set([
        ...capability.provides.map(factKey),
        ...capability.invalidates.map(factKey),
      ]);
      if (execution.result.invalidates.some((reference) => !allowedInvalidations.has(factKey(reference)))) {
        throw schemaError(
          "UNDECLARED_FACT_INVALIDATION",
          "Capability requested an invalidation outside its declared working-set boundary.",
          step.id,
        );
      }
      const invalidation = invalidateFacts(facts, execution.result.invalidates);
      facts = [...invalidation.kept];
      invalidatedFacts.push(...invalidation.removed);
    }
    if (execution.result.status !== "completed") continue;

    const output = await capability.output.validate(execution.result.output);
    if (!output.ok) {
      throw schemaError("INVALID_CAPABILITY_OUTPUT", "Capability output violates its declared schema.", step.id, output.issues.length);
    }
    const evidenceById = new Map(execution.result.evidence.map((record) => [record.id, record]));
    validateCanonicalResponse(execution.result.canonicalResponse, evidenceById, step.id);
    const records: FactRecord[] = [];
    for (const candidate of execution.result.facts) {
      const declaration = capability.provides.find((provided) => factKey(provided) === factKey(candidate));
      if (declaration === undefined) {
        throw schemaError("UNDECLARED_FACT", "Capability returned a fact it did not declare.", step.id);
      }
      const candidateEvidence = candidate.evidenceIds.map((id) => evidenceById.get(id));
      if (candidateEvidence.some((record) => record === undefined)) {
        throw schemaError("UNKNOWN_EVIDENCE", "Fact references evidence absent from the capability result.", step.id);
      }
      records.push({
        ...candidate,
        ...(declaration.modelVisibility === undefined ? {} : { modelVisibility: declaration.modelVisibility }),
        ...(declaration.deriveModelRedactions === undefined
          ? {}
          : { modelRedactions: validateModelRedactions(declaration.deriveModelRedactions(candidate.value), step.id) }),
        evidence: candidateEvidence as EvidenceRecord[],
        producedBy: {
          capabilityId: capability.id,
          capabilityVersion: capability.version,
          turnId: options.turnId,
          stepId: step.id,
        },
      });
    }

    const invalidation = invalidateFacts(facts, [
      ...capability.invalidates,
      ...records.map((record) => ({ type: record.type, version: record.version })),
    ]);
    facts = [...invalidation.kept, ...records];
    invalidatedFacts.push(...invalidation.removed);
    publishedFacts.push(...records);
    evidence.push(...execution.result.evidence);
    artifacts.push(...execution.result.artifacts);
  }

  const provisionalAgenda = updateAgenda(options.checkpoint.agenda, options.plan, options.results, options.dependencyParentId);
  const objectiveCancelled = options.checkpoint.progression?.objective !== undefined &&
    (options.plan.cancelledObjectiveIds ?? []).includes(options.checkpoint.progression.objective.id);
  const interactions: NonNullable<KernelCheckpoint["interaction"]>[] = options.plan.steps.flatMap((step) => {
    const execution = resultByStep.get(step.id);
    if (execution?.status !== "invoked") return [];
    // Dependency retirement also retires an interaction produced earlier in
    // this turn. Otherwise the response can resurrect a now-orphaned question.
    if (!provisionalAgenda.some(item => item.id === `agenda:${step.id}`)) return [];
    const result = execution.result;
    if (result.status === "needs_input" || result.status === "needs_confirmation") {
      return [result.interaction];
    }
    return result.status === "completed" && result.interaction != null
      ? [result.interaction]
      : [];
  });
  const dependencyInterruptsActiveInteraction = options.plan.steps.some((step) => {
    const execution = resultByStep.get(step.id);
    return execution?.status === "invoked" &&
      execution.result.status === "needs_dependency" &&
      options.checkpoint.interaction?.capabilityId !== execution.capabilityId;
  });
  const producedInteraction = interactions.find((interaction) => interaction.mode !== "optional") ?? interactions[0];
  const previousInteractionDismissed = options.plan.steps.some((step) => {
    const execution = resultByStep.get(step.id);
    return execution?.status === "invoked" && execution.result.status === "completed" && execution.result.interaction === null;
  });
  const preservedInteraction = dependencyInterruptsActiveInteraction || previousInteractionDismissed
    ? undefined
    : preservePendingInteraction(options.checkpoint, provisionalAgenda, options.plan);
  const ambientInteractionMustYield = producedInteraction?.mode === "optional" &&
    preservedInteraction !== undefined &&
    preservedInteraction.mode !== "optional" &&
    producedInteraction.capabilityId !== preservedInteraction.capabilityId;
  const activeInteraction = objectiveCancelled
    ? producedInteraction ?? options.plan.interaction
    : (ambientInteractionMustYield
        ? preservedInteraction
        : producedInteraction ?? options.plan.interaction ?? preservedInteraction);
  const ignoredOptionalAgendaIds = ambientInteractionMustYield
    ? new Set(options.plan.steps.flatMap((step) => {
        const execution = resultByStep.get(step.id);
        if (execution?.status !== "invoked") return [];
        const result = execution.result;
        const interaction = result.status === "needs_input" || result.status === "needs_confirmation"
          ? result.interaction
          : result.status === "completed"
            ? result.interaction
            : undefined;
        return interaction?.mode === "optional" ? [`agenda:${step.id}`] : [];
      }))
    : new Set<string>();
  const agenda = ignoredOptionalAgendaIds.size === 0
    ? provisionalAgenda
    : provisionalAgenda.filter((item) => !ignoredOptionalAgendaIds.has(item.id));
  const checkpointBase: Omit<KernelCheckpoint, "interaction"> = {
    schemaVersion: options.checkpoint.schemaVersion,
    revision: options.checkpoint.revision + 1,
    agentFingerprint: options.checkpoint.agentFingerprint,
    messages: options.checkpoint.messages,
    facts,
    agenda,
    effects: options.effects ?? options.checkpoint.effects,
    ...(options.checkpoint.progression === undefined
      ? {}
      : {
          progression: objectiveCancelled
            ? cancelProgression(options.checkpoint.progression)
            : options.checkpoint.progression,
        }),
  };
  const provisionalCheckpoint: KernelCheckpoint = activeInteraction === undefined
    ? checkpointBase
    : { ...checkpointBase, interaction: activeInteraction };
  const checkpoint: KernelCheckpoint = { ...provisionalCheckpoint, agenda: retainSuspendedInteractions({
    previous: options.checkpoint, checkpoint: provisionalCheckpoint, compiled: options.compiled,
    dismissed: previousInteractionDismissed || objectiveCancelled,
    dependencyInterrupted: dependencyInterruptsActiveInteraction && options.plan.steps.some(step => {
      const execution = resultByStep.get(step.id);
      return execution?.status === "invoked" && execution.result.status === "needs_dependency" &&
        execution.capabilityId !== options.checkpoint.interaction?.capabilityId &&
        options.compiled.capabilities.get(execution.capabilityId)?.effect !== "write";
    }),
  }) };

  return deepFreeze(structuredClone({
    checkpoint,
    publishedFacts,
    invalidatedFacts,
    evidence,
    artifacts,
    issues,
    results: options.results,
  }));
}

function cancelProgression(
  progression: NonNullable<KernelCheckpoint["progression"]>,
): NonNullable<KernelCheckpoint["progression"]> {
  return {
    ...(progression.objective === undefined
      ? {}
      : { objective: { ...progression.objective, status: "cancelled" } }),
    occurrences: progression.occurrences.map((occurrence) => {
      if (occurrence.status !== "pending" && occurrence.status !== "active") return occurrence;
      const cancelled = { ...occurrence };
      delete cancelled.activeMember;
      return { ...cancelled, status: "declined" };
    }),
  };
}

function preservePendingInteraction(
  checkpoint: KernelCheckpoint,
  agenda: KernelCheckpoint["agenda"],
  plan: TurnPlan,
): KernelCheckpoint["interaction"] {
  const active = checkpoint.interaction;
  if (active === undefined) return undefined;
  if (
    typeof active.payload === "object" && active.payload !== null &&
    (active.payload as Record<string, unknown>)["kind"] === "progression.group"
  ) return undefined;
  if (
    active.mode === "optional" &&
    plan.steps.some((step) =>
      step.disposition !== "reject" &&
      step.capabilityId !== undefined &&
      step.capabilityId !== active.capabilityId,
    )
  ) return undefined;
  const remainingIds = new Set(agenda.map((item) => item.id));
  const candidates = checkpoint.agenda.filter((item) => {
    if (active.capabilityId !== undefined && item.intention.proposedCapability === active.capabilityId) return true;
    if (typeof active.payload === "object" && active.payload !== null) {
      const payload = active.payload as Record<string, unknown>;
      const intention = payload["intention"];
      if (typeof intention === "object" && intention !== null) {
        const candidate = intention as Record<string, unknown>;
        if (candidate["id"] === item.intention.id) return true;
      }
    }
    return checkpoint.agenda.length === 1;
  });
  return candidates.some((item) => remainingIds.has(item.id)) ? active : undefined;
}

function schemaError(code: string, message: string, stepId: StepId, issues?: number): SchemaValidationError {
  return new SchemaValidationError({
    code,
    message,
    retryable: false,
    context: { stepId, ...(issues === undefined ? {} : { issues }) },
  });
}

function validateModelRedactions(values: unknown, stepId: StepId): readonly string[] {
  if (!Array.isArray(values) || values.some((value: unknown) => typeof value !== "string")) {
    throw schemaError("INVALID_MODEL_REDACTIONS", "Fact redactions must be an array of strings.", stepId);
  }
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length >= 3))];
}

function validateCanonicalResponse(
  response: CanonicalResponse | undefined,
  evidenceById: ReadonlyMap<EvidenceRecord["id"], EvidenceRecord>,
  stepId: StepId,
): void {
  if (response === undefined) return;
  if (response.required !== undefined && typeof response.required !== "boolean") {
    throw schemaError("INVALID_CANONICAL_RESPONSE", "Canonical response required must be a boolean.", stepId);
  }
  if (response.required === true && response.claims.length === 0) {
    throw schemaError("INVALID_CANONICAL_RESPONSE", "Required response must contain evidence-cited claims.", stepId);
  }
  if (response.message.trim().length === 0) {
    throw schemaError("INVALID_CANONICAL_RESPONSE", "Canonical response message must not be empty.", stepId);
  }
  for (const claim of response.claims) {
    if (claim.text.length === 0 || !response.message.includes(claim.text)) {
      throw schemaError("INVALID_CANONICAL_RESPONSE", "Canonical claim must be an exact non-empty message span.", stepId);
    }
    if (claim.evidenceIds.length === 0 || claim.evidenceIds.some((id) => !evidenceById.has(id))) {
      throw schemaError("UNKNOWN_EVIDENCE", "Canonical claim references evidence absent from the capability result.", stepId);
    }
  }
}
