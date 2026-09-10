import type { ModelGateway, ModelRequest, ModelResult } from "../contracts/model.js";
import type { ModelPromptResolver } from "../contracts/prompt.js";
import { resolveModelPrompt } from "../prompts/resolveModelPrompt.js";
import type { KernelClock, KernelIdGenerator } from "../contracts/runtime.js";
import type { TurnResult } from "../contracts/turn.js";
import type { TurnResponse } from "../contracts/response.js";
import { IntentionKernelError } from "../contracts/errors.js";
import type { Interaction, InteractionAnswer } from "../contracts/interaction.js";
import type { CapabilitySelection } from "../interpreter/schemas.js";
import type { IntentionBatch } from "../contracts/intention.js";
import type { TurnSelection } from "../contracts/turn.js";
import type { TurnReduction } from "../reducer/reduceCapabilityResults.js";
import type { TurnPlan } from "../contracts/plan.js";
import type { StepExecutionResult } from "../contracts/plan.js";
import type { KernelCheckpoint } from "../contracts/checkpoint.js";
import type { CompiledAgentDefinition } from "../compiler/compileAgentDefinition.js";
import type { AgendaItemId, CapabilityId } from "../contracts/ids.js";
import { buildContextSnapshot } from "../context/buildContextSnapshot.js";
import { deepFreeze } from "../context/deepFreeze.js";
import { buildResponseBrief, buildResponseDelivery } from "../composer/buildResponseBrief.js";
import { composeResponse, technicalFailureResponse } from "../composer/composeResponse.js";
import { executeTurnPlan } from "../executor/executeTurnPlan.js";
import { interpretTurn } from "../interpreter/interpretTurn.js";
import { selectCapabilities } from "../interpreter/selectCapabilities.js";
import { createTurnPlan } from "../planner/createTurnPlan.js";
import { reduceCapabilityResults } from "../reducer/reduceCapabilityResults.js";
import type { RuntimeStateValue } from "./state.js";
import { reconcileProgression } from "../progression/reconcileProgression.js";
import { observeModelRequest } from "./modelObservation.js";

/** Injected dependencies shared by the private LangGraph node set. */
export interface RuntimeNodeDependencies {
  readonly modelGateway: ModelGateway;
  readonly promptResolver?: ModelPromptResolver;
  readonly ports: Readonly<Record<string, unknown>>;
  readonly clock: KernelClock;
  readonly idGenerator: KernelIdGenerator;
  readonly maxSteps: number;
  readonly recentMessageLimit: number;
}

