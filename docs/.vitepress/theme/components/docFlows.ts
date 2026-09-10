export interface FlowNode {
  id: string;
  title: string;
  owner?: string;
  detail?: string;
  code?: boolean;
  accent?: boolean;
  position: [row: number, column: number, span?: number];
  smallPosition?: [row: number, column: number, span?: number];
  steps?: string[];
  items?: { title: string; detail: string }[];
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
}

export interface FlowDefinition {
  title: string;
  description: string;
  columns: number;
  smallColumns?: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  note?: string;
}

// Linear flows follow one continuous path across rows. On narrow screens,
// document order becomes a single vertical path without shrinking the text.
function sequence(
  title: string,
  description: string,
  nodes: Omit<FlowNode, "position">[],
  note?: string,
): FlowDefinition {
  return {
    title,
    description,
    columns: 3,
    nodes: nodes.map((node, index) => {
      const row = Math.floor(index / 3) + 1;
      const column = row % 2 === 1 ? index % 3 + 1 : 3 - index % 3;
      const span = index === nodes.length - 1 && row % 2 === 1 ? 4 - column : 1;
      return { ...node, position: [row, column, span] };
    }),
    edges: nodes.flatMap((node, index) => {
      const next = nodes[index + 1];
      return next ? [{ from: node.id, to: next.id }] : [];
    }),
    ...(note ? { note } : {}),
  };
}

