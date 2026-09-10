import { randomUUID } from "node:crypto";
import { evaluateAssertions } from "./assertions.js";
import { withDeadline } from "./deadline.js";
import { digest, expandCases, integer } from "./matrix.js";
import type { MatrixCase } from "./matrix.js";
import { EvaluationError, parseData, parseEvaluationSuite } from "./schema.js";
import { parseEvaluationReport } from "./report.js";
import { freezeEvaluationData as immutable } from "./snapshot.js";
import type { EvaluationAssertion, EvaluationAssertionResult, EvaluationCaseResult, EvaluationEvent, EvaluationOptions, EvaluationReport, EvaluationSession, EvaluationSummary, EvaluationTurnResult } from "./types.js";

type MutableCase = { -readonly [Key in keyof EvaluationCaseResult]: EvaluationCaseResult[Key] };
const terminal = new Set(["passed", "failed", "error", "skipped", "blocked"]);
function failureStatus(assertions: readonly EvaluationAssertionResult[]): "passed" | "failed" | "error" {
  return assertions.some(({ errorCode }) => errorCode !== undefined) ? "error" : assertions.every(({ passed }) => passed) ? "passed" : "failed";
}
function count(cases: readonly EvaluationCaseResult[]): EvaluationSummary {
  const summary = { total: cases.length, pending: 0, running: 0, passed: 0, failed: 0, error: 0, skipped: 0, blocked: 0, cancelled: 0 };
  for (const entry of cases) summary[entry.status]++;
  return summary;
}
function assertEvaluators(assertions: readonly EvaluationAssertion[], options: EvaluationOptions): void {
  for (const assertion of assertions) {
    if (assertion.kind === "custom" && (!Object.hasOwn(options.evaluators ?? {}, assertion.evaluator) || typeof options.evaluators?.[assertion.evaluator] !== "function")) throw new EvaluationError("EVALUATOR_NOT_FOUND", [assertion.evaluator]);
    if (assertion.kind === "all" || assertion.kind === "any") assertEvaluators(assertion.assertions, options);
    if (assertion.kind === "not") assertEvaluators([assertion.assertion], options);
  }
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new EvaluationError("EVALUATION_RESUME_INVALID");
  return value;
}
function validateResume(report: EvaluationReport, fingerprint: string, matrix: readonly MatrixCase[]): void {
  if (report.fingerprint !== fingerprint || report.cases.length !== matrix.length) throw new EvaluationError("EVALUATION_RESUME_INCOMPATIBLE");
  const ids = new Set<string>();
  for (const [index, entry] of report.cases.entries()) {
    const definition = required(matrix[index]);
    if (ids.has(entry.id) || entry.id !== definition.id || entry.turns.length > definition.steps.length) throw new EvaluationError("EVALUATION_RESUME_INVALID");
    ids.add(entry.id);
    for (const [offset, turn] of entry.turns.entries()) {
      const step = required(definition.steps[offset]);
      if (turn.stepId !== step.id || digest(turn.input) !== digest(step.input)) throw new EvaluationError("EVALUATION_RESUME_INVALID");
      if (turn.status === "passed" && (turn.observation === undefined || failureStatus(turn.assertions) !== "passed")) throw new EvaluationError("EVALUATION_RESUME_INVALID");
    }
    if (entry.status === "passed" && (entry.turns.length !== definition.steps.length || entry.turns.some((turn: EvaluationTurnResult) => turn.status !== "passed") || failureStatus(entry.assertions) !== "passed")) throw new EvaluationError("EVALUATION_RESUME_INVALID");
  }
}

/**
 * Execute isolated multi-turn cases using an application-owned adapter.
 *
 * @remarks Every transition emits a deeply immutable checkpoint before its event.
 * Unchanged case evidence retains object identity across checkpoints. Cases run
 * concurrently; exchanges within a case remain sequential. A failed expectation
 * does not stop other cases. No request is automatically retried. Cancellation and
 * deadlines cannot undo an external effect; inspect receipts before retrying it.
 * Resume requires an identical suite/selection/target/adapter fingerprint. Only
 * adapters declaring supportsResume may resume an incomplete conversation prefix.
 *
 * @throws EvaluationError for invalid inputs, incompatible resume or a failed observer.
 * @returns Complete case inventory with separate passed, failed, error, blocked and skipped counts.
 */