/** Construct the private LangGraph nodes around pure kernel stages. */
export function createRuntimeNodes(dependencies: RuntimeNodeDependencies) {
  return {
    load: async (state: RuntimeStateValue) => {
      const event = await state.invocation.emitter.emit("turn.started", {
        messageLength: state.invocation.currentMessage.content.length,
        checkpointRevision: state.invocation.checkpoint.revision,
      }, { category: "trace" });
      return { loaded: true, lastEventId: event.id };
    },
    context: async (state: RuntimeStateValue) => {
      const context = buildContextSnapshot({
        checkpoint: state.invocation.checkpoint,
        currentMessage: state.invocation.currentMessage,
        compiled: state.invocation.compiled,
        ...(state.invocation.summary === undefined ? {} : { summary: state.invocation.summary }),
        recentMessageLimit: dependencies.recentMessageLimit,
      });
      // Validate before any model sees the control. Project only its canonical
      // identity, not host metadata, a fabricated text answer or duplicated values.
      const submitted = state.invocation.selection;
      const selectedAnswer = resolveSelection(context.interaction, submitted);
      const snapshot = selectedAnswer === undefined || submitted === undefined ? context : deepFreeze({
        ...context,
        interactionSelection: {
          interactionId: selectedAnswer.interactionId,
          ...(submitted.optionId === undefined ? { action: submitted.action } : { optionId: submitted.optionId }),
        },
      });
      const event = await state.invocation.emitter.emit("context.built", {
        recentMessages: snapshot.conversation.recentMessages.length,
        userMessageCount: snapshot.conversation.recentMessages.filter((message) => message.role === "user").length + 1,
        currentMessageIndex: snapshot.currentMessage.index,
        activeCapabilityId: snapshot.interaction?.capabilityId ?? null,
        facts: snapshot.facts.map((fact) => `${fact.type}@${String(fact.version)}`),
        agendaItems: snapshot.agenda.length,
        activeInteraction: snapshot.interaction?.kind ?? null,
        interactionSelection: snapshot.interactionSelection ?? null,
        selectedModelGuidancePolicies: snapshot.selectedModelGuidancePolicies.map((policy) => ({
          id: policy.id,
          version: policy.version,
          matchedSelectors: policy.matchedSelectors,
        })),
        omissions: snapshot.omissions,
      }, { category: "trace", ...(state.lastEventId === undefined ? {} : { causationId: state.lastEventId }) });
      return { snapshot, lastEventId: event.id };
    },
    selectCapabilities: async (state: RuntimeStateValue) => {
      const snapshot = requireState(state.snapshot, "snapshot");
      const progression = progressionSelection(snapshot.interaction, state.invocation.selection);
      const observed = new ObservedModelGateway(
        dependencies.modelGateway,
        state.invocation.emitter,
        state.lastEventId,
        dependencies.promptResolver,
      );
      const capabilitySelection = progression?.selection ?? await selectCapabilities({
          snapshot,
          gateway: observed,
          signal: state.invocation.signal,
        });
      const event = await state.invocation.emitter.emit("capabilities.selected", {
        source: progression === undefined ? capabilitySelection.source ?? "model" : "structured_selection",
        mode: capabilitySelection.mode,
        capabilityIds: capabilitySelection.capabilityIds,
        rationale: capabilitySelection.rationale,
        evidence: capabilitySelection.evidence,
        adjustments: capabilitySelection.adjustments ?? [],
      }, {
        category: "audit",
        ...(observed.lastEventId === undefined ? {} : { causationId: observed.lastEventId }),
      });
      return { capabilitySelection, lastEventId: event.id };
    },
    interpret: async (state: RuntimeStateValue) => {
      const snapshot = requireState(state.snapshot, "snapshot");
      const progression = progressionSelection(snapshot.interaction, state.invocation.selection);
      const observed = new ObservedModelGateway(
        dependencies.modelGateway,
        state.invocation.emitter,
        state.lastEventId,
        dependencies.promptResolver,
      );
      const selectedAnswer = resolveSelection(snapshot.interaction, state.invocation.selection);
      const interpreted = progression?.batch ?? await interpretTurn({
        compiled: state.invocation.compiled,
          snapshot,
          selection: requireState(state.capabilitySelection, "capabilitySelection"),
          gateway: observed,
          signal: state.invocation.signal,
          ids: dependencies.idGenerator,
          ...(selectedAnswer === undefined ? {} : { validatedInteractionAnswer: selectedAnswer }),
        });
      const batch = selectedAnswer === undefined
        ? interpreted
        : { ...interpreted, answerToInteraction: selectedAnswer };
      const event = await state.invocation.emitter.emit("intention.interpreted", {
        source: progression === undefined ? "model" : "structured_selection",
        intentions: batch.intentions.map((intention) => ({
          id: intention.id,
          objective: intention.objective,
          capabilityId: intention.proposedCapability ?? null,
          resolution: intention.resolution,
          evidence: intention.evidence,
          references: intention.references,
          input: intention.input ?? null,
          alternatives: intention.alternatives ?? [],
          rationale: intention.rationale ?? null,
        })),
        interactionAnswer: batch.answerToInteraction ?? null,
        interactionAnswerSource: selectedAnswer !== undefined || progression !== undefined
          ? "structured_selection" : batch.answerToInteraction === undefined ? null : "model",
        contradictions: batch.contradictions,
        lifecycleActions: batch.lifecycleActions ?? [],
      }, { category: "audit", ...(observed.lastEventId === undefined ? {} : { causationId: observed.lastEventId }) });
      return { batch, lastEventId: event.id };
    },
    plan: async (state: RuntimeStateValue) => {
      const plan = await createTurnPlan({
        batch: requireState(state.batch, "batch"),
        snapshot: requireState(state.snapshot, "snapshot"),
        compiled: state.invocation.compiled,
        ids: dependencies.idGenerator,
      });
      const event = await state.invocation.emitter.emit("plan.created", {
        responseGoal: plan.responseGoal,
        cancelledAgendaItemIds: plan.cancelledAgendaItemIds ?? [],
        cancelledObjectiveIds: plan.cancelledObjectiveIds ?? [],
        steps: plan.steps.map((step) => ({
          id: step.id,
          capabilityId: step.capabilityId ?? null,
          disposition: step.disposition,
          input: step.input ?? null,
          dependsOn: step.dependsOn,
          missingFacts: step.missingFacts,
          reason: { code: step.reason.code, message: step.reason.message, evidence: step.reason.evidence },
        })),
      }, { category: "audit", ...(state.lastEventId === undefined ? {} : { causationId: state.lastEventId }) });
      let lastEventId = event.id;
      for (const step of plan.steps.filter((candidate) => candidate.disposition === "defer" || candidate.disposition === "clarify")) {
        const deferred = await state.invocation.emitter.emit("step.deferred", {
          capabilityId: step.capabilityId ?? null,
          disposition: step.disposition,
          reasonCode: step.reason.code,
        }, { category: "trace", stepId: step.id, causationId: lastEventId });
        lastEventId = deferred.id;
      }
      return { plan, lastEventId };
    },
    execute: async (state: RuntimeStateValue) => {
      const plan = requireState(state.plan, "plan");
      let lastEventId = state.lastEventId;
      const branchEventIds = new Map<string, string>();
      for (const step of plan.steps.filter((candidate) => candidate.disposition === "execute")) {
        const event = await state.invocation.emitter.emit("step.started", {
          capabilityId: step.capabilityId,
          dependsOn: step.dependsOn,
        }, { category: "trace", stepId: step.id, ...(lastEventId === undefined ? {} : { causationId: lastEventId }) });
        lastEventId = event.id;
        const invoked = await state.invocation.emitter.emit("capability.invoked", {
          capabilityId: step.capabilityId,
        }, { category: "trace", stepId: step.id, causationId: lastEventId });
        lastEventId = invoked.id;
        branchEventIds.set(step.id, invoked.id);
      }
      const execution = await executeTurnPlan({
        plan,
        compiled: state.invocation.compiled,
        checkpoint: state.invocation.checkpoint,
        ports: dependencies.ports,
        threadId: state.invocation.threadId,
        turnId: state.invocation.turnId,
        scope: state.invocation.scope,
        signal: state.invocation.signal,
        currentMessage: state.invocation.currentMessage,
        ...(state.invocation.summary === undefined ? {} : { summary: state.invocation.summary }),
        ...(state.invocation.hostContext === undefined ? {} : { hostContext: state.invocation.hostContext }),
        maxSteps: dependencies.maxSteps,
        emitEvent: async (capabilityEvent) => {
          const parentEventId = branchEventIds.get(capabilityEvent.stepId);
          const event = await state.invocation.emitter.emit("capability.event", {
            capabilityId: capabilityEvent.capabilityId,
            name: capabilityEvent.name,
            data: capabilityEvent.data,
          }, {
            category: capabilityEvent.options?.category ?? "trace",
            stepId: capabilityEvent.stepId,
            ...(parentEventId === undefined ? {} : { causationId: parentEventId }),
          });
          branchEventIds.set(capabilityEvent.stepId, event.id);
          lastEventId = event.id;
        },
      });
      for (const result of execution.results) {
        const branchParentEventId = branchEventIds.get(result.stepId);
        const type = result.status === "skipped"
          ? "capability.skipped"
          : result.result.status === "failed"
            ? "capability.failed"
            : "capability.completed";
        const event = await state.invocation.emitter.emit(type, {
          capabilityId: result.capabilityId,
          status: result.status === "skipped" ? result.status : result.result.status,
          ...(result.status === "skipped" ? { reasonCode: result.reason.code } : {}),
          ...(result.status === "invoked" && result.result.status === "completed"
            ? {
                output: result.result.output,
                facts: result.result.facts,
                evidence: result.result.evidence,
                artifacts: result.result.artifacts,
              }
            : {}),
          ...(result.status === "invoked" && result.result.status === "failed"
            ? { issue: result.result.issue }
            : {}),
          ...(result.status === "invoked" && result.result.status === "needs_dependency"
            ? {
                requirement: result.result.requirement,
                providerCapabilityId: result.result.provider.capabilityId,
              }
            : {}),
          ...(result.status === "invoked" && (result.result.status === "needs_input" || result.result.status === "needs_confirmation" ||
            (result.result.status === "completed" && result.result.interaction !== undefined))
            ? { interaction: result.result.interaction }
            : {}),
        }, {
          category: "trace",
          stepId: result.stepId,
          ...(branchParentEventId === undefined
            ? {}
            : { causationId: branchParentEventId }),
        });
        lastEventId = event.id;
        branchEventIds.set(result.stepId, event.id);
        if (result.status === "invoked") {
          for (const receipt of result.effects ?? []) {
            const effectEvent = await state.invocation.emitter.emit("effect.recorded", {
              effectId: receipt.id,
              capabilityId: receipt.capabilityId,
              status: receipt.status,
              idempotencyKey: receipt.idempotencyKey,
            }, { category: "audit", stepId: result.stepId, causationId: lastEventId });
            lastEventId = effectEvent.id;
          }
        }
      }
      return { execution, results: execution.results, lastEventId };
    },
    reduce: async (state: RuntimeStateValue) => {
      const execution = state.execution ?? { results: [], effects: [], facts: state.invocation.checkpoint.facts };
      const reduction = await reduceCapabilityResults({
        checkpoint: state.invocation.checkpoint,
        plan: requireState(state.plan, "plan"),
        results: execution.results,
        compiled: state.invocation.compiled,
        turnId: state.invocation.turnId,
        effects: [...state.invocation.checkpoint.effects, ...execution.effects],
      });
      let cancellationEventId = state.lastEventId;
      for (const agendaItemId of requireState(state.plan, "plan").cancelledAgendaItemIds ?? []) {
        const cancelled = await state.invocation.emitter.emit("agenda.item.cancelled", {
          agendaItemId,
        }, {
          category: "audit",
          ...(cancellationEventId === undefined ? {} : { causationId: cancellationEventId }),
        });
        cancellationEventId = cancelled.id;
      }
      for (const objectiveId of requireState(state.plan, "plan").cancelledObjectiveIds ?? []) {
        const cancelled = await state.invocation.emitter.emit("objective.cancelled", {
          objectiveId,
        }, {
          category: "audit",
          ...(cancellationEventId === undefined ? {} : { causationId: cancellationEventId }),
        });
        cancellationEventId = cancelled.id;
      }
      let combinedPlan = requireState(state.plan, "plan");
      let combinedReduction = reduction;
      let currentPlan = combinedPlan;
      let currentResults = reduction.results;
      const attemptedAutomaticActivations = new Set<string>();
      const attemptedProgressionOccurrences = new Set<string>();
      let progression: ReturnType<typeof reconcileProgression>;
      let automaticSteps = 0;
      for (;;) {
        const dependency = combinedReduction.checkpoint.interaction === undefined
          ? dependencyActivation({
              plan: currentPlan,
              results: currentResults,
              checkpoint: combinedReduction.checkpoint,
              compiled: state.invocation.compiled,
            })
          : undefined;
        // Persist accepted progression actions even when a dependency wins the
        // next execution slot; otherwise replacing currentPlan loses the exit.
        progression = reconcileProgression({
          checkpoint: combinedReduction.checkpoint,
          compiled: state.invocation.compiled,
          plan: currentPlan,
          results: currentResults,
          turnPublications: combinedReduction.publishedFacts,
          turnInvalidations: combinedReduction.invalidatedFacts,
          skippedActivationIds: attemptedProgressionOccurrences,
          deferActivation: dependency !== undefined,
        });
        combinedReduction = { ...combinedReduction, checkpoint: progression.checkpoint };
        const progressionActivation: AutomaticActivation | undefined = dependency === undefined && progression.activation !== undefined
          ? {
              kind: "progression" as const,
              identity: progression.activation.occurrenceId,
              occurrenceId: progression.activation.occurrenceId,
              capabilityId: progression.activation.capabilityId,
            }
          : undefined;
        if (dependency === undefined && progressionActivation === undefined) break;
        const activation = dependency ?? progressionActivation;
        if (activation === undefined) break;
        const activationKey = `${activation.kind}:${activation.identity}`;
        if (attemptedAutomaticActivations.has(activationKey)) break;
        attemptedAutomaticActivations.add(activationKey);
        if (activation.kind === "progression") {
          attemptedProgressionOccurrences.add(activation.occurrenceId);
        }
        automaticSteps += 1;
        if (automaticSteps > dependencies.maxSteps) {
          throw new IntentionKernelError({
            code: "AUTOMATIC_STEP_BUDGET_EXCEEDED",
            message: "Automatic dependency and progression work exceeded the configured turn step budget.",
            retryable: false,
          });
        }
        const capability = state.invocation.compiled.capabilities.get(activation.capabilityId);
        if (capability === undefined) {
          throw new IntentionKernelError({
            code: "AUTOMATIC_CAPABILITY_NOT_REGISTERED",
            message: "An automatic target must reference a registered capability.",
            retryable: false,
            context: { capabilityId: activation.capabilityId },
          });
        }
        const automaticInput = activation.kind === "progression"
          ? activation.input ?? capability.automation?.createInput({
              currentMessage: state.invocation.currentMessage,
              facts: combinedReduction.checkpoint.facts,
            })
          : activation.input;
        if (automaticInput === undefined) {
          throw new IntentionKernelError({
            code: "CAPABILITY_AUTOMATION_REQUIRED",
            message: "An automatic target must provide input or declare a versioned automatic input factory.",
            retryable: false,
            context: { capabilityId: activation.capabilityId },
          });
        }
        const automaticSnapshot = buildContextSnapshot({
          checkpoint: combinedReduction.checkpoint,
          currentMessage: state.invocation.currentMessage,
          compiled: state.invocation.compiled,
          ...(state.invocation.summary === undefined ? {} : { summary: state.invocation.summary }),
          recentMessageLimit: dependencies.recentMessageLimit,
        });
        const automaticPlanBase = await createTurnPlan({
          batch: {
            intentions: [activation.kind === "resume" && activation.intention !== undefined
              ? activation.intention
              : automaticIntention({
              capabilityId: activation.capabilityId,
              capabilityDescription: capability.description,
              input: automaticInput,
              currentMessage: state.invocation.currentMessage.content,
              messageIndex: automaticSnapshot.currentMessage.index,
              identity: activation.identity,
              meaning: activation.kind === "progression"
                ? "A trusted progression rule activated this capability."
                : "A declared capability dependency activated its provider.",
                })],
            contradictions: [],
          },
          snapshot: automaticSnapshot,
          compiled: state.invocation.compiled,
          ids: dependencies.idGenerator,
        });
        const automaticPlan: TurnPlan = {
          ...automaticPlanBase,
          ...(activation.kind === "progression"
            ? {
                progressionAction: {
                  kind: "automatic" as const,
                  occurrenceId: activation.occurrenceId,
                  capabilityId: activation.capabilityId,
                },
              }
            : {}),
        };
        const activatedEvent = await state.invocation.emitter.emit(
          activation.kind === "progression"
            ? "progression.capability.activated"
            : activation.kind === "dependency"
              ? "dependency.capability.activated"
              : "dependency.consumer.resumed",
          {
          ...(activation.kind === "progression" ? { occurrenceId: activation.occurrenceId } : {}),
          capabilityId: activation.capabilityId,
          disposition: automaticPlan.steps[0]?.disposition ?? null,
          trigger: activation.kind,
          identity: activation.identity,
          steps: automaticPlan.steps,
          }, { category: "audit", ...(state.lastEventId === undefined ? {} : { causationId: state.lastEventId }) });
        const automaticExecution = await executeTurnPlan({
          plan: automaticPlan,
          compiled: state.invocation.compiled,
          checkpoint: combinedReduction.checkpoint,
          ports: dependencies.ports,
          threadId: state.invocation.threadId,
          turnId: state.invocation.turnId,
          scope: state.invocation.scope,
          signal: state.invocation.signal,
          currentMessage: state.invocation.currentMessage,
          trigger: activation.kind,
          ...(state.invocation.summary === undefined ? {} : { summary: state.invocation.summary }),
          ...(state.invocation.hostContext === undefined ? {} : { hostContext: state.invocation.hostContext }),
          maxSteps: dependencies.maxSteps - automaticSteps,
          emitEvent: async (capabilityEvent) => {
            await state.invocation.emitter.emit("capability.event", {
              capabilityId: capabilityEvent.capabilityId,
              name: capabilityEvent.name,
              data: capabilityEvent.data,
            }, {
              category: capabilityEvent.options?.category ?? "trace",
              stepId: capabilityEvent.stepId,
              causationId: activatedEvent.id,
            });
          },
        });
        const automaticReductionRaw = await reduceCapabilityResults({
          ...(activation.kind === "dependency" && activation.parentAgendaId !== undefined
            ? { dependencyParentId: activation.parentAgendaId } : {}),
          checkpoint: combinedReduction.checkpoint,
          plan: automaticPlan,
          results: automaticExecution.results,
          compiled: state.invocation.compiled,
          turnId: state.invocation.turnId,
          effects: [...combinedReduction.checkpoint.effects, ...automaticExecution.effects],
        });
        const automaticReduction: TurnReduction = {
          ...automaticReductionRaw,
          checkpoint: {
            ...automaticReductionRaw.checkpoint,
            revision: combinedReduction.checkpoint.revision,
          },
        };
        for (const result of automaticExecution.results) {
          await state.invocation.emitter.emit(
            result.status === "skipped"
              ? "capability.skipped"
              : result.result.status === "failed"
                ? "capability.failed"
                : "capability.completed",
            {
              capabilityId: result.capabilityId,
              status: result.status === "skipped" ? "skipped" : result.result.status,
              ...(result.status === "skipped" ? { reasonCode: result.reason.code } : {}),
              ...(result.status === "invoked" && result.result.status === "failed"
                ? { issue: result.result.issue }
                : {}),
            },
            { category: "trace", stepId: result.stepId, causationId: activatedEvent.id },
          );
        }
        combinedPlan = mergePlans(combinedPlan, automaticPlan);
        combinedReduction = mergeReductions(combinedReduction, automaticReduction);
        currentPlan = automaticPlan;
        currentResults = automaticReduction.results;
      }
      const progressedReduction = combinedReduction;
      const event = await state.invocation.emitter.emit("facts.reduced", {
        published: progressedReduction.publishedFacts,
        invalidated: progressedReduction.invalidatedFacts,
        agendaItems: progressedReduction.checkpoint.agenda.length,
        interaction: progressedReduction.checkpoint.interaction?.kind ?? null,
      }, { category: "audit", ...(cancellationEventId === undefined ? {} : { causationId: cancellationEventId }) });
      let lastEventId = event.id;
      if (progression.interactionRequested) {
        const requested = await state.invocation.emitter.emit("progression.interaction.requested", {
          occurrenceId: progression.occurrenceId,
          kind: progression.checkpoint.interaction?.kind ?? null,
        }, { category: "trace", causationId: lastEventId });
        lastEventId = requested.id;
      }
      if (progressedReduction.checkpoint.interaction !== undefined) {
        const requested = await state.invocation.emitter.emit("interaction.requested", {
          interactionId: progressedReduction.checkpoint.interaction.id,
          kind: progressedReduction.checkpoint.interaction.kind,
          capabilityId: progressedReduction.checkpoint.interaction.capabilityId ?? null,
          requestedFacts: progressedReduction.checkpoint.interaction.requestedFacts,
        }, { category: "trace", causationId: lastEventId });
        return { plan: combinedPlan, reduction: progressedReduction, checkpoint: progressedReduction.checkpoint, lastEventId: requested.id };
      }
      return { plan: combinedPlan, reduction: progressedReduction, checkpoint: progressedReduction.checkpoint, lastEventId };
    },
    compose: async (state: RuntimeStateValue) => {
      const reduction = requireState(state.reduction, "reduction");
      const protectedCanonicalMessage = reduction.checkpoint.interaction?.protectedCanonicalMessage;
      const responseInput = {
        plan: requireState(state.plan, "plan"),
        reduction,
        context: requireState(state.snapshot, "snapshot"),
        decision: requireState(state.capabilitySelection, "capabilitySelection"),
        batch: requireState(state.batch, "batch"),
        ...(state.invocation.compiled.definition.responseFallbacks === undefined
          ? {}
          : { responseFallbacks: state.invocation.compiled.definition.responseFallbacks }),
      };
      const brief = buildResponseBrief(responseInput);
      const delivery = buildResponseDelivery(responseInput);
      const observed = new ObservedModelGateway(
        dependencies.modelGateway,
        state.invocation.emitter,
        state.lastEventId,
        dependencies.promptResolver,
      );
      let response: TurnResponse;
      try {
        response = await composeResponse({
          brief,
          delivery,
          ...(protectedCanonicalMessage === undefined ? {} : { protectedCanonicalMessage }),
          gateway: observed,
          signal: state.invocation.signal,
          models: {
            ...(state.invocation.compiled.definition.modelPolicy["response.compose"] === undefined
              ? {}
              : { compose: state.invocation.compiled.definition.modelPolicy["response.compose"] }),
            ...(state.invocation.compiled.definition.modelPolicy["response.grounding-review"] === undefined
              ? {}
              : { review: state.invocation.compiled.definition.modelPolicy["response.grounding-review"] }),
            ...(state.invocation.compiled.definition.modelPolicy["response.grounding-review.repair"] === undefined
              ? {}
              : { reviewRepair: state.invocation.compiled.definition.modelPolicy["response.grounding-review.repair"] }),
          },
        });
      } catch (error) {
        response = technicalFailureResponse(state.invocation.emitter.events[0]?.correlationId);
        const failure = await state.invocation.emitter.emit("turn.failed", {
          stage: "compose",
          code: publicErrorCode(error),
          details: publicErrorDetails(error),
        }, { category: "audit", ...(observed.lastEventId === undefined ? {} : { causationId: observed.lastEventId }) });
        return { response, lastEventId: failure.id };
      }
      const event = await state.invocation.emitter.emit("response.composed", {
        status: response.status,
        grounded: response.grounded,
        source: response.source,
        claims: response.claims.length,
      }, { category: "audit", ...(observed.lastEventId === undefined ? {} : { causationId: observed.lastEventId }) });
      return { response, lastEventId: event.id };
    },
    commit: async (state: RuntimeStateValue) => {
      const response = requireState(state.response, "response");
      const reduced = requireState(state.checkpoint, "checkpoint");
      const checkpoint = {
        ...reduced,
        messages: [
          ...reduced.messages,
          state.invocation.currentMessage,
          { role: "assistant" as const, content: response.message, at: dependencies.clock.now() },
        ],
      };
      const traceId = state.invocation.emitter.events[0]?.correlationId ?? "unknown-trace";
      const result: TurnResult = {
        response,
        checkpoint,
        threadId: state.invocation.threadId,
        turnId: state.invocation.turnId,
        traceId,
        replayed: false,
      };
      await state.invocation.scope.commit({ value: result, checkpoint }, state.invocation.emitter.events);
      const committed = await state.invocation.emitter.emit("state.committed", {
        revision: checkpoint.revision,
      }, { category: "audit", ...(state.lastEventId === undefined ? {} : { causationId: state.lastEventId }) });
      const completed = await state.invocation.emitter.emit("turn.completed", {
        responseStatus: response.status,
        grounded: response.grounded,
      }, { category: "trace", causationId: committed.id });
      return { checkpoint, result, lastEventId: completed.id };
    },
  };
}

