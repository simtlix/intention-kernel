import { END, START, StateGraph } from "@langchain/langgraph";

import { createRuntimeNodes, type RuntimeNodeDependencies } from "./nodes.js";
import { RuntimeState } from "./state.js";

/** Compile the private LangGraph execution graph for one agent runtime. */
export function compileLangGraphRuntime(dependencies: RuntimeNodeDependencies) {
  const nodes = createRuntimeNodes(dependencies);
  return new StateGraph(RuntimeState)
    .addNode("load_turn", nodes.load)
    .addNode("build_context", nodes.context)
    .addNode("select_capabilities", nodes.selectCapabilities)
    .addNode("interpret_turn", nodes.interpret)
    .addNode("create_plan", nodes.plan)
    .addNode("execute_plan", nodes.execute)
    .addNode("reduce_results", nodes.reduce)
    .addNode("compose_response", nodes.compose)
    .addNode("commit_turn", nodes.commit)
    .addEdge(START, "load_turn")
    .addEdge("load_turn", "build_context")
    .addEdge("build_context", "select_capabilities")
    .addEdge("select_capabilities", "interpret_turn")
    .addEdge("interpret_turn", "create_plan")
    .addEdge("create_plan", "execute_plan")
    .addEdge("execute_plan", "reduce_results")
    .addEdge("reduce_results", "compose_response")
    .addEdge("compose_response", "commit_turn")
    .addEdge("commit_turn", END)
    .compile();
}
