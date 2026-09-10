---
description: Evaluate agents with declarative conversation scenarios, acceptance criteria, custom evaluators, and evidence-rich reports using intention-kernel/testing.
---

# Evaluation framework

Write a conversation as data: the inputs to send, the behavior to accept after each turn, and the conditions that must hold at the end. The evaluation runner executes that definition and produces structured results for every criterion, with the observations needed to investigate failures.

A scenario can require **many acceptance criteria**. For example, choosing a product can require valid options, the correct selection, a persisted fact, and a closed interaction. Use multiple assertions for simultaneous requirements, `any` for acceptable alternatives, and custom evaluators for relationships across turns.

Import the framework from `intention-kernel/testing`. It is independent of the model provider and can run through a compiled agent, an HTTP adapter, a CLI, or a host application.

## Start here

| Goal | Guide |
| --- | --- |
| Evaluate an agent from your installed package | [Evaluating from your project](./evaluation/quick-start.md) |
| Translate a use case into scenarios, steps, inputs, and variants | [Writing scenarios](./evaluation/scenarios.md) |
| Express several criteria, alternatives, and business rules | [Assertions and evaluators](./evaluation/assertions.md) |
| Connect your agent and control execution | [Running evaluations](./evaluation/running.md) |
| Read the evidence and let a coding agent iterate | [Reports and agent iteration](./evaluation/reports.md) |

## Use the installed library

Call the public API from your application's code:

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

The wrapper above belongs to your application. Pass its existing compiled agent and a declarative suite; it returns the report to the caller. No repository checkout, build, npm script, or specific test framework is required. The [first evaluation](./evaluation/quick-start.md) supplies a complete suite and shows how to use its results.

## The definition model

| Term | Meaning |
| --- | --- |
| Use case | A business objective you describe through one or more scenarios. There is no separate `useCase` object in the schema. |
| Suite | A versioned collection of scenarios, with optional checks across cases. |
| Scenario | An ordered conversation and its acceptance criteria. |
| Step | One input sent to the adapter and the checks on its resulting observation. |
| Variant | A complete alternative input for one step. |
| Case | One scenario, one combination of step variants, and one repetition. It receives its own conversation identity. |
| Observation | The JSON evidence returned by the adapter for a turn. |
| Assertion | A declared criterion evaluated against that evidence. |
| Custom evaluator | Host code registered under a name to check a domain relationship or semantic requirement. |
| Report | The definition snapshot, case inventory, submitted inputs, observations, assertion results, and execution status. |

## How validation works

For each selected case, the runner opens a session and sends the steps in order. It evaluates each step's assertions after receiving its observation. Ordinary assertion failures remain in the report and do not prevent later steps from running; transport or evaluator errors can interrupt the conversation.

After the defined steps have been recorded and the final observation is available, scenario assertions evaluate the final state. Custom scenario evaluators also receive the complete recorded turn history. Suite assertions run after scheduling ends and can inspect the whole selected case inventory.

At each scope, all assertions in the array are required. Inside an assertion, `all`, `any`, and `not` express the acceptance logic. The report preserves that expression and its child results, so a failed alternative inside a passing `any` is distinguishable from a failed required criterion.

::: warning Completion is not acceptance
`report.status === "completed"` means execution finished. Cases may still have failed, errored, been skipped, or been blocked. Suite assertions have separate results in `report.assertions`. [Read the report contract](./evaluation/reports.md#decide-whether-the-evaluation-passed) before turning it into an exit code or CI result.
:::

## What you supply

The framework supplies definition validation, case expansion, scheduling, assertion composition, and portable reports. Your application supplies:

- the agent or conversation transport;
- fixture setup and the state isolation needed by the business case;
- custom evaluators and their diagnostic evidence;
- model/provider configuration when evaluating a real agent;
- the application entry point that calls the API and any report storage or presentation it needs.

The JSON definition contains data. It does not execute JavaScript or automatically interpret business descriptions as assertions. A coding agent can edit the definition, invoke your application's evaluation entry point, inspect the returned report, change the implementation, and repeat the same scenarios.

For exact exported signatures, see the [testing API reference](../reference/testing/intention-kernel.md).