function mergePlans(left: TurnPlan, right: TurnPlan): TurnPlan {
  return {
    steps: [...left.steps, ...right.steps],
    ...(right.interaction ?? left.interaction) === undefined
      ? {}
      : { interaction: right.interaction ?? left.interaction },
    responseGoal: [left.responseGoal, right.responseGoal].filter(Boolean).join("; "),
    ...(right.answeredInteractionCapabilityId ?? left.answeredInteractionCapabilityId) === undefined
      ? {}
      : { answeredInteractionCapabilityId: right.answeredInteractionCapabilityId ?? left.answeredInteractionCapabilityId },
    ...(right.progressionAction === undefined ? {} : { progressionAction: right.progressionAction }),
    ...([...(left.cancelledAgendaItemIds ?? []), ...(right.cancelledAgendaItemIds ?? [])].length === 0
      ? {}
      : { cancelledAgendaItemIds: [...new Set([...(left.cancelledAgendaItemIds ?? []), ...(right.cancelledAgendaItemIds ?? [])])] }),
    ...([...(left.cancelledObjectiveIds ?? []), ...(right.cancelledObjectiveIds ?? [])].length === 0
      ? {}
      : { cancelledObjectiveIds: [...new Set([...(left.cancelledObjectiveIds ?? []), ...(right.cancelledObjectiveIds ?? [])])] }),
  };
}

