# Nested workflows

A capability may delegate internal work to LangGraph, another workflow engine, a state machine, or a remote orchestrator. The nested workflow remains behind a host-injected port; it is not part of the Intention Kernel public contract.

## Boundary

<DocFlow name="subgraph" />

The capability remains responsible for input validation, output validation, evidence, fact publication, and any external write coordination.

## Port contract

```ts
interface PlanningGraphPort {
  run(
    input: PlanningInput,
    emit: (name: string, data: unknown) => Promise<void>,
  ): Promise<PlanningOutput>;
}
```

The capability narrows the injected port and bridges progress to the kernel event stream:

```ts
async execute(context, input) {
  const graph = context.ports.planningGraph as PlanningGraphPort;
  const output = await graph.run(
    input,
    (name, data) => context.events.emit(name, data),
  );

  return {
    status: "completed",
    output,
    facts: [/* workflow.plan with evidence lineage */],
    evidence: [/* validated planning result */],
    artifacts: [],
  };
}
```

## Ownership rules

- The parent kernel owns the turn, checkpoint, plan, and active interaction.
- The capability owns the domain operation and validates the nested result.
- The nested workflow owns only its private internal state.
- The durability adapter owns replay and effect receipts.
- Irreversible work still crosses `context.runEffect` at the capability boundary.

A nested graph must not mutate the parent checkpoint directly or create a second source of truth for conversation state.

## Events

The executable planning graph publishes:

- `subgraph.node.started`
- `subgraph.node.completed`

These become causal `capability.event` envelopes under the `workflow.design` plan step. A trace UI can therefore show internal progress without importing LangGraph-specific state types.

## When to use a nested workflow

Use one when a single domain operation has meaningful internal coordination: parallel enrichment, iterative analysis, human approval inside one capability, or a reusable multi-step algorithm.

Do not create a subgraph merely to split ordinary TypeScript functions. The capability contract should remain understandable without knowing the internal engine.

## Executable example

The repository includes a real three-node `StateGraph` in `examples/planningSubgraph.ts` and exposes it only through the `planningGraph` port.

```sh
npm run demo:e2e -- --scenario=subgraph
```

The scenario asserts the selected capability, produced fact, grounded response, and nested causal events.
