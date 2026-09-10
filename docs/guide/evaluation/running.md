# Running evaluations

`runEvaluation()` executes a validated suite through an `EvaluationAdapter` and returns an `EvaluationReport`. The host supplies the agent, model configuration, fixtures, evaluator registry, and report destination.

Start with [Evaluating from your project](./quick-start.md) for a complete module that calls the installed package directly. The library does not require repository scripts or a particular test runner.

## Load a suite

```ts
import { readFile } from "node:fs/promises";
import { parseEvaluationSuite } from "intention-kernel/testing";

const source: unknown = JSON.parse(await readFile("./evaluation.suite.json", "utf8"));
const suite = parseEvaluationSuite(source);
```

`parseEvaluationSuite()` returns a detached definition and rejects invalid shapes, unknown fields, duplicate IDs, and unsafe paths. It does not load adapters or execute custom evaluator code from the file.

## Connect a compiled agent

This reusable helper compiles a host-provided definition, records kernel events, and evaluates the agent through the public direct adapter:

```ts
import {
  createKernel,
  type AgentDefinition,
  type KernelOptions,
} from "intention-kernel";
import {
  createAgentEvaluationAdapter,
  createEventCollector,
  runEvaluation,
  type EvaluationEvaluators,
  type EvaluationReport,
  type EvaluationSuite,
} from "intention-kernel/testing";

export async function evaluateAgent(
  definition: AgentDefinition,
  kernelOptions: Omit<KernelOptions, "eventSink">,
  suite: EvaluationSuite,
  configurationFingerprint: string,
  evaluators: EvaluationEvaluators = {},
): Promise<EvaluationReport> {
  const collector = createEventCollector();
  const kernel = createKernel({ ...kernelOptions, eventSink: collector });
  const agent = await kernel.compile(definition);

  return runEvaluation({
    suite,
    target: {
      id: agent.id,
      fingerprint: `${agent.fingerprint}:${configurationFingerprint}`,
    },
    adapter: createAgentEvaluationAdapter({
      agent,
      events: () => collector.events,
    }),
    evaluators,
    concurrency: 1,
  });
}
```

Supply `kernelOptions` with the same model gateway, durability, and ports your agent needs. The [first-agent guide](../getting-started.md) explains those dependencies. `configurationFingerprint` is a host-owned version or digest of the model configuration, fixtures, and custom evaluator versions relevant to this evaluation. Do not put credentials in it.

If the agent is already compiled, pass it directly to `createAgentEvaluationAdapter({ agent, events })`. The event collector must be the sink configured on that agent's kernel. Supplying an unrelated collector will produce no correlated events.

### Observation from the direct adapter

The adapter exposes the committed `TurnResult`, plus the collected events for that exact thread and turn:

| Path | Evidence |
| --- | --- |
| `["response"]` | Published response, status, grounding, claims, and optional interaction |
| `["checkpoint", "facts"]` | Confirmed facts, values, evidence, and lineage |
| `["checkpoint", "agenda"]` | Retained operations and their state |
| `["checkpoint", "interaction"]` | Pending user interaction, when present |
| `["checkpoint", "effects"]` | Durable effect receipts |
| `["checkpoint", "progression"]` | Progression state, when configured |
| `["checkpoint", "messages"]` | Committed conversation messages |
| `["events"]` | Correlated kernel events, or an empty array if no event source was supplied |
| `["threadId"]`, `["turnId"]`, `["traceId"]`, `["replayed"]` | Runtime identities and replay marker |

