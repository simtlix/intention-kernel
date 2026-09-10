import { describe, expect, it } from "vitest";
import { evaluateAssertions, runEvaluation } from "../../src/testing/index.js";
import type { EvaluationCaseResult, EvaluationContext, EvaluationReport, EvaluationSuite } from "../../src/testing/index.js";

const custom = { id: "evidence", kind: "custom" as const, evaluator: "inspect", parameters: {} };
const suite: EvaluationSuite = { schemaVersion: 1, id: "memory", name: "Memory", assertions: [custom], scenarios: Array.from({ length: 4 }, (_, index) => ({
  id: `case-${String(index)}`, name: "Case", writePolicy: "read_only" as const, assertions: [custom],
  steps: [{ id: "one", input: {} }, { id: "two", input: {} }],
})) };

describe("evaluation evidence snapshots", () => {
  it("cannot replace shared context fields to influence a later assertion", async () => {
    const results = await evaluateAssertions([custom, { id: "original", kind: "check", path: ["valid"], operator: "equals", value: false }],
      { observation: { valid: false }, history: [], cases: [] }, { inspect(context) {
        const blocked = !Reflect.set(context, "observation", { valid: true })
          && !Reflect.set(context, "history", [{ forged: true }])
          && !Reflect.set(context, "cases", [{ forged: true }])
          && !Reflect.set(context, "signal", AbortSignal.abort());
        return { passed: blocked };
      } });
    expect(results).toMatchObject([{ passed: true }, { passed: true }]);
  });
  it("reuses deeply immutable persisted evidence at case and suite boundaries", async () => {
    let latest: EvaluationReport | undefined;
    const seen: EvaluationContext[] = [];
    const report = await runEvaluation({ suite, target: { id: "local", fingerprint: "v1" }, concurrency: 2,
      adapter: { id: "memory", version: "1", open() { return Promise.resolve({ send() {
        return Promise.resolve({ observation: { records: Array.from({ length: 4000 }, (_, id) => ({ id, value: "evidence" })) }, checkpoint: { retained: Array.from({ length: 4000 }, (_, id) => ({ id })) } });
      } }); } },
      onCheckpoint(value) { latest = value; },
      evaluators: { inspect(context) {
        seen.push(context);
        const entries = context.cases ?? latest?.cases.filter((entry) => entry.turns === context.history) ?? [];
        const sameEvidence = context.cases === undefined
          ? entries.length === 1
          : context.cases.every((entry, index) => entry === latest?.cases[index]);
        const observation = entries[0]?.turns[0]?.observation;
        const checkpoint = entries[0]?.turns[0]?.checkpoint;
        return { passed: sameEvidence && Object.isFrozen(context.history) && Object.isFrozen(observation) && Object.isFrozen(checkpoint)
          && (observation === undefined || !Reflect.set(observation, "tampered", true)) };
      } },
    });
    expect(seen).toHaveLength(5);
    expect(report.assertions).toMatchObject([{ passed: true }]);
    expect(report.cases.every((entry) => entry.assertions[0]?.passed === true)).toBe(true);
    expect(report.cases.every((entry) => entry.turns[0]?.observation?.["tampered"] === undefined)).toBe(true);
  });

  it("isolates external mutable evidence even when its root is already frozen", async () => {
    const nested = { value: "original" };
    const entry: EvaluationCaseResult = { id: "case", name: "Case", scenarioId: "case", repetition: 1, variants: {}, threadId: "thread", status: "passed", assertions: [],
      turns: [{ stepId: "one", turnId: "turn", input: {}, observation: { nested }, assertions: [], status: "passed", durationMs: 1 }],
    };
    const cases = Object.freeze([entry]);
    let isolated = false;
    const results = await evaluateAssertions([custom, { ...custom, id: "again" }], { observation: {}, history: entry.turns, cases }, {
      inspect(context) {
        const received = context.cases?.[0]?.turns[0]?.observation?.["nested"];
        isolated = context.cases !== cases && context.history !== entry.turns && Object.isFrozen(received);
        return { passed: typeof received === "object" && received !== null && !Reflect.set(received, "value", "modified") };
      },
    });
    expect(isolated).toBe(true);
    expect(results.every(({ passed }) => passed)).toBe(true);
    expect(nested.value).toBe("original");
    expect(Object.isFrozen(nested)).toBe(false);
  });
});
