import assert from "node:assert/strict";
import process from "node:process";

import { VERSION } from "intention-kernel";
import { TESTING_VERSION } from "intention-kernel/testing";
import * as testing from "intention-kernel/testing";

const expectedVersion = process.argv[2];
assert.equal(typeof expectedVersion, "string", "Pass the installed package version");
assert.equal(VERSION, expectedVersion, "Runtime version must identify the installed artifact");
assert.equal(TESTING_VERSION, expectedVersion, "Testing version must identify the same artifact");

assert.deepEqual(Object.keys(testing).sort(), [
  "EvaluationError", "TESTING_VERSION", "createAgentEvaluationAdapter", "createEventCollector",
  "createMemoryDurability", "evaluateAssertions", "parseEvaluationReport", "parseEvaluationSuite", "runEvaluation",
].sort(), "The installed testing module must expose the complete public API");
for (const [name, value] of Object.entries(testing)) {
  assert.equal(typeof value, name === "TESTING_VERSION" ? "string" : "function", `${name} must be usable at runtime`);
}
await assert.rejects(import("intention-kernel/dist/testing/index.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
await assert.rejects(import("intention-kernel/src/index.ts"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
