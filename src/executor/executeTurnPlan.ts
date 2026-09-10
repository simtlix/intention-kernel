import type { CompiledAgentDefinition } from "../compiler/compileAgentDefinition.js";
import { factKey } from "../compiler/buildDependencyGraph.js";
import type { KernelCheckpoint } from "../contracts/checkpoint.js";
import type { ConversationMessage } from "../contracts/checkpoint.js";
import type { DurableTurnScope } from "../contracts/durability.js";
import type { EffectReceipt } from "../contracts/effects.js";
import { ExecutionBudgetExceededError, IntentionKernelError } from "../contracts/errors.js";
import type { FactRecord } from "../contracts/facts.js";
import type { ThreadId, TurnId } from "../contracts/ids.js";
import type { CapabilityId } from "../contracts/ids.js";
import type { CapabilityEventOptions } from "../contracts/capability.js";
import type { PlanStep, StepExecutionResult, TurnPlan } from "../contracts/plan.js";
import { reduceCapabilityResults } from "../reducer/reduceCapabilityResults.js";
import { executeCapability } from "./executeCapability.js";

/** Aggregate execution results, provisional facts and effect receipts for a turn. */
export interface TurnExecutionSummary {
  readonly results: readonly StepExecutionResult[];
  readonly facts: readonly FactRecord[];
  readonly effects: readonly EffectReceipt[];
}

/** Execute a validated plan by dependency level, parallelizing only safe reads. */
export async function executeTurnPlan(options: {
  readonly plan: TurnPlan;
  readonly compiled: CompiledAgentDefinition;
  readonly checkpoint: KernelCheckpoint;
  readonly ports: Readonly<Record<string, unknown>>;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly scope: DurableTurnScope;
  readonly signal: AbortSignal;
  readonly currentMessage: ConversationMessage;
  /** Authority that produced this execution batch. */
  readonly trigger?: "user" | "progression" | "dependency" | "resume";
  readonly summary?: string;
  readonly hostContext?: unknown;
  readonly maxSteps?: number;
  readonly emitEvent?: (event: {
    readonly stepId: PlanStep["id"];
    readonly capabilityId: CapabilityId;
    readonly name: string;
    readonly data: unknown;
    readonly options?: CapabilityEventOptions;
  }) => Promise<void>;
}): Promise<TurnExecutionSummary> {
  const executable = options.plan.steps.filter((step) => step.disposition === "execute");
  const maxSteps = options.maxSteps ?? 64;
  if (executable.length > maxSteps) {
    throw new ExecutionBudgetExceededError({
      code: "STEP_BUDGET_EXCEEDED",
      message: "The turn plan exceeds the configured step budget.",
      retryable: false,
      context: { planned: executable.length, maxSteps },
    });
  }

  const pending = new Map(executable.map((step) => [step.id, step]));
  const results = new Map<PlanStep["id"], StepExecutionResult>();
  let facts: readonly FactRecord[] = [...options.checkpoint.facts];

  while (pending.size > 0) {
    let progressed = false;
    for (const step of [...pending.values()]) {
      const failedDependency = step.dependsOn.find((dependency) => {
        const outcome = results.get(dependency);
        return outcome !== undefined && !isCompleted(outcome) && !isPending(outcome);
      });
      const absentDependency = step.dependsOn.find((dependency) =>
        !pending.has(dependency) && !results.has(dependency),
      );
      if (failedDependency !== undefined || absentDependency !== undefined) {
        const capabilityId = requireCapabilityId(step);
        results.set(step.id, {
          status: "skipped",
          stepId: step.id,
          capabilityId,
          reason: {
            code: "DEPENDENCY_NOT_COMPLETED",
            message: "A required plan step did not complete successfully.",
            evidence: [String(failedDependency ?? absentDependency)],
          },
        });
        pending.delete(step.id);
        progressed = true;
        continue;
      }
      // A provider asking for data has not failed. Retain only the consumer's
      // declared fact requirements backed by these pending provider steps.
      // Wait for all siblings to settle first so a real failure takes priority.
      const waiting = step.dependsOn.filter((dependency) => isPending(results.get(dependency)));
      if (waiting.length > 0 && step.dependsOn.every((dependency) => results.has(dependency))) {
        const capabilityId = requireCapabilityId(step);
        const providers = new Set(waiting.map((dependency) => results.get(dependency)?.capabilityId));
        const present = new Set(facts.map(factKey));
        const pendingFacts = (options.compiled.capabilities.get(capabilityId)?.requires ?? []).filter((requirement) =>
          !present.has(factKey(requirement)) && providers.has(options.compiled.dependencyGraph.providersByFact.get(factKey(requirement))),
        );
        results.set(step.id, {
          status: "skipped", stepId: step.id, capabilityId,
          reason: {
            code: pendingFacts.length > 0 ? "DEPENDENCY_PENDING" : "DEPENDENCY_NOT_COMPLETED",
            message: pendingFacts.length > 0
              ? "A required fact provider is waiting for continuation."
              : "A required plan step did not complete successfully.",
            evidence: waiting.map(String),
          },
          ...(pendingFacts.length > 0 ? { pendingFacts } : {}),
        });
        pending.delete(step.id);
        progressed = true;
      }
    }

    const ready = [...pending.values()].filter((step) =>
      step.dependsOn.every((dependency) => isCompleted(results.get(dependency))),
    );
    if (ready.length === 0) {
      if (progressed) continue;
      throw new IntentionKernelError({
        code: "INVALID_TURN_PLAN",
        message: "The executable turn plan contains an unresolved dependency cycle.",
        retryable: false,
      });
    }

    const reads = ready.filter((step) => options.compiled.capabilities.get(requireCapabilityId(step))?.effect !== "write");
    const writes = ready.filter((step) => options.compiled.capabilities.get(requireCapabilityId(step))?.effect === "write");
    const readResults = await Promise.all(reads.map((step) => executeCapability({
      step,
      compiled: options.compiled,
      facts,
      ports: options.ports,
      scope: options.scope,
      threadId: options.threadId,
      turnId: options.turnId,
      signal: options.signal,
      previousMessages: options.checkpoint.messages,
      currentMessage: options.currentMessage,
      trigger: options.trigger ?? "user",
      ...(options.summary === undefined ? {} : { summary: options.summary }),
      ...(options.hostContext === undefined ? {} : { hostContext: options.hostContext }),
      ...(options.checkpoint.interaction === undefined ? {} : { interaction: options.checkpoint.interaction }),
      ...(options.emitEvent === undefined ? {} : { emitEvent: options.emitEvent }),
    })));
    for (const [index, result] of readResults.entries()) {
      const step = reads[index];
      if (step === undefined) continue;
      results.set(step.id, result);
      pending.delete(step.id);
    }
    facts = await projectFacts(options, facts, reads, readResults);

    for (const step of writes) {
      const result = await executeCapability({
        step,
        compiled: options.compiled,
        facts,
        ports: options.ports,
        scope: options.scope,
        threadId: options.threadId,
        turnId: options.turnId,
        signal: options.signal,
        previousMessages: options.checkpoint.messages,
        currentMessage: options.currentMessage,
        trigger: options.trigger ?? "user",
        ...(options.summary === undefined ? {} : { summary: options.summary }),
        ...(options.hostContext === undefined ? {} : { hostContext: options.hostContext }),
        ...(options.checkpoint.interaction === undefined ? {} : { interaction: options.checkpoint.interaction }),
        ...(options.emitEvent === undefined ? {} : { emitEvent: options.emitEvent }),
      });
      results.set(step.id, result);
      pending.delete(step.id);
      facts = await projectFacts(options, facts, [step], [result]);
    }
  }

  const orderedResults = executable.flatMap((step) => {
    const result = results.get(step.id);
    return result === undefined ? [] : [result];
  });
  return Object.freeze({
    results: Object.freeze(orderedResults),
    facts: Object.freeze(facts),
    effects: Object.freeze(orderedResults.flatMap((result) => result.status === "invoked" ? result.effects ?? [] : [])),
  });
}

