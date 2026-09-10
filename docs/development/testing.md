# Repository testing

These commands are for developing Intention Kernel from its source repository, with Node.js 22, npm 10, and the repository's development dependencies. Installed-package consumers use the [testing API in their own project](../guide/testing.md).

## Repository verification

```sh
npm ci
npm run verify
npm pack --dry-run
```

`npm run verify` performs:

- TypeScript type checking;
- linting;
- behavior tests;
- type-level tests;
- example type checking;
- generated API documentation verification;
- documentation-site build;
- installation and execution from the packed public artifact.

The package check performs a normal npm install into a temporary consumer project.
It compiles the complete examples from the README and the capability guide against the installed declarations,
executes the documented capability and evaluation examples, exercises the public
testing module, and checks that every source map resolves inside the package.
The site check also validates the public documentation links in the README and
other package Markdown files against the generated site.

## Executable model-backed demos

Provide `GEMINI_API_KEY` in the process environment and run:

```sh
npm run demo:e2e
npm run demo:e2e -- --scenario=controlled-and-free-progress
npm run demo:e2e -- --list
```

`GEMINI_MODEL` is optional and defaults to the model configured by the example gateway. Reports are written to the ignored `examples/.runs/` directory. Keys and raw provider responses are not persisted.

## Model-backed demo expectations

Each demo turn declares expectations for runtime outcomes:

`DemoTurnExpectation` is a convenience type defined by the example application. It is translated into registered checks by that demo runner; it is not the portable `EvaluationAssertion` schema. For generic JSON definitions, use [Assertions and evaluators](../guide/evaluation/assertions.md).

```ts
interface DemoTurnExpectation {
  capabilities: readonly string[];
  facts?: readonly string[];
  interaction?: "none" | "confirmation" | "present";
  writeDelta?: number;
  customEvents?: readonly string[];
  replayed?: boolean;
}
```

The runner checks:

- proposed and executed capabilities;
- plan outcomes and dependencies;
- facts and evidence lineage;
- interactions and controlled progress;
- external write count and replay behavior;
- grounded response status and citations;
- event sequence and nested causal progress.

It does not compare a fixed natural-language response string.

## Scenario coverage

| Scenario | Required behavior |
| --- | --- |
| Simple conversation | A greeting performs no fabricated work; a factual request performs one grounded read. |
| Multiple objectives | Two independent reads are planned and completed in one turn. |
| Similar capabilities | Documentation search and purchasable-service search remain semantically distinct. |
| Controlled and free progress | A safe informational turn completes while a write confirmation remains pending. |
| Durable write | Confirmation executes one write; replay does not execute another. |
| Nested workflow | A real subgraph completes behind a capability port and emits causal node progress. |
| Trace projection | Events expose model usage, plan, capability, facts, grounding, and commit order. |

## Adapter conformance

Production adapters need tests for their own guarantees:

- duplicate `turnId` replay;
- concurrent turn serialization per thread;
- atomic checkpoint, result, and outbox commit;
- prepared, completed, failed, and uncertain effects;
- cancellation and timeout propagation;
- structured model output rejection;
- event redaction before export.

The in-memory durability adapter is useful for kernel consumers and examples, but it cannot prove database transaction behavior.

## Failure diagnosis

When an end-to-end scenario fails, inspect the first incorrect boundary:

1. projected context;
2. intention proposal and evidence;
3. plan authorization;
4. normalized capability input;
5. capability result and upstream evidence;
6. reduced facts and active interaction;
7. response citations and grounding verdict;
8. durable commit and replay marker.

Changing response wording cannot repair an incorrect capability selection or invalid state transition.

## README visuals

The README uses a looping GIF, a static overview, and diagrams for execution and
evaluation. Their source is `scripts/render-readme-visuals.mjs`; exported assets
live in `docs/public/readme/` and are served by the documentation site. The GIF
and evaluation report are illustrations of the documented contracts, not a
recording of a live model run or benchmark results.

To regenerate them, install FFmpeg on your path and provide the static
`Inter-Regular.ttf` and `Inter-SemiBold.ttf` fonts in a directory selected by
`README_FONT_DIR`. On Windows, the script defaults to the system Fonts directory.
Then run these optional authoring commands from the repository root:

```sh
npm install --prefix .tmp/readme-visual-tools --no-save --package-lock=false --ignore-scripts --no-audit --no-fund @resvg/resvg-js@2.6.2
node scripts/render-readme-visuals.mjs
```

Use `--stills` to regenerate only the PNGs. The full render also creates a local
MP4 for playback review. Frames, SVG intermediates, the MP4, and rendering tools
stay under the ignored `.tmp/` directory. Neither the renderer nor the visual
assets are included in the installable library package.

Review the animation loop and text at README width after changing a visual.
Run `npm run docs:build` to verify that every README asset URL resolves in the
generated documentation site. Asset generation is optional and is not part of
the library build or CI.
