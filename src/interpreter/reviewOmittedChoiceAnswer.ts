import { kernelPrompt } from "../prompts/catalog.js";
import { z } from "zod";
import type { IntentionBatch } from "../contracts/intention.js";
import type { ModelGateway } from "../contracts/model.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import { modelRedactionsFor, projectModelContext, redactModelValue } from "../context/projectModelContext.js";
import { defineSchema } from "../schema/runtimeSchema.js";
import type { InterpretationIssue } from "./reviewLifecycleActions.js";

/** Request a repair only for a semantically verified missing server-owned answer. */
export async function reviewOmittedChoiceAnswer(options: {
  readonly batch: IntentionBatch;
  readonly snapshot: ContextSnapshot;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
}): Promise<readonly InterpretationIssue[]> {
  const { batch, snapshot } = options;
  const interaction = snapshot.interaction;
  if (batch.answerToInteraction !== undefined || (batch.lifecycleActions?.length ?? 0) > 0 ||
    interaction?.kind !== "choice" || interaction.capabilityId === undefined || (interaction.options?.length ?? 0) === 0 ||
    !batch.intentions.some((intention) => intention.resolution === "resolved" && intention.proposedCapability === interaction.capabilityId) ||
    (typeof interaction.payload === "object" && interaction.payload !== null &&
      (interaction.payload as Record<string, unknown>)["kind"] === "progression.group")) return [];
  const raw = z.discriminatedUnion("verdict", [
    z.strictObject({ verdict: z.literal("supported"), optionId: z.enum((interaction.options ?? []).map(option => option.id)), rationale: z.string().min(1) }),
    z.strictObject({ verdict: z.literal("unsupported"), optionId: z.null(), rationale: z.string().min(1) }),
  ]);
  const schema = defineSchema<z.infer<typeof raw>>({ vendor: "zod", validate: (value) => {
    const parsed = raw.safeParse(value);
    return parsed.success ? { value: parsed.data } : { issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
  }, jsonSchema: () => z.toJSONSchema(raw) });
  const context = projectModelContext(snapshot);
  const model = snapshot.agent.modelPolicy["interaction-answer.review"] ?? snapshot.agent.modelPolicy["turn.interpret.repair"] ?? snapshot.agent.modelPolicy["turn.interpret"];
  const response = await options.gateway.invoke({ task: "interaction-answer.review", ...(model === undefined ? {} : { model }), ...kernelPrompt("kernel.review-omitted-choice-answer.system"),
    input: { reviewKind: "omitted_choice_answer", context, intentions: redactModelValue(batch.intentions, modelRedactionsFor(snapshot)),
      currentChoice: { id: interaction.id, goal: interaction.goal, options: context.interaction?.options?.map((option, index) => ({ position: index + 1, ...option })) ?? [] },
    }, outputSchema: schema, capabilities: [], signal: options.signal,
  });
  const validated = await schema.validate(response.value);
  if (!validated.ok) {
    return [{ message: "Omitted choice-answer review returned invalid or unpublished option evidence.", path: ["answerToInteraction"] }];
  }
  if (validated.value.verdict === "unsupported") return [];
  return [{ message: `The current message answers the active choice, but the proposal omitted that answer: ${validated.value.rationale}. Add answerToInteraction for ${interaction.id} with exact server-owned option ID ${validated.value.optionId} and literal current-message evidence. Preserve independently requested intentions. Invoking the owner alone does not answer its choice; never invent a value or use an older option.`, path: ["answerToInteraction"] }];
}
