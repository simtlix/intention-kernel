# Execution architecture

Intention Kernel is a capability-first orchestration runtime. The model controls interpretation and language. The kernel controls authority, ordering, durability, and evidence integrity.

The host application assembles an immutable agent definition from capabilities, policies, and model-selection rules. It also injects the adapters that connect the runtime to model providers, persistence, observability, and domain systems. The kernel compiles that definition into one executable graph and applies the same turn contract to every conversation.

During a turn, the model interprets what the user means and proposes intentions. The kernel validates those proposals against the compiled agent, builds a dependency-aware plan, and invokes only authorized capabilities. Capabilities reach external systems through typed ports and return evidence. The kernel reduces validated results into durable facts, asks the model to compose a cited response, verifies its grounding, and commits the response, checkpoint, and event outbox atomically.

<DocFlow name="architecture" />

<KernelFlow />

## Architectural concepts

### Agent

An **agent** is an immutable compiled definition: conversational identity, registered capabilities, policies, and task-based model selection. It does not own infrastructure clients or mutable conversation state. A compiled agent runs many isolated threads through the same contract.

### Intention

An **intention** is the model's structured interpretation of a user objective in the current conversational context. It includes the proposed objective, message-level evidence, typed input, resolved references, and the capability that may satisfy it.

An intention is a proposal. It cannot execute code, grant authorization, or mutate state. The kernel validates it before creating a plan step.

### Capability

A **capability** is one registered domain operation the agent may perform, such as searching verified knowledge, preparing a request, or submitting it. Its definition declares:

- stable identity and version;
- input and output schemas;
- required, provided, and invalidated facts;
- `none`, `read`, or `write` effect semantics;
- confirmation requirements;
- semantic guidance for model selection;
- executable domain code.

The capability is the authority boundary. The model can propose it, but only the kernel can authorize and invoke it.

### Port

A **port** is an interface a capability uses to reach something outside the kernel. Examples include a knowledge index, catalog client, repository, payment gateway, or nested workflow runner.

Ports keep infrastructure SDKs out of agent definitions, prompts, checkpoints, and the public kernel API. A capability receives them through `context.ports` only after the operation has been authorized.

### Tool

A **tool** is an optional provider-level representation used by a model adapter, typically a name, description, and JSON input schema. It may help a provider produce structured output, but it is not a kernel primitive and has no execution authority.

In Intention Kernel, the durable domain contract is the capability. A model tool must never invoke infrastructure directly or bypass planning, policies, schemas, confirmation, and effect coordination.

### Adapter

An **adapter** is a concrete host implementation of a port or runtime boundary. For example:

- `GeminiModelGateway` adapts Gemini structured output to `ModelGateway`;
- a PostgreSQL implementation adapts transactions to `Durability`;
- an HTTP client adapts a remote knowledge service to a capability's knowledge port;
- a LangGraph `StateGraph` adapts a nested workflow to `PlanningGraphPort`.

Ports define what the application needs. Adapters define how a specific technology supplies it.

### Fact

A **fact** is versioned knowledge confirmed by capability execution. It stores its value, producer, evidence IDs, dependency lineage, visibility, and optional model redactions. The kernel validates the fact contract and evidence links; the capability owns validation of its domain value.

Facts are canonical conversation state. They are not assumptions extracted from prose. Later capabilities can require them, planners can order work around them, and invalidation rules remove descendants when an upstream fact changes.

### Event

An **event** is a sanitized observation of something that happened during a turn. Its envelope includes sequence, correlation, causation, thread, turn, optional plan step, category, and versioned data.

Events make interpretation, planning, capability execution, nested workflow progress, fact reduction, grounding, effects, and commit behavior reconstructable. They provide observability; they do not replace the durable checkpoint or become business state.

## How the concepts connect

<DocFlow name="concepts" />

## Runtime ownership

| Layer | Owns | Must not own |
| --- | --- | --- |
| Host application | Agent definitions, capabilities, policies, adapters, tenant authorization | Kernel internals |
| Model gateway | Provider invocation and structured output | Capability execution authority |
| Kernel | Context projection, validation, planning, execution coordination, reduction, grounding, commit | Domain-specific routes or infrastructure clients |
| Capability | One domain operation and its semantic contract | Global conversation orchestration |
| Port adapter | External system integration | User-intention interpretation |
| Durability adapter | Serialization, replay, checkpoints, effects, outbox | Business meaning |
| Nested workflow | Private implementation of one capability | Parent checkpoint ownership |

## Turn sequence

