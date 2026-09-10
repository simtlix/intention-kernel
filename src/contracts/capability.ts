import { IntentionKernelError } from "./errors.js";
import type { FactCandidate, FactDeclaration, FactRecord, FactReference, FactRequirement, EvidenceRecord } from "./facts.js";
import type { CapabilityId, StepId, ThreadId, TurnId } from "./ids.js";
import type { EffectAuthority, EffectExecution } from "./effects.js";
import type { ConversationMessage } from "./checkpoint.js";
import type { Interaction, InteractionAnswer } from "./interaction.js";
import type { IntentionRequest } from "./intention.js";
import type { CanonicalResponse } from "./response.js";
import type { RuntimeSchema } from "../schema/runtimeSchema.js";
import type { CapabilityAutomation } from "./progression.js";

/** Metadata accepted when a capability exposes observable domain progress. */
export interface CapabilityEventOptions {
  /** Event classification used by sinks to route traces, audits and integrations. */
  readonly category?: "trace" | "audit" | "integration";
}

/** Turn-scoped publisher for sanitized capability and nested-workflow events. */
export interface CapabilityEventPublisher {
  /**
   * Publish one named domain event in the causal branch of the current capability.
   *
   * @remarks
   * The kernel wraps the event as `capability.event`, associates it with the current
   * step and applies the configured redactor before it reaches the host sink. Event
   * names must use stable lowercase dot or hyphen segments, for example
   * `subgraph.node.started`.
   */
  emit(name: string, data: unknown, options?: CapabilityEventOptions): Promise<void>;
}

/** Structured artifact returned to a channel or UI. */
export interface Artifact {
  /** Stable channel-local identity for updates or rendering. */
  readonly id: string;
  /** Host-defined renderer or media discriminator. */
  readonly kind: string;
  /** Serializable payload interpreted only by the host channel. */
  readonly data: unknown;
}

