import type { CapabilityId, FactType } from "./ids.js";
import type { FactReference, FactRecord } from "./facts.js";
import type { ConversationMessage } from "./checkpoint.js";

/** Host-defined objective whose completion is represented by one confirmed fact. */
export interface AgentObjectiveDefinition {
  /** Stable semantic identity of the objective. */
  readonly id: string;
  /** Objectives currently begin with a fresh conversation. */
  readonly activation: "conversation_start";
  /** Fact whose presence completes the objective. */
  readonly completionFact: FactReference;
}

/** One executable member exposed inside a capability group interaction. */
export interface CapabilityGroupMember {
  /** Capability invoked when this member is selected. */
  readonly capabilityId: CapabilityId;
  /** User-visible action label. */
  readonly label: string;
  /** Natural-language examples used to interpret free-text selections. */
  readonly examples: readonly string[];
}

/** Declarative set of related capabilities presented as one bounded interaction. */
export interface CapabilityGroupDefinition {
  /** Stable host-owned group identity. */
  readonly id: string;
  /** Short model- and inspector-visible description. */
  readonly label: string;
  /** Prompt used on the first presentation of this occurrence. */
  readonly prompt: string;
  /** Prompt used after a member completes when the group repeats. */
  readonly repeatPrompt?: string;
  /** User-visible option that exits the group. */
  readonly continueLabel: string;
  /** Natural-language examples that mean exit rather than a member operation. */
  readonly continueExamples?: readonly string[];
  /** Whether the interaction returns after a member capability completes. */
  readonly repeatAfterMember: boolean;
  /** Whether completed members remain visible in a repeated group. */
  readonly completedMemberVisibility?: "show" | "hide";
  /** Capabilities available inside the group. */
  readonly members: readonly CapabilityGroupMember[];
}

/** Fact-triggered target made available by the host application. */
export interface ProgressionRuleDefinition {
  /** Stable semantic rule identity. */
  readonly id: string;
  /** Positive version included in the compiled agent fingerprint. */
  readonly version: number;
  /** Capability or capability group activated by the rule. */
  readonly target: Readonly<{ groupId: string }> | Readonly<{ capabilityId: CapabilityId }>;
  /** Required targets interrupt normal suggestions; optional targets are offered once. */
  readonly mode: "available" | "offer" | "required";
  /** Lower values are considered before higher values at a safe boundary. */
  readonly priority: number;
  /** Confirmed facts that create a distinct activation occurrence. */
  readonly activateWhen: readonly FactReference[];
}

/** Complete declarative progression contract for one compiled agent. */
export interface AgentProgressionDefinition {
  /** Optional long-lived objective projected independently from pending work. */
  readonly objective?: AgentObjectiveDefinition;
  /** Reusable user-facing capability groups. */
  readonly groups: readonly CapabilityGroupDefinition[];
  /** Fact-triggered progression rules. */
  readonly rules: readonly ProgressionRuleDefinition[];
}

/** Input available when a capability is invoked by trusted progression authority. */
export interface CapabilityAutomationContext {
  /** Current user message, preserved exactly. */
  readonly currentMessage: ConversationMessage;
  /** Confirmed facts available at the progression boundary. */
  readonly facts: readonly FactRecord[];
}

/** Versioned input factory required for server-authorized capability activation. */
export interface CapabilityAutomation {
  /** Positive version included in the compiled agent fingerprint. */
  readonly version: number;
  /** Construct untrusted input that is validated by the capability schema before execution. */
  readonly createInput: (context: CapabilityAutomationContext) => unknown;
}

/** Durable status of the configured primary objective. */
export interface ProgressionObjectiveState {
  /** Stable objective identity copied from the compiled definition. */
  readonly id: string;
  /** Current lifecycle status derived from conversation start and the completion fact. */
  readonly status: "active" | "completed" | "cancelled";
}

/** Durable fact-bound occurrence of one progression rule. */
export interface ProgressionOccurrence {
  /** Deterministic identity derived from the rule and activating fact publications. */
  readonly id: string;
  /** Rule that produced this occurrence. */
  readonly ruleId: string;
  /** Capability or group governed by the occurrence. */
  readonly target: ProgressionRuleDefinition["target"];
  /** Requirement strength copied from the rule. */
  readonly mode: ProgressionRuleDefinition["mode"];
  /** Stable ordering priority copied from the rule. */
  readonly priority: number;
  /** Exact fact publications that activated this occurrence. */
  readonly activationFacts: readonly Readonly<{
    /** Fact type that participated in activation. */
    type: FactType;
    /** Required fact schema version. */
    version: number;
    /** Stable identity of the concrete fact publication. */
    publication: string;
  }>[];
  /** Durable lifecycle state for this occurrence. */
  readonly status: "pending" | "active" | "declined" | "satisfied" | "superseded";
  /** Whether its user-facing interaction has already been presented. */
  readonly presented: boolean;
  /** Group members completed within this occurrence. */
  readonly completedMembers: readonly CapabilityId[];
  /** Group member currently collecting input or awaiting confirmation. */
  readonly activeMember?: CapabilityId;
}

/** Kernel-owned progression state persisted with the conversation checkpoint. */
export interface ProgressionState {
  /** Current objective lifecycle when the agent defines an objective. */
  readonly objective?: ProgressionObjectiveState;
  /** All active and historical fact-bound rule occurrences. */
  readonly occurrences: readonly ProgressionOccurrence[];
}
