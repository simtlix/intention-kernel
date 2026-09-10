/**
 * Build provider-neutral agents that interpret intentions, validate plans,
 * execute capability effects and publish grounded, durable responses.
 *
 * @packageDocumentation
 */

export { VERSION } from "./version.js";

export * from "./contracts/agent.js";
export * from "./contracts/agenda.js";
export * from "./contracts/capability.js";
export * from "./contracts/checkpoint.js";
export * from "./contracts/durability.js";
export * from "./contracts/effects.js";
export * from "./contracts/errors.js";
export * from "./contracts/events.js";
export * from "./contracts/facts.js";
export * from "./contracts/ids.js";
export * from "./contracts/intention.js";
export * from "./contracts/interaction.js";
export * from "./contracts/model.js";
export * from "./contracts/prompt.js";
export { getKernelPromptDefinitions } from "./prompts/catalog.js";
export { renderModelPrompt } from "./prompts/renderModelPrompt.js";
export * from "./contracts/modelGuidancePolicy.js";
export * from "./contracts/policy.js";
export * from "./contracts/progression.js";
export * from "./contracts/response.js";
export * from "./contracts/runtime.js";
export * from "./contracts/turn.js";
export * from "./schema/runtimeSchema.js";
export { createKernel, type IntentionKernel, type KernelOptions } from "./runtime/createKernel.js";
