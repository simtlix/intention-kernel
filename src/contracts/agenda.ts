import type { FactRequirement } from "./facts.js";
import type { AgendaItemId } from "./ids.js";
import type { IntentionRequest } from "./intention.js";

/** Unresolved work persisted between turns. */
export interface AgendaItem {
  /** Kernel-generated identity for this pending operation. */
  readonly id: AgendaItemId;
  /** Original interpreted objective retained for later resumption. */
  readonly intention: IntentionRequest;
  /** Current reason the operation is pending or ready. */
  readonly status:
    | "ready"
    | "waiting_input"
    | "waiting_facts"
    | "waiting_confirmation"
    | "blocked";
  /** Facts that must exist before this operation can run. */
  readonly missingFacts: readonly FactRequirement[];
  /** Other agenda items that must complete before this one. */
  readonly dependencies: readonly AgendaItemId[];
  /** Capability-owned opaque state required to resume this work. */
  readonly continuation?: unknown;
  /** Kernel-private values removed from model-visible conversation context. */
  readonly modelRedactions?: readonly string[];
}
