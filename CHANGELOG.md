# Changelog

All notable changes are documented here. The project follows Semantic Versioning after `1.0.0`; during `0.x`, a minor release may change the public API.

## 0.8.3 - 2026-09-10

- Restrict resolved interpretation capabilities to the exact selected executable contracts in both the generated JSON Schema and runtime validation. Initial and repair requests cannot substitute guidance policy IDs or unrelated agent capabilities. Preserve ambiguous, unsupported and conversational turn boundaries when no operation is selected.

## 0.8.2 - 2026-09-10

- Bind the visible position, label and opaque ID of a reviewed choice in one schema branch. A model cannot combine the label of one option with another option's ID. Publish the matching choice-review prompt revision for pinned hosts.
- Make omitted-choice review generation reject contradictory verdict/option pairs and unpublished option IDs, matching runtime validation.
- Apply selected interpretation mode to generation and validation: conversational turns cannot manufacture unsupported intentions, and non-control modes cannot generate lifecycle cancellations. Existing active-answer ownership and consent reviews remain in force.

## 0.8.1 - 2026-09-10

- Encode resolution-specific intention requirements in the generated JSON Schema as well as runtime validation: resolved intentions require a capability, ambiguous intentions require alternatives, and unresolved intentions cannot propose operations. Initial and repair requests share the same contract.
- Bind unique free-text choice reviews to the exact current option and preserve that binding through interpretation and repair. Reject stale interaction, page and message bindings; keep independent-operation reviews.
- Include the reviewed choice in capability-selection trace events. The internal choice-review response now requires a current optionId; hosts with pinned prompts should publish the matching choice-review prompt revision.

## 0.8.0

- Expose versioned model prompt definitions through `getKernelPromptDefinitions`, exact interpolation through `renderModelPrompt`, and pinned host revisions through `ModelPromptResolver`. Model requests carry their prompt contract and execution values.
- Add public documentation on GitHub Pages, contribution and security guidance, and verified GitHub release artifacts.
- Document both public entry points and validate the actual README examples and complete testing API against the installed package. Include matching TypeScript sources for debugger and editor navigation while keeping repository development files out of the release artifact.
- Correct guides and API comments to match the existing effect value/receipt contract, idempotency across turns, capability-owned confirmation, and dependency results.
- Honor `null` and `undefined` returned by a host event redactor instead of restoring the original payload. Model audit documentation now describes effective instruction capture and host redaction explicitly.
- License the project under Apache-2.0.

## 0.7.0 - 2026-09-08

- Add optional `Interaction.responseMode: "contextual"` for reviewed conversational framing around a server-owned question. Omitting it preserves canonical delivery. Required questions must occur exactly once; options, requested facts, progression and effect authority do not change.
- Reuse bounded composition, grounding review and canonical fallback. Protected delivery and redacted required questions take precedence without model disclosure. Invalid response modes are rejected at interaction boundaries.
- This minor version adds a backward-compatible public field; it does not enable contextual composition for existing consumers automatically.

## 0.6.27 - 2026-09-07

- Preserve the non-blocking mode of unfinished optional input in durable agenda lineage. After another user request replaces that control, required progression can continue without completing or discarding the optional operation. Required input, confirmations and protected controls remain blocking; legacy state without this lineage stays conservative.

## 0.6.26 - 2026-09-07

- Suspend required read input under its unique transitive progression owner when a fresh, higher-priority read must run. Restore the same control and agenda continuation without repeating the input capability; ambiguous ownership, cancellation, stale prerequisites and write/confirmation boundaries remain protected.
- Revalidate a satisfied required read only when its actual completion publication is retired and an active required consumer still needs that fact. Refresh priority from changed parent publications, retire abandoned repairs, and never reconstruct completion authority from a missing declared output or an older checkpoint without recorded lineage.
- Keep completion lineage private to durable kernel state. Public model/context projections omit it; writes, uncertain effects and declined work cannot be replayed by this repair path.

## 0.6.25 - 2026-09-07

- Deduplicate wholly contained canonical answers while retaining every citation; keep normal composition for unprotected turns when distinct overlapping answers cannot preserve required copy exactly once. Protected or redacted delivery never exposes original copy to resolve these collisions and remains fail-closed.

