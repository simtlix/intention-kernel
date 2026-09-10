import { z } from "zod";

import type {
  Contradiction,
  LifecycleAction,
  ContextReference,
  IntentionBatch,
  IntentionEvidence,
  IntentionRequest,
} from "../contracts/intention.js";
import { capabilityId } from "../contracts/ids.js";
import type { AgendaItemId, CapabilityId, IntentionId } from "../contracts/ids.js";
import type { Interaction, InteractionAnswer } from "../contracts/interaction.js";
import type { KernelIdGenerator } from "../contracts/runtime.js";
import { defineSchema } from "../schema/runtimeSchema.js";
import { deepFreeze } from "../context/deepFreeze.js";

// Keep structured model outputs aligned with the public identifier contract.
// Segments start lowercase but may contain camelCase after their first letter.
const stableId = z.string().regex(/^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/);
const evidenceSchema = z.strictObject({
  text: z.string().min(1),
  meaning: z.string().min(1),
  messageIndex: z.number().int().nonnegative(),
});
const referenceSchema = z.strictObject({
  expression: z.string().min(1),
  target: z.string().min(1).describe("Exactly one target identifier from the supplied context. Never combine multiple identifiers."),
  evidence: z.string().min(1),
});
const intentionFields = {
    objective: z.string().min(1),
    rationale: z.string().min(1).max(1200).describe("Brief decision justification based on the cited evidence and canonical context, not private chain-of-thought.").optional(),
    evidence: z.array(evidenceSchema).min(1),
    references: z.array(referenceSchema),
    input: z.unknown().nullish(),
    alternatives: z.array(z.string().min(1)).nullish(),
};
// Structural branches survive JSON Schema projection; superRefine does not.
// Generation and runtime validation must express the same resolution contract.
const intentionSchema = z.discriminatedUnion("resolution", [
  z.strictObject({ ...intentionFields, resolution: z.literal("resolved"),
    proposedCapability: stableId.describe("Use exactly one capability identifier from the selected contract set.") }),
  z.strictObject({ ...intentionFields, resolution: z.literal("ambiguous"),
    proposedCapability: z.null().optional(), alternatives: z.array(z.string().min(1)).min(2) }),
  z.strictObject({ ...intentionFields, resolution: z.literal("unsupported"),
    proposedCapability: z.null().optional() }),
]);
const answerSchema = z.strictObject({
  interactionId: z.string().min(1),
  value: z.unknown(),
  evidence: z.string().min(1),
  rationale: z.string().min(1).max(1200).describe("Explain briefly why the quoted words answer this exact active interaction; distinguish answering it from requesting an independent operation.").optional(),
});
const contradictionSchema = z.strictObject({
  description: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
});
const lifecycleActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("cancel_agenda_item"),
    targetId: z.string().min(1),
    evidence: evidenceSchema,
  }),
  z.strictObject({
    kind: z.literal("cancel_objective"),
    targetId: z.string().min(1),
    evidence: evidenceSchema,
  }),
]);
const rawBatchSchema = z.strictObject({
  answerToInteraction: answerSchema.nullish(),
  intentions: z.array(intentionSchema),
  contradictions: z.array(contradictionSchema),
  lifecycleActions: z.array(lifecycleActionSchema).optional(),
});

function withoutModelOwnedIntentionIds(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !Array.isArray((value as Record<string, unknown>)["intentions"])) {
    return value;
  }
  return {
    ...(value as Record<string, unknown>),
    intentions: ((value as Record<string, unknown>)["intentions"] as unknown[]).map((candidate) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return candidate;
      const intention = { ...(candidate as Record<string, unknown>) };
      delete intention["id"];
      return intention;
    }),
  };
}

const capabilitySelectionEvidenceSchema = z.strictObject({
  text: z.string().min(1),
  meaning: z.string().min(1),
  messageIndex: z.number().int().nonnegative(),
});

