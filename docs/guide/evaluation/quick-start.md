# Evaluating from your project

Use `runEvaluation()` from the installed `intention-kernel/testing` package in your application. It accepts a suite and an adapter, executes the scenarios, and returns their results and evidence.

**Evaluation requires no Intention Kernel repository checkout, package build, npm script, or particular test runner.** Your application can call the API from a test, a service, an IDE integration, or any other execution entry point it already uses.

## 1. Define and run a suite

The complete module below can be copied into your project as `evaluation.ts`. It imports only the installed package's public entry points.

This example assumes your application already has a compiled catalogue agent whose search records a `product.candidates` fact and returns grounded results without a pending choice. Those are example business requirements, not automatic behavior of every agent. Replace the messages and criteria with your own use case.

<<< ../../../examples/evaluateConsumer.ts

`catalogueSuite` is a declarative definition. Each search must satisfy **all four criteria**: completed response, grounding, a persisted candidates fact, and no pending choice. Its two input variants produce two separate cases.

These criteria describe a baseline search contract. Add the product identities, values, counts, and other requirements needed to establish your application's business outcome. [Scenario syntax](./scenarios.md) covers conversations with several turns; [custom evaluators](./assertions.md#business-rules-across-turns) handle relationships between them.

## 2. Call it with your existing agent

In the application code that already creates or receives your `CompiledAgent`, import the local module and call its function:

```ts
import { evaluateCatalogue, evaluationsPassed } from "./evaluation.js";

// agent is the CompiledAgent supplied by your application.
const report = await evaluateCatalogue(agent);
const passed = evaluationsPassed(report);
```

`./evaluation.js` is the local module from the previous step, using the normal ESM import path for compiled TypeScript. It is not an additional package export. The installed library provides `runEvaluation()` and `createAgentEvaluationAdapter()`; this small wrapper belongs to your project.

The direct adapter sends each declared input to `agent.run()`. Your configured model gateway, ports, capabilities, and durability execute the conversation. The returned report is available immediately to the caller; the library does not require a report file or start another process.

## 3. Use the result

For this suite, acceptance means both variant cases pass all four criteria. If a criterion fails, inspect the case's `turns[n].assertions` and `turns[n].observation`. For example, an omitted candidates fact fails `candidates-recorded`, with the actual facts retained for diagnosis.

`report.status === "completed"` describes execution, not acceptance. The example's `evaluationsPassed()` function requires every selected case and every suite assertion to pass. Your application decides whether to return that boolean, assert it in an existing test, display the report, or persist it.

For example, an existing test can use its own assertion API:

```ts
import assert from "node:assert/strict";
import { evaluateCatalogue, evaluationsPassed } from "./evaluation.js";

// Inside your test, with its configured agent:
const report = await evaluateCatalogue(agent);
assert.equal(evaluationsPassed(report), true, JSON.stringify(report, null, 2));
```

The assertion above uses Node's built-in assertion module. Vitest, Jest, or another test framework can assert the same result; none is required by Intention Kernel.

## 4. Select and repeat cases

Selection and repetition are function options:

```ts
const report = await evaluateCatalogue(agent, {
  scenarioIds: ["find-products"],
  repetitions: 3,
});
```

The two variants now produce six cases. Each has its own conversation identity. See [Running evaluations](./running.md) for concurrency, event collection, custom transports, and fixture isolation.

## Keep definitions wherever your application needs them

The example declares the suite as a TypeScript object so it can be imported directly. You can also store the same definition as JSON and pass the loaded value to `parseEvaluationSuite()`. The application owns loading; no special directory, filename, or project script is required.

A coding agent uses this same integration: execute the application's evaluation entry point, inspect the returned report, correct the behavior, and rerun the affected scenarios. [Reports and agent iteration](./reports.md) explains how to work from that evidence.
