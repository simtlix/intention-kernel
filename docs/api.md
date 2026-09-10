---
description: Explore the public Intention Kernel runtime and testing APIs for agents, capabilities, adapters, scenario evaluations, assertions, and reports.
---

# Public API

Only `intention-kernel` and `intention-kernel/testing` are supported import paths. Files under `dist` are implementation details and are blocked by package exports.

## Entry points

| Import | Responsibility | Reference |
| --- | --- | --- |
| `intention-kernel` | Agent definitions, compilation, capabilities, execution, and runtime contracts | [Runtime exports](./reference/intention-kernel.md) |
| `intention-kernel/testing` | Declarative evaluations, assertions, adapters, reports, and test helpers | [Testing exports](./reference/testing/intention-kernel.md) |

The sections below cover both entry points. Jump to [Testing and evaluation](#testing-subpath) for its functions and contracts, or use the testing groups in the API sidebar.

## Runtime

- `createKernel(options)`: validates adapters and limits, then creates an isolated kernel instance.
- `IntentionKernel`: compiles immutable agent definitions.
- `CompiledAgent`: exposes identity, version, fingerprint and `run()`.
- `KernelOptions`: model, durability, event, ports, clock, ID and redaction adapters.
- `KernelLimits`: turn timeout, maximum steps and bounded recent-message count.
- `KernelClock`, `KernelIdGenerator`: injectable time and unique-ID sources.
- `RunTurnInput`, `TurnResult`, `TurnResponse`: public turn boundary and committed result.

`run()` may throw a typed exceptional error before commit. Expected conversational outcomes such as ambiguity, missing input, confirmation, unsupported work or domain failure are represented in the response, agenda or interaction.

## Definitions

- `defineAgent()`, `AgentDefinition`: declare identity, capabilities, policies and model selection by task.
- `defineCapability()`, `CapabilityDefinition`: declare one executable operation, its schemas, fact dependencies, effects and semantic guidance.
- `definePolicy()`, `PolicyDefinition`, `PolicyDecision`: add pure host-owned constraints evaluated by the planner.
- `defineModelGuidancePolicy()`, `ModelGuidancePolicyDefinition`: select host-owned semantic guidance from canonical turn state before capability routing. Guidance informs the model but never authorizes execution.
- `defineSchema()`, `RuntimeSchema`, `SchemaDefinition`, `ValidationResult`, `ValidationIssue`, `JsonSchema`: adapt any validator through Standard Schema-like runtime semantics without leaking its vendor type.

## Capability data

- `CapabilityExecutionContext`: domain ports, confirmed facts, abort signal, kernel-owned execution identity and durable `runEffect()`.
- `CapabilityEventPublisher`, `CapabilityEventOptions`: sanitized, step-scoped progress from domain adapters and nested workflows.
- `CapabilityResult`: completed, needs-input, needs-dependency, needs-confirmation or failed outcome.
- `CapabilityIssue`, `Artifact`: safe domain failure and structured channel output.
- `FactReference`, `FactRequirement`, `FactDeclaration`, `FactCandidate`, `FactRecord`: versioned facts and lineage.
- `EvidenceRecord`: evidence persisted with confirmed facts and used for response grounding.
- `Interaction`, `InteractionOption`, `InteractionAnswer`: server-owned user input, choice, clarification and confirmation contracts.
- `AgendaItem`, `ConversationMessage`, `KernelCheckpoint`: durable conversation state.
- `EffectStatus`, `EffectAuthority`, `EffectExecution`, `EffectReceipt`, `DurableEffectIdentity`, `DurableTurnResult`, `DurableTurnScope`, `Durability`: effect and persistence contracts.

`InteractionOption.referenceExamples?: readonly string[]` is additive and optional; existing options and an empty array remain valid. Supply at most 32 non-blank examples, each at most 256 characters. These hints never authorize selection. An exact text/example reference competing with a different current display position requires clarification, while validated structured clicks remain authoritative. Invalid examples in a restored interaction or a capability result throw `INVALID_INTERACTION_REFERENCE_EXAMPLES` before the interaction is used or published.

`Interaction.responseMode?: "contextual"` opts into reviewed wording that acknowledges needs explicitly stated in the current message or recent conversation before asking for input. For a required interaction, the exact `goal` must appear once. This field controls presentation, not whether input is required: `mode`, options, requested facts and execution authority remain unchanged.

Omit `responseMode` to preserve the canonical fast path. Contextual delivery uses `response.compose` and `response.grounding-review`, with at most one composition repair and its review before canonical fallback. Provider adapters may have their own retry limits. Protected delivery and redacted required questions bypass contextual composition; unsupported values throw `INVALID_INTERACTION_RESPONSE_MODE` at checkpoint or capability-result validation.

`CapabilityExecutionContext.runEffect(localKey, operation)` prefixes the key with the capability ID and returns `EffectExecution<T>` containing `{ value, receipt }`. The operation receives `EffectAuthority` with the coordinated key and receipt ID. Durability deduplicates that key across turns within the thread, so preserve it for retries of one logical operation and change it for a distinct operation. A constant such as `create-quote` would replay the first quote on later turns; include a stable business operation ID instead. Neither a turn ID nor a step ID is added to the effect key. The host must also satisfy its provider's tenant or global idempotency namespace. See [durability and effects](./guide/durability.md).

## Model and events

### Identified and versioned instructions

`ModelPromptDefinition` identifies one exact variant with `id`, positive `contractVersion`, default `template` and declared `variables`. `ModelPromptReference` supplies that definition and literal string `values`. All 24 kernel variants are registered in the deeply frozen `getKernelPromptDefinitions()` catalog, including separate reviews that share a model task name. Existing default assembled instructions are preserved exactly.

`ModelRequest.prompt` is optional for host adapter compatibility; kernel requests always set it. Inject `KernelOptions.promptResolver: ModelPromptResolver` to resolve an immutable preloaded snapshot. Its synchronous `resolve(reference)` returns `ResolvedModelPrompt` with `template` and nonempty `revision`; never perform database reads in this method. With no resolver, the kernel uses the definition template and records revision `default`.

`renderModelPrompt(definition, values, template?)` substitutes exact `{{variable}}` tokens once. It never evaluates functions, property paths or inserted text. Variable names match `[A-Za-z_][A-Za-z0-9_]{0,63}` and are unique (at most 128). Every declared variable needs an own string value, even if a replacement omits its placeholder. Extra values, accessors, malformed tokens and undeclared names fail. IDs match `[A-Za-z][A-Za-z0-9._-]{0,199}`; versions are positive safe integers. Templates, each value and final UTF-8 instructions are limited to 1 MiB.

Resolution and validation happen before `model.invoked` and provider invocation. The existing redaction boundary processes `audit.prompt` containing `id`, `contractVersion`, `revision`, SHA-256 `templateHash`, SHA-256 `instructionHash` and effective `instructions`. These are the instructions sent to the provider. Existing input projections, schemas and post-provider validation remain enforced. This audit does not capture a complete replayable provider request; hosts own authorized input/schema capture.

Invalid rendering throws `KernelConfigurationError` with `INVALID_MODEL_PROMPT`; a missing kernel reference uses `MODEL_PROMPT_UNIDENTIFIED`. A thrown resolver error becomes sanitized `MODEL_PROMPT_RESOLUTION_FAILED`; malformed resolver returns use `INVALID_MODEL_PROMPT_RESOLUTION`. Revisions must contain 1–200 characters and cannot be all whitespace. Failures never invoke a fallback revision or provider for that request. A composition-stage failure can still produce the existing technical failure response.

The compilable `examples/versioned-prompts.ts` example demonstrates snapshot injection and shared preview rendering. Prompt storage, publication and authorization remain host responsibilities.

- `ModelGateway`, `ModelRequest`, `ModelResult`, `ModelCapability`, `ModelCapabilitySummary`, `ModelCapabilityContract`, `ModelUsage`: structured, provider-neutral model boundary. Summary projections drive capability selection; full contracts are disclosed only for selected operations.
- `EventSink`, `KernelEvent`: sanitized causal observability boundary.
- `IntentionEvidence`, `ContextReference`, `IntentionRequest`, `Contradiction`, `IntentionBatch`: model-proposed semantic interpretation types stored in the agenda when unresolved.
- `ResponseClaim`, `CompletedWork`, `ResponseBrief`: evidence-bearing response contracts.

The event stream records selected capabilities with evidence and concise rationale, interpreted objectives, normalized plan inputs, dependency decisions, capability outputs, fact changes, interactions, effect receipts and model usage. It deliberately strips fields named `chainOfThought`, `privateReasoning` or `rawReasoning`; a host should also supply `redact()` for domain-specific secrets and personal data.

Capability publications use the stable kernel event type `capability.event`. Its
data contains `capabilityId`, the domain event `name` and sanitized `data`.
Names use lowercase dot or hyphen segments, such as `subgraph.node.started`.
Parallel capabilities preserve separate causation branches instead of appearing
to cause one another.

## Identifiers

Semantic identifiers use lowercase dot or hyphen segments:

`BrandedId<Name>` is the nominal-string basis for all ID types; use the constructors below rather than casting it directly.

- types: `AgentId`, `CapabilityId`, `FactType`, `PolicyId`;
- constructors: `agentId()`, `capabilityId()`, `factType()`, `policyId()`.

Opaque host/runtime identifiers require a non-empty value:

- types: `ThreadId`, `TurnId`, `StepId`, `IntentionId`, `EvidenceId`, `InteractionId`, `AgendaItemId`, `EffectId`;
- public constructors: `threadId()`, `turnId()`, `evidenceId()`, `interactionId()`, `effectId()`.

The remaining opaque IDs are produced by the kernel or recovered from typed state and should not be fabricated by consumers. `effectId()` is intended for durability adapters.

## Errors

Runtime exceptions extend `IntentionKernelError` and expose `code`, sanitized `context`, and `retryable`:

- `KernelConfigurationError`
- `AgentCompilationError`
- `SchemaValidationError`
- `ModelGatewayError`
- `DurabilityError`
- `EffectUncertainError`
- `EffectNotAppliedError`
- `ExecutionBudgetExceededError`

`toJSON()` intentionally omits the original `cause`.

## Testing and evaluation {#testing-subpath}

Import these exports from `intention-kernel/testing` in the application that installed the library. Evaluation is a function call that returns a report; it requires no library repository scripts or particular test runner.

### Functions

| Function | Purpose |
| --- | --- |
| [runEvaluation(options)](./reference/testing/intention-kernel.runevaluation.md) | Execute a suite through an adapter and return its complete case inventory, observations, and assertion results. Options control selection, repetitions, concurrency, cancellation, and progress callbacks. |
| [parseEvaluationSuite(value)](./reference/testing/intention-kernel.parseevaluationsuite.md) | Validate a JSON-compatible definition, including scenarios, steps, variants, and multiple acceptance criteria. |
| [createAgentEvaluationAdapter(options)](./reference/testing/intention-kernel.createagentevaluationadapter.md) | Connect an existing compiled agent and optional correlated events to the evaluation runner. |
| [evaluateAssertions(assertions, context, evaluators)](./reference/testing/intention-kernel.evaluateassertions.md) | Evaluate built-in checks, `all`/`any`/`not` expressions, and registered business evaluators against supplied evidence. |
| [parseEvaluationReport(value)](./reference/testing/intention-kernel.parseevaluationreport.md) | Validate an imported report before displaying or resuming it. |
| [createMemoryDurability(options)](./reference/testing/intention-kernel.creatememorydurability.md) | Create an in-memory store with conversation serialization, turn deduplication, and effect semantics for tests and local fixtures. It does not survive process restarts. |
| [createEventCollector()](./reference/testing/intention-kernel.createeventcollector.md) | Create a kernel event sink whose recorded events are available for assertions and diagnostics. |

### Definitions and assertions

| Contract | Role |
| --- | --- |
| [EvaluationSuite](./reference/testing/intention-kernel.evaluationsuite.md) | Versioned definition containing scenarios and optional checks across cases. |
| [EvaluationScenario](./reference/testing/intention-kernel.evaluationscenario.md), [EvaluationStep](./reference/testing/intention-kernel.evaluationstep.md), [EvaluationVariant](./reference/testing/intention-kernel.evaluationvariant.md) | Ordered conversation, acceptance criteria at turn and scenario scope, and complete alternative inputs. |
| [EvaluationAssertion](./reference/testing/intention-kernel.evaluationassertion.md), [EvaluationOperator](./reference/testing/intention-kernel.evaluationoperator.md), [EvaluationPath](./reference/testing/intention-kernel.evaluationpath.md) | Declarative checks and logical composition over safe observation paths. |
| [EvaluationEvaluator](./reference/testing/intention-kernel.evaluationevaluator.md), [EvaluationEvaluators](./reference/testing/intention-kernel.evaluationevaluators.md), [EvaluationContext](./reference/testing/intention-kernel.evaluationcontext.md) | Named business or semantic evaluators, their registry, and immutable observation/history evidence. |
| [EvaluationData](./reference/testing/intention-kernel.evaluationdata.md), [EvaluationValue](./reference/testing/intention-kernel.evaluationvalue.md) | JSON-safe data shared by definitions, observations, parameters, and reports. |

### Execution and transport

| Contract | Role |
| --- | --- |
| [EvaluationOptions](./reference/testing/intention-kernel.evaluationoptions.md) | Runner dependencies, execution limits, selection, and lifecycle callbacks. |
| [AgentEvaluationAdapterOptions](./reference/testing/intention-kernel.agentevaluationadapteroptions.md) | Compiled agent, event source, and optional durable resume support for the direct adapter. |
| [EvaluationAdapter](./reference/testing/intention-kernel.evaluationadapter.md), [EvaluationSession](./reference/testing/intention-kernel.evaluationsession.md), [EvaluationSessionContext](./reference/testing/intention-kernel.evaluationsessioncontext.md) | Application-owned conversation transport and per-case session lifecycle. |
| [EventCollector](./reference/testing/intention-kernel.eventcollector.md) | Event sink with a readable collection of recorded kernel events. |

### Reports and results

| Contract | Role |
| --- | --- |
| [EvaluationReport](./reference/testing/intention-kernel.evaluationreport.md) | Definition snapshot, target identity, complete case inventory, and suite-level assertion results. |
| [EvaluationCaseResult](./reference/testing/intention-kernel.evaluationcaseresult.md), [EvaluationTurnResult](./reference/testing/intention-kernel.evaluationturnresult.md) | Executed inputs, observations, assertions, and outcomes for each case and turn. |
| [EvaluationAssertionResult](./reference/testing/intention-kernel.evaluationassertionresult.md) | Pass/fail result, actual and expected values, evaluator evidence, errors, and composite children. |
| [EvaluationCaseStatus](./reference/testing/intention-kernel.evaluationcasestatus.md), [EvaluationSummary](./reference/testing/intention-kernel.evaluationsummary.md) | Distinct case outcomes and counts, including incomplete and excluded cases. |
| [EvaluationEvent](./reference/testing/intention-kernel.evaluationevent.md) | Ordered run, case, and turn lifecycle notifications. |

### Errors and version

[EvaluationError](./reference/testing/intention-kernel.evaluationerror.md) is separate from the runtime exception hierarchy. Its `code` identifies the validation or execution failure; `paths` contains safe field locations when available. Failed acceptance criteria normally appear in the report instead of rejecting the call.

[TESTING_VERSION](./reference/testing/intention-kernel.testing_version.md) is the installed package version, identical to the runtime's `VERSION`.

For a complete consumer example, see [Evaluating from your project](./guide/evaluation/quick-start.md). For acceptance semantics and diagnosis, see [Assertions and evaluators](./guide/evaluation/assertions.md) and [Reports and agent iteration](./guide/evaluation/reports.md).
