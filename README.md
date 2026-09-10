![Intention Kernel introduction](https://simtlix.github.io/intention-kernel/readme/intro.gif)

# Intention Kernel

[Documentation](https://simtlix.github.io/intention-kernel/) · [Releases](https://github.com/simtlix/intention-kernel/releases) · [Issues](https://github.com/simtlix/intention-kernel/issues)

![A catalog request moves through interpretation, authorization, execution, and grounding before its response and state are committed. Models propose; the kernel decides.](https://simtlix.github.io/intention-kernel/readme/intention-kernel-flow.gif)

[View the static overview](https://simtlix.github.io/intention-kernel/readme/intention-kernel-overview.png)

Intention Kernel is a TypeScript runtime for durable, observable, model-driven agents without turning business behavior into a tree of hard-coded routes.

The model interprets what the user wants. The kernel validates that proposal against registered capabilities and policies, plans multiple operations by dependency, executes authorized code, reduces evidence-bearing facts, and composes one grounded response. LangGraph is the private execution engine; consumers depend only on Intention Kernel contracts.

Intention Kernel is licensed under Apache-2.0. Releases are distributed through GitHub as installable tarballs. The package is not published to the npm registry.

## Installation

Download the `.tgz` asset from the [GitHub release](https://github.com/simtlix/intention-kernel/releases/tag/v0.8.0), then install it in your application:

```sh
npm install ./intention-kernel-0.8.0.tgz
```

## Public entry points

The installed package provides two public modules:

| Import | Public API |
| --- | --- |
| `intention-kernel` | Agent and capability definitions, runtime execution, model gateways, versioned prompts, persistence contracts, and events. |
| `intention-kernel/testing` | Scenario evaluation, assertions, agent adapters, portable reports, event collection, and in-memory test fixtures. |

For example:

```ts
import { createKernel, defineAgent, defineCapability } from "intention-kernel";
import {
  createMemoryDurability,
  createEventCollector,
  createAgentEvaluationAdapter,
  runEvaluation,
  parseEvaluationSuite,
  parseEvaluationReport,
  evaluateAssertions,
  EvaluationError,
  TESTING_VERSION,
} from "intention-kernel/testing";
```

Testing and evaluation are part of the supported public API. Use them from your application, test runner, evaluation service, or development tools. The package includes their runtime implementation and TypeScript declarations.

`createMemoryDurability()` stores state in the current process. Use a transactional durability adapter when the application needs persistence across restarts. Evaluation can exercise an agent configured with that production adapter.

## Mental model

![Execution architecture: the model interprets intentions; the kernel authorizes a plan; host capabilities execute it; the kernel reduces facts and grounds a response; the durability adapter commits the result, checkpoint, and event outbox atomically.](https://simtlix.github.io/intention-kernel/readme/intention-kernel-architecture.png)

- An **intention** is a contextual user objective.
- A **capability** is one executable operation with schemas, fact dependencies and effect semantics.
- A **fact** is confirmed, versioned knowledge with evidence and lineage.
- A **policy** is a pure host-owned constraint applied after interpretation and before execution.
- A **port** is an infrastructure contract injected into capabilities.
- A provider **tool** is only an adapter-level representation; it is not a kernel primitive or execution authority.

## Nested workflows and capability events

Capabilities may delegate implementation work to a nested graph, state machine,
workflow engine or remote orchestrator through an injected port. The kernel does
not expose any of those engine types. Instead, the capability publishes
observable progress through `context.events.emit()`:

```ts
async execute(context, input) {
  const graph = context.ports["planningGraph"] as {
    run(input: unknown, emit: typeof context.events.emit): Promise<unknown>;
  };
  const output = await graph.run(input, (name, data) => context.events.emit(name, data));
  // Validate and return output, facts and evidence here.
}
```

Each publication becomes a sanitized `capability.event` in the same step and
causal branch. This keeps nested execution visible without coupling consumers to
LangGraph. See the executable [`examples`](https://simtlix.github.io/intention-kernel/development/examples.html) for a real
three-node subgraph.

## Define a read capability

```ts
import {
  capabilityId,
  defineCapability,
  defineSchema,
  evidenceId,
  factType,
} from "intention-kernel";

type SearchInput = { query: string };
type SearchOutput = { products: readonly { id: string; name: string; price: number }[] };

const searchInput = defineSchema<SearchInput>({
  vendor: "app",
  validate: (value) => {
    if (typeof value !== "object" || value === null || typeof Reflect.get(value, "query") !== "string") {
      return { issues: [{ message: "query is required", path: ["query"] }] };
    }
    return { value: { query: String(Reflect.get(value, "query")) } };
  },
  jsonSchema: () => ({
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  }),
});

const searchOutput = defineSchema<SearchOutput>({
  vendor: "app",
  validate(value) {
    const products: unknown = Reflect.get(Object(value), "products");
    if (!Array.isArray(products)) {
      return { issues: [{ message: "products must be an array", path: ["products"] }] };
    }
    const parsed: SearchOutput["products"][number][] = [];
    for (const item of products as unknown[]) {
      const id: unknown = Reflect.get(Object(item), "id");
      const name: unknown = Reflect.get(Object(item), "name");
      const price: unknown = Reflect.get(Object(item), "price");
      if (typeof id !== "string" || typeof name !== "string" || typeof price !== "number" || !Number.isFinite(price)) {
        return { issues: [{ message: "Each product needs an id, name, and finite price", path: ["products"] }] };
      }
      parsed.push({ id, name, price });
    }
    return { value: { products: parsed } };
  },
  jsonSchema: () => ({
    type: "object",
    properties: {
      products: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" }, price: { type: "number" } },
          required: ["id", "name", "price"],
          additionalProperties: false,
        },
      },
    },
    required: ["products"],
    additionalProperties: false,
  }),
});

export const searchProducts = defineCapability({
  id: capabilityId("product.search"),
  version: 1,
  description: "Search products that match the user's current needs",
  input: searchInput,
  output: searchOutput,
  requires: [],
  provides: [{ type: factType("product.candidates"), version: 1 }],
  effect: "read",
  guidance: {
    whenToUse: ["The user asks to find, browse or recommend products"],
    whenNotToUse: ["The user is selecting from candidates already present in facts"],
    examples: ["Show me an efficient family option"],
  },
  async execute(context, input) {
    const catalog = context.ports["catalog"] as {
      search(query: string, signal: AbortSignal): Promise<SearchOutput>;
    };
    const output = await catalog.search(input.query, context.signal);
    const evidence = evidenceId("catalog-search-result");
    return {
      status: "completed",
      output,
      facts: [{
        type: factType("product.candidates"),
        version: 1,
        value: output.products,
        evidenceIds: [evidence],
        dependsOn: [],
      }],
      evidence: [{
        id: evidence,
        source: "external",
        content: `The catalog returned ${output.products.length} matching products.`,
        data: output.products,
      }],
      artifacts: [{ id: "product-results", kind: "product-list", data: output.products }],
    };
  },
});
```

Every business fact that may appear in the response needs evidence. The response model emits ordered text parts with evidence IDs; the kernel derives exact claim spans from those parts before semantic review. Capabilities may return `needs_input`, `needs_dependency`, `needs_confirmation` or a safe `failed` issue instead of throwing for expected domain outcomes.

## Compile and run an agent

```ts
import {
  agentId,
  createKernel,
  defineAgent,
  threadId,
  turnId,
  type Durability,
  type ModelGateway,
} from "intention-kernel";
import { searchProducts } from "./search-products.js";

declare const modelGateway: ModelGateway; // Gemini, OpenAI, Anthropic or local adapter
declare const durability: Durability;     // PostgreSQL or another transactional adapter
declare const catalog: unknown;

const kernel = createKernel({
  modelGateway,
  durability,
  ports: { catalog },
  limits: { turnTimeoutMs: 60_000, maxSteps: 64, recentMessageLimit: 20 },
});

const agent = await kernel.compile(defineAgent({
  id: agentId("commerce.advisor"),
  version: 1,
  identity: "A helpful, concise product advisor",
  capabilities: [searchProducts],
  policies: [],
  modelPolicy: {
    "capability.select": "fast-routing-model",
    "turn.interpret": "fast-structured-model",
    "response.compose": "natural-response-model",
    "response.grounding-review": "grounding-review-model",
  },
}));

const result = await agent.run({
  threadId: threadId("customer-42"),
  turnId: turnId(crypto.randomUUID()),
  input: { text: "Find an efficient option for my family and tell me the price" },
});

console.log(result.response.message);
```

The same gateway instance may dispatch each model-policy value to a different provider. Capabilities and conversation state do not change when the model changes.

The selector receives only compact capability summaries. The interpreter then
receives schemas and semantic guidance for the selected capabilities, never the
entire registry. This progressive disclosure keeps the prompt bounded while the
kernel still validates every proposed identifier, input, dependency and policy.

## Writes

A write capability declares `effect: "write"` and an explicit confirmation mode. With `confirmation: "required"`, the planner asks the user before execution. With `confirmation: "capability"`, the capability owns the confirmation interaction and must validate consent before performing its mutation. Writes cannot use `confirmation: "none"`.

Perform mutations through `context.runEffect(operationKey, operation)`, which returns `{ value, receipt }`. Preserve the key for the same logical operation across retries and turns; use a distinct key for a new operation. Completed receipts replay within the thread, and uncertain effects cannot be retried blindly. See [capability confirmation](https://simtlix.github.io/intention-kernel/guide/capabilities.html#confirmation) and [durable effects](https://simtlix.github.io/intention-kernel/guide/durability.html#durable-external-effects) for the complete contract.

## Multiple objectives

One user turn may contain multiple intentions. Independent reads execute concurrently. A dependent operation waits for the fact it requires and can consume a fact produced earlier in the same turn. Conflicting unrelated writes become an explicit user choice rather than an arbitrary model decision.

## Declarative evaluations

Describe use cases as conversation scenarios with ordered inputs and multiple acceptance criteria. Call the installed package from your application:

![The public intention-kernel/testing API runs scenarios and evaluates acceptance criteria. An illustrative report shows one passing case and one failure with evidence for the missing product.candidates fact.](https://simtlix.github.io/intention-kernel/readme/intention-kernel-evaluation.png)

```ts
import type { CompiledAgent } from "intention-kernel";
import {
  createAgentEvaluationAdapter,
  parseEvaluationSuite,
  runEvaluation,
  type EvaluationEvaluators,
} from "intention-kernel/testing";

export function evaluateScenarios(
  agent: CompiledAgent,
  definition: unknown,
  evaluators: EvaluationEvaluators = {},
) {
  return runEvaluation({
    suite: parseEvaluationSuite(definition),
    target: { id: agent.id, fingerprint: agent.fingerprint },
    adapter: createAgentEvaluationAdapter({ agent }),
    evaluators,
  });
}
```

The function above is application code. Pass your compiled agent, the suite definition, and any custom evaluators; the returned report contains case outcomes and diagnostic evidence. The evaluation API requires no library repository checkout, build, package script, or specific test runner.

See [Evaluating from your project](https://simtlix.github.io/intention-kernel/guide/evaluation/quick-start.html) for a complete suite, or the [detailed evaluation guide](https://simtlix.github.io/intention-kernel/guide/evaluation.html) for multiple turns, variants, assertion composition, business evaluators, and coding-agent iteration.

## Documentation

- [Documentation site](https://simtlix.github.io/intention-kernel/)
- [Installation and first agent](https://simtlix.github.io/intention-kernel/guide/getting-started.html)
- [Evaluation framework](https://simtlix.github.io/intention-kernel/guide/evaluation.html)
- [Scenario syntax and use cases](https://simtlix.github.io/intention-kernel/guide/evaluation/scenarios.html)
- [Assertions and custom evaluators](https://simtlix.github.io/intention-kernel/guide/evaluation/assertions.html)
- [Reports and coding-agent iteration](https://simtlix.github.io/intention-kernel/guide/evaluation/reports.html)
- [Execution architecture](https://simtlix.github.io/intention-kernel/architecture/)
- [Application examples](https://simtlix.github.io/intention-kernel/examples/)
- [Public API](https://simtlix.github.io/intention-kernel/api.html)
- [Generated API reference](https://simtlix.github.io/intention-kernel/reference/)
- [Adapter guide](https://simtlix.github.io/intention-kernel/adapters.html)
- [Versioned model prompts](https://simtlix.github.io/intention-kernel/guide/models.html#versioned-model-prompts)
- [Runtime invariants](https://simtlix.github.io/intention-kernel/invariants.html)
- [Competitive analysis](https://simtlix.github.io/intention-kernel/competitive-analysis.html)
- [Release posture](https://simtlix.github.io/intention-kernel/releases.html)

The reference under `docs/reference/` is generated from the public TSDoc and emitted declarations.

## Developing Intention Kernel

The [repository testing guide](https://simtlix.github.io/intention-kernel/development/testing.html) documents the library's build, lint, type, behavior, documentation, and package checks. The [repository examples](https://simtlix.github.io/intention-kernel/development/examples.html) include scripted and model-backed demos. Their development commands apply to a clone of this library's source repository.

Applications that installed the package use the public APIs described above and their own execution or test setup.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull request guidance.

## Security and support

See [SECURITY.md](SECURITY.md). The current `0.x` line may change its public contract between minor versions. Once `1.0.0` is released, breaking changes require a new major version.

## Creators

Intention Kernel was created by:

- **Claudio Gonzales** — [GitHub](https://github.com/claudiojgonzalez)
- **Juan Pablo Paillet** — [Website](https://pailletjp.com) · [GitHub](https://github.com/PailletJuanPablo)

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
