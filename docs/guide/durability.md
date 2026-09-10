# Durability and effects

Durability is the transaction boundary of a turn. It prevents duplicate committed turns, coordinates external write receipts, and commits the next checkpoint together with the observable result.

## Turn boundary

The host implements `Durability.withTurn(scope, operation)`. For a given `threadId`, it must:

1. serialize concurrent mutations;
2. load the latest checkpoint;
3. return an existing result when the same `turnId` was already committed;
4. expose durable effect coordination to the operation;
5. atomically commit the result, next checkpoint, and event outbox.

<DocFlow name="durability" />

The public in-memory adapter from `intention-kernel/testing` supports application tests, evaluations, and examples. Its state lives only in the current process; production persistence requires a durable host adapter.

## Replay

A repeated committed `turnId` returns the stored `TurnResult` with `replayed: true`. No interpretation, capability, model response, or external effect runs again.

Replay depends on the caller preserving turn identity across transport retries. Generating a new ID for the same user delivery creates a new turn by design.

## Durable external effects

A write capability performs mutations through `context.runEffect`:

```ts
const effect = await context.runEffect(`charge:${input.paymentIntentId}`, (authority) =>
  payments.createCharge(input, {
    idempotencyKey: authority.idempotencyKey,
    signal: context.signal,
  }),
);
// effect.value contains the provider result.
// effect.receipt contains its durable identity and completed status.
```

This fragment assumes a host payment port and a stable payment-intent ID. The
[capability example](./capabilities.md#definition-anatomy) shows a complete factory
that returns `effect.value` in an evidence-bearing capability result.

The kernel prefixes the supplied key with the capability ID. The durability
adapter deduplicates that key across turns within the thread: a later call with
the same key returns the original `{ value, receipt }` without calling the
provider. Use a different business operation ID for a distinct write. A fixed
key such as `charge` would replay the first charge for every later request in
that thread; a new random key on every retry would permit duplicates.

Turn and step IDs are receipt metadata, not part of the deduplication key. The
callback receives `EffectAuthority` with the coordinated key and prepared receipt
ID. Thread and tenant IDs are not automatically included in that provider key;
the host port must apply the namespace required by its provider and preserve it
across retries. Prefer a globally unique business operation ID when the provider
uses a global idempotency namespace.

Receipts move through explicit states:

- `prepared`
- `completed`
- `failed`
- `uncertain`

If an operation throws and the adapter cannot prove it was not applied, the
receipt becomes `uncertain`, including when a response is lost after a successful
write. The adapter fails closed with `EffectUncertainError`; later turns cannot
retry it blindly. Only `EffectNotAppliedError`, raised when the host can establish
that no write occurred, records `failed` and permits a retry. Production adapters
must preserve these rules across process restarts.

## Confirmation

A capability declared with `effect: "write"` and `confirmation: "required"` is not executed in the proposing turn. The kernel creates a durable confirmation interaction. A later accepted answer resumes the planned operation.

An unrelated safe question may still be answered while confirmation remains pending. The checkpoint retains both the active interaction and the additional completed work.

With `confirmation: "capability"`, execution may start before confirmation so the
capability can collect and present domain details. The capability must return its
own `needs_confirmation` interaction and validate the resumed answer before
calling `runEffect`. This mode delegates consent handling to the host code; it
does not itself authorize a write. Compilation rejects `confirmation: "none"`
for write capabilities.

## Checkpoint contents

`KernelCheckpoint` stores only canonical runtime state:

- bounded conversation messages;
- versioned fact records and evidence lineage;
- pending agenda items;
- the active interaction;
- durable effect receipts;
- agent fingerprint and schema revision.

Business-specific workflow state belongs in facts produced by capabilities, not in conditional fields added to the kernel.

## Production checklist

- Use a transaction-capable store.
- Serialize by `threadId`.
- Enforce uniqueness for committed `turnId` values.
- Persist effect preparation before invoking a remote write.
- Deduplicate logical effect keys across turns within a thread, independently of turn replay.
- Commit the event outbox with the turn result.
- Treat uncertain receipts as manual or domain-specific reconciliation work.
- Verify checkpoint schema and agent fingerprint compatibility during deployment.
