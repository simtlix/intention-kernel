# Repository examples

These commands run example applications from a clone of the Intention Kernel repository. They require its development dependencies. For an installed library, use the [application examples](../examples/index.md) and call the public API from your project.

## Declarative evaluation tutorial

```sh
npm run demo:evaluation
npm run demo:evaluation -- --fail
```

The first command executes a JSON suite through a scripted catalogue adapter without credentials. The second intentionally selects the wrong product and exits with code 1, demonstrating how a cross-turn business evaluator catches the failure. Both save a complete JSON evaluation report.

Read the [step-by-step tutorial](./evaluation-tutorial.md) and the [complete evaluation guide](../guide/evaluation.md) for syntax, multiple acceptance criteria, custom evaluators, adapters, reports, and coding-agent iteration.

## Model-backed conversations

These examples invoke a real structured-output model, execute registered capabilities, and assert runtime contracts rather than fixed response wording. They use the same evaluation runner with an application-specific adapter and evaluator registry.

```sh
npm run demo:e2e
npm run demo:e2e -- --scenario=subgraph
npm run demo:e2e -- --list
```

Set `GEMINI_API_KEY` in the process environment. `GEMINI_MODEL` is optional. Reports are written to `examples/.runs/` and exclude keys and raw provider responses.

### Scenarios

| ID | Conversation | Demonstrates |
| --- | --- | --- |
| `simple-conversation` | Greeting, then verified documentation question | Social turn without fabricated work; grounded read |
| `complex-conversation` | Service packages and documentation in one message | Multi-intent interpretation; parallel reads; one response |
| `similar-capabilities` | Documentation search, then commercial service search | Semantic distinction between nearby capabilities |
| `controlled-and-free-progress` | Prepare, propose submit, interrupt, confirm, replay | Durable agenda; confirmation; idempotent write |
| `subgraph` | Request an implementation rollout plan | Real LangGraph subgraph behind a capability port |
| `trace-and-events` | Verified checklist question | Causal events, model usage, fact lineage, sanitized output |

## Project structure

| File | Responsibility |
| --- | --- |
| `examples/evaluation.suite.json` | Portable tutorial suite: multi-turn selection, variants, and alternative catalogue outcomes |
| `examples/evaluation.ts` | Scripted evaluation adapter, history-based business evaluator, and runnable reporting command |
| `examples/demoAgent.ts` | Capabilities, policies, ports, and compiled demo agent |
| `examples/geminiModelGateway.ts` | Provider adapter for structured Gemini requests |
| `examples/planningSubgraph.ts` | Private three-node LangGraph workflow adapter |
| `examples/scenarios.ts` | Natural messages and contract-level expectations |
| `examples/run.ts` | Isolated conversations, assertions, and reports |
| `examples/schema.ts` | Example runtime-schema helpers |

## Similar capabilities

`knowledge.search` and `service.search` both perform searches. Their descriptions, schemas, semantic guidance, evidence, and fact outputs distinguish them. The scenario asserts the capability selected by the model and executed by the kernel.

This demonstrates the intended extension model: improve declarative capability contracts instead of adding phrase-specific routing branches.

## Controlled write

The controlled-progress scenario prepares a support request, asks to submit it, answers an unrelated documentation question while confirmation remains pending, accepts the write, and replays the same technical turn ID.

The assertions verify that the external write count increases once and remains unchanged on replay.

## Nested graph

The `workflow.design` capability calls a `planningGraph` port implemented with a real `StateGraph` containing:

1. `analyze_goal`
2. `build_steps`
3. `assess_risks`

The graph emits node progress through the capability event publisher. The parent trace retains causal order without exposing LangGraph types in the package API.

## Reports

The model-backed runner produces the portable `evaluation.json`, plus JSON and Markdown projections for human review. Each turn records the message, response, selected capabilities, facts, interaction, write delta, replay status, grounding result, and relevant event sequence. The local tutorial writes the portable report directly as `report.json`.

See [Reports and agent iteration](../guide/evaluation/reports.md) for the portable report contract and [Repository testing](./testing.md) for repository verification.