- Deliver required current-turn results directly when capability-authored copy represents all completed work. Retain other completed canonical answers and the real required interaction, without invoking composition or review to add an outcome or an undeclared next question.
- Deliver a pending required interaction directly when there is no completed work, issue or separate lifecycle decision to explain. Validate the original question and citations before persisting that exact response; invalid canonical delivery fails closed.
- Preserve natural composition for ordinary informational results, optional controls, lifecycle decisions, issues and mixed completed work lacking canonical copy. Mixed required work cannot use a fallback that discards an unrepresented completed answer. This is a bounded delivery invariant, not a universal semantic guarantee for model-composed turns.

## 0.6.24 - 2026-09-07

- Retain a displaced required read/input interaction under its unique pending progression owner. Restore the same server-owned control after a higher-priority read chain completes, without invoking its capability again or inventing an answer.
- Keep current-turn publication authority across intermediate dependency steps, separate from result settlement. Read dependencies may suspend the prior input before the provider produces its own control.
- Bind suspended controls to their occurrence and declared prerequisite publications. Cancellation, dismissal, completed ownership and changed prerequisites prevent stale restoration. Write confirmations and protected result delivery never use this suspension path.

## 0.6.23 - 2026-09-06

- Reuse deeply immutable evaluation evidence when checking completed cases and whole suites, avoiding aggregate copies of observations and checkpoints at batch closure.
- Isolate mutable external evaluator inputs and prevent custom evaluators from replacing shared context fields or changing evidence used by later assertions.

## 0.6.22 - 2026-09-06

- Do not start additional automatic progression once the configured objective is completed. Explicit requests remain available and retain their normal prerequisite and effect checks.
- Persist the distinction between a completed operation's follow-up and unfinished input. A hidden follow-up no longer blocks automatic progression; unanswered operations and visible required controls still do.

## 0.6.21 - 2026-09-06

- Keep automatic progression pending while an unanswered agenda operation remains after its displayed control was dismissed. Explicit requests and ready dependencies remain available; answering the pending operation releases progression. Visible optional controls retain their non-blocking behavior.
- Distinguish short answers to a single yes/no question from acknowledgements over a menu of independent alternatives. Ambiguous acknowledgements do not authorize an option or a historical operation.
- Do not invent numeric value/position conflicts from digits embedded in compound labels. Genuine selectable numeric values and shared attribute references retain their ambiguity checks.

## 0.6.20 - 2026-09-06

- Correct stale runtime and testing version identifiers. Both now report the same package version, checked against the installed tarball before packaging succeeds. Execution behavior is unchanged.

## 0.6.19 - 2026-09-06

- A completed capability can return `interaction: null` to dismiss an obsolete previous control without cancelling pending work, discarding facts, or granting confirmation. Omission continues to preserve unrelated interactions. New interactions from other steps in the same turn take precedence.

## 0.6.18 - 2026-09-06

- Include a runtime-validated clicked control in the turn-local model context and its audit projection, so companion text can refer to the chosen option without restating its label. Free text is not promoted to trusted selection, and clicks do not authorize independent operations or bypass write confirmation.
- Reject invalid clicked options before model invocation. The submitted control is not persisted as a fact or reused by subsequent turns.

## 0.6.17 - 2026-09-06

- Constrain generated choice answers to the current interaction and public option identifiers. Exact structured values from existing gateways still pass through canonical binding and semantic review; generation no longer asks models to reconstruct host values.
- Preserve reported contradictions in an otherwise valid, bounded abstention after a semantic choice rejection. The pending choice remains intact; this does not authorize execution, cancellation or dropping independent requests.
- Distinguish a reviewed selection of another current option from rejection. Bounded repair receives the exact reviewed identifier and must repair its binding; it cannot silently discard the selection as an empty abstention.
- Keep capability continuations explicitly defined by selected host guidance alongside lifecycle cancellation. A control-only selection must not erase such a continuation; execution prerequisites and effect authority remain unchanged.

## 0.6.16 - 2026-09-06

