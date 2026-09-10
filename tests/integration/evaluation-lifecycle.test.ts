import { describe, expect, it } from "vitest";
import { evaluateAssertions, parseEvaluationReport, parseEvaluationSuite, runEvaluation } from "../../src/testing/index.js";
import type { EvaluationAdapter, EvaluationReport, EvaluationSuite } from "../../src/testing/index.js";

const definition = (count = 1): EvaluationSuite => ({ schemaVersion: 1, id: "suite", name: "Suite", scenarios: Array.from({ length: count }, (_, index) => ({
  id: `case${String(index)}`, name: `Case ${String(index)}`, writePolicy: "read_only", steps: [
    { id: "one", input: { text: "One" } }, { id: "two", input: { text: "Two" } },
  ],
})) });
const target = { id: "test", fingerprint: "v1" };
const adapter: EvaluationAdapter = { id: "test", version: "1", open() {
  return Promise.resolve({ send(input) { return Promise.resolve({ observation: input }); } });
} };

describe("evaluation scheduling and portability", () => {
  it("shares immutable unchanged evidence between checkpoints without rescanning completed cases", async () => {
    const checkpoints: EvaluationReport[] = [];
    await runEvaluation({ suite: definition(2), target, adapter, onCheckpoint(report) { checkpoints.push(report); } });
    const finished = checkpoints.find((report) => report.cases[0]?.status === "passed");
    const later = checkpoints.at(-1);
    expect(finished).toBeDefined();
    expect(later?.cases[0]).toBe(finished?.cases[0]);
    expect(Object.isFrozen(later?.cases[0]?.turns[0]?.observation)).toBe(true);
    expect(checkpoints[0]?.cases[0]?.turns).toHaveLength(0);
  });
  it("keeps checkpoint summaries consistent while another case is still cleaning up", async () => {
    let releaseSecond = (): void => undefined;
    let releaseFirst = (): void => undefined;
    const firstClosing = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const secondClosed = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const snapshots: EvaluationReport[] = [];
    await runEvaluation({ suite: definition(2), target, concurrency: 2, adapter: { ...adapter, open(context) {
      const first = context.scenario.id === "case0";
      return Promise.resolve({ async send(input) {
        if (!first) await firstClosing;
        return { observation: input };
      }, async close() {
        if (first) { releaseSecond(); await secondClosed; }
        else releaseFirst();
      } });
    } }, onCheckpoint(report) { snapshots.push(report); } });
    for (const report of snapshots) expect(() => parseEvaluationReport(report)).not.toThrow();
  });
  it("accepts a multi-case report larger than one observation without removing its per-value limits", async () => {
    const report = await runEvaluation({ suite: definition(5), target, adapter });
    const expanded = { ...report, cases: report.cases.map((entry) => ({ ...entry, turns: entry.turns.map((turn) => ({ ...turn, observation: { values: Array.from({ length: 60000 }, () => 1) } })) })) };
    expect(parseEvaluationReport(expanded).cases).toHaveLength(5);
  });
  it("bounds parallelism without interleaving the steps of one case", async () => {
    let active = 0; let maximum = 0;
    const sessions = new Set<string>();
    const report = await runEvaluation({ suite: definition(5), target, concurrency: 2, adapter: {
      ...adapter, open(context) {
        active++; maximum = Math.max(maximum, active); sessions.add(context.threadId);
        let step = 0;
        return Promise.resolve({ async send(input) {
          expect(input["text"]).toBe(step++ === 0 ? "One" : "Two");
          await new Promise((resolve) => { setTimeout(resolve, 5); });
          return { observation: input };
        }, close() { active--; return Promise.resolve(); } });
      },
    } });
    expect(maximum).toBe(2); expect(active).toBe(0); expect(sessions.size).toBe(5);
    expect(report.summary.passed).toBe(5);
  });

  it("leaves unscheduled cases pending when the accumulated failure limit is reached", async () => {
    const report = await runEvaluation({ suite: definition(5), target, maxFailures: 2, adapter: {
      ...adapter, open() { throw new Error("private error"); },
    } });
    expect(report.status).toBe("limited");
    expect(report.summary).toMatchObject({ total: 5, error: 2, pending: 3, passed: 0 });
    expect(JSON.stringify(report)).not.toContain("private error");
  });

  it("expands step alternatives and repetitions as separate sessions", async () => {
    const suite = parseEvaluationSuite({ ...definition(), scenarios: [{
      id: "variants", name: "Variants", writePolicy: "read_only", steps: [{
        id: "first", input: { text: "baseline" }, variants: [
          { id: "short", input: { text: "Hi" } }, { id: "long", input: { text: "Hello there" } },
        ],
      }],
    }] });
    const report = await runEvaluation({ suite, target, adapter, repetitions: 2 });
    expect(report.summary.total).toBe(4);
    expect(new Set(report.cases.map(({ threadId }) => threadId)).size).toBe(4);
    expect(report.cases.map((entry) => entry.turns[0]?.input["text"])).toEqual(["Hi", "Hi", "Hello there", "Hello there"]);
    await expect(runEvaluation({ suite, target, adapter, repetitions: 2, maxCases: 3 })).rejects.toThrow("EVALUATION_CASE_LIMIT");
  });

  it("resumes a saved healthy prefix only through a checkpoint-aware adapter", async () => {
    const cancellation = new AbortController();
    const calls: string[] = [];
    const resumable: EvaluationAdapter = { ...adapter, supportsResume: true, open(context) {
      let count = context.checkpoint?.["count"] ?? 0;
      return Promise.resolve({ send(input) {
        if (typeof count !== "number") throw new Error("bad state");
        count++; calls.push(String(count));
        return Promise.resolve({ observation: input, checkpoint: { count } });
      } });
    } };
    const first = await runEvaluation({ suite: definition(), target, adapter: resumable, signal: cancellation.signal,
      onEvent(event) { if (event.type === "turn.completed") cancellation.abort(); },
    });
    expect(first.status).toBe("cancelled"); expect(first.cases[0]?.turns).toHaveLength(1);
    const resumed = await runEvaluation({ suite: definition(), target, adapter: resumable, resume: JSON.parse(JSON.stringify(first)) as EvaluationReport });
    expect(calls).toEqual(["1", "2"]);
    expect(resumed.summary.passed).toBe(1);
    expect(resumed.cases[0]?.threadId).toBe(first.cases[0]?.threadId);
    expect(resumed.cases[0]?.errorCode).toBeUndefined();
  });

  it("evaluates final assertions when the adapter completes on the last defined step", async () => {
    let checked = 0;
    const suite = parseEvaluationSuite({ ...definition(), scenarios: [{
      id: "final", name: "Final", writePolicy: "read_only", steps: [{ id: "one", input: {} }],
      assertions: [{ id: "contract", kind: "custom", evaluator: "final", parameters: {} }],
    }] });
    const report = await runEvaluation({ suite, target, adapter: { ...adapter, open() {
      return Promise.resolve({ send() { return Promise.resolve({ observation: {}, stop: { status: "completed", reason: "Conversation complete" } }); } });
    } }, evaluators: { final() { checked++; return { passed: false }; } } });
    expect(checked).toBe(1);
    expect(report.cases[0]?.assertions).toMatchObject([{ id: "contract", passed: false }]);
    expect(report.summary).toMatchObject({ passed: 0, failed: 1 });
  });

  it("persists progress without converting a timed-out operation into a passing case", async () => {
    const report = await runEvaluation({ suite: definition(), target, timeoutMs: 10, adapter: {
      ...adapter, open() { return Promise.resolve({ send() { return new Promise(() => undefined); } }); },
    } });
    expect(report.summary.error).toBe(1);
    expect(report.cases[0]?.turns[0]?.errorCode).toBe("EVALUATION_TIMEOUT");
  });

  it("stops scheduling if durable checkpoint storage fails", async () => {
    let opened = 0;
    await expect(runEvaluation({ suite: definition(3), target, adapter: { ...adapter, open(context) { opened++; return adapter.open(context); } },
      onCheckpoint(report) { if (report.cases.some((entry) => entry.turns.length > 0)) throw new Error("database unavailable"); },
    })).rejects.toThrow("EVALUATION_OBSERVER_FAILED");
    expect(opened).toBe(1);
  });

  it("rejects malformed resume statuses instead of silently counting them", async () => {
    const first = await runEvaluation({ suite: definition(), target, adapter });
    const corrupt = JSON.parse(JSON.stringify(first)) as { cases: { status: string }[] };
    const firstCase = corrupt.cases[0];
    if (firstCase === undefined) throw new Error("missing fixture case");
    firstCase.status = "invented";
    await expect(runEvaluation({ suite: definition(), target, adapter, resume: corrupt as unknown as EvaluationReport })).rejects.toThrow("EVALUATION_RESUME_INVALID");
  });

  it("does not turn evaluator errors into passes with any/not", async () => {
    const results = await evaluateAssertions([
      { id: "not", kind: "not", assertion: { id: "broken", kind: "custom", evaluator: "missing", parameters: {} } },
      { id: "any", kind: "any", assertions: [
        { id: "ok", kind: "check", path: [], operator: "equals", value: {} },
        { id: "broken", kind: "custom", evaluator: "missing", parameters: {} },
      ] },
    ], { observation: {}, history: [] });
    expect(results.map(({ passed }) => passed)).toEqual([false, false]);
  });

  it("rejects cycles and prototype paths without evaluating user code", () => {
    const cyclic: Record<string, unknown> = {}; cyclic["self"] = cyclic;
    expect(() => parseEvaluationSuite(cyclic)).toThrow("EVALUATION_DATA_CYCLE");
    expect(() => parseEvaluationSuite({ ...definition(), scenarios: [{ id: "unsafe", name: "Unsafe", writePolicy: "read_only", steps: [{ id: "one", input: {}, assertions: [
      { id: "proto", kind: "check", path: ["__proto__"], operator: "exists" },
    ] }] }] })).toThrow("EVALUATION_SUITE_INVALID");
  });

  it("does not replay an uncertain external write as a new request on retry-failed", async () => {
    let requests = 0;
    const suite = parseEvaluationSuite({ ...definition(), scenarios: [{ id: "write", name: "Write", writePolicy: "external", steps: [{ id: "send", input: {} }] }] });
    const writing: EvaluationAdapter = { ...adapter, open() { return Promise.resolve({ send() {
      requests++; throw new Error("write may already be committed");
    } }); } };
    const first = await runEvaluation({ suite, target, adapter: writing, allowExternalWrites: true });
    const next = await runEvaluation({ suite, target, adapter: writing, allowExternalWrites: true, resume: first, retryFailed: true });
    expect(requests).toBe(1);
    expect(next.cases[0]?.errorCode).toBe("EXTERNAL_WRITE_RETRY_REQUIRES_RECONCILIATION");
    expect(next.summary.blocked).toBe(1);
  });

  it("does not accept a passed turn whose assertion evidence reports a failure", async () => {
    const first = await runEvaluation({ suite: definition(), target, adapter });
    const entry = first.cases[0]; const turn = entry?.turns[0];
    if (entry === undefined || turn === undefined) throw new Error("missing fixture");
    const corrupt = { ...first, cases: [{ ...entry, turns: [{ ...turn, assertions: [{ id: "lied", passed: false }] }, ...entry.turns.slice(1)] }] };
    await expect(runEvaluation({ suite: definition(), target, adapter, resume: corrupt })).rejects.toThrow("EVALUATION_RESUME_INVALID");
  });

  it("keeps request identities bounded even with the longest supported step names", async () => {
    const suite = parseEvaluationSuite({ ...definition(), scenarios: [{ id: "long", name: "Long", writePolicy: "read_only", steps: [{ id: "s".repeat(160), input: {} }] }] });
    const report = await runEvaluation({ suite, target, adapter });
    expect(report.cases[0]?.turns[0]?.turnId.length).toBeLessThanOrEqual(160);
  });

  it("blocks external-write recovery from a crash before the first turn receipt was persisted", async () => {
    const suite = parseEvaluationSuite({ ...definition(), scenarios: [{ id: "write", name: "Write", writePolicy: "external", steps: [{ id: "send", input: {} }] }] });
    let interrupted: EvaluationReport | undefined;
    await runEvaluation({ suite, target, adapter, allowExternalWrites: true, onCheckpoint(report) {
      if (report.cases[0]?.status === "running" && report.cases[0].turns.length === 0) interrupted = report;
    } });
    if (interrupted === undefined) throw new Error("missing checkpoint");
    const next = await runEvaluation({ suite, target, adapter, resume: interrupted, allowExternalWrites: true });
    expect(next.cases[0]?.errorCode).toBe("EXTERNAL_WRITE_RESUME_REQUIRES_RECONCILIATION");
    expect(next.summary.blocked).toBe(1);
  });
});