function mergeReductions(left: TurnReduction, right: TurnReduction): TurnReduction {
  return {
    checkpoint: right.checkpoint,
    publishedFacts: [...left.publishedFacts, ...right.publishedFacts],
    invalidatedFacts: [...left.invalidatedFacts, ...right.invalidatedFacts],
    evidence: [...left.evidence, ...right.evidence],
    artifacts: [...left.artifacts, ...right.artifacts],
    issues: [...left.issues, ...right.issues],
    results: [...left.results, ...right.results],
  };
}

function progressionSelection(
  interaction: Interaction | undefined,
  selection: TurnSelection | undefined,
): Readonly<{ selection: CapabilitySelection; batch: IntentionBatch }> | undefined {
  if (
    interaction === undefined ||
    interaction.payload === undefined ||
    typeof interaction.payload !== "object" ||
    interaction.payload === null ||
    (interaction.payload as Record<string, unknown>)["kind"] !== "progression.group" ||
    selection === undefined
  ) return undefined;
  const answer = resolveSelection(interaction, selection);
  if (answer === undefined || typeof answer.value !== "object" || answer.value === null) return undefined;
  const value = answer.value as Record<string, unknown>;
  const evidence = [{
    text: answer.evidence,
    meaning: value["kind"] === "progression.continue"
      ? "continue the configured progression"
      : "select a capability from the active progression group",
    messageIndex: 0,
  }];
  if (value["kind"] === "progression.continue") {
    return {
      selection: { mode: "conversational", capabilityIds: [], rationale: "A structured choice continued the active progression.", evidence },
      batch: { answerToInteraction: answer, intentions: [], contradictions: [] },
    };
  }
  if (value["kind"] !== "progression.member" || typeof value["capabilityId"] !== "string") return undefined;
  const capabilityId = value["capabilityId"] as CapabilitySelection["capabilityIds"][number];
  const occurrenceIdentity = typeof value["occurrenceId"] === "string" ? value["occurrenceId"] : "member";
  const capability = interaction.options?.find((option) => option.id === selection.optionId)?.value;
  if (capability === undefined) return undefined;
  return {
    selection: { mode: "selected", capabilityIds: [capabilityId], rationale: "A structured choice selected a member of the active progression group.", evidence },
    batch: {
      answerToInteraction: answer,
      intentions: [{
        id: `progression.${occurrenceIdentity.slice(0, 32)}` as IntentionBatch["intentions"][number]["id"],
        objective: answer.evidence,
        evidence,
        references: [],
        proposedCapability: capabilityId,
        input: { request: answer.evidence },
        resolution: "resolved",
      }],
      contradictions: [],
    },
  };
}

