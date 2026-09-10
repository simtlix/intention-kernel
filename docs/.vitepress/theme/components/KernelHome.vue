<script setup lang="ts">
import { withBase } from "vitepress";

const contracts = [
  ["Intentions", "Model-proposed objectives with message-level evidence."],
  ["Capabilities", "Registered operations with schemas, facts, effects, and semantic guidance."],
  ["Facts", "Versioned durable knowledge with provenance and invalidation rules."],
  ["Interactions", "Server-owned input, choice, clarification, and confirmation boundaries."],
  ["Effects", "Idempotent external writes with prepared, completed, failed, or uncertain receipts."],
  ["Events", "Sanitized causal envelopes for every observable runtime decision."],
] as const;

const scenarios = [
  ["Simple conversation", "A social turn performs no fabricated operation; a factual question invokes one grounded read."],
  ["Multiple objectives", "Independent documentation and service searches execute in the same turn."],
  ["Controlled progress", "An informational interruption is answered while a write confirmation remains pending."],
  ["Nested workflow", "A LangGraph subgraph runs behind a generic capability port and emits causal progress."],
] as const;
</script>

<template>
  <main class="ik-home vp-doc">
    <section class="ik-hero">
      <div class="ik-hero__copy">
        <p class="ik-eyebrow"><span /> TypeScript · Capability-first · Provider-neutral</p>
        <h1>
          <span>Agent</span>
          <span>orchestration</span>
          <span>with explicit</span>
          <span>authority.</span>
        </h1>
        <p class="ik-hero__lead">
          Intention Kernel turns model-proposed objectives into validated plans, durable capability execution,
          evidence-bearing facts, and grounded responses.
        </p>
        <div class="ik-actions">
          <a class="ik-button ik-button--primary" :href="withBase('/guide/getting-started.html')">Build your first agent <span>→</span></a>
          <a class="ik-button" :href="withBase('/architecture/')">Inspect the runtime</a>
        </div>
        <div class="ik-hero__meta" aria-label="Runtime guarantees">
          <span>Node 22</span>
          <span>ESM</span>
          <span>Strict TypeScript</span>
          <span>Durable replay</span>
        </div>
      </div>

      <div class="ik-hero__visual" aria-label="Execution trace preview">
        <div class="ik-orbit ik-orbit--one" />
        <div class="ik-orbit ik-orbit--two" />
        <div class="ik-kernel-mark">
          <img class="ik-symbol--dark" :src="withBase('/intention-kernel-symbol-dark.svg?v=2')" alt="" />
          <img class="ik-symbol--light" :src="withBase('/intention-kernel-symbol-light.svg?v=2')" alt="" />
          <small>authority boundary</small>
        </div>
        <div class="ik-signal ik-signal--input"><span>01</span> capabilities.selected</div>
        <div class="ik-signal ik-signal--plan"><span>02</span> intention.interpreted</div>
        <div class="ik-signal ik-signal--effect"><span>03</span> capability.completed</div>
        <div class="ik-signal ik-signal--output"><span>04</span> response.composed</div>
      </div>
    </section>

    <section class="ik-section ik-section--flow">
      <div class="ik-section__heading">
        <p class="ik-kicker">Execution model</p>
        <h2>The model proposes.<br>The kernel decides what may run.</h2>
        <p>Select a stage to inspect its authority, input, and output.</p>
      </div>
      <KernelFlow />
    </section>

    <section class="ik-section ik-section--split">
      <div class="ik-section__heading">
        <p class="ik-kicker">Minimal public contract</p>
        <h2>Small surface.<br>Strong boundaries.</h2>
        <p>Business meaning stays in capabilities. Infrastructure stays behind injected adapters.</p>
        <a class="ik-text-link" :href="withBase('/guide/core-concepts.html')">Understand the contracts →</a>
      </div>
      <div class="ik-code-window" aria-label="Minimal agent definition">
        <div class="ik-code-window__bar"><span /><span /><span /><small>agent.ts</small></div>
        <pre><code><span class="token-keyword">const</span> agent = <span class="token-call">defineAgent</span>({
  id: <span class="token-call">agentId</span>(<span class="token-string">"support.agent"</span>),
  version: <span class="token-number">1</span>,
  identity: <span class="token-string">"A concise support advisor"</span>,
  capabilities: [
    knowledgeSearch,
    requestPrepare,
    requestSubmit,
  ],
  policies: [],
  modelPolicy: {},
});

<span class="token-keyword">const</span> compiled = <span class="token-keyword">await</span> kernel.<span class="token-call">compile</span>(agent);</code></pre>
      </div>
    </section>

    <section class="ik-section ik-section--contracts">
      <div class="ik-section__heading">
        <p class="ik-kicker">Core vocabulary</p>
        <h2>Every concept has one responsibility.</h2>
      </div>
      <div class="ik-contracts">
        <a v-for="contract in contracts" :key="contract[0]" :href="withBase('/guide/core-concepts.html')">
          <strong>{{ contract[0] }}</strong>
          <span>{{ contract[1] }}</span>
          <b aria-hidden="true">↗</b>
        </a>
      </div>
    </section>

    <section class="ik-section ik-section--evidence">
      <div class="ik-evidence__copy">
        <p class="ik-kicker">Grounding by construction</p>
        <h2>Business claims cannot drift away from their evidence.</h2>
        <p>
          Capabilities return evidence. Facts retain its lineage. The response model writes ordered cited parts,
          and the kernel derives exact claim spans before semantic review.
        </p>
        <a class="ik-text-link" :href="withBase('/guide/grounding.html')">Read the grounding contract →</a>
      </div>
      <div class="ik-evidence__trace">
        <div><span>External record</span><code>evidence-42</code></div>
        <i />
        <div><span>Confirmed fact</span><code>service.candidates@1</code></div>
        <i />
        <div class="is-final"><span>Published claim</span><code>"Incident Response Assist is USD 2400"</code></div>
      </div>
    </section>

    <section class="ik-section ik-section--demos">
      <div class="ik-section__heading">
        <p class="ik-kicker">Executable documentation</p>
        <h2>Examples verify outcomes, not canned prose.</h2>
        <p>The demo suite calls a real structured-output model and asserts capabilities, facts, effects, interactions, grounding, replay, and causal events.</p>
        <a class="ik-text-link" :href="withBase('/guide/evaluation.html')">Write scenarios and iterate from evaluation reports →</a>
      </div>
      <div class="ik-scenarios">
        <a v-for="(scenario, index) in scenarios" :key="scenario[0]" :href="withBase('/development/examples.html')">
          <span>{{ String(index + 1).padStart(2, "0") }}</span>
          <strong>{{ scenario[0] }}</strong>
          <p>{{ scenario[1] }}</p>
        </a>
      </div>
    </section>

    <section class="ik-closing">
      <p class="ik-kicker">Start from the contract</p>
      <h2>Define what the agent can do.<br>Keep the model free to understand why.</h2>
      <div class="ik-actions">
        <a class="ik-button ik-button--primary" :href="withBase('/guide/getting-started.html')">Get started <span>→</span></a>
        <a class="ik-button" :href="withBase('/api.html')">Browse API</a>
      </div>
    </section>
  </main>
</template>
