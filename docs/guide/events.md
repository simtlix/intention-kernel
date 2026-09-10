# Events and traces

The kernel emits structured `KernelEvent` records for interpretation, planning,
execution, effects, and commits. Model invocation audits include the effective
instructions and selected context, subject to the host's redaction policy. Events
explain these runtime boundaries; they are not a complete provider transcript or
an automatic filter for application secrets.

<TraceWalkthrough />

## Event envelope

```ts
interface KernelEvent<T = unknown> {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly stepId?: StepId;
  readonly sequence: number;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly category: "trace" | "audit" | "integration";
  readonly data: T;
}
```

`sequence` orders events within a turn. `correlationId` identifies the root turn trace. `causationId` links an event to the action that directly produced it. `stepId` associates execution events with a plan branch.

## Categories

| Category | Purpose |
| --- | --- |
| `trace` | Detailed diagnostic progress that may use shorter retention. |
| `audit` | Decisions and outcomes needed to explain runtime behavior. |
| `integration` | Boundaries with adapters, effects, commits, or downstream delivery. |

Categories are routing metadata. They do not weaken redaction or durability requirements.

## Capability progress

Capabilities and nested workflows can expose meaningful progress without publishing provider-specific events:

```ts
await context.events.emit(
  "subgraph.node.completed",
  { node: "build_steps", stepCount: output.steps.length },
  { category: "trace" },
);
```

The kernel wraps this publication as `capability.event`, attaches the current step and causal parent, and applies the configured redactor before calling the host event sink.

Event names use stable lowercase dot or hyphen segments. Event payloads should describe domain progress, not dump arbitrary runtime objects.

## Redaction

The `redact` option passed to `createKernel` applies before events leave the runtime. A host should remove credentials, personal data, provider payloads, and capability-private values.

Returning `null` clears an event's data while preserving its envelope. A redactor
result of `null` or `undefined` never falls back to the original payload. Omitting
the redactor preserves the payload subject to the built-in reasoning-field filter.

`model.invoked` includes `audit.prompt` with the prompt ID, contract version,
resolved revision, template and instruction hashes, and rendered `instructions`.
The built-in sanitizer removes fields named `chainOfThought`, `privateReasoning`,
and `rawReasoning`; it does not recognize arbitrary domain secrets. Configure the
host redactor for the data your sink may retain. See [versioned model
prompts](./models.md#versioned-model-prompts).

Facts have a separate model-visibility contract. Event redaction and prompt projection solve different problems and should both be implemented.

## Sink behavior

An `EventSink` may persist, stream, or export events. A production sink should preserve envelope fields exactly and remain idempotent for repeated deliveries from an outbox.

Trace export is not the turn transaction. The durability adapter commits the event outbox together with checkpoint and result; a separate delivery process may publish it to an observability platform.

## Debugging a turn

Follow this order:

1. find `turn.started` by `threadId` and `turnId`;
2. inspect the projected-context event;
3. inspect `capabilities.selected`, its evidence, rationale and compact candidate set;
4. inspect interpreted intentions and confirm each uses a selected contract;
5. inspect the validated plan and unavailable alternatives;
6. follow each `stepId` through capability execution;
7. inspect facts, invalidations, and interactions;
8. verify response citations and grounding review;
9. confirm `state.committed`.

This separates model interpretation failures from planning, capability, grounding, and persistence failures.
