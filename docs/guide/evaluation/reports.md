# Reports and agent iteration

An evaluation report connects a declared requirement to the conversation that exercised it and the evidence that accepted or rejected it. A coding agent can use that same contract: run scenarios, inspect failures, change the implementation, and rerun the affected cases.

The framework returns data to the application that calls it. A coding agent can use that application's existing evaluation entry point to perform the development loop.

## Find the relevant evidence

| Report location | What to inspect |
| --- | --- |
| `suite` | Complete definition snapshot: descriptions, metadata, inputs, and acceptance criteria |
| `target`, `fingerprint` | The evaluated target and compatibility identity |
| `status`, `summary` | Whether execution finished and the counts for every case outcome |
| `cases[n].scenarioId`, `variants`, `repetition` | The scenario and exact combination that ran |
| `cases[n].threadId` | Conversation identity for correlation with the host |
| `cases[n].turns[m].input` | Actual submitted input after variant expansion |
| `cases[n].turns[m].observation` | Complete host-approved evidence returned by the adapter |
| `cases[n].turns[m].assertions` | Step-level results, including composite children |
| `cases[n].assertions` | Final scenario results |
| `assertions` | Suite-level results across the selected inventory |
| `errorCode` at case, turn, or assertion scope | A stable execution or evaluator failure code |

Use stable IDs when locating a failure. Case ordering, a natural-language response, or an assertion label alone is less precise than `scenarioId`, variant IDs, `stepId`, and assertion `id` together.

## Decide whether the evaluation passed

Run status describes scheduling:

| Run status | Meaning |
| --- | --- |
| `running` | An incremental snapshot while execution is active. |
| `completed` | Scheduling finished; cases and suite assertions can still have failed. |
| `cancelled` | Cancellation interrupted execution. |
| `limited` | Cases remain pending after scheduling stopped, such as at the failure limit. |

Case status describes that case's outcome:

| Case status | Meaning |
| --- | --- |
| `passed` | All required executed assertions passed and the defined conversation completed. |
| `failed` | A required criterion evaluated normally and was false. |
| `error` | Execution, evaluation, or cleanup failed. Inspect the relevant `errorCode`. |
| `pending` | The selected case has not run. |
| `running` | The case is in progress in this snapshot. |
| `cancelled` | The case was interrupted by cancellation. |
| `skipped` | A reviewed or adapter-reported exclusion, with a reason. |
| `blocked` | A policy or incomplete/unsafe execution condition prevented completion. |

The summary counts cases, not assertions. A scenario with ten required criteria still contributes one case outcome for each variant and repetition. Suite assertions have their own results and do not change those counts.

When your application requires **every selected case** and every suite criterion to pass, this policy is sufficient:

```ts
import type { EvaluationReport } from "intention-kernel/testing";

export function allSelectedCasesPass(report: EvaluationReport): boolean {
  return report.status === "completed"
    && report.cases.every((entry) => entry.status === "passed")
    && (report.assertions ?? []).every((assertion) => assertion.passed);
}
```

This function belongs to your application. It is the policy used by the [first evaluation example](./quick-start.md). A host that allows reviewed skips should express that policy explicitly and still report them as exclusions, not passes. A `passed` case only establishes the criteria that were actually declared; a scenario without assertions does not establish business correctness.

## Read an assertion result

A built-in failed check includes whether the path existed, what it contained, and what was expected. For a missing interaction kind, a result can look like this:

```json
{
  "id": "choice-offered",
  "passed": false,
  "actual": { "present": false },
  "expected": "choice"
}
```

The definition in `report.suite` supplies the `kind`, `path`, and `operator`. The result retains the evidence needed to compare the expectation with the observation.

Custom results identify the evaluator and parameters and can include domain evidence. For example, an incorrect selection can record `expectedProductId: "desk-lamp"` and `actualProductId: "floor-lamp"`. That directs investigation toward selection binding even though the stored fact and final response exist.

### Respect the assertion expression

Read top-level required results first, then follow `children` to understand the expression. A passing `any` can contain failed alternatives. A passing `not` normally contains a failed child. Flattening every `passed: false` leaf into a defect would misreport valid scenarios.

A child with `errorCode` is different: composite assertions propagate evaluator errors. Fix or investigate that error before interpreting the criterion as a valid business judgment.

## Diagnose the first incorrect boundary

With the direct adapter and a configured event source, correlate the failed assertion with the turn's response, checkpoint, and events. Inspect the earliest observable divergence:

1. Was the submitted input the intended variant, including the correct structured selection?
2. Did the model receive the relevant conversation context and capability guidance?
3. Did capability selection and interpretation identify the requested work and references?
4. Did planning authorize the correct operations and dependencies?
5. Did capabilities receive the correct normalized inputs and return the expected evidence?
6. Did the committed facts, agenda, effects, and interaction represent the correct state?
7. Did the published response reflect that state and its grounding evidence?

