import { kernelPrompt } from "../prompts/catalog.js";
import { ModelGatewayError } from "../contracts/errors.js";
import type { ModelGateway, ModelRequest } from "../contracts/model.js";
import type { ResponseBrief, ResponseClaim, TurnResponse } from "../contracts/response.js";
import type { ResponseDelivery } from "./buildResponseBrief.js";
import { deepFreeze } from "../context/deepFreeze.js";
import { groundingReviewSchema, responseDraftSchema, type GroundingReview, type ResponseDraft } from "./schemas.js";
import { verifyGrounding } from "./verifyGrounding.js";
import { joinCanonicalMessages } from "./joinCanonicalMessages.js";

type ResponseModels = Readonly<{
  compose?: string;
  review?: string;
  reviewRepair?: string;
}>;

/** Deliver fully represented canonical results/input, or compose and review other work with one bounded repair. */
export async function composeResponse(options: {
  readonly brief: ResponseBrief;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
  readonly models?: ResponseModels;
  /** Original server-owned outputs, kept outside all model requests. */
  readonly delivery?: ResponseDelivery;
  /** Capability-owned delivery text, kept outside the model-facing brief. */
  readonly protectedCanonicalMessage?: string;
}): Promise<TurnResponse> {
  const delivery = options.delivery ?? options.brief;
  if (options.protectedCanonicalMessage !== undefined && delivery.interaction !== undefined) {
    const required = delivery.requiredResponses ?? [];
    const completed = options.delivery?.completedResponses ?? required;
    const message = joinCanonicalMessages([...completed.map((response) => response.message), options.protectedCanonicalMessage]);
    const claims = completed.flatMap((response) => response.claims);
    if (verifyGrounding({ message, claims }, deliveryBrief(options.brief, delivery)).length > 0) {
      throw new ModelGatewayError({ code: "UNGROUNDED_RESPONSE", message: "Required delivery content failed citation validation.", retryable: false });
    }
    return deepFreeze(structuredClone({
      status: "completed",
      grounded: true,
      source: "canonical",
      message,
      claims,
      interaction: delivery.interaction,
      artifacts: delivery.artifacts,
      } satisfies TurnResponse));
  }
  // A model cannot reproduce exact required copy that was redacted in its brief.
  // Deliver that already-authorized canonical result without disclosing it to a model.
  const requiredInvitationRedacted = ((delivery.requiredResponses?.length ?? 0) > 0 ||
    delivery.interaction?.responseMode === "contextual") &&
    delivery.interaction !== undefined && delivery.interaction.mode !== "optional" &&
    delivery.interaction.goal !== options.brief.interaction?.goal;
  if (requiredInvitationRedacted || JSON.stringify(delivery.requiredResponses) !== JSON.stringify(options.brief.requiredResponses)) {
    const fallback = verifiedCanonicalFallback(options.brief, delivery);
    if (fallback !== undefined) return fallback;
    throw new ModelGatewayError({ code: "UNGROUNDED_RESPONSE", message: "Required delivery content failed citation validation.", retryable: false });
  }
  const hasRequiredResults = (delivery.requiredResponses?.length ?? 0) > 0;
  const completedResponses = options.delivery?.completedResponses ?? delivery.requiredResponses ?? [];
  const canonicalMessage = delivery.canonicalFallback?.message;
  // Separate authored answers can share a required span without containing each
  // other. Keep normal composition when a lossless join would repeat that span;
  // never rewrite their claims or weaken the exactly-once grounding contract.
  const overlappingCopy = canonicalMessage !== undefined && (delivery.requiredResponses ?? []).some(response =>
    canonicalMessage.indexOf(response.message) !== canonicalMessage.lastIndexOf(response.message));
  const canDeliverCompleted = completedResponses.length === options.brief.completed.length && !overlappingCopy;
  const decision = options.brief.decision?.mode;
  const hasSeparateDecision = decision === "control" || decision === "selected_with_control" || decision === "no_match";
  const collectingOnly = options.brief.completed.length === 0 &&
    delivery.interaction !== undefined && delivery.interaction.mode !== "optional";
  // Models cannot add outcomes or decisions to a response that the server already
  // supplies in full. Mixed work without authored copy, issues and lifecycle
  // acknowledgements still need the existing natural composition path.
  if (options.brief.issues.length === 0 && !hasSeparateDecision &&
    delivery.interaction?.responseMode !== "contextual" &&
    ((hasRequiredResults && canDeliverCompleted) || collectingOnly)) {
    const fallback = verifiedCanonicalFallback(options.brief, delivery);
    if (fallback !== undefined) return fallback;
    throw new ModelGatewayError({ code: "UNGROUNDED_RESPONSE", message: "Canonical delivery content failed validation.", retryable: false });
  }
  try {
    return await composeGroundedResponse(options);
  } catch (error) {
    if (isStructuralModelFailure(error)) {
      const fallback = verifiedCanonicalFallback(options.brief, delivery);
      if (fallback !== undefined) return fallback;
    }
    throw error;
  }
}

