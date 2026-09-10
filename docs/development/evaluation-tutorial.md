# Repository evaluation tutorial

This optional tutorial is for contributors working in a clone of the Intention Kernel repository. If you installed the package in an application, start with [Evaluating from your project](../guide/evaluation/quick-start.md); no repository scripts are required.

This tutorial runs a complete declarative suite, saves its report, and demonstrates a business failure that simpler structural checks would miss. It uses the public `intention-kernel/testing` API and requires no model credentials.

## Run the example

From the repository root, with Node.js 22 and npm 10:

```sh
npm ci
npm run demo:evaluation
```

If dependencies are already installed, run only the second command. The script builds the package, executes `examples/evaluation.ts`, and loads `examples/evaluation.suite.json`.

Expected result: `passed: true`, four passed cases, and a `reportFile` path under `examples/.runs/evaluation-<runId>/report.json`. Each invocation creates a new report directory by default.

The adapter is a small, scripted catalogue. It recognizes the exact messages in the JSON fixture and returns predictable observations. This verifies the example's evaluation logic; evaluating model understanding requires [connecting a real agent](../guide/evaluation/running.md#connect-a-compiled-agent).

## Read the scenario definitions

The suite expresses two business scenarios:

| Scenario | Inputs and cases | Acceptance criteria |
| --- | --- | --- |
| `choose-product` | Two ways to request products, followed by selecting the first option. Two cases, each with two turns. | The search completes, offers a choice with two options, persists a selection, closes the choice, and stores the exact product requested by the user. |
| `availability` | Search a catalogue with results or an empty catalogue. Two cases, each with one turn. | The search completes and either offers a choice with results, or reports no results with no choice. |

That is four cases and six turns. The final `correct-product` evaluator compares the requested option from the search turn with the stored selection after the second turn.

::: details Complete evaluation.suite.json
<<< ../../examples/evaluation.suite.json
:::

The file above is included directly from the executable fixture. Edit that file to change the tutorial's definitions.

`catalogue.count`, `response.reason`, and the fact type `product.selected` belong to this example's adapter and domain. They are not fields or business rules supplied automatically by the framework. [Observation paths](../guide/evaluation/running.md#observation-from-the-direct-adapter) depend on the adapter you use.

## Introduce a failure

```sh
npm run demo:evaluation -- --fail
```

The script now deliberately stores the second product when the user selects the first. Expected result: two failed cases, two passed cases, `passed: false`, and exit code **1**. The nonzero exit is intentional in this exercise.

The response still completes, a selection fact exists, and the choice closes. Those checks pass. The final business criterion catches the incorrect product. In the failed case's `assertions`, the relevant report excerpt is:

```json
{
  "id": "correct-product",
  "label": "The stored selection matches the requested option from the search turn",
  "passed": false,
  "expected": {
    "evaluator": "catalogue.selected-option",
    "parameters": { "searchStepId": "search", "selectionStepId": "select" }
  },
  "evidence": {
    "searchStepId": "search",
    "selectionStepId": "select",
    "expectedProductId": "desk-lamp",
    "actualProductId": "floor-lamp"
  }
}
```

This is why a scenario can need several acceptance criteria: the presence of a fact does not prove that its value matches the user's request.

## Select cases and repeat them

```sh
npm run demo:evaluation -- --scenario=choose-product
npm run demo:evaluation -- --scenario=choose-product --repetitions=3
```

The first command runs the two selection cases. The second runs six cases, each with a separate session. Repetitions of this scripted fixture remain deterministic; repetitions against a real model measure repeated attempts under the configured model and environment.

The tutorial script accepts these arguments:

| Argument | Effect |
| --- | --- |
| `--suite=path/to/suite.json` | Load another suite; paths are relative to the current working directory. It must use this adapter's inputs and registered evaluators. |
| `--scenario=choose-product` | Run one scenario ID, including its variants. |
| `--repetitions=3` | Repeat each expanded case three times. |
| `--output=examples/.runs/my-report.json` | Write the complete report to this path, replacing an existing file at that path. |
| `--fail` | Enable the intentional selection bug in this tutorial's adapter. |

These arguments belong to `examples/evaluation.ts`. The library exposes functions; it does not install a universal evaluation CLI.

## How the script executes the suite

The execution and report-writing section is shown below. Its `argument()` helper, `adapter`, `evaluators`, and `simulateFailure` flag are defined earlier in `examples/evaluation.ts`.

<<< ../../examples/evaluation.ts#run

The example's exit policy requires a completed run, every selected case to pass, and every suite assertion to pass. The runner itself returns a report; your host chooses how to surface that result in a command or CI job.

## Apply this to your agent

1. Describe the use case as one or more [scenarios](../guide/evaluation/scenarios.md), with all required turn and final criteria.
2. Connect your compiled agent with `createAgentEvaluationAdapter()`, or implement an [adapter](../guide/evaluation/running.md#connect-another-transport) for your application's conversation API.
3. Add [custom evaluators](../guide/evaluation/assertions.md#business-rules-across-turns) for relationships that cannot be checked against one observation.
4. Preserve the returned evidence and use the [report-driven iteration workflow](../guide/evaluation/reports.md#let-a-coding-agent-iterate).

The existing [Gemini examples](./examples.md) show model-backed conversations using the same runner, with per-case kernels, stores, and simulated write ports.
