import { createHash } from "node:crypto";
import { EvaluationError } from "./schema.js";
import type { EvaluationData, EvaluationOptions, EvaluationScenario, EvaluationStep, EvaluationSuite } from "./types.js";

export function digest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonical(nested)]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function integer(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new EvaluationError("EVALUATION_OPTIONS_INVALID");
  return result;
}
export interface MatrixCase {
  id: string;
  scenario: EvaluationScenario;
  repetition: number;
  variants: Record<string, string>;
  steps: readonly EvaluationStep[];
}
export function expandCases(suite: EvaluationSuite, options: EvaluationOptions): MatrixCase[] {
  const repeats = integer(options.repetitions, 1, 100);
  const limit = integer(options.maxCases, 1000, 100000);
  const known = new Set(suite.scenarios.map(({ id }) => id));
  if (options.scenarioIds?.some((id) => !known.has(id)) === true) throw new EvaluationError("EVALUATION_SCENARIO_NOT_FOUND");
  const selected = suite.scenarios.filter((scenario) =>
    (options.scenarioIds === undefined || options.scenarioIds.includes(scenario.id)) &&
    (options.tags === undefined || options.tags.some((tag) => scenario.tags?.includes(tag))),
  );
  if (selected.length === 0) throw new EvaluationError("EVALUATION_SELECTION_EMPTY");
  const cases: MatrixCase[] = [];
  for (const scenario of selected) {
    let combinations: { variants: Record<string, string>; inputs: Record<string, EvaluationData> }[] = [{ variants: {}, inputs: {} }];
    for (const step of scenario.steps) {
      const variants = step.variants;
      if (variants === undefined) continue;
      if (combinations.length * variants.length * repeats + cases.length > limit) throw new EvaluationError("EVALUATION_CASE_LIMIT");
      combinations = combinations.flatMap((combination) => variants.map((variant) => ({
        variants: { ...combination.variants, [step.id]: variant.id },
        inputs: { ...combination.inputs, [step.id]: variant.input },
      })));
    }
    for (const combination of combinations) {
      for (let repetition = 0; repetition < repeats; repetition++) {
        if (cases.length >= limit) throw new EvaluationError("EVALUATION_CASE_LIMIT");
        cases.push({
          id: digest({ scenarioId: scenario.id, variants: combination.variants, repetition }), scenario, repetition,
          variants: combination.variants,
          steps: scenario.steps.map((step) => ({ ...step, input: combination.inputs[step.id] ?? step.input })),
        });
      }
    }
  }
  return cases;
}
