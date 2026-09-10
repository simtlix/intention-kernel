import type { FactRecord } from "../contracts/facts.js";
import { deepFreeze } from "./deepFreeze.js";
import { projectProgression } from "../progression/completionLineage.js";
import type { ContextSnapshot, ProjectionOmission } from "./buildContextSnapshot.js";

/** Canonical model projection with capability contracts supplied through the request boundary. */
export type ModelContextProjection = Omit<ContextSnapshot, "capabilities">;

/** Project persisted facts according to their declared model visibility. */
export function projectFactsForModel(facts: readonly FactRecord[]): readonly FactRecord[] {
  return facts.flatMap((fact): FactRecord[] => {
    if (fact.modelVisibility === "hidden") return [];
    const publicFact: FactRecord = {
      type: fact.type,
      version: fact.version,
      value: fact.value,
      evidenceIds: fact.evidenceIds,
      dependsOn: fact.dependsOn,
      evidence: fact.evidence,
      producedBy: fact.producedBy,
      ...(fact.modelVisibility === undefined ? {} : { modelVisibility: fact.modelVisibility }),
    };
    if (fact.modelVisibility !== "presence") return [publicFact];
    return [{
      ...publicFact,
      value: { available: true },
      evidenceIds: [],
      evidence: [],
    }];
  });
}

/** Collect capability-owned redaction values without exposing them to a model. */
export function modelRedactionsFor(snapshot: ContextSnapshot): readonly string[] {
  return uniqueRedactions([
    ...snapshot.facts.flatMap((fact) => fact.modelRedactions ?? []),
    ...snapshot.agenda.flatMap((item) => item.modelRedactions ?? []),
  ]);
}

/** Recursively redact exact sensitive values from a JSON-compatible projection. */
export function redactModelValue<T>(value: T, redactions: readonly string[]): T {
  return redactUnknown(value, redactions) as T;
}

function redactUnknown(value: unknown, redactions: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, redactions);
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, redactions));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      redactUnknown(entry, redactions),
    ]));
  }
  return value;
}

/** Return the canonical, privacy-aware projection used by every model task. */
export function projectModelContext(snapshot: ContextSnapshot): ModelContextProjection {
  const redactions = modelRedactionsFor(snapshot);
  const projectedFacts = projectFactsForModel(snapshot.facts);
  const omittedFacts = snapshot.facts.length - projectedFacts.length;
  const redactedFacts = snapshot.facts.filter((fact) => fact.modelVisibility === "presence").length;
  const omissions: ProjectionOmission[] = [...snapshot.omissions];
  if (omittedFacts > 0) {
    omissions.push({
      path: "facts",
      reason: "Facts declared as hidden are unavailable to model tasks.",
      omitted: omittedFacts,
    });
  }
  if (redactedFacts > 0) {
    omissions.push({
      path: "facts.value",
      reason: "Facts declared as presence-only expose availability without their value or evidence.",
      omitted: redactedFacts,
    });
  }
  const interaction = snapshot.interaction === undefined
    ? undefined
    : {
        id: snapshot.interaction.id,
        kind: snapshot.interaction.kind,
        requestedFacts: snapshot.interaction.requestedFacts,
        goal: snapshot.interaction.goal,
        ...(snapshot.interaction.capabilityId === undefined ? {} : { capabilityId: snapshot.interaction.capabilityId }),
        ...(snapshot.interaction.options === undefined ? {} : { options: snapshot.interaction.options }),
        ...(snapshot.interaction.payload === undefined ? {} : { payload: snapshot.interaction.payload }),
      };
  const agenda = snapshot.agenda.map((item) => ({
    id: item.id,
    intention: item.intention,
    status: item.status,
    missingFacts: item.missingFacts,
    dependencies: item.dependencies,
  }));
  const contextWithoutCapabilities: ModelContextProjection = {
    conversation: snapshot.conversation,
    currentMessage: snapshot.currentMessage,
    facts: snapshot.facts,
    agenda: snapshot.agenda,
    ...(snapshot.progression === undefined ? {} : { progression: snapshot.progression }),
    ...(snapshot.interaction === undefined ? {} : { interaction: snapshot.interaction }),
    ...(snapshot.interactionSelection === undefined ? {} : { interactionSelection: snapshot.interactionSelection }),
    decisions: snapshot.decisions,
    agent: snapshot.agent,
    policies: snapshot.policies,
    selectedModelGuidancePolicies: snapshot.selectedModelGuidancePolicies,
    omissions: snapshot.omissions,
  };
  const projected = {
    ...contextWithoutCapabilities,
    conversation: redactModelValue(snapshot.conversation, redactions),
    currentMessage: redactModelValue(snapshot.currentMessage, redactions),
    facts: redactModelValue(projectedFacts, redactions),
    agenda: redactModelValue(agenda, redactions),
    ...(snapshot.progression === undefined ? {} : { progression: redactModelValue(projectProgression(snapshot.progression), redactions) }),
    ...(interaction === undefined ? {} : { interaction: redactModelValue(interaction, redactions) }),
    decisions: redactModelValue(snapshot.decisions, redactions),
    omissions,
  };
  return deepFreeze(structuredClone(projected));
}

function uniqueRedactions(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length >= 3))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function redactText(value: string, redactions: readonly string[]): string {
  return redactions.reduce((current, sensitive) => current.split(sensitive).join("[redacted]"), value);
}
