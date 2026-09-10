import { randomUUID } from "node:crypto";

import {
  agentId,
  capabilityId,
  defineAgent,
  defineCapability,
  evidenceId,
  factType,
  type CapabilityExecutionContext,
  type FactRecord,
  type FactType,
} from "intention-kernel";
import { z } from "zod";

import type { PlanningGraphPort, PlanningInput } from "./planningSubgraph.js";
import { schemaFromZod } from "./schema.js";

interface KnowledgeArticle {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly keywords: readonly string[];
}

interface ServicePackage {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly priceUsd: number;
}

interface RequestDraft {
  readonly subject: string;
  readonly details: string;
}

interface SubmittedRequest extends RequestDraft {
  readonly id: string;
  readonly status: "open";
}

interface KnowledgePort {
  search(question: string): Promise<KnowledgeArticle | null>;
}

interface ServicesPort {
  search(need: string): Promise<readonly ServicePackage[]>;
}

interface RequestsPort {
  create(draft: RequestDraft): Promise<SubmittedRequest>;
}

/** Host-owned state exposed only so the demo runner can verify real writes. */
export interface DemoRepository extends RequestsPort {
  readonly writes: readonly SubmittedRequest[];
}

/** Concrete ports required by the demo agent. */
export interface DemoPorts {
  readonly knowledge: KnowledgePort;
  readonly services: ServicesPort;
  readonly requests: DemoRepository;
  readonly planningGraph: PlanningGraphPort;
}

const knowledgeAnswerFact = factType("knowledge.answer");
const serviceCandidatesFact = factType("service.candidates");
const requestDraftFact = factType("request.draft");
const requestSubmittedFact = factType("request.submitted");
const workflowPlanFact = factType("workflow.plan");

const knowledgeSearch = defineCapability({
  id: capabilityId("knowledge.search"),
  version: 1,
  description: "Search verified documentation to answer a factual or procedural question; do not use it to find commercial service packages.",
  input: schemaFromZod(z.strictObject({ question: z.string().trim().min(3) })),
  output: schemaFromZod(z.strictObject({
    found: z.boolean(),
    article: z.strictObject({ id: z.string(), title: z.string(), body: z.string() }).nullable(),
  })),
  requires: [],
  provides: [{ type: knowledgeAnswerFact, version: 1 }],
  invalidates: [{ type: knowledgeAnswerFact, version: 1 }],
  effect: "read",
  guidance: {
    whenToUse: ["The user asks for verified information, instructions, policy or documentation."],
    whenNotToUse: ["The user asks which professional service packages are available to buy."],
    examples: ["How long are audit logs retained?", "What should I check after a payment incident?"],
  },
  async execute(context, input) {
    const article = await requirePort(context, "knowledge").search(input.question);
    const output = {
      found: article !== null,
      article: article === null ? null : { id: article.id, title: article.title, body: article.body },
    };
    const evidence = newEvidence("knowledge");
    return {
      status: "completed" as const,
      output,
      facts: [{ type: knowledgeAnswerFact, version: 1, value: output, evidenceIds: [evidence], dependsOn: [] }],
      evidence: [{
        id: evidence,
        source: "external" as const,
        content: article === null
          ? "The verified knowledge base did not contain a matching article."
          : `Verified documentation '${article.title}': ${article.body}`,
        data: output,
      }],
      artifacts: [],
    };
  },
});

const serviceSearch = defineCapability({
  id: capabilityId("service.search"),
  version: 1,
  description: "Find purchasable professional service packages for a user's operational need; do not use it to answer documentation questions.",
  input: schemaFromZod(z.strictObject({ need: z.string().trim().min(2) })),
  output: schemaFromZod(z.strictObject({ services: z.array(z.strictObject({
    id: z.string(),
    name: z.string(),
    purpose: z.string(),
    priceUsd: z.number().nonnegative(),
  })) })),
  requires: [],
  provides: [{ type: serviceCandidatesFact, version: 1 }],
  invalidates: [{ type: serviceCandidatesFact, version: 1 }],
  effect: "read",
  guidance: {
    whenToUse: ["The user wants to discover or compare available service packages."],
    whenNotToUse: ["The user asks only for verified instructions or documentation."],
    examples: ["Which incident-response services can I purchase?"],
  },
  async execute(context, input) {
    const services = await requirePort(context, "services").search(input.need);
    const output = { services };
    const evidence = newEvidence("services");
    return {
      status: "completed" as const,
      output,
      facts: [{ type: serviceCandidatesFact, version: 1, value: services, evidenceIds: [evidence], dependsOn: [] }],
      evidence: [{
        id: evidence,
        source: "external" as const,
        content: services.length === 0
          ? "The service catalog returned no matching packages."
          : `The service catalog returned: ${services.map((service) => `${service.name} at USD ${String(service.priceUsd)}`).join(", ")}.`,
        data: services,
      }],
      artifacts: [{ id: "service-results", kind: "service-list", data: services }],
    };
  },
});

