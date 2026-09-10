import type { CapabilityDefinition } from "./capability.js";
import type { AgentId } from "./ids.js";
import type { PolicyDefinition } from "./policy.js";
import type { AgentProgressionDefinition } from "./progression.js";
import type { ModelGuidancePolicyDefinition } from "./modelGuidancePolicy.js";

/** Host-authored safe copy used only when a model cannot ground a control response. */
export interface AgentResponseFallbacks {
  /** Response for an intention that no registered capability can represent. */
  readonly unsupportedIntention?: string;
}

/** Public definition compiled into an immutable runtime agent. */
export interface AgentDefinition {
  /** Stable semantic identity persisted in the compiled fingerprint. */
  readonly id: AgentId;
  /** Positive manifest version controlled by the host application. */
  readonly version: number;
  /** Model-visible role, tone and authority boundary for the agent. */
  readonly identity: string;
  /** Complete allowlist of operations the compiled agent may execute. */
  readonly capabilities: readonly CapabilityDefinition<unknown, unknown>[];
  /** Pure host-owned constraints applied after interpretation. */
  readonly policies: readonly PolicyDefinition[];
  /** Host-selected semantic guidance available before capability routing. */
  readonly modelGuidancePolicies?: readonly ModelGuidancePolicyDefinition[];
  /** Optional model name or alias selected independently for each model task. */
  readonly modelPolicy: Readonly<Record<string, string>>;
  /** Optional fact-triggered objective and capability progression owned by the host manifest. */
  readonly progression?: AgentProgressionDefinition;
  /** Optional localized control fallbacks; normal responses remain model-composed. */
  readonly responseFallbacks?: AgentResponseFallbacks;
}

/**
 * Define and shallow-freeze a single-agent manifest.
 *
 * @returns An immutable manifest suitable for {@link IntentionKernel.compile}.
 */
export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return Object.freeze({
    ...definition,
    capabilities: Object.freeze([...definition.capabilities]),
    policies: Object.freeze([...definition.policies]),
    ...(definition.modelGuidancePolicies === undefined
      ? {}
      : { modelGuidancePolicies: Object.freeze([...definition.modelGuidancePolicies]) }),
    modelPolicy: Object.freeze({ ...definition.modelPolicy }),
    ...(definition.progression === undefined
      ? {}
      : { progression: freezeProgression(definition.progression) }),
    ...(definition.responseFallbacks === undefined
      ? {}
      : { responseFallbacks: Object.freeze({ ...definition.responseFallbacks }) }),
  });
}

function freezeProgression(progression: AgentProgressionDefinition): AgentProgressionDefinition {
  return Object.freeze({
    ...(progression.objective === undefined
      ? {}
      : { objective: Object.freeze({ ...progression.objective, completionFact: Object.freeze({ ...progression.objective.completionFact }) }) }),
    groups: Object.freeze(progression.groups.map((group) => Object.freeze({
      ...group,
      ...(group.repeatPrompt === undefined ? {} : { repeatPrompt: group.repeatPrompt }),
      ...(group.continueExamples === undefined ? {} : { continueExamples: Object.freeze([...group.continueExamples]) }),
      members: Object.freeze(group.members.map((member) => Object.freeze({
        ...member,
        examples: Object.freeze([...member.examples]),
      }))),
    }))),
    rules: Object.freeze(progression.rules.map((rule) => Object.freeze({
      ...rule,
      target: Object.freeze({ ...rule.target }),
      activateWhen: Object.freeze(rule.activateWhen.map((fact) => Object.freeze({ ...fact }))),
    }))),
  });
}
