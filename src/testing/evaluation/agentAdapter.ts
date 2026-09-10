import { z } from "zod";
import { interactionId, threadId, turnId } from "../../contracts/ids.js";
import type { KernelEvent } from "../../contracts/events.js";
import type { CompiledAgent, TurnSelection } from "../../contracts/turn.js";
import { EvaluationError, parseData } from "./schema.js";
import type { EvaluationAdapter, EvaluationData } from "./types.js";

/** Direct-agent transport dependencies; no HTTP or provider coupling. */
export interface AgentEvaluationAdapterOptions {
  /** Compiled agent to execute; distinct cases use distinct thread identities. */
  readonly agent: CompiledAgent;
  /** Recorded kernel events, filtered by exact thread and turn before reporting. */
  readonly events?: () => readonly KernelEvent[];
  /** Opt in only when the agent's durability survives evaluation interruption. */
  readonly supportsResume?: boolean;
}
const selectionSchema = z.object({
  optionIndex: z.number().int().nonnegative().optional(),
  optionLabel: z.string().min(1).optional(),
  optionId: z.string().min(1).optional(),
}).strict().refine((value) => Object.values(value).filter((item) => item !== undefined).length === 1);
const inputSchema = z.object({ text: z.string().max(10000), selection: selectionSchema.optional() }).strict();
const interactionSchema = z.looseObject({ id: z.string().min(1), options: z.array(z.looseObject({ id: z.string(), label: z.string() })).optional() });
function jsonData(value: unknown): EvaluationData {
  return parseData(JSON.parse(JSON.stringify(value)) as unknown);
}

/**
 * Adapt a compiled agent to the shared evaluation runner.
 * @remarks Inputs are `{ text, selection? }`. A selection uses exactly one of
 * `optionIndex` (zero-based), `optionLabel` or `optionId` from the preceding
 * interaction. Labels must match exactly one published choice; ambiguity is an
 * error, never an arbitrary first-option fallback. Observations include the full
 * committed result and correlated kernel events. Host context and credentials are
 * not accepted in imported scenario input.
 * @returns An adapter usable with runEvaluation, with optional durable resume.
 */
export function createAgentEvaluationAdapter(options: AgentEvaluationAdapterOptions): EvaluationAdapter {
  return {
    id: "intention-kernel.agent", version: "1", supportsResume: options.supportsResume === true,
    open(context) {
      let interaction: unknown = context.checkpoint?.["interaction"];
      return Promise.resolve({
        async send(input, request) {
          const parsed = inputSchema.safeParse(input);
          if (!parsed.success) throw new EvaluationError("EVALUATION_AGENT_INPUT_INVALID");
          let selection: TurnSelection | undefined;
          if (parsed.data.selection !== undefined) {
            const current = interactionSchema.safeParse(interaction);
            if (!current.success) throw new EvaluationError("EVALUATION_SELECTION_UNAVAILABLE");
            const selector = parsed.data.selection;
            const choices = current.data.options ?? [];
            const matches = selector.optionIndex === undefined
              ? choices.filter((choice) => selector.optionId === undefined ? choice.label === selector.optionLabel : choice.id === selector.optionId)
              : choices.filter((_choice, index) => index === selector.optionIndex);
            const match = matches[0];
            if (matches.length !== 1 || match === undefined) throw new EvaluationError("EVALUATION_SELECTION_AMBIGUOUS");
            selection = { interactionId: interactionId(current.data.id), optionId: match.id };
          }
          const result = await options.agent.run({
            threadId: threadId(context.threadId), turnId: turnId(request.turnId),
            input: { text: parsed.data.text }, signal: request.signal,
            ...(selection === undefined ? {} : { selection }),
          });
          interaction = result.checkpoint.interaction;
          const events = (options.events?.() ?? []).filter((event) => event.threadId === result.threadId && event.turnId === result.turnId);
          return {
            observation: jsonData({ ...result, events }),
            checkpoint: jsonData({ interaction: interaction ?? null }),
          };
        },
      });
    },
  };
}