export async function runEvaluation(options: EvaluationOptions): Promise<EvaluationReport> {
  const suite = immutable(parseEvaluationSuite(options.suite));
  const concurrency = integer(options.concurrency, 1, 32);
  const timeoutMs = integer(options.timeoutMs, 120000, 3600000);
  const maxFailures = integer(options.maxFailures, 100000, 100000);
  if (typeof options.target.id !== "string" || options.target.id.length === 0 || typeof options.target.fingerprint !== "string" || options.target.fingerprint.length === 0 || typeof options.adapter.open !== "function" || !options.adapter.id || !options.adapter.version) throw new EvaluationError("EVALUATION_OPTIONS_INVALID");
  if (options.retryFailed === true && options.resume === undefined) throw new EvaluationError("EVALUATION_RESUME_REQUIRED");
  const matrix = expandCases(suite, options);
  assertEvaluators(suite.assertions ?? [], options);
  for (const item of matrix) {
    assertEvaluators(item.scenario.assertions ?? [], options);
    for (const step of item.steps) assertEvaluators(step.assertions ?? [], options);
  }
  const fingerprint = digest({ suite, cases: matrix.map(({ id }) => id), target: options.target, adapter: { id: options.adapter.id, version: options.adapter.version } });
  const resume = options.resume === undefined ? undefined : parseEvaluationReport(options.resume);
  if (resume !== undefined) validateResume(resume, fingerprint, matrix);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const cases: MutableCase[] = matrix.map((entry, index) => {
    const previous = resume?.cases[index];
    const fresh: MutableCase = { id: entry.id, name: entry.scenario.name, scenarioId: entry.scenario.id, repetition: entry.repetition, variants: entry.variants, threadId: `${runId}:${entry.id}`, status: "pending", turns: [], assertions: [] };
    if (previous === undefined) return fresh;
    if (entry.scenario.writePolicy === "external" && ["running", "cancelled"].includes(previous.status)) {
      // A process can disappear after sending an effect but before storing its
      // first receipt. An empty turn array is not evidence that nothing ran.
      return { ...structuredClone(previous), status: "blocked", errorCode: "EXTERNAL_WRITE_RESUME_REQUIRES_RECONCILIATION" };
    }
    if (options.retryFailed === true && ["failed", "error", "blocked", "cancelled"].includes(previous.status)) {
      if (entry.scenario.writePolicy === "external" && !(previous.status === "blocked" && previous.errorCode === "EXTERNAL_WRITES_NOT_AUTHORIZED")) return { ...structuredClone(previous), status: "blocked", errorCode: "EXTERNAL_WRITE_RETRY_REQUIRES_RECONCILIATION" };
      return fresh;
    }
    if (terminal.has(previous.status)) return structuredClone(previous);
    if (previous.turns.length === 0) return fresh;
    if (options.adapter.supportsResume !== true) return { ...structuredClone(previous), status: "blocked", errorCode: "TURN_RESUME_NOT_SUPPORTED" };
    const healthy = previous.turns.every(({ status }) => status === "passed" || status === "failed");
    const checkpoint = previous.turns.at(-1)?.checkpoint;
    if (!healthy || checkpoint === undefined) return { ...structuredClone(previous), status: "blocked", errorCode: "TURN_RESUME_UNSAFE" };
    const continued: MutableCase = { ...structuredClone(previous), status: "pending" };
    delete continued.errorCode;
    return continued;
  });
  const stop = new AbortController();
  const signal = options.signal === undefined ? stop.signal : AbortSignal.any([stop.signal, options.signal]);
  let state: EvaluationReport["status"] = "running";
  const lifecycle: { finishedAt?: string; observerFailure: boolean } = { observerFailure: false };
  let sequence = 0;
  let assertions: readonly EvaluationAssertionResult[] = [];
  let notificationQueue = Promise.resolve();
  const savedTarget = immutable(structuredClone(options.target));
  const positions = new Map(cases.map((entry, index) => [entry.id, index]));
  const savedCases: EvaluationCaseResult[] = cases.map((entry) => immutable({ ...entry }));
  const snapshot = (changedCaseId?: string): EvaluationReport => {
    if (changedCaseId !== undefined) {
      const index = required(positions.get(changedCaseId));
      savedCases[index] = immutable({ ...required(cases[index]) });
    }
    return immutable({
      schemaVersion: 1, runId, suite, fingerprint, startedAt, status: state,
      ...(lifecycle.finishedAt === undefined ? {} : { finishedAt: lifecycle.finishedAt }),
      ...(options.resume === undefined ? {} : { resumedFrom: options.resume.runId }),
      target: savedTarget, cases: [...savedCases], summary: count(savedCases), assertions,
    });
  };
  const publish = async (type: EvaluationEvent["type"], caseId?: string, stepId?: string): Promise<void> => {
    const saved = snapshot(caseId);
    const event: EvaluationEvent = { sequence: ++sequence, type, runId, ...(caseId === undefined ? {} : { caseId }), ...(stepId === undefined ? {} : { stepId }) };
    notificationQueue = notificationQueue.then(async () => {
      try {
        await withDeadline(new AbortController().signal, timeoutMs, async () => {
          await options.onCheckpoint?.(saved);
          await options.onEvent?.(event);
        });
      } catch {
        lifecycle.observerFailure = true;
        stop.abort();
        throw new EvaluationError("EVALUATION_OBSERVER_FAILED");
      }
    });
    await notificationQueue;
  };
  const executeCase = async (definition: MatrixCase, entry: MutableCase): Promise<void> => {
    if (definition.scenario.skipReason !== undefined) {
      entry.status = "skipped"; entry.skipReason = definition.scenario.skipReason;
      await publish("case.completed", entry.id); return;
    }
    if (definition.scenario.writePolicy === "external" && options.allowExternalWrites !== true) {
      entry.status = "blocked"; entry.errorCode = "EXTERNAL_WRITES_NOT_AUTHORIZED";
      await publish("case.completed", entry.id); return;
    }
    entry.status = "running";
    await publish("case.started", entry.id);
    let session: EvaluationSession | undefined;
    let stoppedEarly = false;
    try {
      const checkpoint = entry.turns.at(-1)?.checkpoint;
      session = await withDeadline(signal, timeoutMs, async (openSignal) => {
        const opened = await options.adapter.open({ runId, caseId: entry.id, threadId: entry.threadId, scenario: definition.scenario, signal: openSignal, ...(checkpoint === undefined ? {} : { checkpoint }) });
        if (openSignal.aborted) { await opened.close?.(); throw new EvaluationError("EVALUATION_CANCELLED"); }
        return opened;
      });
      for (let index = entry.turns.length; index < definition.steps.length; index++) {
        if (signal.aborted) throw new EvaluationError("EVALUATION_CANCELLED");
        const step = required(definition.steps[index]);
        const turnId = `eval.${digest({ threadId: entry.threadId, stepId: step.id })}`;
        const start = performance.now();
        let turn: EvaluationTurnResult;
        try {
          const currentSession = session;
          const result = await withDeadline(signal, timeoutMs, async (turnSignal) => {
            const result = await currentSession.send(structuredClone(step.input), { turnId, stepId: step.id, signal: turnSignal });
            const observation = parseData(result.observation);
            const assertions = await evaluateAssertions(step.assertions ?? [], { observation, history: entry.turns, signal: turnSignal }, options.evaluators);
            return { result, observation, assertions };
          });
          turn = { stepId: step.id, turnId, input: step.input, observation: result.observation, assertions: result.assertions,
            status: failureStatus(result.assertions), durationMs: Math.round(performance.now() - start),
            ...(result.result.checkpoint === undefined ? {} : { checkpoint: parseData(result.result.checkpoint) }),
          };
          if (result.result.stop !== undefined) {
            if (result.result.stop.status === "skipped") { entry.skipReason = result.result.stop.reason; entry.status = "skipped"; }
            else if (index !== definition.steps.length - 1) { entry.status = "blocked"; entry.errorCode = "EVALUATION_EARLY_COMPLETION"; }
            stoppedEarly = result.result.stop.status === "skipped" || index !== definition.steps.length - 1;
          }
        } catch (error) {
          const code = error instanceof EvaluationError ? error.code : "EVALUATION_TRANSPORT_FAILED";
          turn = { stepId: step.id, turnId, input: step.input, assertions: [], durationMs: Math.round(performance.now() - start), status: code === "EVALUATION_CANCELLED" ? "cancelled" : "error", errorCode: code };
        }
        entry.turns = [...entry.turns, turn];
        await publish("turn.completed", entry.id, step.id);
        if (turn.status === "error" || turn.status === "cancelled" || stoppedEarly) break;
      }
      const observation = entry.turns.at(-1)?.observation;
      if (!stoppedEarly && entry.turns.length === definition.steps.length && observation !== undefined) {
        entry.assertions = await withDeadline(signal, timeoutMs, (assertionSignal) => evaluateAssertions(definition.scenario.assertions ?? [], { observation, history: entry.turns, signal: assertionSignal }, options.evaluators));
      }
      if (!stoppedEarly) {
        entry.status = entry.turns.some(({ status }) => status === "cancelled") ? "cancelled"
          : entry.turns.some(({ status }) => status === "error") ? "error"
          : entry.turns.some(({ status }) => status === "failed") ? "failed" : failureStatus(entry.assertions);
        if (entry.turns.length !== definition.steps.length && entry.status === "passed") { entry.status = "blocked"; entry.errorCode = "EVALUATION_INCOMPLETE"; }
      } else if (entry.turns.some(({ status }) => status === "error" || status === "failed")) {
        entry.status = entry.turns.some(({ status }) => status === "error") ? "error" : "failed";
      } else if (entry.status === "running") entry.status = failureStatus(entry.assertions);
    } catch (error) {
      if (lifecycle.observerFailure) throw error;
      entry.errorCode = error instanceof EvaluationError ? error.code : "EVALUATION_SESSION_FAILED";
      entry.status = entry.errorCode === "EVALUATION_CANCELLED" ? "cancelled" : "error";
    } finally {
      const close = session?.close?.bind(session);
      if (close !== undefined) {
        try { await withDeadline(new AbortController().signal, timeoutMs, close); }
        catch { entry.status = "error"; entry.errorCode = "EVALUATION_CLEANUP_FAILED"; }
      }
    }
    await publish("case.completed", entry.id);
  };
  await publish("run.started");
  let cursor = 0;
  let failures = 0;
  const worker = async (): Promise<void> => {
    while (cursor < matrix.length && !signal.aborted && failures < maxFailures) {
      const index = cursor++;
      const entry = required(cases[index]);
      if (entry.status !== "pending") continue;
      await executeCase(required(matrix[index]), entry);
      if (["failed", "error"].includes(entry.status)) failures++;
    }
  };
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  if (lifecycle.observerFailure || outcomes.some(({ status }) => status === "rejected")) throw new EvaluationError("EVALUATION_OBSERVER_FAILED");
  state = signal.aborted ? "cancelled" : cases.some(({ status }) => status === "pending") ? "limited" : "completed";
  try {
    assertions = await withDeadline(new AbortController().signal, timeoutMs, (assertionSignal) => evaluateAssertions(
      suite.assertions ?? [], { observation: { summary: count(cases), status: state }, history: [], cases: immutable([...savedCases]), signal: assertionSignal }, options.evaluators,
    ));
  } catch (error) {
    assertions = [{ id: "evaluation.suite", passed: false, errorCode: error instanceof EvaluationError ? error.code : "EVALUATOR_FAILED" }];
  }
  lifecycle.finishedAt = new Date().toISOString();
  await publish("run.completed");
  return snapshot();
}
