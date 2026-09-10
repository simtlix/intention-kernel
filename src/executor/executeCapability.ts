import type { CompiledAgentDefinition } from "../compiler/compileAgentDefinition.js";
import type { FactRecord } from "../contracts/facts.js";
import { IntentionKernelError } from "../contracts/errors.js";
import type { DurableTurnScope } from "../contracts/durability.js";
import type { ConversationMessage } from "../contracts/checkpoint.js";
import type { Interaction } from "../contracts/interaction.js";
import type { CapabilityId, ThreadId, TurnId } from "../contracts/ids.js";
import type { CapabilityEventOptions } from "../contracts/capability.js";
import type { PlanStep, StepExecutionResult } from "../contracts/plan.js";
import { createEffectCoordinator } from "./effectCoordinator.js";
import { bindDeferredChoiceAnswer, readDeferredChoiceAnswer } from "../context/deferredChoiceAnswer.js";
import { validateInteractionReferences } from "../context/validateInteractionReferences.js";

/** Execute one already-validated plan step through the capability boundary. */
export async function executeCapability(options: {
  readonly step: PlanStep;
  readonly compiled: CompiledAgentDefinition;
  readonly facts: readonly FactRecord[];
  readonly ports: Readonly<Record<string, unknown>>;
  readonly scope: DurableTurnScope;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly signal: AbortSignal;
  readonly previousMessages: readonly ConversationMessage[];
  readonly currentMessage: ConversationMessage;
  readonly trigger: "user" | "progression" | "dependency" | "resume";
  readonly summary?: string;
  readonly hostContext?: unknown;
  readonly interaction?: Interaction;
  readonly emitEvent?: (event: {
    readonly stepId: PlanStep["id"];
    readonly capabilityId: CapabilityId;
    readonly name: string;
    readonly data: unknown;
    readonly options?: CapabilityEventOptions;
  }) => Promise<void>;
}): Promise<StepExecutionResult> {
  const capabilityId = options.step.capabilityId;
  if (options.step.disposition !== "execute" || capabilityId === undefined) {
    throw new IntentionKernelError({
      code: "STEP_NOT_EXECUTABLE",
      message: "Only an executable plan step can be dispatched.",
      retryable: false,
      context: { stepId: options.step.id },
    });
  }
  const capability = options.compiled.capabilities.get(capabilityId);
  if (capability === undefined) {
    throw new IntentionKernelError({
      code: "CAPABILITY_NOT_REGISTERED",
      message: "The plan references an unregistered capability.",
      retryable: false,
      context: { stepId: options.step.id, capabilityId },
    });
  }
  const coordinator = createEffectCoordinator({
    scope: options.scope,
    capabilityId,
    stepId: options.step.id,
    turnId: options.turnId,
    allowEffects: capability.effect === "write",
  });
  const deferred = readDeferredChoiceAnswer(options.step);
  const bound = deferred === undefined ? undefined
    : bindDeferredChoiceAnswer(capabilityId, deferred.interaction, options.step.interactionAnswer);
  const interaction = bound?.interaction ?? options.interaction;
  const executed = await capability.execute({
    intention: options.step.intention,
    ports: options.ports,
    facts: options.facts,
    turn: {
      previousMessages: options.previousMessages,
      currentMessage: options.currentMessage,
      ...(options.summary === undefined ? {} : { summary: options.summary }),
      ...(options.hostContext === undefined ? {} : { hostContext: options.hostContext }),
      ...(options.step.continuation === undefined ? {} : { continuation: options.step.continuation }),
      ...(options.step.modelRedactions === undefined ? {} : { modelRedactions: options.step.modelRedactions }),
      ...(interaction !== undefined &&
        (interaction.capabilityId === capabilityId || options.step.interactionAnswer !== undefined)
        ? { interaction }
        : {}),
      ...(options.step.interactionAnswer === undefined ? {} : { interactionAnswer: options.step.interactionAnswer }),
    },
    signal: options.signal,
    execution: {
      threadId: options.threadId,
      turnId: options.turnId,
      stepId: options.step.id,
      capabilityId,
      trigger: options.trigger,
    },
    events: {
      emit: async (name, data, eventOptions) => {
        validateEventName(name, options.step.id, capabilityId);
        await options.emitEvent?.({
          stepId: options.step.id,
          capabilityId,
          name,
          data,
          ...(eventOptions === undefined ? {} : { options: eventOptions }),
        });
      },
    },
    runEffect: (idempotencyKey, operation) => coordinator.run(idempotencyKey, operation),
  }, options.step.input);
  const result = executed.status === "needs_confirmation"
    ? {
        ...executed,
        interaction: {
          ...executed.interaction,
          capabilityId,
          payload: {
            intention: options.step.intention,
            input: options.step.input,
            ...(executed.interaction.payload === undefined
              ? {}
              : { capabilityPayload: executed.interaction.payload }),
          },
        },
      }
    : executed;

  if ("interaction" in result) {
    if (result.interaction !== null) validateInteractionReferences(result.interaction);
    else if (result.status !== "completed") {
      throw new IntentionKernelError({
        code: "INVALID_CAPABILITY_INTERACTION",
        message: "Only a completed capability may dismiss the previous interaction.",
        retryable: false,
        context: { stepId: options.step.id, capabilityId },
      });
    }
  }

  if (capability.effect === "write" && result.status === "completed" && coordinator.calls === 0) {
    throw new IntentionKernelError({
      code: "WRITE_EFFECT_NOT_COORDINATED",
      message: "A completed write capability must execute through runEffect.",
      retryable: false,
      context: { stepId: options.step.id, capabilityId },
    });
  }

  return {
    status: "invoked",
    stepId: options.step.id,
    capabilityId,
    result,
    ...(coordinator.receipts.length === 0 ? {} : { effects: coordinator.receipts }),
  };
}

function validateEventName(name: string, stepId: PlanStep["id"], capabilityId: CapabilityId): void {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(name)) {
    throw new IntentionKernelError({
      code: "INVALID_CAPABILITY_EVENT_NAME",
      message: "Capability event names must use stable lowercase dot or hyphen segments.",
      retryable: false,
      context: { stepId, capabilityId },
    });
  }
}