- Do not turn an input-only continuation into an independently requested optional fact provider. Explicit same-turn provider requests retain their ordering edges; mandatory prerequisites remain blocking.
- Retire an interaction produced by a dependent collector when the same turn completes its parent through another path. The checkpoint cannot keep a question after its owning agenda item has been retired.

## 0.6.15 - 2026-09-06

- Bind operation requests in ordinary-choice capability review to explicit registered capability identifiers. A mismatch with the proposed shortlist requires its existing bounded repair; review text cannot authorize another capability or select an item implicitly.
- Resume an ordinary free-text input answer from its unique resolved, same-owner waiting-input operation, without requiring the model to reconstruct durable parameters. Preserve private continuation and independent requests; stale answers, ambiguous owners and other pending statuses cannot lend this authority. Invalid duplicate inputs still require the existing bounded repair.
- Clarify that an explicit companion request blocked on an unanswered choice remains an intention; dependency order is enforced by planning, not by discarding the user's requested operation in semantic review.

## 0.6.14 - 2026-09-06

- Clarify empty-interpretation repair feedback during a pending confirmation: a supported acceptance or rejection resumes the existing operation without requiring a duplicate intention. Validation and the single-repair limit remain unchanged.
- Apply existing privacy redactions to proposed intentions and answers in confirmation-independence and omitted-choice reviews, without mutating server-owned option bindings or original interpretations.

## 0.6.13 - 2026-09-06

- Review additional operations in a mixed ordinary-choice request after their inputs are interpreted, instead of rejecting related requests from an incomplete capability shortlist. The final boundary also covers unanswered choices, omitted owners and lifecycle actions; only explicit unsupported extras allow bounded abstention.
- Keep non-retryable progression failures bound to their blocked member. The same occurrence cannot automatically regenerate a confirmation after an uncertain effect, including after checkpoint restoration. New explicit requests and new activating fact publications remain separately evaluated.

## 0.6.12 - 2026-09-06

- Classify ordinary-choice answers as an exact current option, ambiguity between distinct current options, or no selection. Only the exact proposed option can be accepted; the existing bounded repair handles rejection without adding model calls.
- Bind server-owned option identity before privacy projection. Redacted values cannot erase or manufacture a binding, and proposed answers and intentions are privacy-filtered in this review.

## 0.6.11 - 2026-09-06

- Validate the input contract of every admitted, resolved operation before planning, including initial requests and free-text continuations. Invalid model input uses the existing single interpretation repair; unresolved requests are not forced into execution.
- Preserve schema-valid null inputs, independent operations, interaction ownership and consent checks. Repair does not copy an answer into operation input or invent missing values; the planner retains its final validation boundary.

## 0.6.10 - 2026-09-06

- Project response decisions from the final interpreted batch and executable plan, not a preliminary capability selection that repair may have rejected. Interpreted requests remain distinct from completed operations.
- Audit uncited response text for unsupported outcomes and commitments. An empty claim list does not exempt factual statements from grounding; contradictory review results cannot approve a draft.
- Keep numeric choice review bound to the current question and displayed options. A privacy placeholder does not imply a hidden competing reference, and an answer to an earlier question does not override a unique current selection.

## 0.6.9 - 2026-09-06

- Resolve supported ordinary-choice answers to their exact capability owner after bounded interpretation repair, without lending the answer to another requested operation.
- Retain an unconsumed server-owned choice while its operation awaits a dependency. Resume only its original intention, consume the binding on invocation, and honor replacement choices and cancellation.
- Review written numeric choices semantically against current option values and positions. Only a validated structured click bypasses this review; ambiguous numeric text requires clarification.
- Add optional, bounded `InteractionOption.referenceExamples`. An exact reference that conflicts with a different current option's position cannot authorize either selection; hints are persisted and privacy-filtered, not execution authority.
- Review progression-member selections and operations independently. Acknowledging a delivered result does not authorize repeating its operation from history; rejecting a member preserves the active group and unrelated current requests.
- Classify omitted progression answers explicitly as requested, not requested or ambiguous. Only requested continuation backed by current-message evidence triggers repair; ambiguity preserves the pending choice.
- Require a pending mandatory invitation once after required current-turn results. Preserve the original verified delivery projection when model redaction changes that invitation.

