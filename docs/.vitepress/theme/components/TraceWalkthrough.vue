<script setup lang="ts">
import { computed, ref } from "vue";

const events = [
  { sequence: 1, type: "turn.started", category: "audit", detail: "A durable turn begins with a thread ID, turn ID, and correlation ID." },
  { sequence: 2, type: "context.built", category: "trace", detail: "The model-visible context is projected from canonical checkpoint state." },
  { sequence: 5, type: "capabilities.selected", category: "audit", detail: "The selector records a compact, evidence-backed capability decision before any input schema is disclosed." },
  { sequence: 8, type: "intention.interpreted", category: "audit", detail: "The model proposes the objective from selected contracts and cites the user message evidence that supports it." },
  { sequence: 9, type: "plan.created", category: "audit", detail: "The kernel validates the proposed capability, input, dependencies, and policy result." },
  { sequence: 11, type: "capability.invoked", category: "integration", detail: "Authorized domain code receives typed input, facts, ports, cancellation, and effect coordination." },
  { sequence: 12, type: "capability.event", category: "trace", detail: "A capability or nested graph publishes sanitized progress on its own causal branch." },
  { sequence: 14, type: "facts.reduced", category: "audit", detail: "Validated facts and their evidence lineage become part of the next checkpoint." },
  { sequence: 19, type: "response.composed", category: "audit", detail: "The response passes exact-span citation checks and semantic grounding review." },
  { sequence: 20, type: "state.committed", category: "integration", detail: "Result, checkpoint, and event outbox are committed atomically by the durability adapter." },
] as const;

const activeSequence = ref<number>(5);
const active = computed(() => events.find((event) => event.sequence === activeSequence.value) ?? events[0]);
</script>

<template>
  <section class="trace-walkthrough" aria-label="Causal trace walkthrough">
    <div class="trace-walkthrough__events" role="listbox" aria-label="Kernel events">
      <button
        v-for="event in events"
        :key="event.sequence"
        type="button"
        :class="{ 'is-active': activeSequence === event.sequence }"
        :aria-selected="activeSequence === event.sequence"
        @click="activeSequence = event.sequence"
      >
        <span>{{ String(event.sequence).padStart(2, "0") }}</span>
        <strong>{{ event.type }}</strong>
      </button>
    </div>
    <div class="trace-walkthrough__detail">
      <span>{{ active.category }}</span>
      <code>{{ active.type }}</code>
      <p>{{ active.detail }}</p>
      <dl>
        <div><dt>sequence</dt><dd>{{ active.sequence }}</dd></div>
        <div><dt>correlation</dt><dd>one turn</dd></div>
        <div><dt>causation</dt><dd>explicit parent</dd></div>
      </dl>
    </div>
  </section>
</template>