/** Compact semantic routing result produced before parameter interpretation. */
export interface CapabilitySelection {
  /** Kernel-bound result of the current choice review; never accepted from routing model output. */
  readonly reviewedChoice?: Readonly<{
    interactionId: string;
    optionId: string;
    messageIndex: number;
    evidence: string;
    rationale: string;
  }>;
  /** Internal provenance; never accepted from the model output schema. */
  readonly source?: "model" | "kernel_boundary";
  /** Kernel-added contract availability, kept separate from the model rationale. */
  readonly adjustments?: readonly Readonly<{ code: string; capabilityId: CapabilityId }>[];
  /** Whether the turn maps to capabilities, has no supported match or is purely conversational. */
  readonly mode: "selected" | "selected_with_control" | "no_match" | "conversational" | "control";
  /** Minimal set of plausible capabilities required to interpret every explicit objective. */
  readonly capabilityIds: readonly CapabilityId[];
  /** Concise auditable explanation, never private chain-of-thought. */
  readonly rationale: string;
  /** Exact visible text supporting the routing decision. */
  readonly evidence: readonly IntentionEvidence[];
}

/** Build a runtime schema that rejects capability identifiers outside the compiled agent. */
export function createCapabilitySelectionSchema(
  allowedCapabilityIds: readonly CapabilityId[],
) {
  const allowed = new Set<string>(allowedCapabilityIds);
  const rawSelectionSchema = z.strictObject({
    mode: z.enum(["selected", "selected_with_control", "no_match", "conversational", "control"]),
    capabilityIds: z.array(stableId).max(allowedCapabilityIds.length),
    rationale: z.string().min(1),
    evidence: z.array(capabilitySelectionEvidenceSchema).min(1),
  }).superRefine((value, context) => {
    for (const [index, id] of value.capabilityIds.entries()) {
      if (!allowed.has(id)) {
        context.addIssue({
          code: "custom",
          message: "Capability is not present in the compiled agent.",
          path: ["capabilityIds", index],
        });
      }
    }
    if (new Set(value.capabilityIds).size !== value.capabilityIds.length) {
      context.addIssue({ code: "custom", message: "Capability identifiers must be unique.", path: ["capabilityIds"] });
    }
    if ((value.mode === "selected" || value.mode === "selected_with_control") && value.capabilityIds.length === 0) {
      context.addIssue({ code: "custom", message: "Selected modes require at least one capability.", path: ["capabilityIds"] });
    }
    if (value.mode !== "selected" && value.mode !== "selected_with_control" && value.capabilityIds.length !== 0) {
      context.addIssue({ code: "custom", message: "Only selected modes may include capabilities.", path: ["capabilityIds"] });
    }
  });
  return defineSchema<CapabilitySelection>({
    vendor: "zod",
    validate: (value) => {
      const parsed = rawSelectionSchema.safeParse(value);
      if (!parsed.success) {
        return { issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
      }
      return {
        value: deepFreeze({
          mode: parsed.data.mode,
          capabilityIds: parsed.data.capabilityIds.map(capabilityId),
          rationale: parsed.data.rationale,
          evidence: parsed.data.evidence.map((entry): IntentionEvidence => ({ ...entry })),
        }),
      };
    },
    jsonSchema: () => z.toJSONSchema(rawSelectionSchema),
  });
}

/** Build the strict model contract while keeping durable intention identifiers under kernel authority. */
export function createIntentionBatchSchema(
  ids: KernelIdGenerator,
  selectedCapabilityIds: readonly CapabilityId[],
  interaction?: Interaction,
  mode?: CapabilitySelection["mode"],
) {
  const allowed = [...new Set(selectedCapabilityIds)];
  const resolvedSchema = allowed.length > 0 ? intentionSchema.options[0].extend({
    proposedCapability: z.enum(allowed).describe("Exactly one selected executable capability ID. Guidance policy IDs are not capabilities."),
  }) : undefined;
  const unresolvedSchema = z.discriminatedUnion("resolution", [intentionSchema.options[1], intentionSchema.options[2]]);
  const selectedIntentionSchema = resolvedSchema === undefined ? unresolvedSchema
    : z.discriminatedUnion("resolution", [resolvedSchema, intentionSchema.options[1], intentionSchema.options[2]]);
  const optionIds = interaction?.kind === "choice" ? interaction.options?.map(option => option.id) ?? [] : [];
  const boundedBatchSchema = rawBatchSchema.extend({
    intentions: mode === "conversational"
      ? resolvedSchema === undefined ? z.array(unresolvedSchema).max(0) : z.array(resolvedSchema)
      : z.array(selectedIntentionSchema),
    lifecycleActions: mode !== undefined && mode !== "control" && mode !== "selected_with_control"
      ? z.array(lifecycleActionSchema).max(0).optional()
      : rawBatchSchema.shape.lifecycleActions,
  });
  // Generation only needs public option identifiers. Structured host values are
  // recovered and semantically reviewed by interpretTurn, never reconstructed.
  // Retain validation compatibility for gateways returning exact legacy values;
  // the same active-option and consent boundaries still apply after parsing.
  const generationSchema = interaction !== undefined && optionIds.length > 0
    ? boundedBatchSchema.extend({ answerToInteraction: answerSchema.extend({
        interactionId: z.literal(interaction.id),
        value: z.enum(optionIds).describe("Exactly one current option ID. Omit the answer when the message does not unambiguously select an option."),
      }).nullish() })
    : boundedBatchSchema;
  return defineSchema<IntentionBatch>({
    vendor: "zod",
    validate: (value) => {
      const parsed = boundedBatchSchema.safeParse(withSoleSelectedCapability(
        withoutModelOwnedIntentionIds(value),
        allowed.length === 1 ? allowed[0] : undefined,
      ));
      if (!parsed.success) {
        return {
          issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
        };
      }
      const batch: IntentionBatch = {
        ...(parsed.data.answerToInteraction == null
          ? {}
          : { answerToInteraction: toInteractionAnswer(parsed.data.answerToInteraction) }),
        intentions: parsed.data.intentions.map((intention) =>
          toIntention(intention, ids.next("intention") as IntentionId)),
        contradictions: parsed.data.contradictions.map(toContradiction),
        ...(parsed.data.lifecycleActions === undefined
          ? {}
          : { lifecycleActions: parsed.data.lifecycleActions.map(toLifecycleAction) }),
      };
      return { value: deepFreeze(batch) };
    },
    jsonSchema: () => z.toJSONSchema(generationSchema),
  });
}

function withSoleSelectedCapability(value: unknown, capability: CapabilityId | undefined): unknown {
  if (
    capability === undefined ||
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as Record<string, unknown>)["intentions"])
  ) {
    return value;
  }
  return {
    ...(value as Record<string, unknown>),
    intentions: ((value as Record<string, unknown>)["intentions"] as unknown[]).map((candidate) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return candidate;
      const intention = candidate as Record<string, unknown>;
      if (intention["resolution"] !== "resolved" || intention["proposedCapability"] != null) return candidate;
      return { ...intention, proposedCapability: capability };
    }),
  };
}

