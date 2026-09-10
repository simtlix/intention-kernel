/** Observable expectations for one user turn in an executable demo. */
export interface DemoTurnExpectation {
  readonly capabilities: readonly string[];
  readonly facts?: readonly string[];
  readonly interaction?: "none" | "confirmation" | "present";
  readonly writeDelta?: number;
  readonly customEvents?: readonly string[];
  readonly replayed?: boolean;
}

/** One natural-language user turn and its contract-level expectations. */
export interface DemoTurn {
  readonly message: string;
  readonly expect: DemoTurnExpectation;
  /** Reuse the prior technical turn identity to prove durable replay. */
  readonly reusePreviousTurnId?: boolean;
}

/** A complete isolated conversation demonstrating one kernel behavior. */
export interface DemoScenario {
  readonly id: string;
  readonly title: string;
  readonly demonstrates: readonly string[];
  readonly turns: readonly DemoTurn[];
}

/** Scenarios executed against the public package and a real model provider. */
export const demoScenarios: readonly DemoScenario[] = [
  {
    id: "simple-conversation",
    title: "Simple conversation",
    demonstrates: ["social turn without fabricated work", "grounded read capability"],
    turns: [
      { message: "Hello!", expect: { capabilities: [], interaction: "none" } },
      {
        message: "How long are audit logs retained according to the verified documentation?",
        expect: { capabilities: ["knowledge.search"], facts: ["knowledge.answer"], interaction: "none" },
      },
    ],
  },
  {
    id: "complex-conversation",
    title: "Multiple objectives in one turn",
    demonstrates: ["multi-intent interpretation", "parallel independent reads", "one grounded response"],
    turns: [{
      message: "Show me the incident-response service packages I can purchase, and also tell me what the verified payment incident checklist recommends.",
      expect: {
        capabilities: ["knowledge.search", "service.search"],
        facts: ["knowledge.answer", "service.candidates"],
        interaction: "none",
      },
    }],
  },
  {
    id: "similar-capabilities",
    title: "Similar capabilities remain distinct",
    demonstrates: ["semantic capability selection", "no route-by-keyword fallback"],
    turns: [
      {
        message: "Search the verified documentation for the payment incident checklist.",
        expect: { capabilities: ["knowledge.search"], facts: ["knowledge.answer"], interaction: "none" },
      },
      {
        message: "Now show me the professional incident-response service packages available to buy, not documentation.",
        expect: { capabilities: ["service.search"], facts: ["service.candidates"], interaction: "none" },
      },
    ],
  },
  {
    id: "controlled-and-free-progress",
    title: "Free information around a controlled write",
    demonstrates: ["durable agenda", "non-disruptive interruption", "confirmation", "idempotent effect"],
    turns: [
      {
        message: "Prepare a support request. Subject: Export authentication failure. Details: CSV exports fail after our identity provider rotation even though interactive login still works.",
        expect: { capabilities: ["request.prepare"], facts: ["request.draft"], interaction: "none" },
      },
      {
        message: "Submit the prepared support request.",
        expect: { capabilities: [], facts: ["request.draft"], interaction: "confirmation", writeDelta: 0 },
      },
      {
        message: "Before I confirm, how long are audit logs retained?",
        expect: {
          capabilities: ["knowledge.search"],
          facts: ["request.draft", "knowledge.answer"],
          interaction: "confirmation",
          writeDelta: 0,
        },
      },
      {
        message: "Yes, submit the request we prepared now.",
        expect: {
          capabilities: ["request.submit"],
          facts: ["request.submitted"],
          interaction: "none",
          writeDelta: 1,
        },
      },
      {
        message: "A changed payload that must not submit a second request.",
        reusePreviousTurnId: true,
        expect: {
          capabilities: [],
          facts: ["request.submitted"],
          interaction: "none",
          writeDelta: 0,
          replayed: true,
        },
      },
    ],
  },
  {
    id: "subgraph",
    title: "Nested workflow behind a capability",
    demonstrates: ["real LangGraph subgraph", "adapter boundary", "nested causal progress events"],
    turns: [{
      message: "Design an implementation rollout plan for a new authentication service, prioritizing continuity and observability.",
      expect: {
        capabilities: ["workflow.design"],
        facts: ["workflow.plan"],
        interaction: "none",
        customEvents: [
          "subgraph.node.started",
          "subgraph.node.completed",
        ],
      },
    }],
  },
  {
    id: "trace-and-events",
    title: "Trace and event projection",
    demonstrates: ["causal event envelope", "model usage", "fact lineage", "sanitized capability output"],
    turns: [{
      message: "What does the verified payment incident checklist say?",
      expect: {
        capabilities: ["knowledge.search"],
        facts: ["knowledge.answer"],
        interaction: "none",
      },
    }],
  },
];