## 0.6.8 - 2026-09-06

- Review independent operation consent even when host guidance authorizes a progression exit. A continuation cannot infer its downstream operation.
- Detect semantically supported omitted ordinary-choice answers, preserving independent same-capability requests and server-owned navigation controls.
- Validate the input contract of an operation accompanying its exact current choice before planning; malformed model input uses bounded repair without fabricating missing business data.
- Review additional operations alongside ordinary choices and confirmations. Preserve the supported answer during repair and reject inferred parent work or duplicate confirmation requests without deduplicating genuinely independent operations.

## 0.6.7 - 2026-09-06

- Reuse a progression-exit rejection only after an actual semantic review. Overlapping evidence alone cannot bypass review of a continuation removed during repair.

## 0.6.6 - 2026-09-06

- Review offered navigation controls as actions, separately from item selection. Resolve the proposed option only against the current server-owned choice and retain that choice and option in the model audit.
- Review omitted progression answers when a request outside the active group may have been inferred from a continuation. Preserve independent operations and require bounded repair for a pure continuation instead of guessing its downstream capability.

## 0.6.5 - 2026-09-06

- Preserve a semantically validated progression exit when a model also infers its downstream operation from the same evidence; repair removes the inferred operation without discarding the valid exit.
- Recover implicit choice answers only from resolved intentions. Ambiguous or unsupported references cannot reinstate a choice removed during repair.
- Persist accepted progression decisions before activating dependencies, then resume the next eligible progression rule after those dependencies finish.
- Retain versioned fact requirements for same-turn consumers whose providers need more input. `DEPENDENCY_PENDING` resumes across turns; failed or cancelled providers remain blocked.

## 0.6.4 - 2026-09-06

- Track same-turn choice providers owned by an answered dependency request; completing the parent retires orphaned choices while independent, shared and protected interactions remain intact.
- Require separate evidence for a requested operation and progression exit. Information requests prefixed by agreement do not implicitly leave their active group.
- Review additional capability requests alongside an active choice without discarding the supported choice answer or admitting unrelated work.
- Give choice review explicit current-option positions. Permit bounded abstention after a rejected semantic choice without accepting an initially empty selection or discarding independent requests.

## 0.6.3 - 2026-09-06

- Keep trusted public interactions and artifacts separate from redacted model inputs, including protected and fallback responses.
- Validate independently requested operations alongside progression continuation; a natural-language continuation cannot skip directly to a guessed downstream capability.
- Review ordinary choice commitments against the complete user message, preserving independent requests without inferring an unrelated acceptance.
- Resume consumers of newly delivered dependency facts before older ready work and discard only obsolete, exclusively owned dependency descendants.

## 0.6.2 - 2026-09-06

- Classify choice review as a unique option, an operational request, or ambiguity. Search refinements no longer depend on a binary verdict that conflates an unselected item with an unsupported operation.

## 0.6.1 - 2026-09-06

- Limit lifecycle-selection review to cancellation semantics. Server-owned progression continuation answers are not lifecycle cancellation, and interaction contract availability does not represent selected operations.
- Supply selected contracts to choice review so supported search refinements do not require choosing one existing item. Ambiguous item selection remains guarded.

## 0.6.0 - 2026-09-06

- Add opt-in `canonicalResponse.required` for evidence-cited results that must reach the user in the current turn. Composition validates exact delivery and citations independently of model approval.
- Preserve required results before subsequent interactions, including protected confirmations and multi-operation fallback. Historical facts do not replay delivery requirements.

## 0.5.1 - 2026-09-06

- Objective cancellation now clears the previous agenda without discarding independent intentions admitted in the same turn. Their pending input, confirmation and fact dependencies remain resumable across messages.
- Confirmation answers can resume the existing operation without emitting a duplicate intention. Recover an incorrectly reconstructed choice container ID only from an exact current server-owned option.
- Clarify final-operation selection and independent interruptions: missing prerequisites do not turn a requested operation into a collector or lock the conversation to its current question.

## 0.5.0 - 2026-09-05

