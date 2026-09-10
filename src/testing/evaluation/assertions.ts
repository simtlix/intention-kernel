import { isDeepStrictEqual } from "node:util";
import { assertionSchema, boundedJson, EvaluationError, parseData } from "./schema.js";
import { evaluationSnapshot, freezeEvaluationData } from "./snapshot.js";
import type { EvaluationAssertion, EvaluationAssertionResult, EvaluationContext, EvaluationEvaluators, EvaluationPath, EvaluationValue } from "./types.js";

function array(value: EvaluationValue | undefined): value is readonly EvaluationValue[] {
  return Array.isArray(value);
}
function at(value: EvaluationValue, path: EvaluationPath): { present: boolean; value?: EvaluationValue } {
  let cursor = value;
  for (const part of path) {
    if (cursor === null || typeof cursor !== "object" || !Object.hasOwn(cursor, part)) return { present: false };
    const next = (cursor as Readonly<Record<string | number, EvaluationValue>>)[part];
    if (next === undefined) return { present: false };
    cursor = next;
  }
  return { present: true, value: cursor };
}
function matches(actual: EvaluationValue, expected: EvaluationValue): boolean {
  if (expected === null || typeof expected !== "object") return isDeepStrictEqual(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  if (array(expected)) return array(actual) && actual.length === expected.length && expected.every((value, index) => {
    const candidate = actual[index]; return candidate !== undefined && matches(candidate, value);
  });
  return !array(actual) && Object.entries(expected).every(([key, value]) => {
    const candidate = (actual as Readonly<Record<string, EvaluationValue>>)[key];
    return Object.hasOwn(actual, key) && candidate !== undefined && matches(candidate, value);
  });
}
async function evaluate(assertion: EvaluationAssertion, context: EvaluationContext, evaluators: EvaluationEvaluators): Promise<EvaluationAssertionResult> {
  const base = { id: assertion.id, ...(assertion.label === undefined ? {} : { label: assertion.label }) };
  if (context.signal?.aborted === true) return { ...base, passed: false, errorCode: "EVALUATION_CANCELLED" };
  switch (assertion.kind) {
    case "check": {
      const actual = at(context.observation, assertion.path);
      const expected = assertion.value;
      let passed: boolean;
      switch (assertion.operator) {
        case "exists": passed = actual.present; break;
        case "absent": passed = !actual.present; break;
        case "equals": passed = actual.present && isDeepStrictEqual(actual.value, expected); break;
        case "matches": passed = actual.present && actual.value !== undefined && expected !== undefined && matches(actual.value, expected); break;
        case "contains": passed = actual.present && (array(actual.value)
          ? expected !== undefined && actual.value.some((value) => matches(value, expected))
          : typeof actual.value === "string" && typeof expected === "string" && actual.value.includes(expected)); break;
        case "gte": passed = typeof actual.value === "number" && actual.value >= (expected as number); break;
        case "lte": passed = typeof actual.value === "number" && actual.value <= (expected as number); break;
        case "length": passed = (Array.isArray(actual.value) || typeof actual.value === "string") && actual.value.length === expected; break;
      }
      return { ...base, passed, actual, ...(expected === undefined ? {} : { expected }) };
    }
    case "all": case "any": {
      const children = [];
      for (const child of assertion.assertions) children.push(await evaluate(child, context, evaluators));
      const error = children.find((child) => child.errorCode !== undefined)?.errorCode;
      const passed = error === undefined && (assertion.kind === "all" ? children.every((child) => child.passed) : children.some((child) => child.passed));
      return { ...base, passed, children, ...(error === undefined ? {} : { errorCode: error }) };
    }
    case "not": {
      const child = await evaluate(assertion.assertion, context, evaluators);
      return { ...base, passed: child.errorCode === undefined && !child.passed, children: [child], ...(child.errorCode === undefined ? {} : { errorCode: child.errorCode }) };
    }
    case "custom": {
      const evaluator = Object.hasOwn(evaluators, assertion.evaluator) ? evaluators[assertion.evaluator] : undefined;
      if (evaluator === undefined) return { ...base, passed: false, errorCode: "EVALUATOR_NOT_FOUND" };
      try {
        const result = await evaluator(context, evaluationSnapshot(assertion.parameters));
        if (typeof result.passed !== "boolean") return { ...base, passed: false, errorCode: "EVALUATOR_RESULT_INVALID" };
        return { ...base, passed: result.passed, expected: { evaluator: assertion.evaluator, parameters: assertion.parameters }, ...(result.evidence === undefined ? {} : { evidence: parseData(result.evidence) }) };
      } catch {
        return { ...base, passed: false, errorCode: "EVALUATOR_FAILED" };
      }
    }
  }
}
/**
 * Evaluate every assertion and preserve the evidence for each outcome.
 * @remarks Errors in a composite assertion cannot become a pass through negation or an alternative.
 * Custom evaluators receive immutable evidence snapshots. Runner-owned snapshots
 * are shared without copying whole runs; mutable caller data remains isolated.
 * Evaluators are explicitly injected; this function does not call any model.
 * @throws EvaluationError for malformed assertion definitions or observations.
 */
export async function evaluateAssertions(
  assertions: readonly EvaluationAssertion[],
  context: EvaluationContext,
  evaluators: EvaluationEvaluators = {},
): Promise<readonly EvaluationAssertionResult[]> {
  boundedJson(assertions);
  const parsed = assertionSchema.array().safeParse(assertions);
  if (!parsed.success) throw new EvaluationError("EVALUATION_ASSERTIONS_INVALID");
  const safeContext = Object.freeze({ ...context, observation: freezeEvaluationData(parseData(context.observation)), history: evaluationSnapshot(context.history),
    ...(context.cases === undefined ? {} : { cases: evaluationSnapshot(context.cases) }),
  });
  const results = [];
  for (const assertion of parsed.data) results.push(await evaluate(assertion, safeContext, evaluators));
  return results;
}