function isCompleted(result: StepExecutionResult | undefined): boolean {
  return result?.status === "invoked" && result.result.status === "completed";
}

function isPending(result: StepExecutionResult | undefined): boolean {
  return result?.status === "skipped"
    ? result.reason.code === "DEPENDENCY_PENDING" && (result.pendingFacts?.length ?? 0) > 0
    : result?.status === "invoked" && ["needs_input", "needs_dependency", "needs_confirmation"].includes(result.result.status);
}


function requireCapabilityId(step: PlanStep) {
  if (step.capabilityId === undefined) {
    throw new IntentionKernelError({
      code: "INVALID_TURN_PLAN",
      message: "An executable step has no capability ID.",
      retryable: false,
      context: { stepId: step.id },
    });
  }
  return step.capabilityId;
}

async function projectFacts(
  options: Parameters<typeof executeTurnPlan>[0],
  facts: readonly FactRecord[],
  steps: readonly PlanStep[],
  results: readonly StepExecutionResult[],
): Promise<readonly FactRecord[]> {
  if (results.every((result) => !isCompleted(result))) return facts;
  const provisionalCheckpoint: KernelCheckpoint = {
    ...options.checkpoint,
    facts,
    agenda: [],
  };
  const reduction = await reduceCapabilityResults({
    checkpoint: provisionalCheckpoint,
    plan: { steps, responseGoal: options.plan.responseGoal },
    results,
    compiled: options.compiled,
    turnId: options.turnId,
  });
  return reduction.checkpoint.facts;
}
