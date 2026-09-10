import type { AgendaItem } from "../contracts/agenda.js";
import type { KernelCheckpoint } from "../contracts/checkpoint.js";
import type { Interaction } from "../contracts/interaction.js";
import type { CompiledAgentDefinition } from "../compiler/compileAgentDefinition.js";
import { fingerprint } from "../compiler/fingerprint.js";
import { waitsForOperationInput } from "./agendaInputState.js";

// Private durable authority. Never supplied by a model or read from a
// capability's opaque continuation. Public projections whitelist agenda fields.
interface SuspendedInteraction {
  readonly interaction: Interaction;
  readonly occurrenceId: string;
  readonly prerequisitePublications: string;
  readonly ownerPath?: string;
}
type SuspendedAgendaItem = AgendaItem & { readonly suspendedInteraction?: SuspendedInteraction };

/** Drop only private suspension lineage; keep all pending work and redactions. */
export function withoutSuspendedInteraction(item: AgendaItem): AgendaItem {
  const next = { ...item } as { -readonly [K in keyof SuspendedAgendaItem]: SuspendedAgendaItem[K] };
  delete next.suspendedInteraction;
  return next;
}

function prerequisitePublications(item: AgendaItem, checkpoint: KernelCheckpoint, compiled: CompiledAgentDefinition): string {
  const capability = item.intention.proposedCapability === undefined ? undefined : compiled.capabilities.get(item.intention.proposedCapability);
  return fingerprint((capability?.requires ?? []).map(reference => {
    const fact = checkpoint.facts.find(candidate => candidate.type === reference.type && candidate.version === reference.version);
    return { type: reference.type, version: reference.version, publication: fact === undefined ? null : {
      value: fact.value, producedBy: fact.producedBy,
    } };
  }));
}

function owner(item: AgendaItem, checkpoint: KernelCheckpoint, compiled: CompiledAgentDefinition) {
  const id = item.intention.proposedCapability;
  const capability = id === undefined ? undefined : compiled.capabilities.get(id);
  if (!waitsForOperationInput(item) || capability === undefined || capability.effect === "write") return undefined;
  if (checkpoint.agenda.filter(candidate => candidate.intention.proposedCapability === id).length !== 1) return undefined;
  const path: AgendaItem[] = [];
  let current: AgendaItem | undefined = item;
  while (current !== undefined) {
    if (path.some(entry => entry.id === current?.id) ||
      checkpoint.effects.some(effect => effect.capabilityId === current?.intention.proposedCapability &&
        (effect.status === "prepared" || effect.status === "uncertain"))) return undefined;
    path.push(current);
    const currentId: AgendaItem["id"] = current.id;
    const parents: AgendaItem[] = checkpoint.agenda.filter(parent => parent.status === "waiting_facts" && parent.dependencies.includes(currentId) &&
      ((parent as AgendaItem & { ownedDependencyIds?: readonly string[] }).ownedDependencyIds ?? []).includes(currentId));
    if (parents.length > 1) return undefined;
    current = parents[0];
  }
  const occurrences = checkpoint.progression?.occurrences.filter(occurrence => occurrence.status === "active" &&
    occurrence.mode === "required" && path.some(entry => entry.intention.proposedCapability === occurrence.activeMember)) ?? [];
  const occurrence = occurrences.length === 1 ? occurrences[0] : undefined;
  return occurrence === undefined ? undefined : { ...occurrence, ownerPath: fingerprint(path.map(entry => entry.id)) };
}

/** Read a still-live, uniquely owned question; stale lineage never grants authority. */
export function suspendedInteraction(item: AgendaItem, checkpoint: KernelCheckpoint, compiled: CompiledAgentDefinition) {
  const marker = (item as SuspendedAgendaItem).suspendedInteraction;
  const occurrence = owner(item, checkpoint, compiled);
  if (marker === undefined || occurrence === undefined || marker.occurrenceId !== occurrence.id ||
    marker.interaction.capabilityId !== item.intention.proposedCapability ||
    marker.interaction.kind === "confirmation" || marker.interaction.mode === "optional" ||
    marker.interaction.protectedCanonicalMessage !== undefined ||
    marker.prerequisitePublications !== prerequisitePublications(item, checkpoint, compiled) ||
    (marker.ownerPath !== undefined && marker.ownerPath !== occurrence.ownerPath)) return undefined;
  return { interaction: marker.interaction, occurrenceId: occurrence.id, priority: occurrence.priority };
}

/** Suspend only a uniquely owned unresolved read control; no confirmation or write authority moves. */
export function activeInteractionSuspension(checkpoint: KernelCheckpoint, compiled: CompiledAgentDefinition) {
  const interaction = checkpoint.interaction;
  if (interaction?.capabilityId === undefined || interaction.mode === "optional" || interaction.kind === "confirmation" ||
    interaction.protectedCanonicalMessage !== undefined) return undefined;
  const items = checkpoint.agenda.filter(item => item.intention.proposedCapability === interaction.capabilityId);
  const item = items.length === 1 ? items[0] : undefined;
  if (item === undefined) return undefined;
  const occurrence = owner(item, checkpoint, compiled);
  if (occurrence === undefined) return undefined;
  const marker: SuspendedInteraction = { interaction, occurrenceId: occurrence.id, ownerPath: occurrence.ownerPath,
    prerequisitePublications: prerequisitePublications(item, checkpoint, compiled) };
  return { priority: occurrence.priority, agenda: checkpoint.agenda.map(candidate => candidate.id === item.id
    ? { ...candidate, suspendedInteraction: marker } : candidate) };
}

/** Retain an unresolved read question when another required control or read dependency interrupts it. */
export function retainSuspendedInteractions(options: {
  readonly previous: KernelCheckpoint;
  readonly checkpoint: KernelCheckpoint;
  readonly compiled: CompiledAgentDefinition;
  readonly dismissed: boolean;
  readonly dependencyInterrupted?: boolean;
}): readonly AgendaItem[] {
  const { previous, checkpoint, compiled } = options;
  const agenda = checkpoint.agenda.map(item => suspendedInteraction(item, checkpoint, compiled) === undefined
    ? withoutSuspendedInteraction(item) : item);
  const active = previous.interaction;
  const replacement = checkpoint.interaction;
  const readDependency = replacement === undefined && options.dependencyInterrupted === true;
  if (options.dismissed || active === undefined || (!readDependency && replacement === undefined) || active.id === replacement?.id ||
    active.capabilityId === undefined || active.capabilityId === replacement?.capabilityId ||
    active.mode === "optional" || active.kind === "confirmation" || active.protectedCanonicalMessage !== undefined ||
    replacement?.mode === "optional" || replacement?.kind === "confirmation") return agenda;
  const previousOwners = previous.agenda.filter(item => item.intention.proposedCapability === active.capabilityId);
  if (previousOwners.length !== 1) return agenda;
  const old = previousOwners[0];
  if (old === undefined) return agenda;
  const retained = agenda.find(item => item.id === old.id);
  if (retained === undefined || prerequisitePublications(old, previous, compiled) !== prerequisitePublications(retained, checkpoint, compiled)) return agenda;
  const occurrence = owner(retained, checkpoint, compiled);
  if (occurrence === undefined) return agenda;
  const marker: SuspendedInteraction = { interaction: active, occurrenceId: occurrence.id, ownerPath: occurrence.ownerPath,
    prerequisitePublications: prerequisitePublications(retained, checkpoint, compiled) };
  return agenda.map(item => item.id === retained.id ? { ...item, suspendedInteraction: marker } : item);
}