The adapter accepts only `{ text, selection? }` inputs. See [selection syntax](./scenarios.md#inputs-and-selection). Provider credentials, runtime configuration, and host ports are not accepted as imported scenario input.

The committed kernel state at `turn.observation.checkpoint` is different from `turn.checkpoint`, the evaluation adapter's optional resume token. The direct adapter's resume token contains the preceding interaction; the agent's actual durable state remains in its durability adapter.

### Conversation and fixture isolation

Each case gets a distinct conversation thread. Steps within a case run sequentially and share that conversation. Different cases may run concurrently.

The helper above shares one compiled agent and its ports across cases. Distinct thread IDs do not reset a shared inventory, counter, database, or test fixture. If your scenarios need independent host state, create that state during each custom adapter `open()` or use per-case fixture namespaces.

## Connect another transport

Implement `EvaluationAdapter` when your application exposes HTTP chat, a service client, or another conversation protocol. The [testing API reference](../../reference/testing/intention-kernel.evaluationadapter.md) defines the full contract.

| Adapter member | Responsibility |
| --- | --- |
| `id`, `version` | Identify the transport contract. |
| `open(context)` | Prepare one case's session. Receives `runId`, `caseId`, `threadId`, the scenario, an optional resume checkpoint, and an abort signal. |
| `session.send(input, context)` | Submit one turn using the provided `turnId`, `stepId`, and signal. Return the observation and optional checkpoint or stop result. |
| `session.close()` | Release case resources after success, failure, or cancellation. Optional. |
| `supportsResume` | Declare checkpoint restoration only when `open()` can restore the exact conversation state. Optional; defaults to unsupported. |

The result of `send()` has this shape:

```ts
import type { EvaluationData } from "intention-kernel/testing";

type SendResult = {
  observation: EvaluationData;
  checkpoint?: EvaluationData;
  stop?: { status: "skipped" | "completed"; reason: string };
};
```

`send()` returns a promise of this shape. `EvaluationData` is a JSON object exported from `intention-kernel/testing`.

`observation` should contain the evidence your assertions and developers need: submitted request data, structured response, relevant state before or after the turn, executed capabilities, domain events, and effect receipts. The framework does not fetch this information from a backend automatically.

Keep credentials in the session closure. The host chooses which data is authorized for the report and performs domain-specific redaction. The generic JSON validator cannot identify application secrets.

### Early stops

Return `stop: { status: "skipped", reason }` when the adapter discovers that a case is not applicable. It remains visible as an explicit exclusion. A previously failed or errored turn still prevents that case from being treated as a successful skip.

Returning `stop: { status: "completed", reason }` before the last defined step marks the case as incomplete with `EVALUATION_EARLY_COMPLETION` unless an existing failure or error determines its outcome. A conversation ending early does not satisfy unexecuted requirements.

Use scenario `skipReason` for exclusions known before execution, so the runner can skip opening a session.

## Execution options

The required options are `suite`, `target: { id, fingerprint }`, and `adapter`.

| Option | Default | Behavior |
| --- | --- | --- |
| `evaluators` | No custom evaluators | Registry of named business or semantic checks. Missing referenced names reject the run before sessions open. |
| `scenarioIds` | All scenarios | Select exact IDs. Unknown IDs are errors. |
| `tags` | No tag filter | Select scenarios matching any requested tag. Combined with `scenarioIds`, both filters must match. |
| `concurrency` | `1` | Concurrent cases; integer from 1 to 32. Steps inside a case remain sequential. |
| `repetitions` | `1` | Independent executions per variant combination; integer from 1 to 100. |
| `maxCases` | `1000` | Reject a larger expanded matrix before execution; configurable up to 100,000. |
| `maxFailures` | `100000` | Stop scheduling after this many newly executed failed/error cases; already-running cases finish. Integer from 1 to 100,000. |
| `timeoutMs` | `120000` | Deadline for each bounded operation; integer from 1 to 3,600,000 milliseconds. |
| `signal` | No external cancellation | Cooperatively cancel the run. |
| `allowExternalWrites` | `false` | Permit scenarios declaring `writePolicy: "external"`, subject to host effect enforcement. |
| `onCheckpoint` | No persistence callback | Save a deeply immutable run snapshot at each transition. |
| `onEvent` | No observer | Receive an ordered lifecycle event after its checkpoint callback succeeds. |
| `resume`, `retryFailed` | Fresh execution | Continue a compatible report or explicitly retry eligible failed cases. See below. |

An empty filter result raises `EVALUATION_SELECTION_EMPTY`. The runner never silently treats an empty selection as a passing evaluation.

`timeoutMs` is not a budget for the whole suite. It bounds session creation, each turn including its step assertions, final scenario assertions, suite assertions, cleanup, and lifecycle callbacks. Use an external abort signal if your host also needs a whole-run deadline.

Cancellation and failure limits leave unexecuted cases in the report as `pending`. `maxFailures` counts cases with status `failed` or `error`; it does not count individual assertion failures or suite assertions evaluated after scheduling.

## Store reports and progress

`runEvaluation()` returns the report directly. Your caller can assert its results or display it without writing any file. If your application needs a saved report, serialize that returned value in its own storage layer. Use `onCheckpoint` when you need durable progress during a longer run.

Snapshots are deeply immutable. Unchanged cases retain object identity between snapshots, allowing a host to avoid repeatedly serializing unchanged evidence. Use `structuredClone(snapshot)` before transforming a report.

Checkpoint callbacks are serialized. The corresponding event is delivered only after checkpoint persistence succeeds. Event types are `run.started`, `case.started`, `turn.completed`, `case.completed`, and `run.completed`, with sequence and relevant identities.

If a persistence or event callback rejects or exceeds its deadline, scheduling stops and `runEvaluation()` rejects with `EVALUATION_OBSERVER_FAILED`. Keep the last successfully persisted snapshot; do not expect a normal final report from that failed call.

Use atomic file replacement or a transaction for incremental storage. Writing a complete JSON report after every transition works for small suites but repeatedly serializes the full history. For larger suites, persist changed cases and assemble a full report for export.

Definitions and independent JSON payloads are bounded to 60 levels and 500,000 visited values. Reports validate turn payloads separately, so a large case inventory does not consume a single observation's budget. Hosts still need appropriate storage and request-size limits.

## External effects

The runner blocks `writePolicy: "external"` scenarios unless `allowExternalWrites: true` is set. The adapter and actual effect boundary must enforce the declared policy; the runner cannot detect that a mislabeled read-only scenario performs a write.

No request is automatically retried. Cancellation and deadlines bound the runner's wait but do not prove an upstream operation stopped or undo an effect. For real writes, preserve receipts and reconcile uncertain results before starting a new attempt.

## Resume and explicit retry

For a fresh run after changing the implementation, omit `resume`. Preserve the old report as evidence of the earlier target.

Use `resume` to continue an interrupted evaluation only when its definition, selected case matrix, target fingerprint, and adapter version match. The runner validates the report with `parseEvaluationReport()` and checks compatibility. A resumed run receives a new `runId` and links to the previous one through `resumedFrom`.

Terminal cases are retained unless an explicit retry applies. A healthy incomplete turn prefix requires an adapter with `supportsResume: true` and a usable checkpoint. Otherwise it is blocked. For the direct adapter, enable resume only when the agent's durability survives the interruption; the interaction token alone cannot restore kernel state.

`retryFailed: true` requires `resume` and starts fresh conversations for eligible failed, errored, blocked, or cancelled cases. Previously attempted external-write cases are blocked pending reconciliation. A case previously blocked solely because external writes were not authorized can be retried after authorization.

External-write cases left `running` or `cancelled` are also blocked on resume, even if no turn was persisted. An empty turn list cannot establish that an external effect did not happen.

Continue with [Reports and agent iteration](./reports.md) to use execution evidence as the input to an improvement loop.
