import { KernelConfigurationError } from "../contracts/errors.js";
import type { ModelRequest } from "../contracts/model.js";
import type { ModelPromptResolver, ResolvedModelPrompt } from "../contracts/prompt.js";
import { renderModelPrompt } from "./renderModelPrompt.js";

/** Resolve before events or provider calls; never downgrade failures to another revision. */
export function resolveModelPrompt<T>(request: ModelRequest<T>, resolver?: ModelPromptResolver): Readonly<{ request: ModelRequest<T>; resolution: ResolvedModelPrompt }> {
  const reference = request.prompt;
  if (reference === undefined) throw new KernelConfigurationError({ code: "MODEL_PROMPT_UNIDENTIFIED", message: "A kernel model request must identify its prompt.", retryable: false });
  renderModelPrompt(reference.definition, reference.values);
  let resolution: unknown;
  try {
    resolution = resolver === undefined ? { template: reference.definition.template, revision: "default" } : resolver.resolve(reference);
  } catch {
    throw new KernelConfigurationError({ code: "MODEL_PROMPT_RESOLUTION_FAILED", message: "The pinned model prompt could not be resolved.", retryable: false });
  }
  const candidate = typeof resolution === "object" && resolution !== null ? resolution as Record<string, unknown> : {};
  if (typeof candidate["template"] !== "string" ||
    typeof candidate["revision"] !== "string" || candidate["revision"].trim().length === 0 || candidate["revision"].length > 200) {
    throw new KernelConfigurationError({ code: "INVALID_MODEL_PROMPT_RESOLUTION", message: "The model prompt resolver returned an invalid revision.", retryable: false });
  }
  const pinned = Object.freeze({ template: candidate["template"], revision: candidate["revision"] });
  return { request: { ...request, system: renderModelPrompt(reference.definition, reference.values, pinned.template) }, resolution: pinned };
}
