import type { CompiledAgentDefinition } from "../compiler/compileAgentDefinition.js";
import type { AgendaItem } from "../contracts/agenda.js";
import type { ConversationMessage, KernelCheckpoint } from "../contracts/checkpoint.js";
import type { FactRecord } from "../contracts/facts.js";
import type { CapabilityId, PolicyId } from "../contracts/ids.js";
import type { CapabilityReferenceRequirements } from "../contracts/capability.js";
import type { Interaction } from "../contracts/interaction.js";
import type { TurnSelection } from "../contracts/turn.js";
import type { JsonSchema } from "../schema/runtimeSchema.js";
import { deepFreeze } from "./deepFreeze.js";
import { validateInteractionReferences } from "./validateInteractionReferences.js";
import type {
  ModelGuidancePolicyContext,
  SelectedModelGuidancePolicy,
} from "../contracts/modelGuidancePolicy.js";

/** Explicit record of information intentionally excluded from a model projection. */
export interface ProjectionOmission {
  readonly path: string;
  readonly reason: string;
  readonly omitted: number;
}

/** Bounded conversation view supplied consistently to every model task. */
export interface ConversationProjection {
  readonly recentMessages: readonly (ConversationMessage & { readonly index: number })[];
  readonly totalMessages: number;
  readonly summary?: string;
}

/** Capability contract and current prerequisite availability visible to a model. */
export interface CapabilityAvailability {
  readonly id: CapabilityId;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly availability: "ready" | "blocked";
  readonly blockedBy: readonly string[];
  readonly guidance?: Readonly<{
    readonly whenToUse: readonly string[];
    readonly whenNotToUse: readonly string[];
    readonly examples: readonly string[];
  }>;
  /** Required semantic references to current options, when declared by the capability. */
  readonly referenceRequirements?: CapabilityReferenceRequirements;
}

/** Prior non-secret decision exposed for conversational coherence. */
export interface DecisionProjection {
  readonly kind: string;
  readonly summary: string;
  readonly evidence: readonly string[];
}

/** Model-visible policy identity. Policy executable code remains private. */
export interface ModelPolicyProjection {
  readonly id: PolicyId;
  readonly version: number;
}

/** Single canonical, immutable source for every model prompt in a turn. */
export interface ContextSnapshot {
  readonly conversation: ConversationProjection;
  readonly currentMessage: ConversationMessage & { readonly index: number };
  readonly facts: readonly FactRecord[];
  readonly agenda: readonly AgendaItem[];
  /** Current configured objective and fact-triggered progression occurrences. */
  readonly progression?: KernelCheckpoint["progression"];
  readonly interaction?: Interaction;
  /** Turn-local clicked control, validated against the active interaction by the runtime. */
  readonly interactionSelection?: TurnSelection;
  readonly capabilities: readonly CapabilityAvailability[];
  readonly decisions: readonly DecisionProjection[];
  readonly agent: Readonly<{
    id: string;
    version: number;
    identity: string;
    modelPolicy: Readonly<Record<string, string>>;
  }>;
  readonly policies: readonly ModelPolicyProjection[];
  /** Contextual semantic guidance selected by pure host rules for this turn. */
  readonly selectedModelGuidancePolicies: readonly SelectedModelGuidancePolicy[];
  readonly omissions: readonly ProjectionOmission[];
}

/** Inputs required to build one immutable canonical context snapshot. */
export interface BuildContextSnapshotOptions {
  readonly checkpoint: KernelCheckpoint;
  readonly currentMessage: ConversationMessage;
  readonly compiled: CompiledAgentDefinition;
  readonly summary?: string;
  readonly decisions?: readonly DecisionProjection[];
  readonly recentMessageLimit?: number;
}

