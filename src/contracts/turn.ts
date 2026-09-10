import type { AgentId, ThreadId, TurnId } from "./ids.js";
import type { InteractionId } from "./ids.js";
import type { KernelCheckpoint } from "./checkpoint.js";
import type { TurnResponse } from "./response.js";

/** Host-verified answer produced by a clicked interaction control. */
export interface TurnSelection {
  /** Active interaction identity recovered from the rendered control. */
  readonly interactionId: InteractionId;
  /** Trusted server option identity selected by the user. */
  readonly optionId?: string;
  /** Trusted interaction action such as pagination. */
  readonly action?: string;
}

/** Public input for one compiled-agent turn. */
export interface RunTurnInput {
  /** Durable conversation identity. */
  readonly threadId: ThreadId;
  /** Idempotent identity for this exact host request. */
  readonly turnId: TurnId;
  /** Current natural-language user input. */
  readonly input: Readonly<{ text: string }>;
  /** Optional host-generated summary paired with explicit history omissions. */
  readonly summary?: string;
  /** Serializable, turn-scoped metadata exposed only to capability implementations. */
  readonly hostContext?: unknown;
  /** Optional verified clicked control returned by the host UI. */
  readonly selection?: TurnSelection;
  /** Optional caller cancellation signal combined with the turn timeout. */
  readonly signal?: AbortSignal;
}

/** Public result committed exactly once for one turn. */
export interface TurnResult {
  /** Validated response returned to the user channel. */
  readonly response: TurnResponse;
  /** Successor state committed atomically with this result. */
  readonly checkpoint: KernelCheckpoint;
  /** Durable conversation identity. */
  readonly threadId: ThreadId;
  /** Idempotent request identity. */
  readonly turnId: TurnId;
  /** Correlation identity shared by all first-execution events. */
  readonly traceId: string;
  /** True when durability returned an already committed turn. */
  readonly replayed: boolean;
}

/** Immutable agent executable produced by {@link IntentionKernel.compile}. */
export interface CompiledAgent {
  /** Agent identity from the compiled manifest. */
  readonly id: AgentId;
  /** Agent manifest version. */
  readonly version: number;
  /** Deterministic compatibility hash for persisted checkpoints. */
  readonly fingerprint: string;
  /** Execute and atomically commit one conversational turn. */
  run(input: RunTurnInput): Promise<TurnResult>;
}
