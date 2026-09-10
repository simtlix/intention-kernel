# Competitive analysis

## Contextual input delivery

Reviewed on 2026-09-08. The gaps below describe this package's delivery requirements, not verified defects in the compared libraries.

| Reference | Reusable pattern | Requirement for this kernel | Decision |
| --- | --- | --- | --- |
| [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) | Keep resumable input state separate from its host-facing payload | Natural wording must not change the pending input | Add an optional presentation field, not a new routing path |
| [AI SDK loop control](https://ai-sdk.dev/docs/agents/loop-control) | Bound generation and configure each step explicitly | Framing must not add an unbounded generation loop | Reuse existing composition and one repair |
| [Mastra processors](https://mastra.ai/docs/agents/processors) | Validate generated output before delivery | Required copy and protected content retain precedence | Reuse grounding review, exact-question validation and canonical fallback |

Acceptance: existing interactions retain their default behavior; contextual wording preserves the required goal once, leaves input authority unchanged, honors redaction, and falls back after unsupported drafts. The packaged TypeScript contract is checked in an isolated consumer.

## Runtime architecture

Reviewed on 2026-09-03 against the maintainers' documentation.

| Library | What to reuse | Defects or gaps for this use case | How Intention Kernel differs |
| --- | --- | --- | --- |
| [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/persistence) | Explicit graphs, resumable state and interrupts | It is intentionally a low-level graph runtime; it does not define portable intentions, fact lineage, business-policy evaluation or effect receipts | LangGraph remains a private scheduler while the public contract is provider-neutral and capability-first |
| [Mastra](https://mastra.ai/docs/agents/overview) | Composable agents, workflows, memory and observability | Its broad application framework surface couples consumers to Mastra agents, tools, storage and runtime concepts | The package exposes one small kernel facade and injects models, durability, domain ports and events through interfaces |
| [Semantic Kernel](https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/) | Semantic operation descriptions, dependency injection and automatic function calling | Provider function calling can blur the boundary between model proposals and authorized side effects | Models propose intentions only; the planner validates capabilities and policies, and every write crosses confirmation plus a durable effect ledger |
| [XState](https://stately.ai/docs/inspection) | Typed actor inspection, nested behavior and explicit transition events | Finite statecharts require enumerating paths and do not provide semantic intention interpretation or evidence grounding | Dynamic LLM proposals become a validated DAG while events retain step-level causal branches and nested workflow visibility |

Resulting quality requirements:

- LangGraph and provider tool-call types never appear in a supported import path.
- The model cannot mutate state, execute a capability or authorize its own write.
- Multiple intentions are represented explicitly and planned by dependency, not flattened into a single route.
- Facts are versioned, evidence-bearing and invalidated through declared lineage.
- Model, durability, event and domain adapters are instance-scoped and swappable.
- Nested workflow engines remain adapter details and publish progress through one sanitized causal event contract.
- Package verification installs the tarball into a clean consumer before release.
- Expected ambiguity and missing information remain structured interactions, not exceptions or hidden deterministic guesses.