- Add a reusable evaluation framework under `intention-kernel/testing`: portable suites, declarative and registered assertions, variants, repetitions, isolated parallel cases and accumulated failure limits.
- Persist incremental reports with stable turn identities, cancellation, compatible checkpoint resume, explicit retry and external-effect reconciliation boundaries.
- Add direct compiled-agent evaluation, suite-level invariants, generated testing API documentation and clean installed-package verification. Run the existing Gemini demos through the shared executor.

## 0.4.56 - 2026-09-05

- Deliver capability-owned protected confirmations from validated checkpoint state, separately from the redacted model brief. Preserve the original response across durable replay without sending its protected text to the response model.

## 0.4.55 - 2026-09-04

- Preserve an active interaction answer alongside an independently selected operation without requiring another capability outside the selected contract set. The owner requirement remains enforced for conversational-only answers.

## 0.4.54 - 2026-09-04

- Align interpretation instructions for ambiguous replies with the conversational boundary: preserve the pending choice instead of inventing an operational intention that the same contract rejects.

## 0.4.53 - 2026-09-04

- Choice normalization distinguishes option references from other context references and compares structured values without depending on property order.
- Invalid interaction answers enter the bounded contract repair path instead of being silently discarded.
- Active interaction owner contracts remain available for answer interpretation when the selector finds no independent operation. A capability-owned answer must include its processing intention; availability alone never executes it.

## 0.4.52 - 2026-09-04

- Interpret answers to active interactions even when no new capability is selected. Empty selections cannot invent capability intentions, and continuation answers still require evidence validation.
- Clarify that selecting a progression continuation does not authorize predicting or directly requesting a downstream capability.
- Satisfy pending capability progression when the same target completes through an explicit request or dependency resumption, preventing duplicate activation. Automatic activation events include the actual plan and trigger.

## 0.4.51 - 2026-09-04

- Selection events distinguish model justifications from kernel boundary fallbacks and confirmation-owner adjustments without rewriting the model's explanation.
- Capability-selection repair clarifies that an unanswered interaction is not itself a new operation. Choice-review instructions align the verdict with its explanation.
- Review observations include the proposed selection and intentions under review.

## 0.4.50 - 2026-09-04

- Runtime-resolved fact requirements order same-turn providers before consumers while preserving conditional dependency activation.
- Intention and interaction-answer proposals can carry concise evidence-based justifications. Model events preserve proposals, request context, repair issues and their causal links through the configured redactor.
- Progression answers receive an evidence review when no selected host policy defines their continuation. Explicit requests for both information and progression remain supported.

## 0.4.49 - 2026-09-04

- Added a narrow semantic review for boolean confirmation answers so unrelated values cannot silently approve or reject pending work.
- Unsupported confirmation answers enter the existing bounded repair path and leave the confirmation pending.

## 0.4.48 - 2026-09-04

- Choice normalization now accepts either a server-owned option ID or the exact structured option value, preventing valid progression answers from being discarded.

## 0.4.47 - 2026-09-04

- Added declarative model-guidance invariants for capability requests that must also continue an active progression interaction.
- Invalid interpretations now receive the exact server-owned interaction and option identifiers through the existing bounded repair path.
- Compilation rejects continuation guidance that references unregistered capabilities.

## 0.4.46 - 2026-09-04

- Made host-guided progression transitions explicit in turn interpretation: a direct capability request may select the active group continue option only when a selected semantic policy defines that transition, while preserving the requested operation in the same turn.

## 0.4.45 - 2026-09-04

- Added an explicit, server-owned target capability to interaction options so an option can be consumed by a capability other than the one that presented it.
- The planner now routes an interaction answer through that declared target even when the same message requests another capability, without interpreting opaque option values as routing authority.

## 0.4.41 - 2026-09-04

- Require an explicit server-owned option reference before applying a model-proposed choice; selecting a capability alone no longer fabricates an interaction answer.

## 0.4.40 - 2026-09-04

- Review free-text selections even when several active options share the same target capability, preventing a common label fragment from silently choosing the first value.

## 0.4.39 - 2026-09-04

- Added a conditional semantic review when capability routing would leave an active interaction, preserving legitimate interruptions while repairing contextual misroutes before planning.

## 0.4.38 - 2026-09-04