function resolveSelection(
  interaction: Interaction | undefined,
  selection: TurnSelection | undefined,
): InteractionAnswer | undefined {
  if (selection === undefined) return undefined;
  if (interaction === undefined || selection.interactionId !== interaction.id) {
    throw new IntentionKernelError({
      code: "INTERACTION_SELECTION_MISMATCH",
      message: "The submitted selection does not match the active interaction.",
      retryable: false,
    });
  }
  if (selection.optionId !== undefined) {
    const option = interaction.options?.find((candidate) => candidate.id === selection.optionId);
    if (option === undefined) {
      throw new IntentionKernelError({
        code: "INTERACTION_OPTION_NOT_FOUND",
        message: "The submitted option does not exist in the active interaction.",
        retryable: false,
        context: { interactionId: interaction.id, optionId: selection.optionId },
      });
    }
    return { interactionId: interaction.id, value: option.value, evidence: option.label };
  }
  if (selection.action !== undefined && selection.action.trim().length > 0) {
    return {
      interactionId: interaction.id,
      value: { action: selection.action },
      evidence: selection.action,
    };
  }
  throw new IntentionKernelError({
    code: "INTERACTION_SELECTION_EMPTY",
    message: "The submitted selection has neither an option nor an action.",
    retryable: false,
  });
}

