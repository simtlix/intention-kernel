import type { AgendaItemId, CapabilityId, IntentionId } from "./ids.js";
import type { InteractionAnswer } from "./interaction.js";

/** Evidence extracted by the model for an interpreted intention. */
export interface IntentionEvidence {
  /** Exact message fragment supporting the interpreted objective. */
  readonly text: string;
  /** Contextual meaning assigned to the fragment. */
  readonly meaning: string;
  /** Message index from the canonical conversation projection. */
  readonly messageIndex: number;
}

/** Context reference used to resolve a conversational expression. */
export interface ContextReference {
  /** User expression that refers to prior conversation state. */
  readonly expression: string;
  /** Exactly one fact, entity, option or message target proposed for the reference. */
  readonly target: string;
  /** Explanation grounded in the visible context. */
  readonly evidence: string;
}

/** One user objective interpreted from the current turn. */
export interface IntentionRequest {
  /** Model-proposed identity unique within the interpreted batch. */
  readonly id: IntentionId;
  /** Natural-language outcome the user is trying to achieve. */
  readonly objective: string;
  /** Concise decision justification citing supplied evidence; never private chain-of-thought. */
  readonly rationale?: string;
  /** Message evidence supporting this objective. */
  readonly evidence: readonly IntentionEvidence[];
  /** References to prior messages or confirmed facts. */
  readonly references: readonly ContextReference[];
  /** Capability proposed only when resolution is `resolved`. */
  readonly proposedCapability?: CapabilityId;
  /** Untrusted structured input proposed for capability validation. */
  readonly input?: unknown;
  /** Whether the objective is executable, ambiguous or unsupported. */
  readonly resolution: "resolved" | "ambiguous" | "unsupported";
  /** Distinct interpretations presented when resolution is ambiguous. */
  readonly alternatives?: readonly string[];
}

/** Explicit contradiction found inside the turn or against confirmed facts. */
export interface Contradiction {
  /** Concise description of mutually incompatible user requirements. */
  readonly description: string;
  /** Exact visible fragments that establish the contradiction. */
  readonly evidence: readonly string[];
}

/** Kernel-owned lifecycle request that never invokes a business capability. */
export type LifecycleAction =
  | Readonly<{
      /** Cancel one exact pending operation while preserving the broader agent objective. */
      kind: "cancel_agenda_item";
      /** Durable agenda item identifier exposed in the canonical model context. */
      targetId: AgendaItemId;
      /** Exact visible text that authorizes the lifecycle change. */
      evidence: IntentionEvidence;
    }>
  | Readonly<{
      /** Cancel the complete configured objective and all of its pending work. */
      kind: "cancel_objective";
      /** Stable objective identifier exposed in the canonical model context. */
      targetId: string;
      /** Exact visible text that authorizes the lifecycle change. */
      evidence: IntentionEvidence;
    }>;

/** Complete semantic interpretation of one user turn. */
export interface IntentionBatch {
  /** Structured answer to the active interaction, when clearly present. */
  readonly answerToInteraction?: InteractionAnswer;
  /** Zero or more independent objectives expressed in the current turn. */
  readonly intentions: readonly IntentionRequest[];
  /** Explicit conflicts that require resolution before execution. */
  readonly contradictions: readonly Contradiction[];
  /** Explicit lifecycle changes for pending work, kept separate from business capabilities. */
  readonly lifecycleActions?: readonly LifecycleAction[];
}