- Delegated conversational replay judgment to the semantic grounding reviewer so repeated clarifications remain valid when consecutive standalone values are still unbound.

## 0.4.37 - 2026-09-04

- Rejected an empty detailed interpretation after capability selection authorized an operation, preventing an apparently helpful response from advancing without executing or persisting the selected capability.

## 0.4.36 - 2026-09-04

- Kept semantic-decision rationale private and rejected conversational drafts that cite or expose their internal classification instead of answering the user.

## 0.4.35 - 2026-09-04

- Rejected exact replay of an earlier assistant message when a new conversational turn has no active work, preventing completed lifecycle responses from trapping later conversation.

## 0.4.34 - 2026-09-04

- Published one exact evidence record for the validated current-turn decision so lifecycle and semantic-decision statements remain grounded without invented citations.
- Added an independent response-decision verdict to grounding review, preventing a response from passing merely because its facts and conversational continuity are valid while it answers the wrong request.

## 0.4.33 - 2026-09-04

- Added the validated current-turn semantic decision to the response brief so composition and review cannot replace it with an earlier request.

## 0.4.32 - 2026-09-04

- Prevented completed lifecycle acknowledgements from being replayed on later conversational turns.
- Required grounding review to reject responses that answer an earlier cancellation, completion or pause instead of the current message.

## 0.4.31 - 2026-09-04

- Projected the same host-selected semantic guidance into response composition and grounding review, closing the final context discontinuity between model stages.
- Required conversational turns without current work to answer the current message without replaying unrelated historical facts.

## 0.4.30 - 2026-09-04

- Resolved an active server-owned choice from its unique capability target when the model selects that capability but omits the redundant interaction-answer field.

## 0.4.29 - 2026-09-04

- Added host-owned contextual model-guidance policies selected from canonical turn state before capability routing.
- Projected the same selected guidance into capability selection and detailed interpretation, and exposed its identity and matched selectors through runtime trace events.
- Included static guidance policy declarations in compilation validation and immutable agent fingerprints without granting execution authority.
- Applied selected contextual guidance during lifecycle safety review so rejecting current values, candidates, or results cannot be misread as abandoning tracked work.

## 0.4.28 - 2026-09-04

- Added optional localized fallbacks for unsupported intentions after bounded model composition and grounding rejection.
- Included response fallback configuration in immutable agent fingerprints.

## 0.4.27 - 2026-09-04

- Returned completed external-effect values together with their durable receipts and passed one stable kernel-owned idempotency authority to provider adapters.
- Scoped effect identities across turns so replaying the same logical write cannot dispatch a second provider mutation.
- Required response composition to clarify generic acknowledgements while a multi-option interaction remains unresolved.

## 0.4.22 - 2026-09-04

- Rejected model-proposed choice answers that do not resolve to one exact server-owned option, preventing free-text refinements from being misread as pagination or another visible action.

## 0.4.21 - 2026-09-04

- Reviewed both false-positive and false-negative lifecycle routing at active progression choices so explicit objective rejection cannot be mistaken for ordinary capability input.

## 0.4.20 - 2026-09-04

- Projected the current progression status into response composition and review, and required unbound values to be clarified without greeting again or silently resuming cancelled work.

## 0.4.19 - 2026-09-04

- Added a semantic boundary review for capability selections made after an objective was cancelled, preventing standalone values from silently resuming cancelled work while still allowing explicit new requests.

## 0.4.18 - 2026-09-04

- Completed an active choice answer from one exact server-owned option reference when the model omitted the redundant interaction-answer field, keeping capability execution and progression state atomic.

## 0.4.17 - 2026-09-04

- Rejected an isolated numeric value as capability routing when no active interaction or pending work can give it meaning, with a safe conversational result after bounded model repair.

## 0.4.16 - 2026-09-04

- Made conversational continuity an explicit grounding-review verdict so mid-conversation greetings, agent reintroductions and invented interactions trigger bounded recomposition instead of being silently approved as non-factual prose.

## 0.4.15 - 2026-09-04

- Prevented unprompted values that merely resemble capability input from starting operations without an active interaction, pending agenda item or explicit user request.

