# Core concepts

The public contract uses a small vocabulary. Each type answers a different architectural question.

| Concept | Question it answers | Owner |
| --- | --- | --- |
| Intention | What does the user want to accomplish now? | Model proposes; kernel validates |
| Capability | Which registered business operation may satisfy that objective? | Host declares; kernel authorizes |
| Fact | What confirmed knowledge is available for later decisions? | Capability produces; kernel stores |
| Policy | Is the proposed operation allowed under host rules? | Host declares; kernel evaluates |
| Interaction | What explicit user input or confirmation is still required? | Kernel owns |
| Port | How does a capability reach external infrastructure? | Host injects |
| Effect | How is an external write coordinated, recorded, and protected against duplicate execution? | Durability coordinates |
| Event | What happened, in which order, and because of which prior action? | Kernel emits |

## Intention

An `IntentionRequest` is a model-proposed objective supported by message-level evidence. It contains an objective, a proposed capability, typed input, references, evidence, resolution, and optional alternatives.

The model may propose no intention for a social turn, one intention for a focused request, or several intentions for a compound message. A proposal is not execution authority.

## Capability

A `CapabilityDefinition` is one registered operation. It combines semantic guidance with an executable contract:

- input and output schemas;
- required, provided, and invalidated facts;
- `none`, `read`, or `write` effect classification;
- confirmation mode, mandatory for writes;
- execution code with access to injected ports.

Capabilities express domain meaning. They are not menus, routes, or provider-specific function declarations.

## Fact

A `FactRecord` is confirmed, versioned conversation knowledge. It retains:

- a branded fact type and version;
- a confirmed value;
- the capability that produced it;
- evidence lineage;
- dependency lineage;
- model visibility and optional redactions.

Facts allow later turns to reference established results without treating raw conversation text as canonical business state.

## Policy

A policy is a pure host-owned constraint evaluated after interpretation and before execution. It can allow, deny, or require explicit handling without embedding business-specific branches in the kernel.

Use policies for authorization and cross-capability constraints. Use capability guidance to teach the model when an operation semantically applies.

## Contextual model guidance

A `ModelGuidancePolicyDefinition` lets the host select semantic instructions from the canonical turn state before capability routing. Its pure `select()` function can inspect active and registered capability IDs, confirmed facts, the agenda, the current interaction, and progression state. Only selected policy copy is sent to the model, and the same projection is used by both capability selection and detailed interpretation.

Contextual model guidance is not an authorization mechanism and cannot execute an operation. Planner policies and capability contracts remain the execution boundary. Runtime events expose the selected policy ID, version, and matched selectors so a host can explain why the guidance was present for a turn.

## Interaction

An interaction represents a server-owned boundary that the user must resolve. Its kind may request free input, a bounded choice, clarification, or confirmation.

The kernel keeps an interaction durable while unrelated safe work proceeds. A later message may answer it explicitly, ask an unrelated question, or introduce a new objective; interpretation decides which occurred.

## Port and tool

A port is an application-facing interface injected into capability execution, such as a catalog client, database gateway, or nested workflow runner.

A provider tool is an adapter representation used by a model SDK. It is not a kernel primitive and has no authority to execute a capability. This distinction prevents one model provider's function-calling format from becoming the application architecture.

## Relationship

<DocFlow name="relationship" />

The [execution architecture](../architecture/index.md) shows where each contract enters the turn.