const requestPrepare = defineCapability({
  id: capabilityId("request.prepare"),
  version: 1,
  description: "Prepare, but do not submit, a support request when the user supplies a subject and concrete problem details.",
  input: schemaFromZod(z.strictObject({
    subject: z.string().trim().min(3).max(120),
    details: z.string().trim().min(10).max(2_000),
  })),
  output: schemaFromZod(z.strictObject({ subject: z.string(), details: z.string() })),
  requires: [],
  provides: [{ type: requestDraftFact, version: 1 }],
  invalidates: [{ type: requestDraftFact, version: 1 }, { type: requestSubmittedFact, version: 1 }],
  effect: "none",
  guidance: {
    whenToUse: ["The user explicitly wants a support request and provides enough detail to draft it."],
    whenNotToUse: ["The user only asks an informational question."],
    examples: ["Prepare a request: exports fail after our identity provider rotation."],
  },
  execute(_context, input) {
    const evidence = newEvidence("request-draft");
    return Promise.resolve({
      status: "completed" as const,
      output: input,
      facts: [{ type: requestDraftFact, version: 1, value: input, evidenceIds: [evidence], dependsOn: [] }],
      evidence: [{ id: evidence, source: "user" as const, content: `Prepared request '${input.subject}': ${input.details}`, data: input }],
      artifacts: [],
    });
  },
});

const requestSubmit = defineCapability({
  id: capabilityId("request.submit"),
  version: 1,
  description: "Submit the currently prepared support request as an external write; use only after the user explicitly asks to submit it.",
  input: schemaFromZod(z.strictObject({})),
  output: schemaFromZod(z.strictObject({
    id: z.string(),
    subject: z.string(),
    details: z.string(),
    status: z.literal("open"),
  })),
  requires: [{ type: requestDraftFact, version: 1, description: "A prepared support request draft" }],
  provides: [{ type: requestSubmittedFact, version: 1, modelVisibility: "presence" }],
  invalidates: [{ type: requestSubmittedFact, version: 1 }],
  effect: "write",
  confirmation: "required",
  guidance: {
    whenToUse: ["The user asks to submit the request that is already prepared."],
    whenNotToUse: ["No request draft exists or the user only wants information."],
    examples: ["Submit the prepared request."],
  },
  async execute(context) {
    const draft = requireFact(context.facts, requestDraftFact) as RequestDraft;
    const effect = await context.runEffect(
      "submit-request",
      () => requirePort(context, "requests").create(draft),
    );
    const request = effect.value;
    const evidence = newEvidence("request-submitted");
    return {
      status: "completed" as const,
      output: request,
      facts: [{
        type: requestSubmittedFact,
        version: 1,
        value: request,
        evidenceIds: [evidence],
        dependsOn: [{ type: requestDraftFact, version: 1 }],
      }],
      evidence: [{ id: evidence, source: "external" as const, content: `Request ${request.id} was submitted with status open.`, data: request }],
      artifacts: [{ id: request.id, kind: "support-request", data: request }],
    };
  },
});

