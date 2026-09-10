import type { CompiledAgentDefinition } from "../compiler/compileAgentDefinition.js";
import { fingerprint } from "../compiler/fingerprint.js";
import type { KernelCheckpoint } from "../contracts/checkpoint.js";
import type { FactRecord, FactReference } from "../contracts/facts.js";
import type { StepExecutionResult } from "../contracts/plan.js";
import type { ProgressionOccurrence, ProgressionState } from "../contracts/progression.js";

type Publication = FactReference & { readonly publication: string };
interface CompletionLineage {
  readonly publications: readonly (Publication & { readonly parents: readonly Publication[] })[];
  readonly revalidating?: true;
}
type CompletedOccurrence = ProgressionOccurrence & { readonly completionLineage?: CompletionLineage };

/** Concrete publication identity, independent of the fact's schema version. */
export function factPublicationKey(fact: FactRecord): string {
  return fingerprint({ type: fact.type, version: fact.version, value: fact.value, producedBy: fact.producedBy });
}

function reference(fact: FactRecord): Publication {
  return { type: fact.type, version: fact.version, publication: factPublicationKey(fact) };
}

function current(reference: Publication, facts: readonly FactRecord[]): boolean {
  return facts.some(fact => fact.type === reference.type && fact.version === reference.version && factPublicationKey(fact) === reference.publication);
}

function pendingConsumer(reference: FactReference, checkpoint: KernelCheckpoint, compiled: CompiledAgentDefinition): boolean {
  return checkpoint.agenda.some(item => {
    const id = item.intention.proposedCapability;
    return id !== undefined && item.status === "waiting_facts" &&
      !checkpoint.effects.some(effect => effect.capabilityId === id && (effect.status === "prepared" || effect.status === "uncertain")) &&
      checkpoint.progression?.occurrences.some(occurrence => occurrence.status === "active" && occurrence.mode === "required" && occurrence.activeMember === id) &&
      compiled.capabilities.get(id)?.requires.some(required => required.type === reference.type && required.version === reference.version);
  });
}

/** Reconcile actual read completions; absence of a declared optional output grants no authority. */
export function reconcileCompletionLineage(options: {
  readonly occurrences: readonly ProgressionOccurrence[];
  readonly checkpoint: KernelCheckpoint;
  readonly compiled: CompiledAgentDefinition;
  readonly results: readonly StepExecutionResult[];
  readonly invalidatedFacts: readonly FactRecord[];
}): readonly ProgressionOccurrence[] {
  const { checkpoint, compiled } = options;
  return options.occurrences.map(occurrence => {
    if (!("capabilityId" in occurrence.target) || occurrence.mode !== "required" ||
      !["satisfied", "pending"].includes(occurrence.status) ||
      !occurrence.activationFacts.every(activation => current(activation, checkpoint.facts))) return occurrence;
    const id = occurrence.target.capabilityId;
    const capability = compiled.capabilities.get(id);
    if (capability?.effect !== "read" || capability.confirmation !== "none" ||
      checkpoint.effects.some(effect => effect.capabilityId === id && (effect.status === "prepared" || effect.status === "uncertain")) ||
      options.occurrences.filter(peer => "capabilityId" in peer.target && peer.target.capabilityId === id &&
        peer.mode === "required" && peer.status !== "declined" && peer.status !== "superseded" &&
        peer.activationFacts.every(activation => current(activation, checkpoint.facts))).length !== 1) return occurrence;
    const result = options.results.findLast(result => result.capabilityId === id && result.status === "invoked" && result.result.status === "completed");
    if (result?.status === "invoked" && result.result.status === "completed") {
      const publications = checkpoint.facts.filter(fact => fact.producedBy.capabilityId === id && fact.producedBy.stepId === result.stepId &&
        result.result.status === "completed" && result.result.facts.some(candidate => candidate.type === fact.type && candidate.version === fact.version));
      const next = { ...occurrence } as CompletedOccurrence;
      delete (next as { completionLineage?: CompletionLineage }).completionLineage;
      return publications.length === 0 ? next : { ...next, completionLineage: { publications: publications.map(fact => ({ ...reference(fact),
        parents: fact.dependsOn.flatMap(parent => checkpoint.facts.filter(candidate => candidate.type === parent.type && candidate.version === parent.version).map(reference)),
      })) } } as CompletedOccurrence;
    }
    const lineage = (occurrence as CompletedOccurrence).completionLineage;
    if (occurrence.status === "pending" && lineage?.revalidating === true &&
      !lineage.publications.some(publication => pendingConsumer(publication, checkpoint, compiled) &&
        !checkpoint.facts.some(fact => fact.type === publication.type && fact.version === publication.version))) {
      return { ...occurrence, status: "superseded" };
    }
    if (occurrence.status !== "satisfied" || lineage === undefined) return occurrence;
    const retired = lineage.publications.some(publication => pendingConsumer(publication, checkpoint, compiled) &&
      !checkpoint.facts.some(fact => fact.type === publication.type && fact.version === publication.version) &&
      options.invalidatedFacts.some(fact => fact.type === publication.type && fact.version === publication.version && factPublicationKey(fact) === publication.publication));
    return retired ? { ...occurrence, status: "pending", completionLineage: { ...lineage, revalidating: true } } as CompletedOccurrence : occurrence;
  });
}

/** Only changed parents of a retired, still-required completion can refresh its scheduler authority. */
export function completionRevalidationFacts(occurrence: ProgressionOccurrence, checkpoint: KernelCheckpoint, compiled: CompiledAgentDefinition): readonly Publication[] {
  const lineage = (occurrence as CompletedOccurrence).completionLineage;
  if (lineage?.revalidating !== true) return [];
  return lineage.publications.filter(publication => pendingConsumer(publication, checkpoint, compiled) &&
    publication.parents.every(parent => checkpoint.facts.some(fact => fact.type === parent.type && fact.version === parent.version))).flatMap(publication =>
    publication.parents.flatMap(parent => checkpoint.facts.filter(fact => fact.type === parent.type && fact.version === parent.version &&
      factPublicationKey(fact) !== parent.publication).map(reference)));
}

/** Private completion proof is durable kernel authority, never model context. */
export function projectProgression(progression: ProgressionState): ProgressionState {
  return { ...progression, occurrences: progression.occurrences.map(occurrence => {
    const next = { ...occurrence } as { completionLineage?: CompletionLineage } & ProgressionOccurrence;
    delete next.completionLineage;
    return next;
  }) };
}
