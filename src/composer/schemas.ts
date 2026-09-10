import { z } from "zod";

import type { EvidenceId } from "../contracts/ids.js";
import type { ResponseClaim } from "../contracts/response.js";
import { defineSchema } from "../schema/runtimeSchema.js";
import { deepFreeze } from "../context/deepFreeze.js";

const responsePartSchema = z.strictObject({
  text: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
});
const draftSchema = z.strictObject({
  parts: z.array(responsePartSchema).min(1),
});

/** Internal structured draft generated before grounding verification. */
export interface ResponseDraft {
  readonly message: string;
  readonly claims: readonly ResponseClaim[];
}

/** Runtime validator for an internal response draft. */
export const responseDraftSchema = defineSchema<ResponseDraft>({
  vendor: "zod",
  validate: (value) => {
    const parsed = draftSchema.safeParse(value);
    if (!parsed.success) return { issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
    const claims = parsed.data.parts.flatMap((part) => part.evidenceIds.length === 0
      ? []
      : [{ text: part.text, evidenceIds: part.evidenceIds as EvidenceId[] }]);
    return {
      value: deepFreeze({
        message: parsed.data.parts.map((part) => part.text).join(""),
        claims,
      }),
    };
  },
  jsonSchema: () => z.toJSONSchema(draftSchema),
});

const reviewSchema = z.strictObject({
  verdict: z.enum(["supported", "unsupported"]),
  continuityVerdict: z.enum(["supported", "violated"]),
  decisionVerdict: z.enum(["supported", "violated"]),
  unsupportedClaims: z.array(z.string()),
  approvedClaimIndexes: z.array(z.number().int().nonnegative()),
});

/** Internal semantic verdict for a proposed response. */
export interface GroundingReview {
  readonly verdict: "supported" | "unsupported";
  readonly continuityVerdict: "supported" | "violated";
  readonly decisionVerdict: "supported" | "violated";
  readonly unsupportedClaims: readonly string[];
  readonly approvedClaimIndexes: readonly number[];
}

/** Runtime validator for the semantic grounding verdict. */
export const groundingReviewSchema = defineSchema<GroundingReview>({
  vendor: "zod",
  validate: (value) => {
    const parsed = reviewSchema.safeParse(value);
    return parsed.success
      ? { value: deepFreeze({
          verdict: parsed.data.verdict,
          continuityVerdict: parsed.data.continuityVerdict,
          decisionVerdict: parsed.data.decisionVerdict,
          unsupportedClaims: parsed.data.unsupportedClaims,
          approvedClaimIndexes: parsed.data.approvedClaimIndexes,
        }) }
      : { issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
  },
  jsonSchema: () => z.toJSONSchema(reviewSchema),
});
