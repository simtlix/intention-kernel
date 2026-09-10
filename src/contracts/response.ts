import type { AgendaItem } from "./agenda.js";
import type { Artifact, CapabilityIssue } from "./capability.js";
import type { EvidenceRecord, FactRecord } from "./facts.js";
import type { CapabilityId, EvidenceId, StepId } from "./ids.js";
import type { IntentionEvidence } from "./intention.js";
import type { Interaction } from "./interaction.js";
import type { SelectedModelGuidancePolicy } from "./modelGuidancePolicy.js";
import type { ProgressionState } from "./progression.js";

/** Capability-authored response copy with explicit evidence annotations. */
export interface CanonicalResponse {
  /** Exact user-facing message owned by the capability. */
  readonly message: string;
  /** Exact factual spans and the evidence records that support them. */
  readonly claims: readonly ResponseClaim[];
  /** When true, deliver this exact evidence-cited message once in the current turn. Use authored copy directly when it covers all completed work without repeating required results and no separate issue or lifecycle explanation remains. Defaults to fallback-only. */
  readonly required?: boolean;
}

/** Authorized completed operation exposed to the response composer. */
export interface CompletedWork {
  /** Plan step that produced this completed work item. */
  readonly stepId: StepId;
  /** Executed capability. */
  readonly capabilityId: CapabilityId;
  /** Interpreted user objective addressed by the capability. */
  readonly objective: string;
  /** Runtime-validated capability output. */
  readonly output: unknown;
  /** Evidence available for claims about this output. */
  readonly evidenceIds: readonly EvidenceId[];
}

/** Validated semantic meaning of the current turn supplied to response composition. */
export interface ResponseDecision {
  /** Evidence record that supports claims about the validated current-turn decision. */
  readonly evidenceId: EvidenceId;
  /** Whether the current turn selected operations, control, conversation or no supported match. */
  readonly mode: "selected" | "selected_with_control" | "no_match" | "conversational" | "control";
  /** Capabilities retained by final interpretation and not rejected by the plan; selection is not execution evidence. */
  readonly capabilityIds: readonly CapabilityId[];
  /** Concise audited explanation of the current message meaning. */
  readonly rationale: string;
  /** Exact current-conversation evidence supporting the decision. */
  readonly evidence: readonly IntentionEvidence[];
}

/** Port-free, evidence-bearing input for response composition. */
export interface ResponseBrief {
  /** Turn-level communication goal derived from the validated plan. */
  readonly responseGoal: string;
  /** Bounded conversation projection and configured agent identity. */
  readonly conversation?: Readonly<{
    readonly currentMessage: string;
    readonly recentMessages: readonly Readonly<{ role: "user" | "assistant"; content: string }>[];
    readonly agentIdentity: string;
  }>;
  /** Current configured objective and progression status available to composition and review. */
  readonly progression?: ProgressionState;
  /** Validated semantic decision for the current message. */
  readonly decision?: ResponseDecision;
  /** Contextual semantic guidance shared with interpretation, composition and review for this turn. */
  readonly modelGuidance: readonly SelectedModelGuidancePolicy[];
  /** Successfully completed operations in this turn. */
  readonly completed: readonly CompletedWork[];
  /** Operations the agent may offer without inventing functionality. */
  readonly capabilities: readonly Readonly<{ id: CapabilityId; description: string }> [];
  /** Durable work still waiting after this turn. */
  readonly pending: readonly AgendaItem[];
  /** Safe expected domain failures to explain to the user. */
  readonly issues: readonly CapabilityIssue[];
  /** Primary requested user action, when one remains. */
  readonly interaction?: Interaction;
  /** Capability allowlist available for next-step language. */
  readonly allowedActions: readonly CapabilityId[];
  /** Current confirmed facts with lineage. */
  readonly facts: readonly FactRecord[];
  /** Evidence authorized for factual response claims. */
  readonly evidence: readonly EvidenceRecord[];
  /** Structured channel artifacts produced this turn. */
  readonly artifacts: readonly Artifact[];
  /** Current-turn capability results that must appear verbatim, once, with their cited evidence. Never inferred from historical facts or artifacts. */
  readonly requiredResponses?: readonly CanonicalResponse[];
  /** Validated copy for a single completed capability, all authored current-turn results when any is required, or a server-owned interaction goal. Required invitations follow completed results; optional invitations may be omitted. */
  readonly canonicalFallback?: CanonicalResponse;
}

/** Evidence annotation for one exact factual span in the assistant message. */
export interface ResponseClaim {
  /** Exact substring from the assistant message. */
  readonly text: string;
  /** Evidence whose meaning supports the complete substring. */
  readonly evidenceIds: readonly EvidenceId[];
}

/** Validated response returned by a compiled agent. */
export interface TurnResponse {
  /** Whether the conversational turn completed or failed closed. */
  readonly status: "completed" | "failed";
  /** True after citation validation and either semantic model review or trusted server-authored delivery. */
  readonly grounded: boolean;
  /** Component responsible for the final response copy. */
  readonly source: "model" | "canonical" | "technical_fallback";
  /** User-facing response text. */
  readonly message: string;
  /** Evidence annotations for every factual business span. */
  readonly claims: readonly ResponseClaim[];
  /** User interaction that remains active after this turn. */
  readonly interaction?: Interaction;
  /** Structured outputs available to the host channel. */
  readonly artifacts: readonly Artifact[];
  /** Correlation identity included on a technical failure response. */
  readonly traceId?: string;
}
