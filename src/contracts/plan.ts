import type { AgendaItemId, CapabilityId, IntentionId, StepId } from "./ids.js";
import type { CapabilityResult } from "./capability.js";
import type { FactRequirement } from "./facts.js";
import type { IntentionRequest } from "./intention.js";
import type { Interaction, InteractionAnswer } from "./interaction.js";
import type { EffectReceipt } from "./effects.js";

/** Reason recorded for a planner disposition. */
export interface PlanReason {
  /** Stable machine-readable planner decision code. */
  readonly code: string;
  /** Safe explanation of the planner decision. */
  readonly message: string;
  /** Visible inputs or facts supporting the decision. */
  readonly evidence: readonly string[];
}

/** One validated operation in a turn plan. */
export interface PlanStep {
  /** Kernel-owned execution branch identity. */
  readonly id: StepId;
  /** Interpreted objective represented by this step. */
  readonly intentionId: IntentionId;
  /** Complete interpreted objective retained for agenda persistence. */
  readonly intention: IntentionRequest;
  /** Validated operation selected for executable or deferred work. */
  readonly capabilityId?: CapabilityId;
  /** Runtime-validated capability input. */
  readonly input?: unknown;
  /** Capability-owned opaque state used when resuming work. */
  readonly continuation?: unknown;
  /** Sensitive values removed from later model projections. */
  readonly modelRedactions?: readonly string[];
  /** Answer supplied to a resumed capability interaction. */
  readonly interactionAnswer?: InteractionAnswer;
  /** Other steps that must complete before this one executes. */
  readonly dependsOn: readonly StepId[];
  /** Confirmed facts still required before execution. */
  readonly missingFacts: readonly FactRequirement[];
  /** Planner authority describing what may happen this turn. */
  readonly disposition: "execute" | "defer" | "clarify" | "reject";
  /** Evidence-bearing reason for the disposition. */
  readonly reason: PlanReason;
}

/** Validated DAG of work for a single turn. */
export interface TurnPlan {
  /** Validated operation graph for the current turn. */
  readonly steps: readonly PlanStep[];
  /** Primary interaction to ask instead of unsafe execution. */
  readonly interaction?: Interaction;
  /** Capability whose prior interaction was answered by this turn. */
  readonly answeredInteractionCapabilityId?: CapabilityId;
  /** Communication objective supplied to response composition. */
  readonly responseGoal: string;
  /** Trusted action derived from an active progression interaction. */
  readonly progressionAction?: Readonly<{
    readonly kind: "member" | "continue" | "automatic";
    readonly occurrenceId: string;
    readonly capabilityId?: CapabilityId;
  }>;
  /** Pending objectives explicitly cancelled by the user in this turn. */
  readonly cancelledAgendaItemIds?: readonly AgendaItemId[];
  /** Configured objectives explicitly cancelled by the user in this turn. */
  readonly cancelledObjectiveIds?: readonly string[];
}

/** Outcome of attempting one executable plan step. */
export type StepExecutionResult =
  | {
      readonly status: "invoked";
      readonly stepId: StepId;
      readonly capabilityId: CapabilityId;
      readonly result: CapabilityResult<unknown>;
      readonly effects?: readonly EffectReceipt[];
    }
  | {
      readonly status: "skipped";
      readonly stepId: StepId;
      readonly capabilityId: CapabilityId;
      readonly reason: PlanReason;
      /** Verified prerequisites retained when DEPENDENCY_PENDING defers execution. */
      readonly pendingFacts?: readonly FactRequirement[];
    };