## 0.4.14 - 2026-09-04

- Included the audited capability-selection decision in both interpretation requests so detailed interpretation can honor lifecycle-control authorization and selected capability boundaries without relying on invisible prior-stage state.

## 0.4.13 - 2026-09-04

- Treated an exact numeric answer to an active choice as the authoritative one-based server option, preventing a model from selecting a neighboring option with a similar label.

## 0.4.12 - 2026-09-04

- Recovered complete server-owned choice values when a model returns either an option object or the exact option identifier, preventing the parent operation from being replayed alongside its selected child.

## 0.4.11 - 2026-09-04

- Required response composition and review to preserve conversational continuity instead of greeting again, reintroducing the agent or asking to show structured results that were already returned.

## 0.4.10 - 2026-09-04

- Distinguished an explicit rejection of the configured objective from a conversational acknowledgement or rejection of a current option, including when it is expressed from an optional progression menu.

## 0.4.9 - 2026-09-04

- Distinguished lifecycle cancellation from replacing a choice, refining a request or restarting a capability operation.
- Added an explicit combined selection mode for turns that both cancel tracked work and request a capability operation.
- Rejected lifecycle actions unless the semantic selection stage explicitly authorized lifecycle control.
- Treated combined lifecycle selection as a permissive shortlist so detailed interpretation can retain a valid capability operation without inventing a cancellation.
- Deduplicated a confirmation restatement from its durable pending operation even when the model rephrases the capability input, while retaining independently evidenced same-capability objectives.
- Preserved a valid turn through a verified capability or interaction fallback when structured response composition or review is unavailable.
- Completed an omitted resolved capability identifier only when the preceding semantic shortlist authorized exactly one contract.
- Reviewed lifecycle-control routing before reducing visible capability contracts, allowing false control classifications to be repaired as ordinary operations.
- Added a model-based safety review for destructive lifecycle cancellations, invoked only when such an action is proposed.
- Preserved interactions produced by a new capability when the same turn explicitly cancels the previous configured objective.
- Recovered complete server-owned choice values from a unique grounded option reference, preventing a delegated choice from replaying its parent capability.

## 0.4.1 - 2026-09-04

- Added model-interpreted lifecycle actions for cancelling one pending operation or the complete configured objective.
- Made objective cancellation atomically clear pending agenda work, active interactions and open progression occurrences.
- Added the configured progression state to the canonical model context and emitted explicit cancellation audit events.

## 0.3.1 - 2026-09-04

- Exposed the planner-validated intention to capability execution, including grounded semantic references.

## 0.3.0 - 2026-09-04

- Added declarative progression objectives, rules, capability groups and durable progression state.
- Added model-selected capability expansion with compact summaries and full contracts only for relevant capabilities.
- Added dynamic capability dependencies that can be resolved within the same turn.
- Added canonical capability responses and optional interactions without weakening grounding guarantees.
- Extended the event stream and public result contracts for complete runtime traceability.

## 0.2.12 - 2026-09-03

- Added one bounded structural repair for malformed grounding-review output.
- Added an independent `response.grounding-review.repair` model-policy entry.

## 0.1.0 - 2026-09-03

- Added the provider-neutral TypeScript public contracts.
- Added declarative agent, capability, fact and policy definitions.
- Added compilation with schema, dependency, cycle and write-confirmation validation.
- Added one canonical immutable model context with bounded history and explicit omissions.
- Added multi-intention interpretation, dependency planning and durable agenda reduction.
- Added progressive capability selection with compact summaries and selected-contract expansion.
- Added parallel reads, dependent in-turn execution and durable write-effect safety.
- Added evidence-bearing grounded composition with exact claims derived from cited response parts and one bounded repair.
- Added causal, redacted runtime events.
- Added the private LangGraph runtime behind `createKernel().compile().run()`.
- Added clean tarball-consumer and API-report gates.
- Added safe constructors for capability-, host- and durability-owned identifiers.
- Added causally linked capability events for nested workflows and domain progress.
- Added six real-model executable demos with JSON and Markdown trace reports.
- Added generated API reference documentation and an undocumented-member gate.
- Added cross-platform packed-consumer verification and Node 22 CI.
