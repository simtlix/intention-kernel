# Runtime invariants

These constraints are part of the compatibility contract. An adapter may implement storage or model calls differently, but it may not weaken them.

## Authority boundaries

- A model proposes `IntentionRequest` values. It never invokes capabilities or changes a checkpoint.
- The compiler is the authority over registered capability IDs, schemas and fact dependencies.
- The planner is the authority over execution, dependency order, policy outcomes and user interactions.
- The reducer is the only stage that publishes or invalidates facts and changes the agenda.
- The composer receives a port-free `ResponseBrief`; it cannot call infrastructure.

## Conversation and context

- Every model task receives one immutable canonical context projection.
- Recent messages carry their exact checkpoint index. Truncation is explicit in `omissions` and can be paired with a host summary.
- Confirmed facts carry their evidence inline so grounding survives process restarts and later turns.
- Ambiguous references produce a clarification. They are never resolved by a hidden keyword fallback.
- Purely social or acknowledgement-only turns may contain no operation; the model is not forced to fabricate an unsupported intention.
- A model restatement of the exact operation carried by an accepted confirmation is merged with that resumed operation; it cannot become a duplicate write.
- A temporary interruption or additional question does not accept or decline a pending confirmation.
- Progression-member answers require current-message choice evidence. Omitting a member answer cannot authorize its operation from historical input; semantic rejection preserves the active group, agenda and independently requested work.
- Answering a choice or confirmation does not independently request its parent or downstream operation. Semantic repair of unsupported additional operations preserves the already-supported interaction ID and answer value.
- Every admitted, resolved operation's input is checked against its runtime schema before planning. Invalid input uses the single bounded interpretation repair, including initial requests and free-text continuations; it never fabricates business values or substitutes an interaction answer for operation input. Schema-valid null values and unresolved requests remain valid cases, and planner validation remains the final guard.
- Written numbers undergo semantic choice review; only a validated structured selection bypasses it. A number competing as both a current position and a different literal option value does not authorize either choice without disambiguating wording.
- Review cannot invent a competing reference from a privacy placeholder. Historical answers to other questions do not override a unique reference to the current choice.
- Ordinary-choice review identifies an exact current option or distinct competing current options. Only a selected ID matching the proposed server-owned option is accepted; the rationale is not execution authority. Option identity is bound before privacy projection, and redacted value equality never creates a binding.
- Optional `InteractionOption.referenceExamples` are bounded exact-reference hints, not authority. When the trimmed current text exactly matches one option's registered example and a different option's one-based position, the kernel rejects both inferred selections and preserves the choice for clarification. It does not parse labels, units, business values or opaque host payloads. Non-conflicting examples still require semantic review; exact structured clicks remain authoritative.

## Capabilities and facts

- Capability inputs and completed outputs are validated at runtime.
- A required fact is identified by `type@version`; a different version does not satisfy it.
- Only a completed capability result may publish facts.
- Replacing a fact invalidates only declared descendants and only after its provider succeeds.
- Independent reads may run concurrently. Dependent work observes facts produced earlier in the same turn.
- A requirement with `resolution: "runtime"` creates a dependency edge when its provider shares the turn. Otherwise the capability decides whether to request it through `needs_dependency`.
- When a same-turn provider awaits input, confirmation or another declared fact, its consumer retains the versioned requirements in `waiting_facts`. The skipped execution records `DEPENDENCY_PENDING`; a later completed provider resumes the consumer. Failed, cancelled or missing providers do not become resumable waits.
- An exact ordinary-choice answer whose owner has not yet executed is retained with its server-owned interaction while that same intention waits for facts. It is delivered only to that owner on resumption, never to its provider or a fresh request. A newer owner interaction supersedes it, cancellation removes it, and invocation consumes it; confirmations and progression controls do not use this retention path.
- Accepted progression decisions are persisted before dependency activation. Completing a dependency cannot reopen the progression interaction that the user already left.
- A displaced required read/input interaction may be suspended only under its unique active progression owner, bound to the occurrence and all declared prerequisite publications (including absent runtime requirements). Fresh higher-priority reads may complete first; restoration reuses the server-owned control without invocation or an inferred answer. Cancellation, explicit dismissal, stale prerequisites and retired owners invalidate it. Write confirmations, protected delivery and completed follow-ups are excluded.
- A fresh higher-priority required read may also suspend an existing read question owned transitively by one active required occurrence. Every ancestor edge must be kernel-owned, the path must remain unique and unchanged, and no ancestor may have a prepared or uncertain effect. Suspension preserves the agenda, private continuation and redactions; it never transfers write consent or consumes the question's answer.
- Required read completion records retain private identities of the facts actually published by their completing execution. Only reducer-confirmed retirement of that exact publication, still required by a pending active consumer, can reopen the occurrence. Declared-but-absent or unrelated optional outputs, declined or ambiguous occurrences, and write completions do not authorize repair. Repair may preempt a stored question only on a fresh changed parent publication; cancelling its consumer retires repair. Legacy checkpoints without completion lineage remain conservative rather than reconstructing automatic authority from absence. This internal lineage is omitted from model and response-brief projections.

