import { kernelPrompt } from "../prompts/catalog.js";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { IntentionBatch } from "../contracts/intention.js";
import type { ModelGateway } from "../contracts/model.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import { modelRedactionsFor, projectModelContext, redactModelValue } from "../context/projectModelContext.js";
import { defineSchema } from "../schema/runtimeSchema.js";
import type { InterpretationIssue } from "./reviewLifecycleActions.js";
import type { CapabilitySelection } from "./schemas.js";

/** Defer only ordinary-choice mixed shortlists; no execution is authorized at selection. */
export function defersOrdinaryChoiceExtras(snapshot: ContextSnapshot, selection: CapabilitySelection): boolean {
  const interaction = snapshot.interaction;
  if (interaction?.kind !== "choice" ||
    (selection.mode !== "selected" && selection.mode !== "selected_with_control") ||
    (typeof interaction.payload === "object" && interaction.payload !== null &&
      (interaction.payload as Record<string, unknown>)["kind"] === "progression.group")) return false;
  const active = new Set([interaction.capabilityId, ...(interaction.options ?? []).map(option => option.targetCapabilityId)]);
  return selection.capabilityIds.some(id => active.has(id)) && selection.capabilityIds.some(id => !active.has(id));
}

const raw = z.strictObject({ verdict: z.enum(["supported", "unsupported"]), rationale: z.string().min(1) });
const schema = defineSchema<z.infer<typeof raw>>({ vendor: "zod", validate: (value) => {
  const parsed = raw.safeParse(value);
  return parsed.success ? { value: parsed.data } : { issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
}, jsonSchema: () => z.toJSONSchema(raw) });

/** Preserve a supported choice without inferring independent parent or downstream work. */
export async function reviewChoiceIntentions(options: {
  readonly batch: IntentionBatch;
  readonly snapshot: ContextSnapshot;
  readonly gateway: ModelGateway;
  readonly signal: AbortSignal;
  readonly selection: CapabilitySelection;
}): Promise<readonly InterpretationIssue[]> {
  const { batch, snapshot } = options;
  const interaction = snapshot.interaction;
  const answer = batch.answerToInteraction;
  const unanswered = answer === undefined && defersOrdinaryChoiceExtras(snapshot, options.selection);
  if (interaction?.kind !== "choice" || (!unanswered && answer?.interactionId !== interaction.id) ||
    (typeof interaction.payload === "object" && interaction.payload !== null &&
      (interaction.payload as Record<string, unknown>)["kind"] === "progression.group" &&
      !(typeof answer?.value === "object" && answer.value !== null &&
        (answer.value as Record<string, unknown>)["kind"] === "progression.member"))) return [];
  const matched = answer === undefined ? [] : interaction.options?.filter((option) => isDeepStrictEqual(option.value, answer.value)) ?? [];
  const owner = matched.length === 1 ? matched[0]?.targetCapabilityId ?? interaction.capabilityId : undefined;
  if (!unanswered && owner === undefined) return [];
  const active = new Set([interaction.capabilityId, ...(interaction.options ?? []).map(option => option.targetCapabilityId)]);
  const additionalIntentions = batch.intentions.filter((intention) => intention.resolution === "resolved" &&
    (unanswered ? !active.has(intention.proposedCapability) : intention.proposedCapability !== owner));
  if (additionalIntentions.length === 0) return [];
  const model = snapshot.agent.modelPolicy["interaction-answer.review"] ?? snapshot.agent.modelPolicy["turn.interpret.repair"] ?? snapshot.agent.modelPolicy["turn.interpret"];
  const redactions = modelRedactionsFor(snapshot);
  const response = await options.gateway.invoke({ task: "interaction-answer.review", ...(model === undefined ? {} : { model }), ...kernelPrompt(unanswered ? "kernel.review-choice-intentions.unanswered-system" : "kernel.review-choice-intentions.system"),
    input: { reviewKind: "choice_intention_independence", context: projectModelContext(snapshot),
      ...(unanswered ? { answerStatus: "unanswered" } : { proposedAnswer: redactModelValue(answer, redactions), choiceOwner: owner }),
      additionalIntentions: redactModelValue(additionalIntentions, redactions) },
    outputSchema: schema, capabilities: snapshot.capabilities.filter((capability) => batch.intentions.some((intention) => intention.proposedCapability === capability.id)).map((capability) => ({ ...capability, detail: "contract" as const })), signal: options.signal,
  });
  const validation = await schema.validate(response.value);
  if (!validation.ok) return [{ message: "Choice intention-independence review returned invalid evidence.", path: ["intentions"] }];
  if (validation.value.verdict === "supported") return [];
  if (unanswered) return [{ code: "UNSUPPORTED_UNANSWERED_CHOICE_EXTRAS", message: `Additional operations lack independent current-message evidence: ${validation.value.rationale}. Remove only unsupported additional intentions. Preserve independently requested work, any supported lifecycle actions and the unanswered active choice. Do not invent an answer, a replacement owner operation or a continuation. If nothing was requested, empty intentions and no answer are valid.`, path: ["intentions"] }];
  return [{ code: "UNSUPPORTED_CHOICE_INTENTIONS", message: `The active choice answer is supported, but additional operations lack independent current-message evidence: ${validation.value.rationale}. Preserve answerToInteraction, its exact owning operation and companion input. Remove only intentions inferred from answering that choice, its waiting parent or likely workflow progression. Retain genuinely independently requested operations; the kernel schedules pending dependencies and progression.`, path: ["intentions"] }];
}
