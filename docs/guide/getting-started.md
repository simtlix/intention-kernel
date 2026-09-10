# Installation and first agent

Intention Kernel is licensed under Apache-2.0 and distributed through GitHub as installable release tarballs. It is not published to the npm registry.

## Requirements

- Node.js 22
- npm 10
- ESM
- TypeScript 5.9 or newer recommended

## Installation

Download the `.tgz` asset from the [GitHub release](https://github.com/simtlix/intention-kernel/releases/tag/v0.8.0), then install it in your application:

```sh
npm install ./intention-kernel-0.8.0.tgz
```

The public package exposes two supported entry points:

```ts
import { createKernel, defineAgent, defineCapability } from "intention-kernel";
import { createMemoryDurability } from "intention-kernel/testing";
```

`intention-kernel/testing` is a supported public module. It provides scenario evaluation, assertions, reports, event collection, and in-memory fixtures for applications and development tools. See [Testing your application](./testing.md) and the [testing API](../api.md#testing-subpath).

`createMemoryDurability()` stores state only in the current process. Use a transactional durability adapter when your agent needs persistence across restarts; the evaluation APIs can exercise agents using either adapter.

## 1. Define a capability

A capability describes one operation the runtime may authorize. It owns its schemas, fact contract, effect classification, model guidance, and implementation.

```ts
import {
  capabilityId,
  defineCapability,
  defineSchema,
  evidenceId,
  factType,
} from "intention-kernel";

type LookupInput = { query: string };
type LookupOutput = { answer: string };

const input = defineSchema<LookupInput>({
  vendor: "example",
  validate(value) {
    const query = Reflect.get(Object(value), "query");
    return typeof query === "string"
      ? { value: { query } }
      : { issues: [{ path: ["query"], message: "query is required" }] };
  },
  jsonSchema: () => ({
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  }),
});

const output = defineSchema<LookupOutput>({
  vendor: "example",
  validate(value) {
    const answer: unknown = Reflect.get(Object(value), "answer");
    return typeof answer === "string"
      ? { value: { answer } }
      : { issues: [{ path: ["answer"], message: "answer is required" }] };
  },
  jsonSchema: () => ({
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  }),
});

const knowledgeLookup = defineCapability({
  id: capabilityId("knowledge.lookup"),
  version: 1,
  description: "Answer a factual question from the host knowledge source",
  input,
  output,
  requires: [],
  provides: [{ type: factType("knowledge.answer"), version: 1 }],
  invalidates: [],
  effect: "read",
  guidance: {
    whenToUse: ["The user asks a factual question covered by the knowledge source"],
    whenNotToUse: ["The message is only social conversation"],
    examples: ["What is included in the service?"],
  },
  async execute(context, request) {
    const knowledge = context.ports["knowledge"] as {
      lookup(query: string, signal: AbortSignal): Promise<string>;
    };
    const answer = await knowledge.lookup(request.query, context.signal);
    const evidence = evidenceId("knowledge-result");

    return {
      status: "completed",
      output: { answer },
      evidence: [{ id: evidence, source: "external", content: answer }],
      facts: [{
        type: factType("knowledge.answer"),
        version: 1,
        value: { answer },
        evidenceIds: [evidence],
        dependsOn: [],
      }],
      artifacts: [],
    };
  },
});
```

## 2. Compile an agent

```ts
import { agentId, defineAgent } from "intention-kernel";

const definition = defineAgent({
  id: agentId("support.agent"),
  version: 1,
  identity: "A concise support advisor",
  capabilities: [knowledgeLookup],
  policies: [],
  modelPolicy: {
    "capability.select": "fast-routing-model",
    "turn.interpret": "fast-structured-model",
    "response.compose": "natural-response-model",
    "response.grounding-review": "grounding-review-model",
  },
});
```

`identity` defines the conversational role. `modelPolicy` selects a model per task without coupling the agent to a provider SDK.

## 3. Create the runtime

```ts
import { createKernel } from "intention-kernel";

const kernel = createKernel({
  modelGateway,
  durability,
  ports: { knowledge },
  limits: {
    turnTimeoutMs: 60_000,
    maxSteps: 64,
    recentMessageLimit: 20,
  },
});

const agent = await kernel.compile(definition);
```

The host owns `modelGateway`, `durability`, and every port. Compilation rejects invalid capability graphs before a conversation starts.

## 4. Run a turn

```ts
import { threadId, turnId } from "intention-kernel";

const result = await agent.run({
  threadId: threadId("customer-42"),
  turnId: turnId(crypto.randomUUID()),
  input: { text: "What is included in the service?" },
});

console.log(result.response.message);
```

A stable `threadId` identifies the conversation. Generate a `turnId` once for a
new user delivery and reuse it for every retry of that delivery. The example
creates a new delivery; generating another ID inside a retry would start a new
turn and bypass committed-turn replay.

## Next steps

- [Separate capabilities from ports and provider tools](./capabilities.md)
- [Implement a model gateway](./models.md)
- [Implement production durability](./durability.md)
- [Explore application examples](../examples/index.md)
- [Write declarative scenarios and validate your agent](./evaluation.md)