/** Expected domain failure that is safe to expose through the response composer. */
export interface CapabilityIssue {
  /** Stable machine-readable domain code. */
  readonly code: string;
  /** Safe explanation available to the response composer. */
  readonly message: string;
  /** Whether a later user or infrastructure retry may be meaningful. */
  readonly retryable: boolean;
  /** Optional sanitized domain metadata. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Model-facing semantic guidance attached to one capability contract. */
export interface CapabilityGuidance {
  /** Situations in which this capability is an appropriate operation. */
  readonly whenToUse: readonly string[];
  /** Situations that resemble this operation but must not select it. */
  readonly whenNotToUse: readonly string[];
  /** Representative utterances used only as semantic examples. */
  readonly examples: readonly string[];
}

/** Model-reference requirements for capabilities that operate on active server-owned choices. */
export interface CapabilityReferenceRequirements {
  /** Authoritative target set exposed to the model for reference resolution. */
  readonly source: "active_interaction_options";
  /** Minimum number of distinct option targets required for execution. */
  readonly minimum: number;
  /** Maximum number of distinct option targets accepted for execution. */
  readonly maximum: number;
}

/** Runtime services available to a capability implementation. */
export interface CapabilityTurnContext {
  /** Conversation committed before the current user message. */
  readonly previousMessages: readonly ConversationMessage[];
  /** Current user message that produced this execution step. */
  readonly currentMessage: ConversationMessage;
  /** Optional host-generated summary paired with explicitly bounded history. */
  readonly summary?: string;
  /** Serializable, turn-scoped metadata supplied by the host application. */
  readonly hostContext?: unknown;
  /** Capability-owned opaque state persisted while its work remains open. */
  readonly continuation?: unknown;
  /** Sensitive values from prior capability state, available only to host code. */
  readonly modelRedactions?: readonly string[];
  /** Active interaction owned by this capability, when one exists. */
  readonly interaction?: Interaction;
  /** Structured answer to the active interaction, when the turn answered it. */
  readonly interactionAnswer?: InteractionAnswer;
}

/** Runtime services available to a capability implementation. */
export interface CapabilityExecutionContext {
  /** Complete model interpretation validated by the planner for this execution step. */
  readonly intention: IntentionRequest;
  /** Instance-scoped infrastructure adapters injected by the host. */
  readonly ports: Readonly<Record<string, unknown>>;
  /** Confirmed facts available before this capability executes. */
  readonly facts: readonly FactRecord[];
  /** Conversation and interaction information for this turn. */
  readonly turn: CapabilityTurnContext;
  /** Signal aborted by the caller or the configured turn timeout. */
  readonly signal: AbortSignal;
  /** Kernel-owned technical identity for correlating host-side work. */
  readonly execution: Readonly<{
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly stepId: StepId;
    readonly capabilityId: CapabilityId;
    /** Authority that caused this invocation within the current turn. */
    readonly trigger: "user" | "progression" | "dependency" | "resume";
  }>;
  /** Observable progress channel for domain adapters and nested workflows. */
  readonly events: CapabilityEventPublisher;
  /**
   * Coordinate one external write through the durability effect ledger.
   *
   * @remarks
   * Preserve the local key for the same logical operation across retries and
   * turns; use a different key for a distinct operation. The kernel prefixes
   * it with the capability ID, and the durability ledger scopes it by thread.
   * A completed receipt is replayed; an uncertain receipt is never called again
   * automatically. The callback receives provider authority, and the result
   * contains both the provider value and its durable receipt.
   */
  readonly runEffect: <T>(
    idempotencyKey: string,
    operation: (authority: EffectAuthority) => Promise<T>,
  ) => Promise<EffectExecution<T>>;
}

/** Result returned by a capability. */
export type CapabilityResult<TOutput> =
  | {
      readonly status: "completed";
      readonly output: TOutput;
      readonly facts: readonly FactCandidate[];
      readonly evidence: readonly EvidenceRecord[];
      readonly artifacts: readonly Artifact[];
      /** Evidence-backed copy used as a fallback, or delivered directly with fully represented required results. */
      readonly canonicalResponse?: CanonicalResponse;
      /**
       * Follow-up exposed while retaining completed output and facts.
       * Omit to preserve an unrelated pending interaction. Explicit null dismisses
       * only the previous interaction, not its agenda, facts or confirmation authority.
       * A new interaction produced by another step in this turn takes precedence.
       */
      readonly interaction?: Interaction | null;
      /** Opaque state needed to continue the optional follow-up. */
      readonly continuation?: unknown;
      readonly modelRedactions?: readonly string[];
    }
  | {
      readonly status: "needs_input";
      readonly interaction: Interaction;
      readonly partialInput?: unknown;
      /** Declared working-set facts made stale by entering this collection state. */
      readonly invalidates?: readonly FactReference[];
      readonly modelRedactions?: readonly string[];
    }
  | {
      /** A domain prerequisite must be produced by another registered capability. */
      readonly status: "needs_dependency";
      /** Exact fact contract that is still absent. */
      readonly requirement: FactRequirement;
      /** Explicit provider selected by the capability's domain contract. */
      readonly provider: Readonly<{
        readonly capabilityId: CapabilityId;
        readonly input: unknown;
      }>;
      /** Opaque state used to resume the consumer once the fact is available. */
      readonly continuation?: unknown;
      readonly modelRedactions?: readonly string[];
    }
  | {
      readonly status: "needs_confirmation";
      readonly interaction: Interaction;
      readonly proposedInput: unknown;
      readonly continuation?: unknown;
      readonly modelRedactions?: readonly string[];
    }
  | {
      readonly status: "failed";
      readonly issue: CapabilityIssue;
    };

/** Executable operation independent of its infrastructure adapters. */
export interface CapabilityDefinition<TInput, TOutput> {
  /** Stable semantic operation name visible to the model and planner. */
  readonly id: CapabilityId;
  /** Positive contract version included in compiled fingerprints. */
  readonly version: number;
  /** Precise model-visible operation description. */
  readonly description: string;
  /** Runtime validator and JSON Schema projection for proposed inputs. */
  readonly input: RuntimeSchema<TInput>;
  /** Runtime validator for completed outputs. */
  readonly output: RuntimeSchema<TOutput>;
  /** Confirmed facts required before execution. */
  readonly requires: readonly FactRequirement[];
  /** Versioned facts this capability may publish after completion. */
  readonly provides: readonly FactDeclaration[];
  /** Existing fact roots and descendants replaced after successful completion. */
  readonly invalidates: readonly FactReference[];
  /** Side-effect classification used to determine concurrency and safeguards. */
  readonly effect: "none" | "read" | "write";
  /** Required is kernel-owned; capability delegates confirmation to its own resumable interaction. */
  readonly confirmation: "none" | "required" | "capability";
  /** Optional semantic examples and exclusions shown to the interpreter. */
  readonly guidance?: CapabilityGuidance;
  /** Optional bounds for semantic references to current server-owned options. */
  readonly referenceRequirements?: CapabilityReferenceRequirements;
  /** Optional host-owned input factory used only by declarative progression authority. */
  readonly automation?: CapabilityAutomation;
  /** Execute this operation after the planner validates its input and prerequisites. */
  execute(
    context: CapabilityExecutionContext,
    input: TInput,
  ): Promise<CapabilityResult<TOutput>>;
}

/**
 * Define and freeze a capability contract without executing it.
 *
 * @throws {@link IntentionKernelError} when the version or description is invalid.
 * @returns The immutable operation definition consumed by an agent manifest.
 */
export function defineCapability<TInput, TOutput>(
  definition: Omit<CapabilityDefinition<TInput, TOutput>, "invalidates" | "confirmation"> &
    Partial<Pick<CapabilityDefinition<TInput, TOutput>, "invalidates" | "confirmation">>,
): CapabilityDefinition<TInput, TOutput> {
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new IntentionKernelError({
      code: "INVALID_CAPABILITY_VERSION",
      message: "Capability version must be a positive integer.",
      retryable: false,
      context: { capabilityId: definition.id, version: definition.version },
    });
  }
  if (definition.description.trim().length === 0) {
    throw new IntentionKernelError({
      code: "INVALID_CAPABILITY_DESCRIPTION",
      message: "Capability description must not be empty.",
      retryable: false,
      context: { capabilityId: definition.id },
    });
  }
  return Object.freeze({
    ...definition,
    requires: Object.freeze([...definition.requires]),
    provides: Object.freeze([...definition.provides]),
    invalidates: Object.freeze([...(definition.invalidates ?? [])]),
    confirmation: definition.confirmation ?? "none",
    ...(definition.referenceRequirements === undefined
      ? {}
      : { referenceRequirements: Object.freeze({ ...definition.referenceRequirements }) }),
    ...(definition.automation === undefined
      ? {}
      : { automation: Object.freeze({ ...definition.automation }) }),
  });
}