/** Build the canonical model context without relying on hidden process state. */
export function buildContextSnapshot(options: BuildContextSnapshotOptions): ContextSnapshot {
  validateInteractionReferences(options.checkpoint.interaction);
  const recentMessageLimit = options.recentMessageLimit ?? 20;
  if (!Number.isInteger(recentMessageLimit) || recentMessageLimit < 0) {
    throw new RangeError("recentMessageLimit must be a non-negative integer.");
  }

  const totalMessages = options.checkpoint.messages.length;
  const omittedMessages = Math.max(0, totalMessages - recentMessageLimit);
  const recentMessages = options.checkpoint.messages
    .slice(omittedMessages)
    .map((message, offset) => ({ ...message, index: omittedMessages + offset }));
  const availableFacts = new Set(
    options.checkpoint.facts.map((fact) => `${fact.type}@${String(fact.version)}`),
  );

  const capabilities = [...options.compiled.capabilities.values()]
    .sort((left, right) => compareText(left.id, right.id))
    .map((capability): CapabilityAvailability => {
      const blockedBy = capability.requires
        .filter((requirement) => !availableFacts.has(`${requirement.type}@${String(requirement.version)}`))
        .map((requirement) => requirement.description);
      const inputSchema = options.compiled.inputSchemas.get(capability.id);
      if (inputSchema === undefined) {
        throw new Error(`Compiled capability ${capability.id} has no input schema.`);
      }
      return {
        id: capability.id,
        description: capability.description,
        inputSchema,
        availability: blockedBy.length === 0 ? "ready" : "blocked",
        blockedBy,
        ...(capability.guidance === undefined ? {} : { guidance: capability.guidance }),
        ...(capability.referenceRequirements === undefined
          ? {}
          : { referenceRequirements: capability.referenceRequirements }),
      };
    });

  const guidanceContext = modelGuidanceContext(options.checkpoint, capabilities.map(({ id }) => id));
  const selectedModelGuidancePolicies = (options.compiled.definition.modelGuidancePolicies ?? [])
    .flatMap((policy): SelectedModelGuidancePolicy[] => {
      const match = policy.select(guidanceContext);
      if (!validGuidanceMatch(match)) {
        throw new Error(`Model guidance policy ${policy.id} returned an invalid selection result.`);
      }
      if (!match.selected) return [];
      return [{
        id: policy.id,
        version: policy.version,
        description: policy.description,
        instructions: policy.instructions,
        examples: policy.examples,
        counterExamples: policy.counterExamples,
        ...(policy.continueProgressionForCapabilities === undefined
          ? {}
          : {
              continueProgressionForCapabilities: [
                ...policy.continueProgressionForCapabilities,
              ],
            }),
        matchedSelectors: [...match.matchedSelectors],
      }];
    });

  const omissions: ProjectionOmission[] = [];
  if (omittedMessages > 0) {
    omissions.push({
      path: "conversation.messages",
      reason: "Outside the configured recent-message window; use the supplied summary when present.",
      omitted: omittedMessages,
    });
  }

  const clone = structuredClone({
    conversation: {
      recentMessages,
      totalMessages,
      ...(options.summary === undefined ? {} : { summary: options.summary }),
    },
    currentMessage: { ...options.currentMessage, index: totalMessages },
    facts: options.checkpoint.facts,
    agenda: options.checkpoint.agenda,
    ...(options.checkpoint.progression === undefined ? {} : { progression: options.checkpoint.progression }),
    ...(options.checkpoint.interaction === undefined
      ? {}
      : { interaction: options.checkpoint.interaction }),
    capabilities,
    decisions: options.decisions ?? [],
    agent: {
      id: options.compiled.definition.id,
      version: options.compiled.definition.version,
      identity: options.compiled.definition.identity,
      modelPolicy: options.compiled.definition.modelPolicy,
    },
    policies: options.compiled.definition.policies
      .map((policy) => ({ id: policy.id, version: policy.version }))
      .sort((left, right) => compareText(left.id, right.id)),
    selectedModelGuidancePolicies,
    omissions,
  }) as ContextSnapshot;

  return deepFreeze(clone);
}

function modelGuidanceContext(
  checkpoint: KernelCheckpoint,
  registeredCapabilityIds: readonly CapabilityId[],
): ModelGuidancePolicyContext {
  const activeCapabilityIds = new Set<CapabilityId>();
  if (checkpoint.interaction?.capabilityId !== undefined) {
    activeCapabilityIds.add(checkpoint.interaction.capabilityId);
  }
  for (const item of checkpoint.agenda) {
    if (item.intention.proposedCapability !== undefined) {
      activeCapabilityIds.add(item.intention.proposedCapability);
    }
  }
  for (const option of checkpoint.interaction?.options ?? []) {
    if (option.targetCapabilityId !== undefined) activeCapabilityIds.add(option.targetCapabilityId);
  }
  for (const occurrence of checkpoint.progression?.occurrences ?? []) {
    if (occurrence.activeMember !== undefined) activeCapabilityIds.add(occurrence.activeMember);
  }
  return deepFreeze(structuredClone({
    activeCapabilityIds: [...activeCapabilityIds].sort(compareText),
    registeredCapabilityIds: [...registeredCapabilityIds].sort(compareText),
    facts: checkpoint.facts,
    presentFactTypes: [...new Set(checkpoint.facts.map(({ type }) => type))].sort(compareText),
    agenda: checkpoint.agenda,
    ...(checkpoint.interaction === undefined ? {} : { interaction: checkpoint.interaction }),
    ...(checkpoint.progression === undefined ? {} : { progression: checkpoint.progression }),
  }));
}

function validGuidanceMatch(value: unknown): value is Readonly<{
  selected: boolean;
  matchedSelectors: readonly string[];
}> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["selected"] === "boolean" &&
    Array.isArray(candidate["matchedSelectors"]) &&
    candidate["matchedSelectors"].every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
