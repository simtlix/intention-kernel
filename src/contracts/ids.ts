import { IntentionKernelError } from "./errors.js";

declare const brand: unique symbol;
/** Nominal string used to keep unrelated kernel identifiers distinct at compile time. */
export type BrandedId<Name extends string> = string & { readonly [brand]: Name };

/** Stable capability identifier such as `product.search`. */
export type CapabilityId = BrandedId<"CapabilityId">;
/** Stable fact type such as `product.candidates`. */
export type FactType = BrandedId<"FactType">;
/** Stable policy identifier. */
export type PolicyId = BrandedId<"PolicyId">;
/** Stable agent identifier. */
export type AgentId = BrandedId<"AgentId">;
/** Stable thread identifier supplied by the host. */
export type ThreadId = BrandedId<"ThreadId">;
/** Stable turn identifier supplied by the host. */
export type TurnId = BrandedId<"TurnId">;
/** Stable plan step identifier. */
export type StepId = BrandedId<"StepId">;
/** Stable intention identifier. */
export type IntentionId = BrandedId<"IntentionId">;
/** Stable evidence identifier. */
export type EvidenceId = BrandedId<"EvidenceId">;
/** Stable interaction identifier. */
export type InteractionId = BrandedId<"InteractionId">;
/** Stable agenda item identifier. */
export type AgendaItemId = BrandedId<"AgendaItemId">;
/** Stable effect identifier. */
export type EffectId = BrandedId<"EffectId">;

const SEGMENT = /^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/;

function checkedId<Name extends string>(value: string, kind: Name): BrandedId<Name> {
  if (!SEGMENT.test(value)) {
    throw new IntentionKernelError({
      code: "INVALID_IDENTIFIER",
      message: `${kind} must use dot or hyphen separated segments beginning with a lowercase letter.`,
      retryable: false,
      context: { kind, value },
    });
  }
  return value as BrandedId<Name>;
}

/** Validate and brand a capability ID. */
export const capabilityId = (value: string): CapabilityId => checkedId(value, "CapabilityId");
/** Validate and brand a fact type. */
export const factType = (value: string): FactType => checkedId(value, "FactType");
/** Validate and brand a policy ID. */
export const policyId = (value: string): PolicyId => checkedId(value, "PolicyId");
/** Validate and brand an agent ID. */
export const agentId = (value: string): AgentId => checkedId(value, "AgentId");

/** Brand a host-generated thread ID after checking it is non-empty. */
export function threadId(value: string): ThreadId {
  if (value.trim().length === 0) throwInvalidOpaqueId("ThreadId");
  return value as ThreadId;
}

/** Brand a host-generated turn ID after checking it is non-empty. */
export function turnId(value: string): TurnId {
  if (value.trim().length === 0) throwInvalidOpaqueId("TurnId");
  return value as TurnId;
}

/** Brand a host- or capability-generated evidence ID after checking it is non-empty. */
export function evidenceId(value: string): EvidenceId {
  if (value.trim().length === 0) throwInvalidOpaqueId("EvidenceId");
  return value as EvidenceId;
}

/** Brand a host- or capability-generated interaction ID after checking it is non-empty. */
export function interactionId(value: string): InteractionId {
  if (value.trim().length === 0) throwInvalidOpaqueId("InteractionId");
  return value as InteractionId;
}

/** Brand a durability-adapter-generated effect ID after checking it is non-empty. */
export function effectId(value: string): EffectId {
  if (value.trim().length === 0) throwInvalidOpaqueId("EffectId");
  return value as EffectId;
}

function throwInvalidOpaqueId(kind: string): never {
  throw new IntentionKernelError({
    code: "INVALID_IDENTIFIER",
    message: `${kind} must not be empty.`,
    retryable: false,
    context: { kind },
  });
}
