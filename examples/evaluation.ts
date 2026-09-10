/**
 * Executable evaluation tutorial using a scripted, local catalogue transport.
 * It teaches suite execution and diagnosis; it does not evaluate a real model.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EvaluationError,
  parseEvaluationSuite,
  runEvaluation,
  type EvaluationAdapter,
  type EvaluationData,
  type EvaluationEvaluators,
  type EvaluationValue,
} from "intention-kernel/testing";

const argument = (name: string): string | undefined => process.argv
  .find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const simulateFailure = process.argv.includes("--fail");

// #region evaluator
function object(value: EvaluationValue | undefined): EvaluationData | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as EvaluationData : undefined;
}
function list(value: EvaluationValue | undefined): readonly EvaluationValue[] {
  return Array.isArray(value) ? value as readonly EvaluationValue[] : [];
}

const evaluators: EvaluationEvaluators = {
  "catalogue.selected-option": ({ observation, history }, parameters) => {
    const searchStepId = parameters["searchStepId"];
    const selectionStepId = parameters["selectionStepId"];
    if (typeof searchStepId !== "string" || typeof selectionStepId !== "string") {
      return { passed: false, evidence: { reason: "Step identifiers are required" } };
    }
    const search = history.find((turn) => turn.stepId === searchStepId);
    const selection = history.find((turn) => turn.stepId === selectionStepId);
    const interaction = object(object(search?.observation?.["response"])?.["interaction"]);
    const optionIndex = object(selection?.input["selection"])?.["optionIndex"];
    const option = typeof optionIndex === "number"
      ? object(list(interaction?.["options"])[optionIndex]) : undefined;
    const expectedId = object(option?.["value"])?.["id"];
    const facts = list(object(observation["checkpoint"])?.["facts"]);
    const selected = object(facts.find((fact) => object(fact)?.["type"] === "product.selected"));
    const actualId = object(selected?.["value"])?.["id"];
    return {
      passed: typeof expectedId === "string" && actualId === expectedId,
      evidence: {
        searchStepId, selectionStepId,
        expectedProductId: expectedId ?? null,
        actualProductId: actualId ?? null,
      },
    };
  },
};
// #endregion evaluator

// #region adapter
const products = [
  { id: "desk-lamp", name: "Desk lamp", price: 40 },
  { id: "floor-lamp", name: "Floor lamp", price: 90 },
];
const messages = new Map([
  ["Show available products", products],
  ["Please show available products", products],
  ["Show unavailable products", []],
]);
const adapter: EvaluationAdapter = {
  id: "tutorial.catalogue", version: "1",
  open() {
    // State belongs to this case. Parallel cases never share a selection.
    let displayed: typeof products = [];
    return Promise.resolve({
      send(input) {
        const selection = object(input["selection"]);
        if (selection !== undefined) {
          const index = selection["optionIndex"];
          if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
            throw new EvaluationError("TUTORIAL_SELECTION_INVALID");
          }
          const selected = displayed[simulateFailure ? index + 1 : index];
          if (selected === undefined) throw new EvaluationError("TUTORIAL_OPTION_UNAVAILABLE");
          return Promise.resolve({ observation: {
            response: { status: "completed", message: `Selected ${selected.name}.` },
            checkpoint: { facts: [{ type: "product.selected", value: selected }] },
            catalogue: { count: displayed.length },
          } });
        }
        const text = input["text"];
        const found = typeof text === "string" ? messages.get(text) : undefined;
        if (found === undefined) throw new EvaluationError("TUTORIAL_MESSAGE_UNKNOWN");
        displayed = found;
        return Promise.resolve({ observation: {
          response: {
            status: "completed",
            message: found.length === 0 ? "No products matched." : "Choose a product.",
            ...(found.length === 0 ? { reason: "no_results" } : { interaction: {
              kind: "choice", options: found.map((product) => ({
                id: product.id, label: product.name, value: product,
              })),
            } }),
          },
          checkpoint: { facts: [] },
          catalogue: { count: found.length },
        } });
      },
    });
  },
};
// #endregion adapter

// #region run
const suiteFile = argument("suite") ?? fileURLToPath(new URL("./evaluation.suite.json", import.meta.url));
const suite = parseEvaluationSuite(JSON.parse(await readFile(suiteFile, "utf8")) as unknown);
const scenarioId = argument("scenario");
const controller = new AbortController();
const cancel = (): void => { controller.abort(); };
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

const report = await runEvaluation({
  suite, adapter, evaluators,
  target: { id: "tutorial.catalogue", fingerprint: simulateFailure ? "wrong-selection" : "correct-selection" },
  ...(scenarioId === undefined ? {} : { scenarioIds: [scenarioId] }),
  concurrency: 2,
  repetitions: Number(argument("repetitions") ?? 1),
  signal: controller.signal,
}).finally(() => {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
});

const output = path.resolve(argument("output") ?? path.join(
  "examples", ".runs", `evaluation-${report.runId}`, "report.json",
));
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");

// This tutorial requires every selected case and every suite assertion to pass.
// A case already aggregates its complete assertion expression, including any/all.
const passed = report.status === "completed"
  && report.cases.every((entry) => entry.status === "passed")
  && (report.assertions ?? []).every((assertion) => assertion.passed);
process.stdout.write(JSON.stringify({ passed, summary: report.summary, reportFile: output }, null, 2) + "\n");
if (!passed) process.exitCode = 1;
// #endregion run
