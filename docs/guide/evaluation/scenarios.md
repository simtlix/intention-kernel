# Writing scenarios

A use case describes an objective, such as selecting a product. A scenario describes a concrete conversation that exercises that objective and the conditions required to accept it. One use case can have several scenarios: successful selection, empty results, an ambiguous answer, or a correction after an earlier choice.

Keep every criterion needed to establish the business outcome. Split scenarios when the starting conditions or conversation paths differ; use multiple assertions when several conditions must hold in the same conversation.

## A complete definition

This suite targets an agent that searches products and records a `product.selected` fact. The host must provide those capabilities and the catalogue fixture. Fact names and expected business behavior come from the application.

```json
{
  "schemaVersion": 1,
  "id": "product-selection",
  "name": "Product selection",
  "metadata": { "useCase": "A customer chooses a product" },
  "scenarios": [
    {
      "id": "browse-and-select",
      "name": "Choose from the displayed products",
      "description": "Show available products, accept the first option, and finish the choice.",
      "tags": ["catalogue", "selection"],
      "writePolicy": "read_only",
      "steps": [
        {
          "id": "search",
          "input": { "text": "Show available products" },
          "assertions": [
            { "id": "completed", "kind": "check", "path": ["response", "status"], "operator": "equals", "value": "completed" },
            { "id": "choice", "kind": "check", "path": ["response", "interaction", "kind"], "operator": "equals", "value": "choice" },
            { "id": "options", "kind": "check", "path": ["response", "interaction", "options"], "operator": "exists" }
          ]
        },
        {
          "id": "select",
          "input": { "text": "I choose the first product", "selection": { "optionIndex": 0 } },
          "assertions": [
            { "id": "selection-recorded", "kind": "check", "path": ["checkpoint", "facts"], "operator": "contains", "value": { "type": "product.selected" } },
            { "id": "choice-closed", "kind": "check", "path": ["response", "interaction"], "operator": "absent" }
          ]
        }
      ],
      "assertions": [
        { "id": "final-response-completed", "kind": "check", "path": ["response", "status"], "operator": "equals", "value": "completed" }
      ]
    }
  ]
}
```