type AutomaticActivation =
  | Readonly<{
      kind: "progression";
      identity: string;
      occurrenceId: string;
      capabilityId: CapabilityId;
      input?: unknown;
    }>
  | Readonly<{
      kind: "dependency" | "resume";
      parentAgendaId?: AgendaItemId;
      identity: string;
      capabilityId: CapabilityId;
      input: unknown;
      intention?: IntentionBatch["intentions"][number];
    }>;

export function dependencyActivation(options: {
  readonly plan: TurnPlan;
  readonly results: readonly StepExecutionResult[];
  readonly checkpoint: KernelCheckpoint;
  readonly compiled: CompiledAgentDefinition;
}): AutomaticActivation | undefined {
  for (const result of options.results) {
    if (result.status !== "invoked" || result.result.status !== "needs_dependency") continue;
    const dependency = result.result;
    if (dependency.provider.capabilityId === result.capabilityId) {
      throw new IntentionKernelError({
        code: "DYNAMIC_DEPENDENCY_SELF_REFERENCE",
        message: "A capability cannot dynamically depend on itself.",
        retryable: false,
        context: { capabilityId: result.capabilityId, fact: dependency.requirement.type },
      });
    }
    const provider = options.compiled.capabilities.get(dependency.provider.capabilityId);
    if (provider === undefined) {
      throw new IntentionKernelError({
        code: "DYNAMIC_DEPENDENCY_PROVIDER_NOT_REGISTERED",
        message: "A dynamic dependency references an unregistered provider capability.",
        retryable: false,
        context: { capabilityId: dependency.provider.capabilityId, fact: dependency.requirement.type },
      });
    }
    const declaresFact = provider.provides.some((fact) =>
      fact.type === dependency.requirement.type && fact.version === dependency.requirement.version,
    );
    if (!declaresFact) {
      throw new IntentionKernelError({
        code: "DYNAMIC_DEPENDENCY_FACT_NOT_PROVIDED",
        message: "The declared dependency provider does not publish the required fact contract.",
        retryable: false,
        context: { capabilityId: provider.id, fact: dependency.requirement.type, version: dependency.requirement.version },
      });
    }
    return {
      kind: "dependency",
      parentAgendaId: `agenda:${result.stepId}` as AgendaItemId,
      identity: `${result.stepId}:${provider.id}`,
      capabilityId: provider.id,
      input: dependency.provider.input,
    };
  }

  const ready = options.checkpoint.agenda.filter((item) =>
    item.status === "waiting_facts" &&
    item.missingFacts.length > 0 &&
    item.missingFacts.every((requirement) => options.checkpoint.facts.some((fact) =>
      fact.type === requirement.type && fact.version === requirement.version,
    )),
  );
  const published = options.results.flatMap((result) =>
    result.status === "invoked" && result.result.status === "completed" ? result.result.facts : []);
  const resumable = ready.find((item) => item.missingFacts.some((requirement) =>
    published.some((fact) => fact.type === requirement.type && fact.version === requirement.version),
  )) ?? ready[0];
  const capabilityId = resumable?.intention.proposedCapability;
  if (resumable === undefined || capabilityId === undefined) return undefined;
  return {
    kind: "resume",
    identity: resumable.id,
    capabilityId,
    input: resumable.intention.input,
    intention: resumable.intention,
  };
}

