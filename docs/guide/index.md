---
description: Learn how Intention Kernel combines natural-language understanding with explicit execution authority, durable state, and evidence-backed responses.
---

# Intention Kernel

Intention Kernel is a TypeScript runtime for agents that must combine natural-language understanding with explicit execution authority, durable state, and evidence-backed responses.

It separates two responsibilities:

- The model interprets the conversation, proposes objectives, resolves references, and writes natural responses.
- The kernel validates those proposals, authorizes capabilities, coordinates effects, reduces facts, and commits the turn.

This boundary allows the model to remain flexible without granting it direct access to infrastructure or business mutations.

## Execution contract

<KernelFlow />

Every turn follows the same contract. A greeting may produce no intention. A compound request may produce several intentions. A write may pause for confirmation. The runtime changes its plan, not its architecture.

## What the runtime guarantees

| Guarantee | Enforcement |
| --- | --- |
| Explicit authority | Only registered capabilities can execute. |
| Validated inputs | Capability input and output cross runtime schemas. |
| Durable replay | A committed `turnId` returns its prior result. |
| Idempotent writes | External mutations run through durable effect receipts. |
| Evidence lineage | Facts retain the evidence that produced them. |
| Grounded responses | Published business claims cite available evidence. |
| Observable causality | Events carry sequence, correlation, causation, turn, and optional step identity. |
| Provider neutrality | Models and infrastructure are host-provided adapters. |

## Use Intention Kernel when

- one message may request multiple operations;
- business actions have prerequisites or confirmation requirements;
- users may interrupt and later resume controlled work;
- external writes must not execute twice after a timeout or retry;
- model output must be traceable to facts and evidence;
- model providers or workflow engines must remain replaceable.

The runtime is not a prompt collection, chatbot UI, vector database, or domain framework. A host application supplies those concerns through capabilities, ports, policies, model gateways, and durability.

## Learning path

1. [Install the package and run a first agent](./getting-started.md).
2. Learn the [core contracts](./core-concepts.md).
3. Define domain behavior as [capabilities](./capabilities.md).
4. Add production [durability and effect coordination](./durability.md).
5. Inspect the [complete execution architecture](../architecture/index.md).
6. Write [declarative evaluation scenarios](./evaluation.md) and use their reports to improve the agent.

## Validate behavior with scenarios

The evaluation framework lets you describe a use case as ordered conversation steps and multiple acceptance criteria. It supports input variants, repeated cases, logical assertion groups, custom business evaluators, and structured evidence for coding-agent iteration.

Start by [evaluating from your project](./evaluation/quick-start.md), then learn [scenario syntax](./evaluation/scenarios.md), [assertion logic](./evaluation/assertions.md), and [failure diagnosis](./evaluation/reports.md).
