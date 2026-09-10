import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createKernel,
  evidenceId,
  threadId,
  turnId,
  type KernelEvent,
  type TurnResult,
} from "intention-kernel";
import {
  createEventCollector, createMemoryDurability, parseEvaluationSuite, runEvaluation,
  type EvaluationAdapter, type EvaluationData, type EvaluationReport,
} from "intention-kernel/testing";

import { createDemoPorts, demoAgent } from "./demoAgent.js";
import { GeminiModelGateway } from "./geminiModelGateway.js";
import { createPlanningGraphPort } from "./planningSubgraph.js";
import { demoScenarios, type DemoTurnExpectation } from "./scenarios.js";

interface AssertionResult {
  readonly name: string;
  readonly passed: boolean;
  readonly details: string;
}

interface TurnReport {
  readonly message: string;
  readonly response: string;
  readonly claims: TurnResult["response"]["claims"];
  readonly traceId: string;
  readonly capabilities: readonly string[];
  readonly facts: readonly string[];
  readonly interaction: string | null;
  readonly events: readonly KernelEvent[];
  readonly assertions: readonly AssertionResult[];
  readonly passed: boolean;
  readonly durationMs: number;
}

interface ScenarioReport {
  readonly id: string;
  readonly title: string;
  readonly demonstrates: readonly string[];
  readonly turns: readonly TurnReport[];
  readonly passed: boolean;
  readonly error?: string;
}

const requestedScenario = argument("scenario");
if (process.argv.includes("--list")) {
  process.stdout.write(demoScenarios.map((scenario) => `${scenario.id}: ${scenario.title}`).join("\n") + "\n");
  process.exit(0);
}
const scenarios = requestedScenario === undefined
  ? demoScenarios
  : demoScenarios.filter((scenario) => scenario.id === requestedScenario);
if (scenarios.length === 0) throw new Error(`UNKNOWN_DEMO_SCENARIO:${requestedScenario ?? ""}`);

const apiKey = process.env["GEMINI_API_KEY"];
if (apiKey === undefined || apiKey.trim().length === 0) throw new Error("GEMINI_API_KEY_REQUIRED");
const model = process.env["GEMINI_MODEL"]?.trim() || "gemini-2.5-flash";

