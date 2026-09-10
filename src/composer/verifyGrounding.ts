import type { ResponseBrief } from "../contracts/response.js";
import type { ResponseDraft } from "./schemas.js";

/** Deterministic citation checks performed before semantic grounding review. */
export function verifyGrounding(draft: ResponseDraft, brief: ResponseBrief): readonly string[] {
  const knownEvidence = new Set(brief.evidence.map((record) => record.id));
  const issues: string[] = [];
  for (const required of brief.requiredResponses ?? []) {
    const start = draft.message.indexOf(required.message);
    if (start < 0 || start !== draft.message.lastIndexOf(required.message)) {
      issues.push("Required completed result must appear exactly once in the response.");
    }
    for (const claim of required.claims) {
      if (!draft.claims.some((candidate) => candidate.text.includes(claim.text) &&
        claim.evidenceIds.every((id) => candidate.evidenceIds.includes(id)))) {
        issues.push("Required completed result is missing its evidence annotation.");
      }
    }
  }
  for (const claim of draft.claims) {
    if (!draft.message.includes(claim.text)) {
      issues.push(`Claim text is not an exact response span: ${claim.text}`);
    }
    for (const evidenceId of claim.evidenceIds) {
      if (!knownEvidence.has(evidenceId)) issues.push(`Unknown evidence citation: ${evidenceId}`);
    }
  }
  if (
    brief.decision?.mode === "conversational" &&
    draft.claims.some((claim) => claim.evidenceIds.includes(brief.decision?.evidenceId as never))
  ) {
    issues.push("Conversational response cites the private decision rationale instead of addressing the current message.");
  }
  return issues;
}
