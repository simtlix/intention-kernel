# Assertions and evaluators

An assertion states one acceptance condition or composes several conditions. Every assertion in a step, scenario, or suite's top-level `assertions` array is required. A business scenario can contain as many criteria as it needs within the schema limits.

## Check one value

```json
{
  "id": "response-completed",
  "label": "The turn completes successfully",
  "kind": "check",
  "path": ["response", "status"],
  "operator": "equals",
  "value": "completed"
}
```

This is an assertion fragment to place in an `assertions` array. `path` starts at the current observation, not at the report, scenario definition, or `history`. A result retains its `id`, optional `label`, actual value and presence, expected value when applicable, and pass/fail outcome.

## Operators

| Operator | Passes when | Example |
| --- | --- | --- |
| `equals` | The actual value is structurally equal to `value`, including object fields and array order. | Status equals `"completed"`. |
| `matches` | An object contains the expected fields recursively. Arrays must have the same length and order, with each item recursively matching. | A response matches `{ "status": "completed" }` while allowing other fields. |
| `contains` | At least one array element matches `value`, or an actual string includes the expected literal string. | Facts contain `{ "type": "product.selected" }`. |
| `exists` | The path is present as an own property. | A field exists, even if its value is `null`. |
| `absent` | The path is missing. | No `response.interaction` field was published. |
| `gte` | The actual number is greater than or equal to `value`. | An observed result count is at least `1`. |
| `lte` | The actual number is less than or equal to `value`. | An observed effect count is at most `1`. |
| `length` | The actual string or array has exactly the expected length. | There are exactly `2` options. |

`value` is required except for `exists` and `absent`; omit it for those two operators. `gte` and `lte` require a number. `length` requires a nonnegative safe integer and uses JavaScript string length for strings, not a grapheme count.

Comparisons do not coerce types: `"2"` does not satisfy a numeric bound. String containment is case-sensitive and literal; it does not interpret regular expressions or natural-language meaning.

### Object subsets and array membership

Given an observation containing these facts:

```json
{
  "checkpoint": {
    "facts": [
      { "type": "catalogue.loaded", "value": { "count": 2 } },
      { "type": "product.selected", "value": { "id": "desk-lamp", "name": "Desk lamp" } }
    ]
  }
}
```

This criterion checks the selected product while allowing other facts and extra fields:

```json
{
  "id": "expected-product",
  "kind": "check",
  "path": ["checkpoint", "facts"],
  "operator": "contains",
  "value": { "type": "product.selected", "value": { "id": "desk-lamp" } }
}
```

Using `matches` with a one-element expected array would fail against the two-element facts array. Use `contains` to find an item and `matches` to compare a known object's subset.

### Paths, missing fields, and null

Paths are arrays of own-property segments:

```json
["response", "interaction", "options", 0, "label"]
```

String segments are literal: `["facts.byType", "product.selected"]` accesses two properties whose names contain dots. It does not split them into nested paths. Numeric segments address array indexes. A path may contain at most 40 segments; `__proto__`, `prototype`, and `constructor` are rejected.

Given `{ "interaction": null }`, `exists` on `["interaction"]` passes and `absent` fails. If the field is omitted, `exists` fails and `absent` passes. To require explicit null, use `equals` with `value: null`.

Choose the path according to the adapter's actual observation. The compiled-agent adapter exposes the committed response and checkpoint, while a custom HTTP adapter may use a different shape.

## Require multiple conditions

Separate assertions in the same array are implicitly ANDed. Use `all` when you want to give a group of conditions its own identity and label:

```json
{
  "id": "selection-complete",
  "label": "A product is stored and the choice is closed",
  "kind": "all",
  "assertions": [
    { "id": "fact-stored", "kind": "check", "path": ["checkpoint", "facts"], "operator": "contains", "value": { "type": "product.selected" } },
    { "id": "choice-closed", "kind": "check", "path": ["response", "interaction"], "operator": "absent" }
  ]
}
```

Both conditions must pass. Other required conditions can sit alongside this group in the same scenario.

## Accept alternative outcomes

Use `any` to require at least one acceptable branch. Each branch can itself require several conditions:

```json
{
  "id": "accepted-catalogue-outcome",
  "kind": "any",
  "assertions": [
    {
      "id": "products-offered",
      "kind": "all",
      "assertions": [
        { "id": "has-results", "kind": "check", "path": ["catalogue", "count"], "operator": "gte", "value": 1 },
        { "id": "choice-shown", "kind": "check", "path": ["response", "interaction", "kind"], "operator": "equals", "value": "choice" }
      ]
    },
    {
      "id": "empty-catalogue-explained",
      "kind": "all",
      "assertions": [
        { "id": "no-results", "kind": "check", "path": ["catalogue", "count"], "operator": "equals", "value": 0 },
        { "id": "no-choice", "kind": "check", "path": ["response", "interaction"], "operator": "absent" },
        { "id": "reason-given", "kind": "check", "path": ["response", "reason"], "operator": "equals", "value": "no_results" }
      ]
    }
  ]
}
```

