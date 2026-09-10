# Model gateways

Intention Kernel does not depend on a model provider SDK. The host implements `ModelGateway` and receives a structured `ModelRequest` for each model task.

## Contract

```ts
interface ModelGateway {
  invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>>;
}
```

Each request contains:

- `task`: the runtime task being performed;
- `model`: the model selected by agent policy;
- `system`: kernel and agent instructions;
- `prompt`: the identified instruction contract and interpolation values, supplied by kernel requests;
- `input`: the bounded task context;
- `outputSchema`: the required structured output contract;
- `capabilities`: availability and semantic descriptions when relevant;
- `signal`: cancellation and timeout propagation.

The gateway returns the validated value together with provider, model, duration, and optional usage metadata.

## Task-based model selection

An agent selects models by responsibility:

```ts
modelPolicy: {
  "capability.select": "fast-routing-model",
  "turn.interpret": "fast-structured-model",
  "response.compose": "natural-response-model",
  "response.grounding-review": "grounding-review-model",
}
```

The values are opaque to the kernel. A gateway may map them to Gemini, OpenAI, Anthropic, a local model, or a routing service. Switching providers does not change capabilities, facts, policies, or checkpoint state.

## Structured output

The runtime expects structured values for interpretation, response composition, and grounding review. The gateway must enforce the supplied schema using the strongest mechanism supported by its provider.

If a provider cannot satisfy the schema, the adapter fails with a sanitized `ModelGatewayError`. It must not repair invalid output by inventing missing business values.

## Interpretation authority

Before `turn.interpret`, `capability.select` receives the canonical conversation
projection plus compact summaries for every registered capability. It selects
the smallest plausible set for all objectives in the message. The runtime then
expands only those selected contracts with their input schemas and semantic
guidance for `turn.interpret`.

The selector never receives capability schemas, extracts no parameters and
executes nothing. Unknown capability IDs and an interpretation that references
an unselected contract are rejected with one bounded structural repair.

During `turn.interpret`, the model may:

- propose zero, one, or multiple intentions;
- cite message-level evidence;
- resolve references against projected context;
- answer an existing interaction;
- report contradictions or ambiguity;
- propose alternative capabilities.

It may not invoke a capability, mutate a checkpoint, authorize a policy, or write to an external system.

## Context discipline

The model receives a canonical projection rather than arbitrary runtime objects. The projection includes the current message, bounded recent history, confirmed visible facts, pending agenda, active interaction, and explicit redactions. Capability data is supplied once through `ModelRequest.capabilities`: summaries for selection and expanded contracts for interpretation.

This keeps context consistent across model calls and omits kernel-private state.
The host must declare fact visibility and redactions for sensitive domain data;
the kernel cannot infer which application values are confidential.

## Adapter requirements

A production gateway should:

- preserve the requested task and model identity in telemetry;
- enforce structured output against `outputSchema`;
- propagate `AbortSignal` cancellation;
- report usage without exposing provider secrets;
- sanitize provider errors before they reach events or callers;
- avoid automatic retries that can outlive the kernel turn deadline.

See the [adapter contract](../adapters.md) and the executable `GeminiModelGateway` in `examples/geminiModelGateway.ts`.

## Versioned model prompts

`getKernelPromptDefinitions()` exposes the kernel's immutable instruction catalog. Each definition has a stable `id`, a `contractVersion`, a default `template`, and an allowlist of interpolation variables. These IDs identify instruction variants independently of model task names.

Hosts can load a reviewed snapshot before constructing the kernel and supply a synchronous `ModelPromptResolver`:

```ts
import {
  createKernel,
  getKernelPromptDefinitions,
  type ModelPromptResolver,
} from "intention-kernel";

const pinned = new Map(getKernelPromptDefinitions().map(definition => [
  definition.id,
  { template: definition.template, revision: `reviewed-v${definition.contractVersion}` },
]));

const promptResolver: ModelPromptResolver = {
  resolve(reference) {
    const prompt = pinned.get(reference.definition.id);
    if (!prompt) throw new Error("The pinned prompt snapshot is incomplete");
    return prompt;
  },
};

const kernel = createKernel({ modelGateway, durability, promptResolver });
```

This example pins the bundled defaults. A host can replace their templates with reviewed content from its own configuration store. Load that data before execution; the resolver does not perform asynchronous I/O.

The kernel renders the selected template into `ModelRequest.system`. The gateway should send that field to its provider and retain `ModelRequest.prompt` as contract metadata. Use `renderModelPrompt` when validating a template outside execution: values are inserted once, undeclared variables are rejected, and templates, values, and rendered output are bounded to 1 MiB of UTF-8.

An invalid or missing pinned revision aborts the invocation instead of silently falling back to different instructions. Without a resolver, the kernel uses the bundled defaults.
