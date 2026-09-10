# Grounded responses

Grounding links published business claims to evidence returned by authorized capabilities. It is enforced across capability execution, fact reduction, response composition, and semantic review.

## Evidence lineage

<DocFlow name="grounding" />

Capabilities return `EvidenceRecord` values for external or authoritative observations. Facts cite those records. The response model composes ordered parts and attaches evidence IDs to parts that state business claims.

The kernel joins the parts into one message and derives exact claim text from their spans. The model does not provide free-form claim offsets.

## Response brief

The response model receives a bounded `ResponseBrief` containing:

- the response goal;
- recent conversation context;
- completed and pending work;
- visible confirmed facts;
- available evidence;
- permitted next actions;
- artifacts and an active interaction;
- sanitized capability issues.

The brief excludes infrastructure ports and follows fact visibility and host
redaction rules. The host remains responsible for marking or removing sensitive
domain values before model disclosure.

## Verification stages

1. **Citation validation** rejects evidence IDs that are unavailable to the turn.
2. **Exact-span derivation** creates `ResponseClaim` values from cited text parts.
3. **Semantic review** checks that claims are supported by cited evidence.
4. **Required result validation** checks that capability-declared required messages appear exactly once with their evidence annotations, independently of model approval.
5. **Capability fallback validation** checks exact claim spans and capability-owned evidence before delivery.
6. **Fail-closed response** prevents unsupported business assertions from being published when neither model composition nor a validated capability fallback is available.

Grounding validates factual support. The response model writes natural, context-aware language when the turn needs composition. Fully represented required results and pure pending input use validated server-authored delivery.

`canonicalResponse` is optional. For ordinary informational work, the kernel tries natural model composition and one repair first. A single completed capability's copy can then be used as a fallback if its citations are valid. Domain wording stays with the capability.

## Required current-turn results

Set `canonicalResponse.required: true` when a completed operation produces a result the user must receive, such as an estimated value. Its message must be non-empty and contain evidence-cited claims. The reducer validates those citations against the capability result.

The composer receives these entries as `ResponseBrief.requiredResponses`. Each exact message must appear once, with its evidence, before the required next interaction. When every current completed operation supplies canonical copy that can be joined without repeating a required result, and no separate issue or lifecycle decision needs explanation, the kernel directly delivers that copy followed by the actual required interaction goal. This includes copy from other completed operations whose `required` flag is absent. An answer wholly contained in another is not repeated; all evidence annotations are retained. If distinct answers share a required span that cannot be joined once without rewriting, an ordinary unprotected turn retains normal composition and grounding review. Protected confirmation text uses the original delivery projection; optional interactions remain available but do not require an invitation in the message.

Protected confirmation and redacted required delivery never expose original copy to a model to resolve overlapping text. Those paths fail closed if their authored messages cannot satisfy the exact-delivery checks. Protected delivery also does not compose an additional completed answer lacking authored copy; that combination is outside the mixed-result preservation guarantee.

When a mixed turn contains a completed operation without canonical copy, the kernel retains natural composition to preserve that answer. Exact required-copy and invitation checks still apply independently of model approval. If composition and repair fail, a partial fallback cannot silently discard the unrepresented completed work. Issues and lifecycle decisions also retain the existing composition and review path. This boundary does not make model-composed turns universally immune to unsupported wording.

A turn with no completed work or issue and only a pending required interaction delivers the exact server-owned goal directly. Separate lifecycle or unsupported-request decisions retain composition. Pending input cannot be rewritten by composition as a completed action in the direct-delivery path. Missing or invalid canonical copy fails closed without calling a model, and the validated delivery text is the same text committed to conversation history.

Delivery requirements are derived only from current-turn completed operations. Historical facts and separately rendered artifacts do not create them. Leave `required` absent for ordinary fallback-only copy, including option lists already rendered by the host. The kernel does not infer domain-specific importance or require all historical results to be repeated.

## What requires evidence

Evidence is required for statements such as prices, availability, eligibility, calculated values, record status, identifiers, and external URLs. Pure conversational framing and questions do not require business evidence.

## Capability requirements

- Give each evidence record a stable ID within the operation.
- Use `source` to identify the authority, not an implementation detail.
- Put human-auditable support in `content`.
- Keep structured source data in `data` when later processing needs it.
- Attach evidence IDs to every fact derived from the source.
- Do not convert an upstream failure into a fabricated fact.

## Operational inspection

A successful response is more than text. Inspect:

- executed capability IDs and normalized inputs;
- facts produced and invalidated;
- evidence IDs cited by claims;
- `response.grounded` and response source;
- capability issues and pending interactions;
- causal events through `response.composed` and `state.committed`.