const startedAt = new Date().toISOString();
const outputDirectory = path.resolve(argument("output") ?? path.join("examples", ".runs", startedAt.replaceAll(":", "-")));
await mkdir(outputDirectory, { recursive: true });
const suite = parseEvaluationSuite({
  schemaVersion: 1, id: "kernel.demos", name: "Intention Kernel executable demos",
  scenarios: scenarios.map((scenario) => ({
    id: scenario.id, name: scenario.title, tags: scenario.demonstrates,
    // Demo mutations are isolated in-memory ports, never external business writes.
    writePolicy: "read_only",
    steps: scenario.turns.map((turn, index) => ({
      id: `turn.${String(index + 1)}`,
      input: { text: turn.message, replayPrevious: turn.reusePreviousTurnId === true },
      assertions: [{ id: "demo.contract", kind: "custom", evaluator: "demo.contract", parameters: turn.expect }],
    })),
  })),
});
const adapter: EvaluationAdapter = {
  id: "kernel.demo", version: "1",
  async open(context) {
    const collector = createEventCollector();
    const ports = createDemoPorts(createPlanningGraphPort());
    const kernel = createKernel({
      modelGateway: new GeminiModelGateway({ apiKey, model }),
      durability: createMemoryDurability(), eventSink: collector,
      ports: { knowledge: ports.knowledge, services: ports.services, requests: ports.requests, planningGraph: ports.planningGraph },
      redact: (value) => redact(value, [apiKey]),
      limits: { turnTimeoutMs: 180_000, maxSteps: 32, recentMessageLimit: 20 },
    });
    const agent = await kernel.compile(demoAgent);
    let previousTurn: ReturnType<typeof turnId> | undefined;
    return {
      async send(input, turn) {
        if (typeof input["text"] !== "string") throw new Error("DEMO_INPUT_INVALID");
        const technicalTurnId = input["replayPrevious"] === true && previousTurn !== undefined ? previousTurn : turnId(turn.turnId);
        const offset = collector.events.length, writesBefore = ports.requests.writes.length;
        const result = await agent.run({ threadId: threadId(context.threadId), turnId: technicalTurnId, input: { text: input["text"] }, signal: turn.signal });
        previousTurn = technicalTurnId;
        const events = collector.events.slice(offset).filter((event) => event.threadId === context.threadId && event.turnId === technicalTurnId);
        return { observation: JSON.parse(JSON.stringify({ result, events, writeDelta: ports.requests.writes.length - writesBefore })) as EvaluationData };
      },
    };
  },
};
const controller = new AbortController();
const cancel = (): void => { controller.abort(); };
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
let evaluation: EvaluationReport;
try {
  evaluation = await runEvaluation({
    suite, adapter, target: { id: String(demoAgent.id), fingerprint: `${model}:${JSON.stringify(suite)}` },
    concurrency: Number(argument("parallel") ?? 1), repetitions: Number(argument("repetitions") ?? 1),
    maxFailures: Number(argument("max-failures") ?? 20), timeoutMs: 180_000, signal: controller.signal,
    evaluators: {
      "demo.contract": ({ observation }, parameters) => {
        const result = observation["result"] as unknown as TurnResult;
        const events = observation["events"] as unknown as readonly KernelEvent[];
        const assertions = evaluate({
          expectation: parameters as unknown as DemoTurnExpectation, result, events,
          capabilities: invokedCapabilities(events), facts: result.checkpoint.facts.map((fact) => String(fact.type)),
          writeDelta: observation["writeDelta"] as number,
        });
        return { passed: assertions.every((item) => item.passed), evidence: { assertions: JSON.parse(JSON.stringify(assertions)) as EvaluationData[] } };
      },
    },
    onCheckpoint: async (snapshot) => {
      await writeFile(path.join(outputDirectory, "evaluation.json"), JSON.stringify(snapshot, null, 2));
    },
  });
} finally {
  process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
}
const reports: ScenarioReport[] = evaluation.cases.map((entry) => ({
  id: entry.id, title: entry.name,
  demonstrates: scenarios.find((scenario) => scenario.id === entry.scenarioId)?.demonstrates ?? [],
  passed: entry.status === "passed",
  ...(entry.errorCode === undefined ? {} : { error: entry.errorCode }),
  turns: entry.turns.flatMap((turn): TurnReport[] => {
    if (turn.observation === undefined) return [];
    const result = turn.observation["result"] as unknown as TurnResult;
    const events = turn.observation["events"] as unknown as readonly KernelEvent[];
    return [{
      message: typeof turn.input["text"] === "string" ? turn.input["text"] : turn.stepId, response: result.response.message, claims: result.response.claims,
      traceId: result.traceId, capabilities: invokedCapabilities(events), facts: result.checkpoint.facts.map((fact) => String(fact.type)),
      interaction: result.response.interaction?.kind ?? null, events, durationMs: turn.durationMs, passed: turn.status === "passed",
      assertions: (turn.assertions[0]?.evidence?.["assertions"] ?? []) as unknown as readonly AssertionResult[],
    }];
  }),
}));
const passed = evaluation.status === "completed" && reports.every((report) => report.passed);
const report = { startedAt, completedAt: new Date().toISOString(), model, passed, scenarios: reports };
await writeFile(path.join(outputDirectory, "report.json"), JSON.stringify(report, null, 2));
await writeFile(path.join(outputDirectory, "report.md"), markdownReport(report));
process.stdout.write(JSON.stringify({ status: passed ? "passed" : "failed", model, summary: evaluation.summary, reportDirectory: outputDirectory }, null, 2) + "\n");
if (!passed) process.exitCode = 1;

function evaluate(options: {
  readonly expectation: DemoTurnExpectation;
  readonly result: TurnResult;
  readonly events: readonly KernelEvent[];
  readonly capabilities: readonly string[];
  readonly facts: readonly string[];
  readonly writeDelta: number;
}): AssertionResult[] {
  const expectedFacts = options.expectation.facts ?? [];
  const expectedInteraction = options.expectation.interaction ?? "none";
  const eventTypes = options.events.map((event) => event.type);
  const replayed = options.expectation.replayed ?? false;
  const customEvents = options.events
    .filter((event) => event.type === "capability.event")
    .flatMap((event) => readString(event.data, "name"));
  const assertions = [
    assertion("completed grounded model response", options.result.response.status === "completed" && options.result.response.grounded && options.result.response.source === "model", `${options.result.response.status}/${String(options.result.response.grounded)}/${options.result.response.source}`),
    assertion("expected capabilities", sameMembers(options.capabilities, options.expectation.capabilities), `expected ${options.expectation.capabilities.join(", ") || "none"}; observed ${options.capabilities.join(", ") || "none"}`),
    assertion("expected durable facts", expectedFacts.every((fact) => options.facts.includes(fact)), `expected ${expectedFacts.join(", ") || "none"}; observed ${options.facts.join(", ") || "none"}`),
    assertion("expected interaction", expectedInteraction === "none" ? options.result.response.interaction === undefined : expectedInteraction === "present" ? options.result.response.interaction !== undefined : options.result.response.interaction?.kind === expectedInteraction, `expected ${expectedInteraction}; observed ${options.result.response.interaction?.kind ?? "none"}`),
    assertion("expected write delta", options.writeDelta === (options.expectation.writeDelta ?? 0), `expected ${String(options.expectation.writeDelta ?? 0)}; observed ${String(options.writeDelta)}`),
    assertion("expected replay state", options.result.replayed === replayed, `expected ${String(replayed)}; observed ${String(options.result.replayed)}`),
    assertion("complete event lifecycle", replayed ? options.events.length === 0 : eventTypes.includes("turn.started") && eventTypes.includes("capabilities.selected") && eventTypes.includes("intention.interpreted") && eventTypes.includes("plan.created") && eventTypes.includes("response.composed") && eventTypes.includes("turn.completed"), replayed ? `${String(options.events.length)} new events on replay` : eventTypes.join(" -> ")),
    assertion("valid causal event graph", replayed ? options.events.length === 0 : validCausality(options.events), `${String(options.events.length)} ordered events inspected`),
    assertion("no private reasoning leaked", !containsPrivateReasoning(options.events), "event payloads inspected recursively"),
    assertion("claims cite available evidence", validClaims(options.result), `${String(options.result.response.claims.length)} claims inspected`),
  ];
  for (const name of options.expectation.customEvents ?? []) {
    assertions.push(assertion(`custom event ${name}`, customEvents.includes(name), customEvents.join(", ")));
  }
  return assertions;
}