async function composeGroundedResponse(options: {
  readonly brief: ResponseBrief;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
  readonly models?: ResponseModels;
  readonly delivery?: ResponseDelivery;
}): Promise<TurnResponse> {
  let draft = await invokeDraft(options.gateway, {
    task: "response.compose",
    ...(options.models?.compose === undefined ? {} : { model: options.models.compose }),
    ...kernelPrompt("kernel.response.compose"),
    input: options.brief,
    outputSchema: responseDraftSchema,
    capabilities: [],
    signal: options.signal,
  });
  let { review, staticIssues, semanticIssues } = await assessGrounding(options, draft);
  if (staticIssues.length === 0 && review.verdict === "supported") {
    return completeResponse(draft, options.delivery ?? options.brief, draft.claims);
  }

  draft = await invokeDraft(options.gateway, {
    task: "response.compose.repair",
    ...(options.models?.compose === undefined ? {} : { model: options.models.compose }),
    ...kernelPrompt("kernel.compose-response.compose-repair"),
    input: {
      brief: options.brief,
      rejectedResponse: draft,
      issues: [...staticIssues, ...semanticIssues],
    },
    outputSchema: responseDraftSchema,
    capabilities: [],
    signal: options.signal,
  });
  ({ review, staticIssues, semanticIssues } = await assessGrounding(options, draft));
  if (staticIssues.length === 0 && review.verdict === "supported") {
    return completeResponse(draft, options.delivery ?? options.brief, draft.claims);
  }

  const fallback = verifiedCanonicalFallback(options.brief, options.delivery ?? options.brief);
  if (fallback !== undefined) return fallback;

  throw new ModelGatewayError({
    code: "UNGROUNDED_RESPONSE",
    message: "The response remained ungrounded after one bounded recomposition.",
    retryable: false,
    context: { staticIssues: JSON.stringify(staticIssues), semanticIssues: JSON.stringify(semanticIssues) },
  });
}

function deliveryBrief(brief: ResponseBrief, delivery: ResponseDelivery): ResponseBrief {
  return { ...brief, ...delivery, evidence: [...brief.evidence, ...delivery.evidence] };
}

function verifiedCanonicalFallback(brief: ResponseBrief, delivery: ResponseDelivery): TurnResponse | undefined {
  const fallback = delivery.canonicalFallback;
  const hasRequiredResults = (delivery.requiredResponses?.length ?? 0) > 0;
  if (hasRequiredResults && delivery.completedResponses !== undefined && delivery.completedResponses.length < brief.completed.length) return undefined;
  const authoritativeBrief = deliveryBrief(brief, delivery);
  if (fallback === undefined || verifyGrounding(fallback, authoritativeBrief).length > 0 ||
    requiredInvitationIssues(fallback, authoritativeBrief).length > 0) return undefined;
  if (!hasRequiredResults && brief.completed.length === 0 && delivery.interaction !== undefined &&
    (fallback.message !== delivery.interaction.goal || fallback.claims.length !== 0)) return undefined;
  return deepFreeze(structuredClone({
    status: "completed",
    grounded: true,
    source: "canonical",
    message: fallback.message,
    claims: fallback.claims,
    ...(delivery.interaction === undefined ? {} : { interaction: delivery.interaction }),
    artifacts: delivery.artifacts,
  } satisfies TurnResponse));
}

async function assessGrounding(
  options: {
    readonly brief: ResponseBrief;
    readonly gateway: ModelGateway;
    readonly signal: AbortSignal;
    readonly models?: ResponseModels;
  },
  draft: ResponseDraft,
): Promise<Readonly<{
  review: GroundingReview;
  staticIssues: readonly string[];
  semanticIssues: readonly string[];
}>> {
  const staticIssues = [...verifyGrounding(draft, options.brief), ...requiredInvitationIssues(draft, options.brief)];
  const review = await reviewGrounding(options, draft);
  const expected = draft.claims.map((_claim, index) => index);
  const approved = [...new Set(review.approvedClaimIndexes)].sort((left, right) => left - right);
  const approvalsComplete = approved.length === expected.length &&
    approved.every((value, index) => value === expected[index]);
  const continuityIssues = review.continuityVerdict === "violated"
    ? ["The proposed response violates conversational continuity."]
    : [];
  const decisionIssues = review.decisionVerdict === "violated"
    ? ["The proposed response does not implement the validated current-turn decision."]
    : [];
  const semanticIssues = review.verdict === "supported" && !approvalsComplete
    ? [...review.unsupportedClaims, ...continuityIssues, ...decisionIssues, "The reviewer did not approve every proposed claim."]
    : [...review.unsupportedClaims, ...continuityIssues, ...decisionIssues];
  const normalizedReview = review.verdict === "supported" && (
    !approvalsComplete || review.unsupportedClaims.length > 0 || review.continuityVerdict === "violated" || review.decisionVerdict === "violated"
  )
    ? { ...review, verdict: "unsupported" as const }
    : review;
  return { review: normalizedReview, staticIssues, semanticIssues };
}