### 1. Build context

The runtime enters `Durability.withTurn`, loads the canonical checkpoint, and projects bounded context. The projection includes recent messages, visible facts, pending agenda, the active interaction, host context, and explicit redactions.

### 2. Select capabilities

The model sees a compact registry containing only capability identity,
description, availability and blocked prerequisites. It selects the smallest
set that can plausibly cover every objective in the message. The kernel rejects
unknown IDs and emits the decision, evidence and concise rationale as
`capabilities.selected`.

### 3. Interpret

The model receives only the expanded contracts selected in the previous stage
and produces an `IntentionBatch`. Each proposed objective includes message-level
evidence, an optional capability, typed input, references, and resolution state.
The batch may also answer an existing interaction or report contradictions. A
resolved intention cannot reference a capability outside the selected set.

### 4. Validate and plan

The kernel checks capability registration, schema validity, policy decisions, fact prerequisites, dependencies, confirmation, ambiguity, and execution limits. It creates a `TurnPlan`; it does not execute an unregistered model proposal.

Independent reads may share an execution level. A step requiring a fact produced by another step is ordered after it. Conflicting unresolved work becomes an interaction instead of an arbitrary choice.

### 5. Execute

The executor runs authorized capabilities with a frozen context containing ports, confirmed facts, conversation context, cancellation, technical execution identity, event publication, and effect coordination.

Capabilities return explicit results: completed work, missing input, a required dependency, confirmation, or a safe domain failure.

### 6. Reduce

Completed results are validated. The reducer publishes facts with evidence lineage, invalidates stale fact roots and descendants, updates pending agenda items, and selects the active interaction.

### 7. Compose and verify

The response model receives a `ResponseBrief`, not arbitrary runtime state. It writes ordered cited parts. The kernel derives exact claims, performs semantic grounding review, and creates a `TurnResponse` with artifacts and interactions. A capability may declare `canonicalResponse.required: true` for a current-turn result that must appear verbatim, once, with its evidence. When authored copy covers every completed operation and there is no separate issue or lifecycle decision, the kernel directly delivers all current canonical answers and the real required interaction. A pure pending required interaction likewise delivers its server-owned goal directly. These paths do not invoke response models, and their exact validated text is committed to the checkpoint.

Informational work, issues, lifecycle decisions and mixed completed work lacking canonical copy retain composition and one bounded repair. Distinct canonical answers that overlap a required span also retain composition in unprotected turns if their joined copy would repeat that span. Answers wholly contained in another are not repeated, and all citations remain attached. Protected or redacted delivery fails closed on unresolved exact-copy collisions without exposing originals to a model. Required result and invitation checks remain independent of model approval; a partial fallback cannot discard an unrepresented completed answer. Ordinary fallback-only copy remains limited to a single completed capability. Without a valid response, the turn fails closed. Model-composed turns still rely on semantic review; direct canonical delivery is a bounded invariant.

### 8. Commit

The durability adapter atomically commits the successor checkpoint, turn result, and event outbox. A repeated committed turn ID returns the stored result without executing the graph again.

## Multiple objectives

One message may request several independent or dependent operations.

<DocFlow name="objectives" />

The model identifies both objectives. The planner validates both capabilities and schedules their independent reads together. The response is composed once from both evidence sets.

If one operation depends on a fact produced by another, the compiler and planner use `requires` and `provides` to establish the order. If a required fact remains unavailable, the kernel creates pending work or an interaction instead of fabricating input.

## Controlled and free progress

A durable agenda allows safe work to continue around a controlled operation:

<DocFlow name="confirmation" />

The informational turn does not discard or silently accept the pending write. The later answer is interpreted against the active interaction and full canonical context.

## LangGraph boundary

LangGraph is the private graph execution engine. Consumers compile and run an `IntentionKernel`; they do not import LangGraph types from the public package.

Nested LangGraph workflows are port implementations behind capabilities. This keeps workflow-engine state from competing with kernel checkpoints, fact state, or effect receipts.

## Source map

| Responsibility | Source |
| --- | --- |
| Agent compilation | `src/compiler/` |
| Context projection | `src/context/` |
| Intention interpretation | `src/interpreter/` |
| Plan construction | `src/planner/` |
| Capability and effect execution | `src/executor/` |
| Fact and agenda reduction | `src/reducer/` |
| Response composition and grounding | `src/composer/` |
| LangGraph runtime assembly | `src/runtime/` |
| Public contracts | `src/contracts/` |
| Schema abstraction | `src/schema/` |
