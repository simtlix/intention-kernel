import { randomUUID } from "node:crypto";

import { compileAgentDefinition } from "../compiler/compileAgentDefinition.js";
import type { AgentDefinition } from "../contracts/agent.js";
import type { Durability } from "../contracts/durability.js";
import { KernelConfigurationError } from "../contracts/errors.js";
import type { EventSink } from "../contracts/events.js";
import type { ModelGateway } from "../contracts/model.js";
import type { ModelPromptResolver } from "../contracts/prompt.js";
import type { KernelClock, KernelIdGenerator, KernelLimits } from "../contracts/runtime.js";
import type { CompiledAgent } from "../contracts/turn.js";
import { compileLangGraphRuntime } from "./compileLangGraphRuntime.js";
import { createCompiledAgent } from "./compiledAgent.js";

/** Isolated runtime facade that compiles declarative agent manifests. */
export interface IntentionKernel {
  /** Validate and compile one immutable agent manifest. */
  compile(definition: AgentDefinition): Promise<CompiledAgent>;
}

/** Provider and host adapters used by one isolated kernel instance. */
export interface KernelOptions {
  /** Provider-neutral structured model adapter. */
  readonly modelGateway: ModelGateway;
  /** Resolve pinned instruction revisions synchronously before observation/provider invocation. */
  readonly promptResolver?: ModelPromptResolver;
  /** Host persistence, locking, replay and effect-ledger adapter. */
  readonly durability: Durability;
  /** Optional sink for sanitized causal runtime events. */
  readonly eventSink?: EventSink;
  /** Instance-scoped domain and infrastructure adapters visible only to capabilities. */
  readonly ports?: Readonly<Record<string, unknown>>;
  /** Optional deterministic or host-specific clock. */
  readonly clock?: KernelClock;
  /** Optional source of unique runtime identifiers. */
  readonly idGenerator?: KernelIdGenerator;
  /** Optional bounded execution limits. */
  readonly limits?: KernelLimits;
  /** Domain-specific redactor applied before every event reaches the sink; nullish results never restore the original payload. */
  readonly redact?: (data: unknown) => unknown;
}

/**
 * Create a provider-neutral kernel whose compiled agents run on private LangGraph state.
 *
 * @throws {@link KernelConfigurationError} when an adapter or limit is invalid.
 * @returns An isolated kernel instance with no mutable module-level configuration.
 */
export function createKernel(options: KernelOptions): IntentionKernel {
  validateKernelOptions(options);
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const idGenerator = options.idGenerator ?? { next: () => randomUUID() };
  const eventSink = options.eventSink ?? { emit: () => Promise.resolve() };
  const cache = new WeakMap<AgentDefinition, Promise<CompiledAgent>>();
  return Object.freeze({
    compile(definition: AgentDefinition): Promise<CompiledAgent> {
      const cached = cache.get(definition);
      if (cached !== undefined) return cached;
      const compiling = compileAgentDefinition(definition).then((compiled) => {
        const graph = compileLangGraphRuntime({
          modelGateway: options.modelGateway,
          ...(options.promptResolver === undefined ? {} : { promptResolver: options.promptResolver }),
          ports: options.ports ?? {},
          clock,
          idGenerator,
          maxSteps: options.limits?.maxSteps ?? 64,
          recentMessageLimit: options.limits?.recentMessageLimit ?? 20,
        });
        return createCompiledAgent({
          compiled,
          graph,
          durability: options.durability,
          eventSink,
          clock,
          idGenerator,
          turnTimeoutMs: options.limits?.turnTimeoutMs ?? 60_000,
          ...(options.redact === undefined ? {} : { redact: options.redact }),
        });
      });
      cache.set(definition, compiling);
      return compiling;
    },
  });
}

function validateKernelOptions(options: KernelOptions): void {
  requireMethod(options.modelGateway, "invoke", "modelGateway");
  if (options.promptResolver !== undefined) requireMethod(options.promptResolver, "resolve", "promptResolver");
  requireMethod(options.durability, "withTurn", "durability");
  if (options.eventSink !== undefined) requireMethod(options.eventSink, "emit", "eventSink");
  if (options.clock !== undefined) requireMethod(options.clock, "now", "clock");
  if (options.idGenerator !== undefined) requireMethod(options.idGenerator, "next", "idGenerator");
  const redact = (options as { readonly redact?: unknown }).redact;
  if (redact !== undefined && typeof redact !== "function") {
    invalidDependency("redact");
  }
  const ports = (options as { readonly ports?: unknown }).ports;
  if (ports !== undefined && (typeof ports !== "object" || ports === null)) {
    invalidDependency("ports");
  }
  validateLimit("turnTimeoutMs", options.limits?.turnTimeoutMs, false);
  validateLimit("maxSteps", options.limits?.maxSteps, false);
  validateLimit("recentMessageLimit", options.limits?.recentMessageLimit, true);
}

function requireMethod(value: unknown, method: string, dependency: string): void {
  if (typeof value !== "object" || value === null || typeof (value as Record<string, unknown>)[method] !== "function") {
    invalidDependency(dependency);
  }
}

function invalidDependency(dependency: string): never {
  throw new KernelConfigurationError({
    code: "INVALID_KERNEL_DEPENDENCY",
    message: `Kernel dependency ${dependency} does not implement its required contract.`,
    retryable: false,
    context: { dependency },
  });
}

function validateLimit(name: string, value: number | undefined, allowZero: boolean): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new KernelConfigurationError({
      code: "INVALID_KERNEL_LIMIT",
      message: `Kernel limit ${name} is outside its supported range.`,
      retryable: false,
      context: { limit: name },
    });
  }
}