## Writes and durability

- A write capability declares kernel-owned (`required`) or capability-owned (`capability`) confirmation. Capability-owned confirmation must validate consent before the mutation.
- Every completed write must execute through `runEffect`.
- Each effect has a stable logical-operation key prefixed by capability and deduplicated across turns within the ledger's thread scope, with durable `prepared`, `completed`, `failed` or `uncertain` status.
- An uncertain effect is never retried automatically. Only a host-certified `EffectNotAppliedError` is retryable.
- A non-retryable progression failure retains its active member and blocked agenda instead of becoming a pending automatic activation. It is neither satisfied nor declined; the same fact-publication occurrence cannot regenerate a confirmation by itself.
- Mixed ordinary-choice shortlists do not authorize execution. Actual additional intentions undergo independence review after interpretation, also without an option answer or with lifecycle actions. A rejected extra permits one bounded repair; malformed reviews do not authorize abstention or inferred consent.
- A durability adapter serializes work per thread, deduplicates `turnId`, checks checkpoint revision and atomically stores the turn result, checkpoint and event outbox.
- Replaying a committed `turnId` returns the prior result and invokes neither models nor capabilities.

## Responses and observability

- The model composes ordered response parts. The kernel derives every factual claim from the exact cited part, so claim text cannot drift from the published message.
- Every factual business claim cites evidence whose meaning supports that exact message span. Each composed response receives one semantic grounding review; an unsupported response receives at most one recomposition.
- The response decision is projected from the final interpreted batch and plan. Preliminary selections rejected during repair are not accepted-decision evidence; an interpreted request is not evidence that an operation completed.
- Grounding audits the entire response, including uncited parts. An empty claim list does not authorize factual outcomes or commitments, and a review containing unsupported claims cannot approve the response.
- After two rejected model drafts, the kernel may use one capability-owned `canonicalResponse` only when its exact claims cite evidence returned by that capability. Without that validated fallback, grounding failure remains a typed technical failure.
- Explicitly required canonical results must be delivered once with their evidence in the current turn. When authored copy covers every completed operation, can be joined without repeating required results, and no separate issue or lifecycle decision remains, the kernel directly delivers all completed copy plus the real required interaction. Historical facts never create delivery requirements.
- A pure pending required interaction with no completed result, issue or separate control/unsupported decision delivers its exact server-owned goal without composition or review. Invalid canonical delivery fails closed; the delivered message is also the committed checkpoint message.
- Mixed work without copy for every completed result retains natural composition and cannot fall back to an incomplete required answer. Model-composed turns still require semantic review; the direct-delivery invariant does not replace that review globally.
- When required results coexist with a required interaction, composed or canonical responses include the exact pending goal once, after those results. Optional or absent interactions do not create a mandatory invitation. If model redaction changes required delivery text or its required goal, the kernel uses the verified original delivery projection without exposing that text to the model.
- Events are ordered per turn and carry correlation plus causation identifiers.
- Events emitted by parallel capabilities retain independent causal branches.
- Nested workflows publish through the capability event channel and cannot mutate parent state.
- Event data is redacted before emission and strips private chain-of-thought fields.
- Traces contain structured rationale and evidence, not hidden model reasoning.
- `model.invoked` records the supplied context, visible capabilities, instruction digest and repair issues. `model.completed` records the unvalidated proposal. Accepted interpretations and executable plans remain separate events.
- A model justification explains its proposal; it does not prove that the decision or resulting execution was correct.
