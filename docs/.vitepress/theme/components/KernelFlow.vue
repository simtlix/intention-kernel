<script setup lang="ts">
import { computed, ref } from "vue";

const stages = [
  {
    id: "context",
    index: "01",
    title: "Context",
    owner: "Kernel",
    summary: "Loads the checkpoint and projects bounded conversation history, confirmed facts, pending work, and explicit omissions.",
    input: "RunTurnInput",
    output: "ContextSnapshot",
  },
  {
    id: "select",
    index: "02",
    title: "Select",
    owner: "Model + kernel",
    summary: "Chooses the smallest plausible set from compact capability summaries. Schemas and guidance remain undisclosed.",
    input: "ContextSnapshot + summaries",
    output: "CapabilitySelection",
  },
  {
    id: "interpret",
    index: "03",
    title: "Interpret",
    owner: "Model",
    summary: "Uses only selected capability contracts to propose zero, one, or several evidence-backed intentions.",
    input: "Context + selected contracts",
    output: "IntentionBatch",
  },
  {
    id: "plan",
    index: "04",
    title: "Validate & plan",
    owner: "Kernel",
    summary: "Checks registered capability IDs, schemas, facts, dependencies, policies, confirmation, and ambiguity.",
    input: "IntentionBatch + manifest",
    output: "TurnPlan",
  },
  {
    id: "execute",
    index: "05",
    title: "Execute",
    owner: "Capabilities",
    summary: "Runs independent reads concurrently, resolves dependent work in order, and protects writes with durable effects.",
    input: "Validated plan steps",
    output: "CapabilityResult[]",
  },
  {
    id: "reduce",
    index: "06",
    title: "Reduce",
    owner: "Kernel",
    summary: "Publishes evidence-bearing facts, invalidates descendants, and updates the durable agenda and interaction.",
    input: "Results + prior checkpoint",
    output: "Next checkpoint",
  },
  {
    id: "respond",
    index: "07",
    title: "Ground & respond",
    owner: "Model + kernel",
    summary: "Composes cited text parts, derives exact claim spans, performs semantic review, and commits one grounded result.",
    input: "ResponseBrief",
    output: "TurnResponse + events",
  },
] as const;

const selectedId = ref<(typeof stages)[number]["id"]>("select");
const selected = computed(() => stages.find((stage) => stage.id === selectedId.value) ?? stages[0]);
</script>

<template>
  <section class="kernel-flow" aria-label="Intention Kernel execution flow">
    <div class="kernel-flow__rail" role="tablist" aria-label="Execution stages">
      <button
        v-for="stage in stages"
        :key="stage.id"
        class="kernel-flow__stage"
        :class="{ 'is-active': selectedId === stage.id }"
        type="button"
        role="tab"
        :aria-selected="selectedId === stage.id"
        @click="selectedId = stage.id"
        @focus="selectedId = stage.id"
      >
        <span class="kernel-flow__index">{{ stage.index }}</span>
        <span class="kernel-flow__node" aria-hidden="true" />
        <span class="kernel-flow__title">{{ stage.title }}</span>
      </button>
    </div>

    <div class="kernel-flow__detail" role="tabpanel">
      <div>
        <span class="kernel-flow__owner">Authority · {{ selected.owner }}</span>
        <h3>{{ selected.title }}</h3>
        <p>{{ selected.summary }}</p>
      </div>
      <dl>
        <div>
          <dt>Receives</dt>
          <dd>{{ selected.input }}</dd>
        </div>
        <div>
          <dt>Produces</dt>
          <dd>{{ selected.output }}</dd>
        </div>
      </dl>
    </div>
  </section>
</template>
