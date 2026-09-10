import assert from "node:assert/strict";

const library = await import("../../dist/index.js");
const testing = await import("../../dist/testing/index.js");

assert.equal(library.VERSION, testing.TESTING_VERSION);
assert.equal(typeof testing.runEvaluation, "function");
