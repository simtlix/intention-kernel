# Application examples

These examples show how to use the installed package from your own application. The evaluation API is called directly; each example supplies definitions or integration code you can adapt to your existing agent.

| Example | What it demonstrates |
| --- | --- |
| [Evaluate your compiled agent](../guide/evaluation/quick-start.md) | A complete suite with two input variants, four required criteria, direct execution, and report acceptance. |
| [A conversation with several turns](../guide/evaluation/scenarios.md#a-complete-definition) | Search, select an option, and verify the final conversation state. |
| [Alternative valid outcomes](../guide/evaluation/assertions.md#accept-alternative-outcomes) | Require several conditions within each acceptable branch using `any` and `all`. |
| [A business rule across turns](../guide/evaluation/assertions.md#business-rules-across-turns) | Compare the requested option with the stored product and retain both values as evidence. |
| [Agent integration and event collection](../guide/evaluation/running.md#connect-a-compiled-agent) | Use application-owned model, durability, and ports with a correlated event collector. |
| [Another conversation transport](../guide/evaluation/running.md#connect-another-transport) | Adapt an application protocol through `EvaluationAdapter`. |
| [Coding-agent iteration](../guide/evaluation/reports.md#let-a-coding-agent-iterate) | Inspect a report, correct the responsible behavior, and rerun selected scenarios. |

## Runtime examples

The [first-agent guide](../guide/getting-started.md) covers capabilities and compilation. [Nested workflows](../guide/subgraphs.md) shows how a capability delegates to a host port while retaining causal events.

## Developing the library

The source repository also contains [scripted and model-backed demos](../development/examples.md). Those optional examples use repository development commands; they are not prerequisites for using the installed library.