function automaticIntention(options: {
  readonly capabilityId: CapabilityId;
  readonly capabilityDescription: string;
  readonly input: unknown;
  readonly currentMessage: string;
  readonly messageIndex: number;
  readonly identity: string;
  readonly meaning: string;
}): IntentionBatch["intentions"][number] {
  return {
    id: `automatic.${options.identity.slice(0, 48)}` as IntentionBatch["intentions"][number]["id"],
    objective: options.capabilityDescription,
    evidence: [{
      text: options.currentMessage,
      meaning: options.meaning,
      messageIndex: options.messageIndex,
    }],
    references: [],
    proposedCapability: options.capabilityId,
    input: options.input,
    resolution: "resolved",
  };
}

class ObservedModelGateway implements ModelGateway {
  lastEventId: string | undefined;

  constructor(
    private readonly gateway: ModelGateway,
    private readonly emitter: RuntimeStateValue["invocation"]["emitter"],
    causationId?: string,
    private readonly promptResolver?: ModelPromptResolver,
  ) {
    this.lastEventId = causationId;
  }

  async invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    const resolved = resolveModelPrompt(request, this.promptResolver);
    request = resolved.request;
    const invoked = await this.emitter.emit("model.invoked", {
      task: request.task,
      model: request.model ?? null,
      capabilityCount: request.capabilities.length,
      audit: observeModelRequest(request, resolved.resolution),
    }, { category: "trace", ...(this.lastEventId === undefined ? {} : { causationId: this.lastEventId }) });
    this.lastEventId = invoked.id;
    try {
      const result = await this.gateway.invoke(request);
      const completed = await this.emitter.emit("model.completed", {
        task: request.task,
        provider: result.provider,
        model: result.model,
        durationMs: result.durationMs,
        usage: result.usage ?? null,
        proposal: result.value,
      }, { category: "trace", causationId: invoked.id });
      this.lastEventId = completed.id;
      return result;
    } catch (error) {
      const failed = await this.emitter.emit("model.failed", {
        task: request.task,
        code: publicErrorCode(error),
      }, { category: "audit", causationId: invoked.id });
      this.lastEventId = failed.id;
      throw error;
    }
  }
}

function requireState<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`Runtime state ${field} is missing.`);
  return value;
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