Kernel events can expose model request audit data, returned proposals, selected capabilities, execution progress, effects, and commits. See [Events and traces](../events.md). Availability depends on the event source and host redaction; the evaluation runner does not reconstruct missing backend or provider data.

The model request audit records an `instructionDigest` and `audit.prompt` with
identified prompt metadata and the effective instruction text, subject to host
redaction. Reports contain this data only when the adapter includes those events.
The audit is not a complete provider transcript: hosts own any additional
authorized input, schema, or provider capture. Distinguish recorded evidence from
a proposed cause when diagnosing a failure.

### Missing observations and errors

If `send()` throws before it returns a valid observation, the turn can contain only the submitted input, duration, and stable error code. The direct adapter collects its observation after `agent.run()` returns successfully, so a thrown runtime error may leave no turn observation in the report.

An `EvaluationError` thrown by an adapter preserves its code. Other thrown errors become a generic transport or session code; raw exception messages are not included. Keep detailed, sanitized infrastructure diagnostics in the host's logs and correlate them by thread and turn. A custom adapter can expose additional safe diagnostic fields when it can still return a valid observation.

| Code | First check |
| --- | --- |
| `EVALUATION_SUITE_INVALID` | Definition shape and `EvaluationError.paths`. |
| `EVALUATOR_NOT_FOUND` | Registry key and the assertion's `evaluator` name. |
| `EVALUATOR_FAILED` | The custom evaluator, its parameters, and required evidence. |
| `EVALUATOR_RESULT_INVALID` | Whether the custom evaluator returned a boolean `passed`. |
| `EVALUATION_AGENT_INPUT_INVALID` | Direct-adapter input fields and exactly one selection form. |
| `EVALUATION_SELECTION_UNAVAILABLE` | Whether the preceding turn left a usable interaction. |
| `EVALUATION_SELECTION_AMBIGUOUS` | Whether the selector matched exactly one published option, including valid index bounds. |
| `EVALUATION_TRANSPORT_FAILED` / `EVALUATION_SESSION_FAILED` | Correlated host logs and session setup or transport behavior. |
| `EVALUATION_TIMEOUT` / `EVALUATION_CANCELLED` | The deadline or abort source and any upstream work still in flight. |
| `EVALUATION_CLEANUP_FAILED` | Session cleanup; a previously successful conversation can still have a cleanup error. |
| `EVALUATION_OBSERVER_FAILED` | Report persistence or event delivery and the last saved snapshot. |
| `EXTERNAL_WRITES_NOT_AUTHORIZED` | Scenario write policy and explicit run authorization. |
| `EVALUATION_EARLY_COMPLETION` | Why the transport ended before all defined steps ran. |

Invalid definitions or options can reject `runEvaluation()` before a report is created. A failed expectation normally returns a report with failed results. Handle promise rejection separately from rejected acceptance criteria.

## Let a coding agent iterate

Codex, Claude Code, or another coding agent needs the suite definition, your application's evaluation entry point, access to the returned report, and the implementation it may change. That entry point can be a test, a function exposed through a development tool, or an existing application command. The library requires no particular invocation mechanism.

1. **Run the declared scenarios.** Retain the returned report and identify the failing case, turn, and required criterion.
2. **Inspect the evidence.** Read submitted inputs, current and previous observations, and the assertion expression. Distinguish business failure, evaluator failure, and incomplete execution.
3. **Change the responsible behavior.** Update the capability contract, model guidance, state handling, adapter, or evaluator according to the observed cause. Keep valid acceptance criteria intact.
4. **Rerun the affected scenario.** Use its variants and relevant repetitions to check the change.
5. **Run the broader affected suite.** Confirm that other required paths still pass and report any errors, exclusions, or unfinished cases.

Use the public API to select the scenarios affected by a change. This helper belongs to the consuming application:

```ts
import { runEvaluation, type EvaluationOptions } from "intention-kernel/testing";

export function evaluateAffectedScenarios(
  options: EvaluationOptions,
  scenarioIds: readonly string[],
) {
  return runEvaluation({ ...options, scenarioIds });
}
```

The supplied options contain your suite, adapter, target, and any registered evaluators. Optionally combine `tags` and use `repetitions` when repeated model execution is relevant. After changing the implementation, start a fresh evaluation without `resume`; retain the previous report for comparison.

A task instruction for a coding agent can be as concrete as:

```text
Read the product-selection suite and its acceptance criteria.
Execute the application's evaluation entry point and inspect its returned report.
For each failing required criterion, identify the case, step, expected result,
actual evidence, and first incorrect implementation boundary.
Correct the behavior, rerun the affected scenarios, then run the affected suite.
Preserve valid acceptance criteria and report failed, errored, blocked, skipped,
or incomplete cases explicitly. Do not treat execution completion as acceptance.
```

Add the location of your suite and evaluation integration to that instruction. The framework supplies the declarative execution and evidence contract; the coding agent uses it through your application while performing the code changes.
