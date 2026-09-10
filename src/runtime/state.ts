import { Annotation } from "@langchain/langgraph";

import type { CompiledAgentDefinition } from "../compiler/compileAgentDefinition.js";
import type { ConversationMessage, KernelCheckpoint } from "../contracts/checkpoint.js";
import type { DurableTurnScope } from "../contracts/durability.js";
import type { IntentionBatch } from "../contracts/intention.js";
import type { StepExecutionResult, TurnPlan } from "../contracts/plan.js";
import type { TurnResponse } from "../contracts/response.js";
import type { ThreadId, TurnId } from "../contracts/ids.js";
import type { TurnResult, TurnSelection } from "../contracts/turn.js";
import type { ContextSnapshot } from "../context/buildContextSnapshot.js";
import type { KernelEventEmitter } from "../events/createEventEmitter.js";
import type { TurnExecutionSummary } from "../executor/executeTurnPlan.js";
import type { TurnReduction } from "../reducer/reduceCapabilityResults.js";
import type { CapabilitySelection } from "../interpreter/schemas.js";

/** Turn-scoped dependencies and durable state passed through the private graph. */
export interface RuntimeInvocation {
  readonly compiled: CompiledAgentDefinition;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly checkpoint: KernelCheckpoint;
  readonly currentMessage: ConversationMessage;
  readonly summary?: string;
  readonly hostContext?: unknown;
  readonly selection?: TurnSelection;
  readonly signal: AbortSignal;
  readonly scope: DurableTurnScope;
  readonly emitter: KernelEventEmitter;
}

/** Private LangGraph state. It is intentionally not exported from the package root. */
export const RuntimeState = Annotation.Root({
  invocation: Annotation<RuntimeInvocation>(),
  loaded: Annotation<boolean>(),
  snapshot: Annotation<ContextSnapshot | undefined>(),
  capabilitySelection: Annotation<CapabilitySelection | undefined>(),
  batch: Annotation<IntentionBatch | undefined>(),
  plan: Annotation<TurnPlan | undefined>(),
  execution: Annotation<TurnExecutionSummary | undefined>(),
  results: Annotation<readonly StepExecutionResult[] | undefined>(),
  reduction: Annotation<TurnReduction | undefined>(),
  response: Annotation<TurnResponse | undefined>(),
  checkpoint: Annotation<KernelCheckpoint | undefined>(),
  result: Annotation<TurnResult | undefined>(),
  lastEventId: Annotation<string | undefined>(),
});

/** Concrete value type of the private annotated LangGraph state. */
export type RuntimeStateValue = typeof RuntimeState.State;
