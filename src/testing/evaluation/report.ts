import { z } from "zod";
import { boundedJson, EvaluationError, parseData, parseEvaluationSuite } from "./schema.js";
import type { EvaluationReport } from "./types.js";

const string = z.string().min(1);
const data = z.unknown().transform((value) => parseData(value));
const result: z.ZodType = z.lazy(() => z.object({
  id: string, label: z.string().optional(), passed: z.boolean(),
  actual: z.object({ present: z.boolean(), value: z.json().optional() }).strict().optional(),
  expected: z.json().optional(), errorCode: string.optional(), evidence: data.optional(),
  children: z.array(result).optional(),
}).strict());
const assertions = z.preprocess((value) => { boundedJson(value); return value; }, z.array(result).max(200));
const turn = z.object({
  stepId: string, turnId: string, input: data,
  status: z.enum(["passed", "failed", "error", "cancelled"]),
  observation: data.optional(), assertions, errorCode: string.optional(),
  durationMs: z.number().nonnegative(), checkpoint: data.optional(),
}).strict();
const caseResult = z.object({
  id: string, scenarioId: string, name: string, repetition: z.number().int().nonnegative(),
  variants: z.record(z.string(), string), threadId: string,
  status: z.enum(["pending", "running", "passed", "failed", "error", "cancelled", "skipped", "blocked"]),
  turns: z.array(turn).max(500), assertions, errorCode: string.optional(), skipReason: string.optional(),
}).strict();
const number = z.number().int().nonnegative();
const reportSchema = z.object({
  schemaVersion: z.literal(1), runId: string, resumedFrom: string.optional(),
  suite: z.unknown().transform((value) => parseEvaluationSuite(value)),
  fingerprint: string, target: z.object({ id: string, fingerprint: string }).strict(),
  startedAt: string, finishedAt: string.optional(),
  status: z.enum(["running", "completed", "cancelled", "limited"]),
  cases: z.array(caseResult).max(100000),
  assertions: assertions.optional(),
  summary: z.object({ total: number, pending: number, running: number, passed: number, failed: number,
    error: number, skipped: number, blocked: number, cancelled: number }).strict(),
}).strict();

/**
 * Validate an imported execution report before display or resume.
 * @throws EvaluationError for malformed data or inconsistent summary counts.
 * @remarks This checks structure, not authenticity. Hosts must authorize report storage and access.
 */
export function parseEvaluationReport(value: unknown): EvaluationReport {
  // Bound each independent payload, not the aggregate experiment. Applying one
  // observation's budget to all cases made valid large runs impossible to resume.
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) throw new EvaluationError("EVALUATION_RESUME_INVALID", parsed.error.issues.map(({ path }) => path.join(".")));
  // Zod has validated recursive values; optional undefined properties are omitted by
  // the JSON report format. This cast preserves the stricter public optional types.
  const report = parsed.data as EvaluationReport;
  const states = ["pending", "running", "passed", "failed", "error", "skipped", "blocked", "cancelled"] as const;
  if (report.summary.total !== report.cases.length || states.some((status) => report.summary[status] !== report.cases.filter((entry) => entry.status === status).length)) throw new EvaluationError("EVALUATION_RESUME_INVALID");
  return report;
}
