import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

/** Input accepted by the nested workflow demo. */
export interface PlanningInput {
  readonly goal: string;
  readonly priorities: readonly string[];
}

/** Structured result returned by the nested workflow demo. */
export interface PlanningOutput {
  readonly goal: string;
  readonly approach: string;
  readonly steps: readonly string[];
  readonly risks: readonly string[];
}

/** Observable boundary used by a nested workflow without depending on kernel internals. */
export type PlanningEventPublisher = (
  name: string,
  data: unknown,
) => Promise<void>;

/** Port implemented by any workflow engine capable of building a plan. */
export interface PlanningGraphPort {
  run(input: PlanningInput, publish: PlanningEventPublisher, signal: AbortSignal): Promise<PlanningOutput>;
}

const PlanningState = Annotation.Root({
  input: Annotation<PlanningInput>(),
  publish: Annotation<PlanningEventPublisher>(),
  approach: Annotation<string | undefined>(),
  steps: Annotation<readonly string[] | undefined>(),
  risks: Annotation<readonly string[] | undefined>(),
});

/** Create a real three-node LangGraph hidden behind the generic planning port. */
export function createPlanningGraphPort(): PlanningGraphPort {
  const graph = new StateGraph(PlanningState)
    .addNode("analyze_goal", async (state) => {
      await state.publish("subgraph.node.started", { node: "analyze_goal" });
      const approach = state.input.priorities.includes("continuity")
        ? "incremental rollout with reversible checkpoints"
        : "short validated delivery increments";
      await state.publish("subgraph.node.completed", { node: "analyze_goal", approach });
      return { approach };
    })
    .addNode("build_steps", async (state) => {
      await state.publish("subgraph.node.started", { node: "build_steps" });
      const steps = [
        `Establish measurable acceptance criteria for ${state.input.goal}`,
        `Deliver ${state.approach ?? "validated increments"}`,
        "Review evidence before expanding the rollout",
      ];
      await state.publish("subgraph.node.completed", { node: "build_steps", count: steps.length });
      return { steps };
    })
    .addNode("assess_risks", async (state) => {
      await state.publish("subgraph.node.started", { node: "assess_risks" });
      const risks = ["unverified assumptions", "irreversible rollout without evidence"];
      await state.publish("subgraph.node.completed", { node: "assess_risks", count: risks.length });
      return { risks };
    })
    .addEdge(START, "analyze_goal")
    .addEdge("analyze_goal", "build_steps")
    .addEdge("build_steps", "assess_risks")
    .addEdge("assess_risks", END)
    .compile();
  return {
    async run(input, publish, signal) {
      const result = await graph.invoke({ input, publish }, { signal });
      if (result.approach === undefined || result.steps === undefined || result.risks === undefined) {
        throw new Error("PLANNING_SUBGRAPH_INCOMPLETE");
      }
      return {
        goal: input.goal,
        approach: result.approach,
        steps: result.steps,
        risks: result.risks,
      };
    },
  };
}
