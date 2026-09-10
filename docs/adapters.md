# Adapter guide

Intention Kernel owns orchestration invariants. The host owns infrastructure through four boundaries.

Hosts may supply `InteractionOption.referenceExamples` as exact-reference hints: at most 32 non-blank strings of at most 256 characters each, or an empty array. Preserve them losslessly with checkpoint interactions. They never authorize a selection or bypass review; the kernel uses an exact example competing with another current display position to require clarification. The kernel does not inspect opaque host payloads for aliases. Model projections redact these examples with the same capability-owned redactions as other interaction fields.

## ModelGateway

`ModelGateway.invoke()` receives a provider-neutral structured request:

- `task`: stable semantic task such as `capability.select`, `turn.interpret`, `response.compose` or `response.grounding-review`.
- `model`: optional model selected by the agent's `modelPolicy`.
- `system` and `input`: canonical instructions and JSON-safe context.
- `outputSchema`: runtime validation plus optional JSON Schema projection.
- `capabilities`: compact summaries for `capability.select`, expanded contracts for `turn.interpret`, and an empty array for response tasks.
- `signal`: cancellation and timeout propagation.

The adapter should request structured JSON from the provider, return parsed data in `value`, and report sanitized provider/model/usage metadata. The kernel validates `value`; provider errors should be wrapped as `ModelGatewayError` with a stable code and without credentials or raw sensitive bodies.

Model switching belongs in this adapter. A single gateway may dispatch by `request.model` to Gemini, OpenAI, Anthropic or a local model without changing the agent definition or capability code.

## Durability

`Durability.withTurn()` must:

1. serialize execution for a `threadId`;
2. return a committed prior result for a duplicate `turnId`;
3. load the latest checkpoint;
4. coordinate effects by idempotency key;
5. atomically commit the result, successor checkpoint and event outbox.

A production relational adapter normally uses one transaction for the turn record, checkpoint revision and outbox, plus a unique constraint on `(thread_id, turn_id)`. External calls cannot share that database transaction, so effect receipts must be written before and after the call. A recovered `prepared` receipt becomes `uncertain`; it is not safe to call the provider again without reconciliation.

Checkpoint storage must round-trip the complete JSON value, including kernel-private agenda metadata for dependency ownership and unconsumed choice answers. Do not reconstruct agenda records from a public-field allowlist: doing so loses pending execution authority. This metadata is not capability input and must not be copied into model requests.

`createMemoryDurability()` from `intention-kernel/testing` is a conformance helper, not production storage.

## EventSink

The sink receives sanitized `KernelEvent` envelopes. Persist or export them using `threadId`, `turnId`, `sequence`, `correlationId` and `causationId` so a UI can reconstruct the path from input to response. Do not treat trace events as a replacement for the durable outbox when delivering integration events.

Pair `model.completed` with its `model.invoked` event using `causationId`. The request audit contains the projected messages, fact values and provenance, active choices, selected guidance and repair issues. The result contains the model's structured proposal, including its declared rationale. Compare these with `intention.interpreted`, `plan.created` and capability events to locate the first divergence. Configure the host redactor for contact fields and other sensitive domain values before persisting events.

## Domain ports

`ports` is an instance-scoped map available only inside capabilities. Store authenticated catalog clients, repositories or service adapters there; never place them in prompts, facts or checkpoints. A capability narrows the required port at its boundary and converts upstream failures into either a safe `CapabilityIssue` or a typed exceptional error.

Tenant identity and authorization remain host concerns. The model must never select a tenant, credential or permission scope.

### Nested graph adapter

A nested graph is an implementation of a domain port, not a second kernel API.
The capability remains the authority boundary: it validates the graph input,
calls the injected adapter, validates its completed output and publishes facts
plus evidence. The graph can report node progress with
`context.events.emit(name, data)`; the kernel associates each publication with
the parent capability step, applies redaction and preserves causal order.

This pattern keeps checkpoint and effect ownership unambiguous. A nested graph
must not write the parent checkpoint directly, and any irreversible operation
still crosses `context.runEffect()` in the parent capability.