This definition checks the shape and lifecycle of the conversation. To establish that the *correct* product was selected, add the [history-based evaluator](./assertions.md#business-rules-across-turns). A fact's presence alone does not establish its business correctness.

## Fields and responsibilities

| Object | Required fields | Optional fields |
| --- | --- | --- |
| Suite | `schemaVersion: 1`, `id`, `name`, `scenarios` | `metadata`, `assertions` |
| Scenario | `id`, `name`, `writePolicy`, `steps` | `description`, `tags`, `skipReason`, `metadata`, `assertions` |
| Step | `id`, `input` | `variants`, `assertions` |
| Variant | `id`, `input` | None |
| Assertion | `id`, `kind`, and the fields required by that kind | `label` |

Use `name` and `description` to explain the intended business behavior. Use assertion `label` to explain a specific acceptance criterion. These descriptions appear in the definition snapshot; they are not automatically evaluated as prose.

`metadata` can hold a use-case identifier, source requirement, fixture name, or other host-owned JSON. The runner stores it without interpreting it. The adapter can read `context.scenario.metadata` during session setup. There is no built-in `given`, `when`, `then`, `expect`, fixture loader, or separate use-case schema; unknown definition fields are rejected.

`writePolicy: "read_only"` permits cases that do not require external business writes. Use `"external"` when the conversation may create or change an external record. The runner requires `allowExternalWrites: true` for those cases, and the host enforces the policy at the actual effect boundary. See [execution policies](./running.md#external-effects).

`skipReason` describes a reviewed exclusion. The resulting cases remain visible as skipped; they do not count as passed.

## Inputs and selection

The generic framework accepts a JSON object for each input. Your adapter defines its meaning. The direct compiled-agent adapter accepts exactly `text` and an optional `selection`:

```json
{ "text": "What services are available?" }
```

For a structured choice, supply exactly one selector:

```json
{ "text": "I choose the first option", "selection": { "optionIndex": 0 } }
```

```json
{ "text": "I choose this option", "selection": { "optionLabel": "Desk lamp" } }
```

```json
{ "text": "I choose this option", "selection": { "optionId": "published-option-id" } }
```

The direct adapter resolves the selector against the preceding checkpoint interaction. Indexes are zero-based. Labels and IDs must match exactly one published option. No active interaction, an out-of-range index, an unknown ID, or an ambiguous label produces an evaluation error.

`text` remains required and can be empty; the direct adapter accepts at most 10,000 characters. Do not combine `optionIndex`, `optionLabel`, and `optionId` in one selection object.

A structured `selection` exercises the explicit-choice path, like a UI click. To evaluate whether the model understands “the first one,” submit only `text`. These are distinct behaviors and may deserve separate scenarios.

## Put assertions at the right scope

| Location | Built-in checks read | Custom evaluator also receives |
| --- | --- | --- |
| `steps[n].assertions` | That step's current observation | Prior recorded turns in `history`; the current turn is not yet in it |
| `scenario.assertions` | The last available observation after all defined steps are recorded | The full recorded conversation, including the final turn |
| `suite.assertions` | `{ "summary": ..., "status": ... }` after scheduling ends | All selected cases in `cases`, including incomplete cases; `history` is empty |

Use step assertions to catch a failure where it first becomes observable: the wrong interaction, missing fact, or incorrect effect count. Use scenario assertions for final state and cross-turn relationships. Use suite assertions for conditions across cases, such as unique external identifiers.

Ordinary assertion failures do not stop subsequent steps. Errors or cancellation can prevent the remaining steps from running. Final scenario assertions require all defined steps to be recorded and the final observation to exist, with no early stop. A partial conversation must not be accepted merely because a final assertion was never executed.

## Variants and repetitions

Variants let one step receive different complete inputs while keeping the same scenario and acceptance logic:

```json
{
  "id": "search",
  "input": { "text": "Show available products" },
  "variants": [
    { "id": "direct", "input": { "text": "Show available products" } },
    { "id": "polite", "input": { "text": "Please show available products" } }
  ]
}
```

This is a **step fragment** to place in `steps`. When `variants` is present, only its listed inputs are executed. The required baseline `input` is not an additional case. Include it explicitly as a variant if you want to run it.

A variant replaces the entire input; it does not merge fields. If the baseline contains `selection` and a variant omits it, that case has no structured selection.

Multiple variant steps form a Cartesian product. A scenario with two search variants and three selection variants produces six cases. With `repetitions: 2`, it produces twelve cases. A scenario without variants produces one case per repetition.

Each case records its chosen variant IDs and zero-based repetition index. The runner gives cases distinct thread identities; the adapter must arrange any additional fixture or backend-state isolation the application requires.

## Alternatives and conversation paths

`any` means several observed outcomes are acceptable. It does not choose the next input or branch the conversation. Steps remain a fixed ordered list.

For example, “offer products or explain that none are available” can be a single-step scenario with an `any` assertion. “Select a product if results exist, otherwise change the search” involves different next turns: write separate scenarios, or implement that interaction behavior explicitly in a host adapter.

There is no built-in interpolation such as `${previous.productId}`, variable capture, loop, or conditional step. To use a dynamic published option, use the direct adapter's `selection`. To check relationships with previous turns, use a custom evaluator. Other dynamic protocols belong to the adapter.

## Definition validation

Load external data with `parseEvaluationSuite()` before storing or executing it. `runEvaluation()` validates again at its public boundary.

- IDs contain 1–160 characters, start with a letter or number, and then use letters, numbers, `_`, `.`, `:`, or `-`.
- Scenario IDs are unique within the suite; step IDs within a scenario; variant IDs within a step; assertion IDs within each sibling assertion array.
- A suite contains 1–10,000 scenarios; a scenario contains 1–500 steps; a variant list contains 1–100 alternatives.
- Step, scenario, and suite assertion arrays allow up to 200 entries. `all` and `any` contain 1–100 children.
- Definitions contain only JSON values. Cycles, excessive nesting, unsafe assertion paths, and unknown fields are rejected.
- A custom evaluator's name must be registered before execution. Its domain-specific `parameters` still need validation by host code.

Empty or omitted assertion arrays are allowed by the schema. Successful transport execution alone can therefore produce a passed case. Declare the business criteria you actually need to establish acceptance.

For every assertion form and exact operator behavior, continue with [Assertions and evaluators](./assertions.md).
