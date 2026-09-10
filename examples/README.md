# Executable examples

This directory is for contributors working in a clone of the library repository. Its commands are optional development tools. Applications that installed the package call the [public evaluation API](https://simtlix.github.io/intention-kernel/guide/evaluation/quick-start.html) from their own code.

## Declarative evaluation tutorial

Run from the repository root with Node.js 22 and installed dependencies:

```sh
npm run demo:evaluation
npm run demo:evaluation -- --fail
npm run demo:evaluation -- --scenario=choose-product --repetitions=3
```

`evaluation.suite.json` declares multi-turn scenarios, input variants, several required criteria, and acceptable alternative outcomes. `evaluation.ts` supplies a scripted local adapter and a custom evaluator that compares a selected product with the option requested in the preceding interaction. No model credentials are required.

The default run passes four cases. `--fail` introduces a wrong-product selection: two cases fail, two pass, and the command exits with code 1. Each run writes its full JSON report to a new directory under `examples/.runs/` and prints the path. `--output=path/to/report.json` chooses a destination and replaces that file if it exists.

This fixture teaches evaluation and diagnosis. It does not test model understanding. See the [repository tutorial](https://simtlix.github.io/intention-kernel/development/evaluation-tutorial.html), [scenario syntax](https://simtlix.github.io/intention-kernel/guide/evaluation/scenarios.html), and [agent integration](https://simtlix.github.io/intention-kernel/guide/evaluation/running.html).

`evaluateConsumer.ts` is a separate, programmatic example that can be copied into a consuming application. It defines and evaluates a suite using public imports, with no command-line or filesystem dependency.

## Model-backed demos

These demos are small host applications, not kernel fixtures. They import only
the public `intention-kernel` and `intention-kernel/testing` entry points, call a real structured-output
model, execute real capabilities and verify the resulting facts, interactions,
effects and causal events.

The suite covers:

- a greeting and a simple grounded read;
- a multi-operation request;
- two semantically similar search capabilities;
- free informational work while a controlled write remains pending;
- a confirmed, idempotent external effect;
- an actual nested LangGraph workflow behind a capability port;
- event redaction, branch causality and a human-readable trace report.

### Run

Build the package and provide a Gemini key only in the process environment:

```sh
npm run demo:e2e
npm run demo:e2e -- --scenario=controlled-and-free-progress
npm run demo:e2e -- --list
npm run demo:e2e -- --parallel=3 --max-failures=5 --repetitions=2
```

`GEMINI_MODEL` is optional and defaults to `gemini-2.5-flash`. Reports are
written under `examples/.runs/` as JSON and Markdown. The key and raw provider
responses are never included.

The demos use `runEvaluation` from `intention-kernel/testing`. Every case owns its kernel, memory store and simulated write ports. `evaluation.json` is the portable framework report, saved after each transition; `report.json` and `report.md` are readable projections. Cancellation keeps pending cases visible. Requests that simulate writes never reach external business services.

## Why the nested workflow is a port

Intention Kernel deliberately does not expose LangGraph types. The
`workflow.design` capability calls an injected `planningGraph` port whose demo
adapter is implemented with a real `StateGraph`. Its nodes publish progress
through `context.events`, so the parent turn retains one causal trace while a
consumer remains free to replace LangGraph with another workflow engine.
