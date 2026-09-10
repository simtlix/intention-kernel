import type { AgendaItem } from "./agenda.js";
import type { EffectReceipt } from "./effects.js";
import type { FactRecord } from "./facts.js";
import type { Interaction } from "./interaction.js";
import type { ProgressionState } from "./progression.js";

/** Persisted conversation message. */
export interface ConversationMessage {
  /** Origin of the committed message. */
  readonly role: "user" | "assistant";
  /** Exact committed text supplied to later context projections. */
  readonly content: string;
  /** ISO timestamp supplied by the configured kernel clock. */
  readonly at: string;
}

/** Minimal durable state owned by Intention Kernel. */
export interface KernelCheckpoint {
  /** Serialization contract version for future checkpoint migrations. */
  readonly schemaVersion: 1;
  /** Monotonically increasing committed conversation revision. */
  readonly revision: number;
  /** Hash that prevents use under an incompatible agent manifest. */
  readonly agentFingerprint: string;
  /** Complete committed conversation history. */
  readonly messages: readonly ConversationMessage[];
  /** Current confirmed knowledge with evidence and lineage. */
  readonly facts: readonly FactRecord[];
  /** Operations intentionally retained between turns. */
  readonly agenda: readonly AgendaItem[];
  /** Primary user interaction awaiting an answer, when present. */
  readonly interaction?: Interaction;
  /** Durable receipts for coordinated external effects. */
  readonly effects: readonly EffectReceipt[];
  /** Durable objective and fact-triggered progression occurrences, when configured. */
  readonly progression?: ProgressionState;
}