export const docFlows = {
  relationship: sequence(
    "From message to cited response",
    "A message leads to an intention proposal, capability authorization, a port call or durable effect, evidence, a fact, and a cited response, in that order.",
    [
      { id: "message", title: "Message", owner: "User", detail: "Expresses an objective" },
      { id: "intention", title: "Intention proposal", owner: "Model", detail: "Interprets the request" },
      { id: "capability", title: "Capability authorization", owner: "Kernel", accent: true },
      { id: "execution", title: "Port call or durable effect", owner: "Capability" },
      { id: "evidence", title: "Evidence", owner: "Capability", detail: "Returns authoritative support" },
      { id: "fact", title: "Fact", owner: "Kernel", detail: "Publishes confirmed knowledge" },
      { id: "response", title: "Cited response", owner: "Model + kernel", accent: true },
    ],
  ),
  grounding: sequence(
    "Evidence travels with the claim",
    "An external source produces an EvidenceRecord. FactCandidate.evidenceIds links it to a FactRecord. A cited response part becomes an exact ResponseClaim span.",
    [
      { id: "source", title: "External source", owner: "Authority" },
      { id: "evidence", title: "EvidenceRecord", owner: "Capability", code: true, accent: true },
      { id: "candidate", title: "FactCandidate.evidenceIds", owner: "Evidence link", code: true },
      { id: "fact", title: "FactRecord", owner: "Kernel", code: true },
      { id: "part", title: "Cited response part", owner: "Model" },
      { id: "claim", title: "Exact ResponseClaim span", owner: "Kernel", accent: true },
    ],
  ),
  concepts: sequence(
    "From intent to evidence",
    "The model proposes an intention from a user message. The kernel authorizes a capability, which calls a port. A host adapter reaches the external system. The capability returns evidence, the kernel publishes a fact, and the model composes a cited response.",
    [
      { id: "message", title: "User message", owner: "Input" },
      { id: "intention", title: "Propose an Intention", owner: "Model" },
      { id: "capability", title: "Authorize a Capability", owner: "Kernel", accent: true },
      { id: "port", title: "Call a Port", owner: "Capability", detail: "Application-facing interface" },
      { id: "adapter", title: "Reach the external system", owner: "Host adapter" },
      { id: "evidence", title: "Return Evidence", owner: "Capability" },
      { id: "fact", title: "Publish a Fact", owner: "Kernel" },
      { id: "response", title: "Compose a cited response", owner: "Model", accent: true },
    ],
    "Every material transition emits an Event. Provider tools have no execution authority.",
  ),
  architecture: {
    title: "The host assembles. The kernel orchestrates.",
    description: "The host provides an agent definition and model, durability, and domain adapters. Intention Kernel executes the turn graph and produces a TurnResult, checkpoint, and causal events.",
    columns: 1,
    nodes: [
      {
        id: "host", title: "Host application", owner: "Composition boundary", position: [1, 1],
        items: [
          { title: "Agent definition", detail: "Identity, capabilities, policies, model policy" },
          { title: "Model adapter", detail: "Structured interpretation and response generation" },
          { title: "Durability adapter", detail: "Checkpoint, replay, effects, event outbox" },
          { title: "Domain adapters", detail: "Implementations of capability ports" },
        ],
      },
      {
        id: "runtime", title: "Intention Kernel runtime", owner: "Execution boundary", accent: true, position: [2, 1],
        detail: "Context, select, interpret, plan, execute, reduce, ground, commit.",
      },
      { id: "result", title: "TurnResult + checkpoint + causal events", owner: "Atomic output", position: [3, 1] },
    ],
    edges: [{ from: "host", to: "runtime" }, { from: "runtime", to: "result" }],
  },
  subgraph: {
    title: "A workflow behind a capability",
    description: "Intention Kernel authorizes workflow.design, which calls PlanningGraphPort. Its private LangGraph StateGraph runs analyze_goal, build_steps, and assess_risks in order. The validated workflow result returns through the port; the capability returns facts, evidence, and artifacts to the kernel.",
    columns: 3,
    nodes: [
      { id: "kernel", title: "Intention Kernel", owner: "Turn owner", position: [1, 1] },
      { id: "capability", title: "workflow.design", owner: "Authorized capability", code: true, accent: true, position: [1, 2] },
      { id: "port", title: "PlanningGraphPort", owner: "Host-injected port", code: true, position: [1, 3] },
      {
        id: "workflow", title: "LangGraph StateGraph", owner: "Private workflow", position: [2, 1, 3],
        steps: ["analyze_goal", "build_steps", "assess_risks"],
      },
      { id: "validated", title: "Validated workflow result", owner: "Return through port", position: [3, 3] },
      { id: "result", title: "Facts + evidence + artifacts", owner: "Capability returns to kernel", accent: true, position: [3, 1, 2] },
    ],
    edges: [
      { from: "kernel", to: "capability" }, { from: "capability", to: "port" },
      { from: "port", to: "workflow" }, { from: "workflow", to: "validated" },
      { from: "validated", to: "result" },
    ],
    note: "The nested workflow owns its private state. The parent kernel keeps ownership of the turn and checkpoint.",
  },
  objectives: {
    title: "One message, independent reads",
    description: "The model interprets both objectives and the planner validates them. service.search and knowledge.search can run concurrently. Their service.candidates and knowledge.answer facts support one composed response.",
    columns: 2,
    smallColumns: 2,
    nodes: [
      { id: "message", title: "Find a support package and explain the payment incident checklist", owner: "User message", position: [1, 1, 2] },
      { id: "plan", title: "Interpret & plan", detail: "Validate both capabilities and schedule independent reads", owner: "Model + kernel", accent: true, position: [2, 1, 2] },
      { id: "service", title: "service.search", owner: "Read capability", code: true, position: [3, 1] },
      { id: "knowledge", title: "knowledge.search", owner: "Read capability", code: true, position: [3, 2] },
      { id: "candidates", title: "service.candidates", owner: "Confirmed fact", code: true, position: [4, 1] },
      { id: "answer", title: "knowledge.answer", owner: "Confirmed fact", code: true, position: [4, 2] },
      { id: "response", title: "One grounded response", detail: "Composed from both evidence sets", owner: "Model + kernel", accent: true, position: [5, 1, 2] },
    ],
    edges: [
      { from: "message", to: "plan" }, { from: "plan", to: "service" }, { from: "plan", to: "knowledge" },
      { from: "service", to: "candidates" }, { from: "knowledge", to: "answer" },
      { from: "candidates", to: "response" }, { from: "answer", to: "response" },
    ],
    note: "Independent reads share an execution level. Fact dependencies determine the order of dependent work.",
  },
  confirmation: {
    title: "Safe work around a pending write",
    description: "request.prepare leads to a proposed request.submit and a pending confirmation. While it is pending, knowledge.search may complete independently. Only a later accepted confirmation allows the request.submit effect.",
    columns: 2,
    smallColumns: 2,
    nodes: [
      { id: "prepare", title: "request.prepare", owner: "Prepare", code: true, position: [1, 1], smallPosition: [1, 1, 2] },
      { id: "propose", title: "request.submit", owner: "Proposed write", code: true, position: [1, 2], smallPosition: [2, 1, 2] },
      { id: "pending", title: "Confirmation pending", owner: "Durable interaction", accent: true, position: [2, 1, 2], smallPosition: [3, 1, 2] },
      { id: "read", title: "knowledge.search", owner: "Safe work", code: true, detail: "Completes while confirmation stays pending", position: [3, 1], smallPosition: [4, 1] },
      { id: "accepted", title: "Confirmation accepted", owner: "Later user answer", position: [3, 2], smallPosition: [4, 2] },
      { id: "effect", title: "request.submit", owner: "Durable effect", code: true, accent: true, position: [4, 2], smallPosition: [5, 2] },
    ],
    edges: [
      { from: "prepare", to: "propose" }, { from: "propose", to: "pending" },
      { from: "pending", to: "read" }, { from: "pending", to: "accepted" }, { from: "accepted", to: "effect" },
    ],
    note: "Completing an unrelated read neither discards nor accepts the pending write.",
  },
  durability: {
    title: "One turn, one durable boundary",
    description: "Begin the turn, lock the thread, and check for a prior result. An already committed turn returns its stored result. A new turn loads the checkpoint, executes the runtime, and atomically commits result, checkpoint, and events. Both paths end the turn.",
    columns: 2,
    smallColumns: 2,
    nodes: [
      { id: "begin", title: "Begin turn", owner: "withTurn", position: [1, 1] },
      { id: "lock", title: "Lock thread", owner: "Serialize", position: [1, 2] },
      { id: "check", title: "Check prior turn result", owner: "turnId", accent: true, position: [2, 1, 2] },
      { id: "replay", title: "Return stored result", owner: "Replay", detail: "replayed: true", position: [3, 1] },
      { id: "checkpoint", title: "Load checkpoint", owner: "New execution", position: [3, 2] },
      { id: "execute", title: "Execute runtime", position: [4, 2] },
      { id: "commit", title: "Atomic commit", detail: "Result + checkpoint + events", accent: true, position: [5, 2] },
      { id: "end", title: "End turn", position: [6, 1, 2] },
    ],
    edges: [
      { from: "begin", to: "lock" }, { from: "lock", to: "check" },
      { from: "check", to: "replay", label: "Committed" }, { from: "check", to: "checkpoint", label: "New turn" },
      { from: "checkpoint", to: "execute" }, { from: "execute", to: "commit" },
      { from: "commit", to: "end" }, { from: "replay", to: "end" },
    ],
    note: "Replay returns the committed result without running the graph or external effects again.",
  },
} satisfies Record<string, FlowDefinition>;