function requiredInvitationIssues(draft: ResponseDraft, brief: ResponseBrief): readonly string[] {
  const interaction = brief.interaction;
  const requiresInvitation = ((brief.requiredResponses?.length ?? 0) > 0 ||
    interaction?.responseMode === "contextual") &&
    interaction !== undefined && interaction.mode !== "optional";
  // Required result delivery must not erase the authoritative next question.
  // Check the registered goal itself, not language-dependent question patterns.
  return requiresInvitation &&
    (!draft.message.includes(interaction.goal) ||
      draft.message.indexOf(interaction.goal) !== draft.message.lastIndexOf(interaction.goal) ||
      brief.requiredResponses?.some((response) => {
        // A capability may already end its verified answer with this exact goal.
        // Count that suffix once, while still rejecting a question before other
        // required result content or a duplicated invitation.
        const resultLength = response.message.endsWith(interaction.goal)
          ? response.message.length - interaction.goal.length
          : response.message.length;
        return draft.message.indexOf(interaction.goal) < draft.message.indexOf(response.message) + resultLength;
      }))
    ? ["Include the exact active interaction goal once after the required results."]
    : [];
}

/** Technical-only fallback that cannot be mistaken for a successful business answer. */
export function technicalFailureResponse(traceId?: string): TurnResponse {
  return Object.freeze({
    status: "failed",
    grounded: false,
    source: "technical_fallback",
    message: "I couldn't complete this turn safely. Please try again.",
    claims: Object.freeze([]),
    artifacts: Object.freeze([]),
    ...(traceId === undefined ? {} : { traceId }),
  });
}

async function invokeDraft(gateway: ModelGateway, request: ModelRequest<ResponseDraft>): Promise<ResponseDraft> {
  const result = await gateway.invoke(request);
  const validation = await responseDraftSchema.validate(result.value);
  if (validation.ok) return validation.value;
  throw new ModelGatewayError({
    code: "MODEL_OUTPUT_INVALID",
    message: "The response model returned invalid structured output.",
    retryable: false,
    context: { task: request.task, issues: validation.issues.length },
  });
}

async function reviewGrounding(
  options: {
    readonly brief: ResponseBrief;
    readonly gateway: ModelGateway;
    readonly signal: AbortSignal;
    readonly models?: ResponseModels;
  },
  draft: ResponseDraft,
): Promise<GroundingReview> {
  const input = {
    response: draft,
    brief: options.brief,
  };
  const request: ModelRequest<GroundingReview> = {
    task: "response.grounding-review",
    ...(options.models?.review === undefined ? {} : { model: options.models.review }),
    ...kernelPrompt("kernel.response.grounding-review"),
    input,
    outputSchema: groundingReviewSchema,
    capabilities: [],
    signal: options.signal,
  };
  try {
    return await invokeGroundingReview(options.gateway, request);
  } catch (error) {
    if (!isStructuralModelFailure(error)) throw error;
  }
  const repairModel = options.models?.reviewRepair ?? options.models?.review;
  const repairRequest: ModelRequest<GroundingReview> = {
    ...request,
    task: "response.grounding-review.repair",
    ...(repairModel === undefined ? {} : { model: repairModel }),
    ...kernelPrompt("kernel.response.grounding-review.repair"),
    input,
  };
  try {
    return await invokeGroundingReview(options.gateway, repairRequest);
  } catch (error) {
    if (!isStructuralModelFailure(error)) throw error;
  }
  throw new ModelGatewayError({
    code: "MODEL_OUTPUT_INVALID",
    message: "The grounding reviewer returned invalid structured output after one repair.",
    retryable: false,
    context: { task: request.task, attempts: 2 },
  });
}

async function invokeGroundingReview(
  gateway: ModelGateway,
  request: ModelRequest<GroundingReview>,
): Promise<GroundingReview> {
  const result = await gateway.invoke(request);
  const validation = await groundingReviewSchema.validate(result.value);
  if (validation.ok) return validation.value;
  throw new ModelGatewayError({
    code: "MODEL_OUTPUT_INVALID",
    message: "The grounding reviewer returned invalid structured output.",
    retryable: false,
    context: { task: request.task, issues: validation.issues.length },
  });
}

function isStructuralModelFailure(error: unknown): boolean {
  if (!(error instanceof ModelGatewayError)) return false;
  return ["MODEL_EMPTY_RESPONSE", "MODEL_JSON_INVALID", "MODEL_OUTPUT_INVALID"].includes(error.code);
}

function completeResponse(draft: ResponseDraft, delivery: ResponseDelivery, claims: readonly ResponseClaim[]): TurnResponse {
  return deepFreeze(structuredClone({
    status: "completed",
    grounded: true,
    source: "model",
    message: draft.message,
    claims,
    ...(delivery.interaction === undefined ? {} : { interaction: delivery.interaction }),
    artifacts: delivery.artifacts,
  } satisfies TurnResponse));
}