const workflowDesign = defineCapability({
  id: capabilityId("workflow.design"),
  version: 1,
  description: "Build an implementation or rollout plan by delegating structured work to the configured planning subgraph.",
  input: schemaFromZod(z.strictObject({
    goal: z.string().trim().min(5),
    priorities: z.array(z.string().trim().min(2)).max(5),
  })),
  output: schemaFromZod(z.strictObject({
    goal: z.string(),
    approach: z.string(),
    steps: z.array(z.string()),
    risks: z.array(z.string()),
  })),
  requires: [],
  provides: [{ type: workflowPlanFact, version: 1 }],
  invalidates: [{ type: workflowPlanFact, version: 1 }],
  effect: "read",
  guidance: {
    whenToUse: ["The user asks for an implementation plan, rollout plan or staged execution design."],
    whenNotToUse: ["The user only asks a factual documentation question."],
    examples: ["Design a rollout plan prioritizing continuity and observability."],
  },
  async execute(context, input) {
    const graph = requirePort(context, "planningGraph");
    const plan = await graph.run(
      input satisfies PlanningInput,
      (name, data) => context.events.emit(name, data),
      context.signal,
    );
    const evidence = newEvidence("workflow-plan");
    return {
      status: "completed" as const,
      output: plan,
      facts: [{ type: workflowPlanFact, version: 1, value: plan, evidenceIds: [evidence], dependsOn: [] }],
      evidence: [{
        id: evidence,
        source: "capability" as const,
        content: `The planning subgraph produced approach '${plan.approach}' with ${String(plan.steps.length)} steps and ${String(plan.risks.length)} risks.`,
        data: plan,
      }],
      artifacts: [{ id: "workflow-plan", kind: "plan", data: plan }],
    };
  },
});

/** Agent manifest used by every executable demo scenario. */
export const demoAgent = defineAgent({
  id: agentId("demo.operations-advisor"),
  version: 1,
  identity: "A concise operations advisor. Distinguish verified documentation from purchasable services, keep informational questions non-disruptive, and never submit a request without explicit confirmation.",
  capabilities: [knowledgeSearch, serviceSearch, requestPrepare, requestSubmit, workflowDesign],
  policies: [],
  modelPolicy: {},
});

/** Build isolated, real domain adapters for one complete demo run. */
export function createDemoPorts(planningGraph: PlanningGraphPort): DemoPorts {
  const articles: readonly KnowledgeArticle[] = [
    {
      id: "audit-retention",
      title: "Audit log retention",
      body: "Audit logs are retained for 90 days in the standard plan and can be exported before expiry.",
      keywords: ["audit", "logs", "retention", "retained"],
    },
    {
      id: "incident-checklist",
      title: "Payment incident checklist",
      body: "Verify provider status, correlation IDs and idempotency receipts before retrying a payment operation.",
      keywords: ["payment", "incident", "checklist", "retry"],
    },
  ];
  const services: readonly ServicePackage[] = [
    { id: "readiness", name: "Incident Readiness Review", purpose: "Review runbooks and recovery controls", priceUsd: 1_200 },
    { id: "response", name: "Incident Response Assist", purpose: "Provide guided response during an active incident", priceUsd: 2_400 },
  ];
  const writes: SubmittedRequest[] = [];
  const requests: DemoRepository = {
    get writes() {
      return writes;
    },
    create(draft) {
      const request: SubmittedRequest = { ...draft, id: `req-${String(writes.length + 1)}`, status: "open" };
      writes.push(request);
      return Promise.resolve(request);
    },
  };
  return {
    knowledge: {
      search(question) {
        const normalized = normalize(question);
        const ranked = articles
          .map((article) => ({ article, score: article.keywords.filter((keyword) => normalized.includes(keyword)).length }))
          .sort((left, right) => right.score - left.score);
        return Promise.resolve(ranked[0]?.score === 0 ? null : ranked[0]?.article ?? null);
      },
    },
    services: {
      search(need) {
        const normalized = normalize(need);
        return Promise.resolve(normalized.includes("incident") ? services : []);
      },
    },
    requests,
    planningGraph,
  };
}

function requirePort<K extends keyof DemoPorts>(context: CapabilityExecutionContext, name: K): DemoPorts[K] {
  const port: unknown = Reflect.get(context.ports, name);
  if (port === undefined) throw new Error(`MISSING_DEMO_PORT:${name}`);
  return port as DemoPorts[K];
}

function requireFact(facts: readonly FactRecord[], type: FactType): unknown {
  const value = facts.find((fact) => fact.type === type)?.value;
  if (value === undefined) throw new Error(`MISSING_DEMO_FACT:${type}`);
  return value;
}

function newEvidence(scope: string) {
  return evidenceId(`${scope}.${randomUUID()}`);
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
