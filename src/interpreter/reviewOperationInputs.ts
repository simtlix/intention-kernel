import type { CompiledAgentDefinition } from "../compiler/compileAgentDefinition.js";
import type { IntentionBatch } from "../contracts/intention.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import { resolveInteractionAnswerOwner } from "../context/resolveInteractionAnswerOwner.js";
import type { InterpretationIssue } from "./reviewLifecycleActions.js";

/** Validate admitted operation inputs before the single bounded model repair. */
export async function reviewOperationInputs(options: {
  readonly batch: IntentionBatch;
  readonly compiled: CompiledAgentDefinition;
  readonly snapshot: ContextSnapshot;
}): Promise<readonly InterpretationIssue[]> {
  const { batch, compiled } = options;
  const owner = resolveInteractionAnswerOwner(options.snapshot, batch.answerToInteraction);
  const issues: InterpretationIssue[] = [];
  for (const [index, intention] of batch.intentions.entries()) {
    if (intention.resolution !== "resolved" || intention.proposedCapability === undefined) continue;
    const capability = compiled.capabilities.get(intention.proposedCapability);
    if (capability === undefined) continue;
    const validation = await capability.input.validate(intention.input);
    if (validation.ok) continue;
    const inputIssues = validation.issues.length > 0 ? validation.issues : [{ message: "Runtime input validation failed.", path: [] }];
    issues.push(...inputIssues.map((issue) => ({
      message: `The proposed operation input does not satisfy its capability contract: ${issue.message}. ${owner?.pending !== undefined && owner.capabilityId === intention.proposedCapability
        ? "This exact active answer has one resolved same-owner waiting_input operation. If this intention only restates that collection, remove the duplicate intention and preserve answerToInteraction; the kernel reuses the original durable input and private continuation. Do not reconstruct its parameters. Repair an input only if it represents a genuinely independent request."
        : "Repair this intention's input using the supplied contract and actual current-message or canonical-context evidence."} Preserve supported interaction answers and independently requested intentions. Do not fabricate missing business values, infer consent, replace an answer, or ask the user to repeat supplied information merely because the operation input is malformed. Genuinely missing business information remains subject to the capability's requirements.`,
      path: ["intentions", index, "input", ...issue.path],
    })));
  }
  return issues;
}
