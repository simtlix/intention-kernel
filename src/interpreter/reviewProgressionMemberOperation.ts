import { kernelPrompt } from "../prompts/catalog.js";
import { z } from "zod";
import type { IntentionBatch } from "../contracts/intention.js";
import type { ModelGateway } from "../contracts/model.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import { projectModelContext } from "../context/projectModelContext.js";
import { defineSchema } from "../schema/runtimeSchema.js";
import type { InterpretationIssue } from "./reviewLifecycleActions.js";

const raw = z.strictObject({ verdict: z.enum(["supported", "unsupported"]), rationale: z.string().min(1) });
const schema = defineSchema<z.infer<typeof raw>>({ vendor: "zod", validate: value => {
  const parsed = raw.safeParse(value);
  return parsed.success ? { value: parsed.data } : { issues: parsed.error.issues.map(issue => ({ message: issue.message, path: issue.path })) };
}, jsonSchema: () => z.toJSONSchema(raw) });

/** Review member operations that cannot inherit consent from an exact supported answer. */
export async function reviewProgressionMemberOperation(options: {
  readonly batch: IntentionBatch;
  readonly snapshot: ContextSnapshot;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
}): Promise<readonly InterpretationIssue[]> {
  const { batch, snapshot } = options;
  const interaction = snapshot.interaction;
  if (batch.answerToInteraction !== undefined || interaction?.kind !== "choice" ||
    typeof interaction.payload !== "object" || interaction.payload === null ||
    (interaction.payload as Record<string, unknown>)["kind"] !== "progression.group") return [];
  const members = interaction.options?.filter(option => typeof option.value === "object" && option.value !== null &&
    (option.value as Record<string, unknown>)["kind"] === "progression.member") ?? [];
  const proposedMemberIntentions = batch.intentions.filter(intention => intention.resolution === "resolved" &&
    members.some(member => member.targetCapabilityId === intention.proposedCapability));
  if (proposedMemberIntentions.length === 0) return [];
  const model = snapshot.agent.modelPolicy["interaction-answer.review"] ?? snapshot.agent.modelPolicy["turn.interpret.repair"] ?? snapshot.agent.modelPolicy["turn.interpret"];
  const response = await options.gateway.invoke({ task: "interaction-answer.review", ...(model === undefined ? {} : { model }), ...kernelPrompt("kernel.review-progression-member-operation.system"),
    input: { reviewKind: "progression_member_operation", context: projectModelContext(snapshot), proposedMemberIntentions, intentions: batch.intentions },
    outputSchema: schema, capabilities: snapshot.capabilities.filter(capability => proposedMemberIntentions.some(intention => intention.proposedCapability === capability.id))
      .map(capability => ({ ...capability, detail: "contract" as const })), signal: options.signal,
  });
  const validation = await schema.validate(response.value);
  if (!validation.ok) return [{ message: "Progression-member operation review returned invalid evidence.", path: ["intentions"] }];
  return validation.value.verdict === "supported" ? [] : [{
    code: "UNSUPPORTED_PROGRESSION_MEMBER_OPERATION",
    message: `A proposed progression-member operation lacks independent current-message support: ${validation.value.rationale}. Remove only unsupported answer-derived or historical operations; retain separately explicit current operations. Preserve the active group, agenda and pending interaction. If no independent operation remains, return empty intentions and no answerToInteraction; do not invent another member, continuation or cancellation.`,
    path: ["intentions"],
  }];
}
