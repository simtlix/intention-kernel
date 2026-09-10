/** Copy this module into an application that has installed intention-kernel. */
import type { CompiledAgent } from "intention-kernel";
import {
  createAgentEvaluationAdapter,
  parseEvaluationSuite,
  runEvaluation,
  type EvaluationOptions,
  type EvaluationReport,
} from "intention-kernel/testing";

export const catalogueSuite = parseEvaluationSuite({
  schemaVersion: 1,
  id: "catalogue",
  name: "Catalogue searches",
  scenarios: [{
    id: "find-products",
    name: "Search for a family product",
    description: "Return grounded catalogue results and preserve the candidates as facts.",
    writePolicy: "read_only",
    steps: [{
      id: "search",
      input: { text: "Find a family option" },
      variants: [
        { id: "direct", input: { text: "Find a family option" } },
        { id: "polite", input: { text: "Please find a family option" } },
      ],
      assertions: [
        { id: "completed", kind: "check", path: ["response", "status"], operator: "equals", value: "completed" },
        { id: "grounded", kind: "check", path: ["response", "grounded"], operator: "equals", value: true },
        { id: "candidates-recorded", kind: "check", path: ["checkpoint", "facts"], operator: "contains", value: { type: "product.candidates" } },
        { id: "no-pending-choice", kind: "check", path: ["response", "interaction"], operator: "absent" },
      ],
    }],
  }],
});

type CatalogueEvaluationOptions = Pick<
  EvaluationOptions,
  "scenarioIds" | "tags" | "repetitions" | "concurrency" | "signal"
>;

export function evaluateCatalogue(
  agent: CompiledAgent,
  options: CatalogueEvaluationOptions = {},
): Promise<EvaluationReport> {
  return runEvaluation({
    suite: catalogueSuite,
    target: { id: agent.id, fingerprint: agent.fingerprint },
    adapter: createAgentEvaluationAdapter({ agent }),
    ...options,
  });
}

export function evaluationsPassed(report: EvaluationReport): boolean {
  return report.status === "completed"
    && report.cases.every((entry) => entry.status === "passed")
    && (report.assertions ?? []).every((assertion) => assertion.passed);
}
