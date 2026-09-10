import { z } from "zod";
import type { EvaluationAssertion, EvaluationData, EvaluationSuite, EvaluationValue } from "./types.js";

/** Stable public failure for invalid definitions, reports or execution options. */
export class EvaluationError extends Error {
  /** Machine-readable error identity; never includes secret input values. */
  readonly code: string;
  /** Safe field locations that failed validation. */
  readonly paths: readonly string[];
  /** Construct an evaluation error with stable code and optional field paths. */
  constructor(code: string, paths: readonly string[] = []) {
    super(code);
    this.name = "EvaluationError";
    this.code = code;
    this.paths = paths;
  }
}

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);
const json: z.ZodType<EvaluationValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(), z.array(json), z.record(z.string(), json),
]));
const data = z.record(z.string(), json);
const path = z.array(z.union([z.string().max(240).refine((key) => !["__proto__", "prototype", "constructor"].includes(key)), z.number().int().nonnegative()])).max(40);
const assertionBase = { id: identifier, label: z.string().max(500).optional() };
export const assertionSchema: z.ZodType<EvaluationAssertion> = z.lazy(() => z.union([
  z.object({ ...assertionBase, kind: z.literal("check"), path,
    operator: z.enum(["equals", "matches", "contains", "exists", "absent", "gte", "lte", "length"]),
    value: json.optional(),
  }).strict().superRefine((assertion, ctx) => {
    const { operator, value } = assertion;
    if (!["exists", "absent"].includes(operator) && value === undefined) ctx.addIssue({ code: "custom", message: "value required", path: ["value"] });
    if (["gte", "lte", "length"].includes(operator) && typeof value !== "number") ctx.addIssue({ code: "custom", message: "number required", path: ["value"] });
    if (operator === "length" && typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) ctx.addIssue({ code: "custom", message: "nonnegative integer required", path: ["value"] });
  }),
  z.object({ ...assertionBase, kind: z.enum(["all", "any"]), assertions: z.array(assertionSchema).min(1).max(100) }).strict(),
  z.object({ ...assertionBase, kind: z.literal("not"), assertion: assertionSchema }).strict(),
  z.object({ ...assertionBase, kind: z.literal("custom"), evaluator: identifier, parameters: data }).strict(),
]).transform((value): EvaluationAssertion => {
  const base = { id: value.id, ...(value.label === undefined ? {} : { label: value.label }) };
  switch (value.kind) {
    case "check": return { ...base, kind: value.kind, path: value.path, operator: value.operator, ...(value.value === undefined ? {} : { value: value.value }) };
    case "all": case "any": return { ...base, kind: value.kind, assertions: value.assertions };
    case "not": return { ...base, kind: value.kind, assertion: value.assertion };
    case "custom": return { ...base, kind: value.kind, evaluator: value.evaluator, parameters: value.parameters };
  }
}));
const assertions = z.array(assertionSchema).max(200);
const step = z.object({
  id: identifier, input: data, assertions: assertions.optional(),
  variants: z.array(z.object({ id: identifier, input: data }).strict()).min(1).max(100).optional(),
}).strict();
const scenario = z.object({
  id: identifier, name: z.string().trim().min(1).max(500), description: z.string().max(5000).optional(),
  tags: z.array(z.string().min(1).max(160)).max(100).optional(),
  writePolicy: z.enum(["read_only", "external"]), skipReason: z.string().trim().min(1).max(2000).optional(),
  metadata: data.optional(), steps: z.array(step).min(1).max(500), assertions: assertions.optional(),
}).strict();
const suiteSchema = z.object({
  schemaVersion: z.literal(1), id: identifier, name: z.string().trim().min(1).max(500),
  metadata: data.optional(), scenarios: z.array(scenario).min(1).max(10000), assertions: assertions.optional(),
}).strict();

// Check depth/cycles before recursive schema evaluation, and never traverse prototypes.
export function boundedJson(value: unknown): void {
  const active = new Set<object>();
  let count = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++count > 500000 || depth > 60) throw new EvaluationError("EVALUATION_DATA_LIMIT");
    if (item === null || typeof item !== "object") return;
    if (active.has(item)) throw new EvaluationError("EVALUATION_DATA_CYCLE");
    active.add(item);
    for (const nested of Object.values(item)) visit(nested, depth + 1);
    active.delete(item);
  };
  visit(value, 0);
}
export function parseData(value: unknown): EvaluationData {
  boundedJson(value);
  const result = data.safeParse(value);
  if (!result.success) throw new EvaluationError("EVALUATION_OBSERVATION_INVALID");
  return result.data;
}
function unique(ids: readonly string[], location: string): void {
  if (new Set(ids).size !== ids.length) throw new EvaluationError("EVALUATION_SUITE_INVALID", [location]);
}
function checkAssertions(values: readonly EvaluationAssertion[], location: string): void {
  unique(values.map(({ id }) => id), location);
  for (const value of values) {
    if (value.kind === "all" || value.kind === "any") checkAssertions(value.assertions, `${location}.${value.id}`);
    if (value.kind === "not") checkAssertions([value.assertion], `${location}.${value.id}`);
  }
}
/**
 * Parse a portable suite, rejecting unknown fields, duplicate IDs and unsafe paths.
 * @throws EvaluationError with field paths; input values are not included in errors.
 * @returns A detached definition safe to store or pass to runEvaluation.
 */
export function parseEvaluationSuite(value: unknown): EvaluationSuite {
  boundedJson(value);
  const parsed = suiteSchema.safeParse(value);
  if (!parsed.success) throw new EvaluationError("EVALUATION_SUITE_INVALID", parsed.error.issues.map(({ path }) => path.join(".")));
  unique(parsed.data.scenarios.map(({ id }) => id), "scenarios");
  checkAssertions(parsed.data.assertions ?? [], "assertions");
  for (const entry of parsed.data.scenarios) {
    unique(entry.steps.map(({ id }) => id), `scenarios.${entry.id}.steps`);
    checkAssertions(entry.assertions ?? [], `scenarios.${entry.id}.assertions`);
    for (const turn of entry.steps) {
      unique((turn.variants ?? []).map(({ id }) => id), `scenarios.${entry.id}.${turn.id}.variants`);
      checkAssertions(turn.assertions ?? [], `scenarios.${entry.id}.${turn.id}.assertions`);
    }
  }
  const result = parsed.data;
  return {
    schemaVersion: result.schemaVersion, id: result.id, name: result.name,
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
    ...(result.assertions === undefined ? {} : { assertions: result.assertions }),
    scenarios: result.scenarios.map((entry) => ({
      id: entry.id, name: entry.name, writePolicy: entry.writePolicy,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.tags === undefined ? {} : { tags: entry.tags }),
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      ...(entry.skipReason === undefined ? {} : { skipReason: entry.skipReason }),
      ...(entry.assertions === undefined ? {} : { assertions: entry.assertions }),
      steps: entry.steps.map((turn) => ({
        id: turn.id, input: turn.input,
        ...(turn.assertions === undefined ? {} : { assertions: turn.assertions }),
        ...(turn.variants === undefined ? {} : { variants: turn.variants }),
      })),
    })),
  };
}
