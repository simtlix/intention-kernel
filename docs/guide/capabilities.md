# Capabilities

A capability is the smallest unit of domain authority in Intention Kernel. It declares what an agent can do, the conditions under which the operation applies, the facts it consumes and produces, and the code allowed to perform it.

## Definition anatomy

This factory accepts the host's runtime schemas. Inject a `requests` port when
creating the kernel; it must authorize access to the existing request, enforce
the provider's idempotency namespace, and return the validated submission result.
The request ID identifies one logical submission and must survive retries.

```ts
import {
  capabilityId,
  defineCapability,
  evidenceId,
  factType,
  type RuntimeSchema,
} from "intention-kernel";

type SubmitInput = { requestId: string };
type SubmitOutput = { reference: string };

export function createSubmitCapability(
  input: RuntimeSchema<SubmitInput>,
  output: RuntimeSchema<SubmitOutput>,
) {
  return defineCapability({
    id: capabilityId("request.submit"),
    version: 1,
    description: "Submit an existing service request",
    input,
    output,
    requires: [],
    provides: [{ type: factType("request.submitted"), version: 1 }],
    effect: "write",
    confirmation: "required",
    guidance: {
      whenToUse: ["The user asks to submit an existing request"],
      whenNotToUse: ["The user is still preparing a request"],
      examples: ["Submit request REQ-123"],
    },
    async execute(context, input) {
      const requests = context.ports["requests"] as {
        submit(requestId: string, options: {
          idempotencyKey: string;
          signal: AbortSignal;
        }): Promise<SubmitOutput>;
      };
      const effect = await context.runEffect(`submit:${input.requestId}`, (authority) =>
        requests.submit(input.requestId, {
          idempotencyKey: authority.idempotencyKey,
          signal: context.signal,
        }),
      );
      const evidence = evidenceId(`submitted:${effect.receipt.id}`);
      return {
        status: "completed",
        output: effect.value,
        facts: [{
          type: factType("request.submitted"),
          version: 1,
          value: effect.value,
          evidenceIds: [evidence],
          dependsOn: [],
        }],
        evidence: [{
          id: evidence,
          source: "external",
          content: `Request submitted with reference ${effect.value.reference}.`,
          data: effect.value,
        }],
        artifacts: [],
      };
    },
  });
}
```

### Identity and version

`id` is stable domain identity. `version` identifies the published contract. Changing schemas, fact semantics, or execution behavior requires deliberate versioning.

### Schemas

`input` validates model-proposed arguments before execution. `output` validates completed output before reduction. Both use the vendor-neutral `RuntimeSchema` contract. Model-visible inputs must also provide `jsonSchema()` so the gateway can describe their accepted shape; the output schema's JSON projection is optional.

### Fact graph

- `requires` declares prerequisites.
- `provides` declares new confirmed knowledge.
- `invalidates` removes facts that become stale after this operation.

The compiler uses these declarations to validate the agent. The planner uses them to order dependent work. The reducer uses them to keep the checkpoint coherent.

### Effect classification

| Effect | Meaning | Execution rule |
| --- | --- | --- |
| `none` | Pure computation inside the process | No external observation or mutation |
| `read` | External observation | May run concurrently when independent |
| `write` | External mutation | Requires an explicit confirmation mode and must use durable effect coordination |

### Confirmation

| Mode | Behavior |
| --- | --- |
| `none` | No capability-level confirmation. Valid for `none` and `read` effects; compilation rejects it for writes. |
| `required` | The kernel creates a confirmation interaction before invoking the capability and resumes it after acceptance. |
| `capability` | The capability owns a resumable confirmation interaction. Its implementation must validate consent before calling `runEffect`; the kernel does not add the automatic pre-execution question. |

Planner policies may independently require confirmation. Choose `required` for
straightforward writes. Use `capability` when the domain must collect or present
information before asking for consent, returning `needs_confirmation` until that
consent is established. See [durability and effects](./durability.md#confirmation).

### Guidance

Guidance is semantic input for interpretation. It helps the model distinguish similar capabilities without hard-coded phrase matching.

The global selector sees only each capability ID, description and current
availability. Detailed guidance and the input schema are disclosed only for the
capabilities selected for the current turn. This keeps large agents extensible
without placing every domain contract in every model request.

Write guidance around meaning and context:

- describe positive use cases;
- identify nearby but different operations;
- include representative phrasing, not an exhaustive phrase list;
- avoid duplicating authorization rules that belong in policies or schemas.

## Result statuses

A capability returns an explicit result instead of throwing for expected domain outcomes.

| Status | Use |
| --- | --- |
| `completed` | The operation finished and may publish output, facts, evidence, and artifacts. |
| `needs_input` | Required user information is missing. |
| `needs_dependency` | A registered provider must produce a required fact before this operation can continue. |
| `needs_confirmation` | The proposed operation requires explicit acceptance. |
| `failed` | The domain operation could not complete safely. |

Unexpected implementation failures still use typed kernel errors and produce sanitized events.

A `needs_dependency` result supplies a versioned `requirement`, a registered
`provider` with its `capabilityId` and validated `input`, and optional private
`continuation` state. The provider must declare that it produces the requested
fact. The kernel plans the dependency and resumes the consumer when the fact is
available; input or confirmation required by the provider remains an explicit
interaction. See the [CapabilityResult contract](../reference/intention-kernel.capabilityresult.md).

## Capability, port, and provider tool

These concepts must remain separate:

| Concept | Example |
| --- | --- |
| Capability | `knowledge.search` |
| Domain meaning | Answer a verified factual question |
| Port | `knowledgeIndex.search(query, signal)` |
| Adapter | HTTP client, database client, or local implementation |
| Provider tool | Optional JSON function declaration sent to a model SDK |

Only the capability belongs to the agent definition. Ports are available inside `execute`. Provider tools remain internal to a model adapter and never become execution authority.

## Similar capabilities

The executable demos define `knowledge.search` and `service.search`. Both search, but their evidence domains and outcomes differ. The model sees their descriptions, schemas, availability, and guidance; the kernel validates whichever operation it proposes.

Do not resolve this distinction with keyword branches in the kernel. Improve the capability definitions and examples, then validate behavior through semantic assertions.

## Design rules

- Keep one domain outcome per capability.
- Return evidence for every business fact that may reach the response.
- Keep infrastructure SDK types behind ports.
- Use `needs_input`, `needs_dependency`, or `needs_confirmation` for expected pauses.
- Never perform a write outside `context.runEffect`.
- Emit sanitized progress for meaningful nested work through `context.events.emit`.
