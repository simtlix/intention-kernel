import type { CompiledAgentDefinition } from "../compiler/compileAgentDefinition.js";
import type { Durability } from "../contracts/durability.js";
import { DurabilityError, IntentionKernelError } from "../contracts/errors.js";
import type { EventSink } from "../contracts/events.js";
import type { KernelClock, KernelIdGenerator } from "../contracts/runtime.js";
import type { CompiledAgent, RunTurnInput, TurnResult } from "../contracts/turn.js";
import { createEventEmitter } from "../events/createEventEmitter.js";
import type { compileLangGraphRuntime } from "./compileLangGraphRuntime.js";
import type { RuntimeInvocation } from "./state.js";

/** Bind a compiled definition and private LangGraph to durable turn execution. */
export function createCompiledAgent(options: {
  readonly compiled: CompiledAgentDefinition;
  readonly graph: ReturnType<typeof compileLangGraphRuntime>;
  readonly durability: Durability;
  readonly eventSink: EventSink;
  readonly clock: KernelClock;
  readonly idGenerator: KernelIdGenerator;
  readonly turnTimeoutMs: number;
  readonly redact?: (data: unknown) => unknown;
}): CompiledAgent {
  return Object.freeze({
    id: options.compiled.definition.id,
    version: options.compiled.definition.version,
    fingerprint: options.compiled.fingerprint,
    run: (input: RunTurnInput) => options.durability.withTurn(
      { threadId: input.threadId, turnId: input.turnId },
      async (scope): Promise<TurnResult> => {
        if (scope.priorResult !== null) return replay(scope.priorResult.value);
        const checkpoint = scope.checkpoint ?? {
          schemaVersion: 1,
          revision: 0,
          agentFingerprint: options.compiled.fingerprint,
          messages: [],
          facts: [],
          agenda: [],
          effects: [],
          ...(options.compiled.definition.progression === undefined
            ? {}
            : { progression: { occurrences: [] } }),
        };
        if (checkpoint.agentFingerprint !== options.compiled.fingerprint) {
          throw new DurabilityError({
            code: "AGENT_FINGERPRINT_MISMATCH",
            message: "The stored conversation belongs to a different compiled agent definition.",
            retryable: false,
            context: {
              storedFingerprint: checkpoint.agentFingerprint,
              compiledFingerprint: options.compiled.fingerprint,
            },
          });
        }
        const ownTimeout = AbortSignal.timeout(options.turnTimeoutMs);
        const signal = input.signal === undefined ? ownTimeout : AbortSignal.any([input.signal, ownTimeout]);
        const traceId = options.idGenerator.next("event");
        const emitter = createEventEmitter({
          sink: options.eventSink,
          threadId: input.threadId,
          turnId: input.turnId,
          correlationId: traceId,
          now: () => options.clock.now(),
          nextId: () => options.idGenerator.next("event"),
          ...(options.redact === undefined ? {} : { redact: options.redact }),
        });
        const invocation: RuntimeInvocation = {
          compiled: options.compiled,
          threadId: input.threadId,
          turnId: input.turnId,
          checkpoint,
          currentMessage: { role: "user", content: input.input.text, at: options.clock.now() },
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          ...(input.hostContext === undefined ? {} : { hostContext: input.hostContext }),
          ...(input.selection === undefined ? {} : { selection: input.selection }),
          signal,
          scope,
          emitter,
        };
        let state: Awaited<ReturnType<typeof options.graph.invoke>>;
        try {
          state = await options.graph.invoke({ invocation }, { recursionLimit: 16 });
        } catch (error) {
          try {
            const lastEventId = emitter.events.at(-1)?.id;
            await emitter.emit("turn.failed", {
              stage: "runtime",
              code: publicErrorCode(error),
              details: publicErrorDetails(error),
            }, { category: "audit", ...(lastEventId === undefined ? {} : { causationId: lastEventId }) });
          } catch {
            // Preserve the originating runtime failure if observability is also unavailable.
          }
          throw error;
        }
        if (state.result === undefined) {
          throw new IntentionKernelError({
            code: "RUNTIME_RESULT_MISSING",
            message: "The LangGraph runtime completed without a turn result.",
            retryable: false,
          });
        }
        return state.result;
      },
    ),
  });
}

function publicErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as Record<string, unknown>)["code"] === "string"
    ? String((error as Record<string, unknown>)["code"])
    : "UNEXPECTED_ERROR";
}

function publicErrorDetails(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  return {
    retryable: record["retryable"] ?? false,
    context: record["context"] ?? null,
  };
}

function replay(value: unknown): TurnResult {
  if (!isTurnResult(value)) {
    throw new DurabilityError({
      code: "INVALID_DURABLE_TURN_RESULT",
      message: "The durability adapter returned an invalid prior turn result.",
      retryable: false,
    });
  }
  return { ...value, replayed: true };
}

function isTurnResult(value: unknown): value is TurnResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["traceId"] === "string" &&
    typeof record["response"] === "object" && record["response"] !== null &&
    typeof record["checkpoint"] === "object" && record["checkpoint"] !== null;
}
