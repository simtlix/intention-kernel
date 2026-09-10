import { describe, expect, it } from "vitest";
import * as testing from "../../src/testing/index.js";

const suite = {
  schemaVersion: 1,
  id: "support",
  name: "Support conversations",
  scenarios: [{
    id: "greet", name: "Greeting", writePolicy: "read_only",
    steps: [{ id: "hello", input: { text: "Hello" }, assertions: [
      { id: "reply", kind: "check", path: ["response", "grounded"], operator: "equals", value: true },
    ] }],
  }],
};
const greeting = suite.scenarios[0];
if (greeting === undefined) throw new Error("Missing greeting fixture");

describe("evaluation public contract", () => {
  it("exports an independent suite parser, evaluator and runner", () => {
    expect(testing).toHaveProperty("parseEvaluationSuite", expect.any(Function));
    expect(testing).toHaveProperty("evaluateAssertions", expect.any(Function));
    expect(testing).toHaveProperty("runEvaluation", expect.any(Function));
  });

  it("rejects duplicate scenario identities and unknown assertion operators", () => {
    expect(() => testing.parseEvaluationSuite({ ...suite, scenarios: [...suite.scenarios, ...suite.scenarios] }))
      .toThrow("EVALUATION_SUITE_INVALID");
    const invalid = structuredClone(suite);
    const assertion = invalid.scenarios[0]?.steps[0]?.assertions[0];
    if (assertion === undefined) throw new Error("Missing assertion fixture");
    assertion.operator = "execute-javascript";
    expect(() => testing.parseEvaluationSuite(invalid)).toThrow("EVALUATION_SUITE_INVALID");
  });

  it("distinguishes missing paths from explicit null and compares nested values", async () => {
    const results = await testing.evaluateAssertions([
      { id: "null", kind: "check", path: ["nullable"], operator: "equals", value: null },
      { id: "missing", kind: "check", path: ["missing"], operator: "equals", value: null },
      { id: "exists", kind: "check", path: ["nullable"], operator: "exists" },
      { id: "nested", kind: "check", path: ["facts"], operator: "contains", value: { type: "item", value: { id: 7 } } },
    ], { observation: { nullable: null, facts: [{ type: "item", value: { id: 7, name: "Seven" } }] }, history: [] });
    expect(results.map((entry) => entry.passed)).toEqual([true, false, true, true]);
    expect(results[1]?.actual).toEqual({ present: false });
  });

  it("keeps custom evaluator errors distinct from failed business expectations", async () => {
    const results = await testing.evaluateAssertions([
      { id: "unknown", kind: "custom", evaluator: "missing", parameters: {} },
      { id: "failed", kind: "custom", evaluator: "quality", parameters: {} },
    ], { observation: {}, history: [] }, {
      quality: () => { throw new Error("private upstream body"); },
    });
    expect(results.map((entry) => entry.errorCode)).toEqual(["EVALUATOR_NOT_FOUND", "EVALUATOR_FAILED"]);
    expect(JSON.stringify(results)).not.toContain("private upstream");
  });
});

describe("evaluation execution", () => {
  it("persists cross-case assertions without rewriting individual case outcomes", async () => {
    const report = await testing.runEvaluation({
      suite: testing.parseEvaluationSuite({ ...suite, assertions: [
        { id: "distinct", kind: "custom", evaluator: "distinct", parameters: {} },
      ], scenarios: [greeting, { ...greeting, id: "other" }] }),
      target: { id: "demo", fingerprint: "v1" },
      adapter: { id: "test", version: "1", open: () => Promise.resolve({
        send: () => Promise.resolve({ observation: { receipt: "same", response: { grounded: true } } }),
      }) },
      evaluators: { distinct: ({ cases }) => ({
        passed: new Set(cases?.map((entry) => entry.turns[0]?.observation?.["receipt"])).size === 2,
        evidence: { caseCount: cases?.length ?? 0 },
      }) },
    });
    expect(report.summary.passed).toBe(2);
    expect(report.assertions).toMatchObject([{ id: "distinct", passed: false, evidence: { caseCount: 2 } }]);
    expect(testing.parseEvaluationReport(report).assertions).toEqual(report.assertions);
  });
  it("executes every sequential turn, records evidence and does not hide failures", async () => {
    const parsed = testing.parseEvaluationSuite({ ...suite, scenarios: [
      { ...suite.scenarios[0], steps: [
        ...greeting.steps,
        { id: "again", input: { text: "Again" }, assertions: [] },
      ] },
      { ...suite.scenarios[0], id: "second" },
    ] });
    const seen: string[] = [];
    let closed = 0;
    const snapshots: testing.EvaluationReport[] = [];
    const report = await testing.runEvaluation({
      suite: parsed, target: { id: "demo", fingerprint: "runtime-1" },
      adapter: { id: "test", version: "1", open(context) {
        return Promise.resolve({
          send(input) {
            if (typeof input["text"] !== "string") throw new Error("Expected text");
            seen.push(`${context.scenario.id}:${input["text"]}`);
            return Promise.resolve({ observation: { response: { grounded: false }, events: [{ type: "decision" }] } });
          },
          close() { closed++; return Promise.resolve(); },
        });
      } },
      onCheckpoint(report) { snapshots.push(report); },
    });
    expect(seen).toEqual(["greet:Hello", "greet:Again", "second:Hello"]);
    expect(closed).toBe(2);
    expect(report.status).toBe("completed");
    expect(report.summary).toMatchObject({ total: 2, passed: 0, failed: 2, pending: 0 });
    expect(report.cases[0]?.turns[0]?.observation?.["events"]).toEqual([{ type: "decision" }]);
    expect(snapshots.some((snapshot) => snapshot.cases[0]?.turns.length === 1)).toBe(true);
    expect(snapshots[0]?.cases[0]?.turns).toHaveLength(0);
  });

  it("never starts external-write scenarios without explicit authorization", async () => {
    let opened = false;
    const report = await testing.runEvaluation({
      suite: testing.parseEvaluationSuite({ ...suite, scenarios: [{ ...suite.scenarios[0], writePolicy: "external" }] }),
      target: { id: "demo", fingerprint: "v1" },
      adapter: { id: "test", version: "1", open() { opened = true; throw new Error("unexpected"); } },
    });
    expect(opened).toBe(false);
    expect(report.summary).toMatchObject({ blocked: 1, passed: 0 });
    expect(report.cases[0]?.errorCode).toBe("EXTERNAL_WRITES_NOT_AUTHORIZED");
  });

  it("rejects resume from another runtime rather than silently reusing green results", async () => {
    const options: testing.EvaluationOptions = {
      suite: testing.parseEvaluationSuite(suite), target: { id: "demo", fingerprint: "v1" },
      adapter: { id: "test", version: "1", open() { return Promise.resolve({ send() {
        return Promise.resolve({ observation: { response: { grounded: true } } });
      } }); } },
    };
    const first = await testing.runEvaluation(options);
    await expect(testing.runEvaluation({ ...options, target: { id: "demo", fingerprint: "v2" }, resume: first }))
      .rejects.toThrow("EVALUATION_RESUME_INCOMPATIBLE");
  });
});
