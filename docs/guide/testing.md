# Testing your application

The installed `intention-kernel/testing` entry point provides evaluation APIs, an in-memory durability adapter, and an event collector. Import these helpers into your application's tests or execution code. There is no required package script or test framework.

## Declarative acceptance scenarios

Define the conversation and all criteria required to accept it, then call the evaluation API with your agent:

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

`definition` is your JSON-compatible suite. The helper returns an `EvaluationReport`; your caller chooses how to assert, display, or store it. Start with [Evaluating from your project](./evaluation/quick-start.md) for a complete example.

The framework supports sequential turns, input variants, repeated cases, multiple required assertions, `all`/`any`/`not`, and registered business evaluators that can inspect previous turns.

## Assert the report in your existing tests

Check individual case outcomes and suite-level assertions. A completed execution can still contain failed, errored, skipped, or blocked cases. [Reports and agent iteration](./evaluation/reports.md#decide-whether-the-evaluation-passed) includes a reusable acceptance predicate.

Your current test framework can assert that predicate. A service or IDE integration can return the report directly. A coding agent can use whichever entry point the application exposes, then inspect the same evidence to guide changes.

## Runtime test helpers

| Export | Use in your application |
| --- | --- |
| `createMemoryDurability()` | Create an isolated in-memory conversation store for a test or local fixture. |
| `createEventCollector()` | Capture kernel events for assertions and diagnostics; configure it as the kernel's `eventSink`. |
| `createAgentEvaluationAdapter()` | Execute scenarios against a compiled agent and optionally include its correlated events. |
| `evaluateAssertions()` | Evaluate declared criteria against an observation you already have. |
| `parseEvaluationSuite()`, `parseEvaluationReport()` | Validate imported definitions or saved execution evidence. |

In-memory durability does not establish the transaction guarantees of your production database adapter. Test that adapter's replay, concurrent turns, atomic commits, effect receipts, and cancellation behavior in its own environment.

## Diagnose observed behavior

For an acceptance failure, inspect the submitted input, model selection and interpretation, plan, capability result, committed facts and interaction, response, and effect evidence. The [evaluation guide](./evaluation.md) explains which data to capture and how to read it.

For development of Intention Kernel itself, see [Repository testing](../development/testing.md). Its build, lint, and demo commands apply to contributors working in the library's source checkout.
