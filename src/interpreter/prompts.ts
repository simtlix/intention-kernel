import { kernelPrompt } from "../prompts/catalog.js";

/** Default instructions retained for internal compatibility. */
export const TURN_INTERPRETATION_SYSTEM_PROMPT = kernelPrompt("kernel.turn.interpret").system;
/** Default instructions retained for internal compatibility. */
export const TURN_INTERPRETATION_REPAIR_PROMPT = kernelPrompt("kernel.turn.interpret.repair").system;
/** Default instructions retained for internal compatibility. */
export const CAPABILITY_SELECTION_SYSTEM_PROMPT = kernelPrompt("kernel.capability.select").system;
/** Default instructions retained for internal compatibility. */
export const CAPABILITY_SELECTION_REPAIR_PROMPT = kernelPrompt("kernel.capability.select.repair").system;