function toLifecycleAction(value: z.infer<typeof lifecycleActionSchema>): LifecycleAction {
  if (value.kind === "cancel_agenda_item") {
    return {
      kind: value.kind,
      targetId: value.targetId as AgendaItemId,
      evidence: { ...value.evidence },
    };
  }
  return {
    kind: value.kind,
    targetId: value.targetId,
    evidence: { ...value.evidence },
  };
}

function toInteractionAnswer(value: z.infer<typeof answerSchema>): InteractionAnswer {
  return {
    interactionId: value.interactionId as InteractionAnswer["interactionId"],
    value: value.value,
    evidence: value.evidence,
    ...(value.rationale === undefined ? {} : { rationale: value.rationale }),
  };
}

function toIntention(value: z.infer<typeof intentionSchema>, id: IntentionId): IntentionRequest {
  return {
    id,
    objective: value.objective,
    ...(value.rationale === undefined ? {} : { rationale: value.rationale }),
    evidence: value.evidence.map((entry): IntentionEvidence => ({ ...entry })),
    references: value.references.map((entry): ContextReference => ({ ...entry })),
    ...(value.proposedCapability == null ? {} : { proposedCapability: capabilityId(value.proposedCapability) }),
    ...(value.input === undefined ? {} : { input: value.input }),
    resolution: value.resolution,
    ...(value.alternatives == null ? {} : { alternatives: value.alternatives }),
  };
}

function toContradiction(value: z.infer<typeof contradictionSchema>): Contradiction {
  return { description: value.description, evidence: value.evidence };
}