Here `catalogue.count` and `response.reason` are example fields supplied by an application adapter; adapt those paths to your observation. Both branches validate the business conditions that justify the response. An unrestricted “choice or no choice” assertion would establish very little.

## Negate a criterion

`not` takes one `assertion`, singular:

```json
{
  "id": "no-external-submission",
  "kind": "not",
  "assertion": {
    "id": "submission-present",
    "kind": "check",
    "path": ["checkpoint", "facts"],
    "operator": "contains",
    "value": { "type": "request.submitted" }
  }
}
```

This passes when the child criterion fails normally. It does not prove that no external write occurred unless the observed facts are sufficient evidence for that application. Use effect receipts or an observed external-write count when that is the required guarantee.

### Composition preserves evidence and errors

The evaluator visits every child of `all` and `any`, without short-circuiting, and retains their results in `children`. A failed child inside a passing `any`, or the failed child of a passing `not`, is expected by that expression's logic.

An evaluator error is different from a normal failed criterion. An error in **any child** makes `all` or `any` fail with that error, even if another alternative passed. `not` never turns an evaluator error into success.

## Business rules across turns

Built-in checks compare a path in one observation with a declared JSON value. Use a custom evaluator when the expected value depends on earlier turns, several facts, external evidence, or domain logic.

Declare the evaluator by name in a scenario's final `assertions`:

```json
{
  "id": "correct-product",
  "label": "The stored selection matches the requested option from the search turn",
  "kind": "custom",
  "evaluator": "catalogue.selected-option",
  "parameters": { "searchStepId": "search", "selectionStepId": "select" }
}
```

Add this evaluator registry to your application. The type imports and implementation below include all the JSON helpers it needs:

```ts
import type {
  EvaluationData,
  EvaluationEvaluators,
  EvaluationValue,
} from "intention-kernel/testing";
```

<<< ../../../examples/evaluation.ts#evaluator

Pass the resulting `evaluators` object through the `evaluators` option of `runEvaluation()`, as shown in [Running evaluations](./running.md#connect-a-compiled-agent). No script registration or package configuration is required.

The evaluator looks up turns by stable `stepId`, reads the requested option index from the actual submitted input, finds the corresponding offered product, and compares it with the stored selection. Its evidence retains both IDs. This makes the failure useful to a developer or coding agent instead of returning only `false`.

### Evaluator contract

`EvaluationEvaluator` receives `(context, parameters)` and may return a value or a promise:

```ts
type EvaluatorResult = {
  passed: boolean;
  evidence?: EvaluationData;
};
```

`context.observation`, `context.history`, optional suite-level `context.cases`, and `parameters` are immutable JSON evidence. `context.signal` supports cancellation. At step scope, `history` contains previous turns only; at final scenario scope it includes the final turn as well.

The framework checks that referenced evaluator names exist before opening sessions. It validates `parameters` as JSON, not as a domain-specific schema. Validate required parameter fields in your host or evaluator. A thrown exception becomes `EVALUATOR_FAILED`; the raw exception message is not copied into the report.

Prefer evidence that identifies the relevant turns, expected and actual values, and the observed reason for rejection. Include only data intended for the report's readers. Evaluators should inspect the supplied evidence without changing the conversation or making business writes.

### Semantic criteria

There is no built-in natural-language judge or execution of JavaScript, regex source, or prompt strings from a suite. If a criterion needs semantic evaluation, register a host evaluator that calls the chosen model explicitly.

Define what that evaluator must judge and return enough evidence to inspect its result, such as the criterion, model identity, and concise decision explanation. Apply cancellation and bounds in that evaluator. Model cost and variability belong to that explicit host integration.

## Checks across cases

Suite-level checks run after scheduling ends, including cancelled and limited runs. Built-in checks read `{ summary, status }`. For example, this assertion verifies that no selected case remains pending:

```json
{
  "id": "no-pending-cases",
  "kind": "check",
  "path": ["summary", "pending"],
  "operator": "equals",
  "value": 0
}
```

It does not by itself establish that the cases passed. Custom suite evaluators can inspect `context.cases` for relationships such as unique created-record IDs or behavior shared across variants. Handle missing observations and incomplete cases explicitly; suite evaluators receive the entire selected inventory.

Suite results live in `report.assertions`. They do not rewrite the statuses of individual cases. See [Reports and agent iteration](./reports.md) for how to assess both.