function invokedCapabilities(events: readonly KernelEvent[]): string[] {
  return events
    .filter((event) => event.type === "capability.invoked")
    .flatMap((event) => readString(event.data, "capabilityId"));
}

function validCausality(events: readonly KernelEvent[]): boolean {
  const seen = new Set<string>();
  let priorSequence = 0;
  for (const event of events) {
    if (event.sequence <= priorSequence || seen.has(event.id)) return false;
    if (event.causationId !== undefined && !seen.has(event.causationId)) return false;
    if (event.correlationId !== events[0]?.correlationId) return false;
    priorSequence = event.sequence;
    seen.add(event.id);
  }
  return events[0]?.sequence === 1;
}

function validClaims(result: TurnResult): boolean {
  const evidence = new Set([
    evidenceId("agent.configuration"),
    ...result.checkpoint.facts.flatMap((fact) => fact.evidence.map((entry) => entry.id)),
  ]);
  return result.response.claims.every((claim) =>
    result.response.message.includes(claim.text) &&
    claim.evidenceIds.length > 0 &&
    claim.evidenceIds.every((id) => evidence.has(id)),
  );
}

function containsPrivateReasoning(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateReasoning);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, child]) =>
    ["chainOfThought", "privateReasoning", "rawReasoning"].includes(key) || containsPrivateReasoning(child),
  );
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  const first = [...new Set(left)].sort();
  const second = [...new Set(right)].sort();
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function assertion(name: string, passed: boolean, details: string): AssertionResult {
  return { name, passed, details };
}

function readString(value: unknown, property: string): string[] {
  if (typeof value !== "object" || value === null) return [];
  const found = (value as Record<string, unknown>)[property];
  return typeof found === "string" ? [found] : [];
}

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce((current, secret) => secret.length === 0 ? current : current.replaceAll(secret, "[redacted]"), value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child, secrets)]));
}

function markdownReport(report: {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly model: string;
  readonly passed: boolean;
  readonly scenarios: readonly ScenarioReport[];
}): string {
  const lines = [
    "# Intention Kernel executable demos",
    "",
    `- Started: ${report.startedAt}`,
    `- Completed: ${report.completedAt}`,
    `- Model: ${report.model}`,
    `- Result: ${report.passed ? "PASS" : "FAIL"}`,
    "",
  ];
  for (const scenario of report.scenarios) {
    lines.push(`## ${scenario.title} — ${scenario.passed ? "PASS" : "FAIL"}`, "", scenario.demonstrates.map((item) => `- ${item}`).join("\n"), "");
    if (scenario.error !== undefined) lines.push(`Error: ${scenario.error}`, "");
    for (const [index, turn] of scenario.turns.entries()) {
      lines.push(
        `### Turn ${String(index + 1)} — ${turn.passed ? "PASS" : "FAIL"}`,
        "",
        `**User:** ${turn.message}`,
        "",
        `**Assistant:** ${turn.response}`,
        "",
        `**Capabilities:** ${turn.capabilities.join(", ") || "none"}`,
        "",
        `**Facts:** ${turn.facts.join(", ") || "none"}`,
        "",
        `**Interaction:** ${turn.interaction ?? "none"}`,
        "",
        "**Assertions:**",
        "",
        ...turn.assertions.map((item) => `- ${item.passed ? "PASS" : "FAIL"} — ${item.name}: ${item.details}`),
        "",
        "**Timeline:**",
        "",
        ...turn.events.map((event) => `- ${String(event.sequence).padStart(2, "0")} ${event.type}${event.stepId === undefined ? "" : ` [${event.stepId}]`}`),
        "",
      );
    }
  }
  return lines.join("\n") + "\n";
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}
