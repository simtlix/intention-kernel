import { createHash } from "node:crypto";

import type { ModelRequest } from "../contracts/model.js";
import type { ResolvedModelPrompt } from "../contracts/prompt.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Observe the supplied context and repair inputs without changing a model request. */
export function observeModelRequest(request: ModelRequest<unknown>, resolution?: ResolvedModelPrompt): unknown {
  const input = record(request.input);
  const context = record(input["context"] ?? input["brief"] ?? input);
  const conversation = record(context["conversation"]);
  const interaction = record(context["interaction"]);
  const currentMessage = context["currentMessage"] ?? conversation["currentMessage"] ?? null;
  return {
    instructionDigest: createHash("sha256").update(request.system).digest("hex"),
    ...(request.prompt === undefined || resolution === undefined ? {} : { prompt: {
      id: request.prompt.definition.id,
      contractVersion: request.prompt.definition.contractVersion,
      revision: resolution.revision,
      templateHash: createHash("sha256").update(resolution.template).digest("hex"),
      instructionHash: createHash("sha256").update(request.system).digest("hex"),
      instructions: request.system,
    } }),
    context: {
      currentMessage,
      interactionSelection: context["interactionSelection"] ?? null,
      recentMessages: conversation["recentMessages"] ?? [],
      totalMessages: conversation["totalMessages"] ?? null,
      facts: items(context["facts"]).map((candidate) => {
        const fact = record(candidate);
        return {
          type: fact["type"],
          version: fact["version"],
          value: fact["value"],
          producedBy: fact["producedBy"],
        };
      }),
      interaction: Object.keys(interaction).length === 0 ? null : {
        id: interaction["id"],
        kind: interaction["kind"],
        capabilityId: interaction["capabilityId"] ?? null,
        goal: interaction["goal"],
        options: interaction["options"] ?? [],
      },
      agenda: context["agenda"] ?? context["pending"] ?? [],
      selectedModelGuidancePolicies: context["selectedModelGuidancePolicies"] ?? context["modelGuidance"] ?? [],
      omissions: context["omissions"] ?? [],
    },
    capabilities: request.capabilities,
    selection: input["selection"] ?? null,
    proposedSelection: input["proposedSelection"] ?? null,
    intentions: input["intentions"] ?? [],
    completedWork: context["completed"] ?? [],
    responseGoal: context["responseGoal"] ?? null,
    proposedAnswer: input["proposedAnswer"] ?? null,
    currentChoice: input["currentChoice"] ?? null,
    proposedOption: input["proposedOption"] ?? null,
    validationIssues: input["validationIssues"] ?? input["issues"] ?? [],
    rejectedProposal: input["invalidOutput"] ?? input["rejectedResponse"] ?? null,
  };
}
