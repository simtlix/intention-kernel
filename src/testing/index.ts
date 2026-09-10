/**
 * Declarative scenario evaluation, assertions, portable reports, and in-memory test helpers.
 *
 * @remarks
 * Import these APIs from `intention-kernel/testing` in the consuming application.
 * Evaluations run through a compiled agent or an application-owned transport and
 * return structured results for each case and acceptance criterion.
 *
 * @packageDocumentation
 */

import { VERSION } from "../version.js";

/** Package version of these testing helpers, identical to the runtime's VERSION. */
export const TESTING_VERSION = VERSION;
export * from "./createMemoryDurability.js";
export * from "./createEventCollector.js";
export * from "./evaluation/types.js";
export { EvaluationError, parseEvaluationSuite } from "./evaluation/schema.js";
export { evaluateAssertions } from "./evaluation/assertions.js";
export { runEvaluation } from "./evaluation/runner.js";
export { parseEvaluationReport } from "./evaluation/report.js";
export { createAgentEvaluationAdapter } from "./evaluation/agentAdapter.js";
export type { AgentEvaluationAdapterOptions } from "./evaluation/agentAdapter.js";
