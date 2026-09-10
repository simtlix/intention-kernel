<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";

import { docFlows } from "./docFlows";
import type { FlowDefinition, FlowNode } from "./docFlows";

const props = defineProps<{ name: keyof typeof docFlows }>();
const flow = computed<FlowDefinition>(() => docFlows[props.name]);
const id = `doc-flow-${useId()}`;
const canvas = ref<HTMLElement>();
const paths = ref<{ d: string; label?: string; x: number; y: number }[]>([]);
let observer: ResizeObserver | undefined;
let frame = 0;

function nodeStyle(node: FlowNode, index: number) {
  const [row, column, span = 1] = node.position;
  const [smallRow, smallColumn, smallSpan = 1] = node.smallPosition
    ?? (flow.value.smallColumns ? node.position : [index + 1, 1]);
  return {
    gridRow: row,
    "--column": column,
    "--span": span,
    "--small-row": smallRow,
    "--small-column": smallColumn,
    "--small-span": smallSpan,
  };
}

// Measure real HTML nodes so connectors follow wrapped labels, nested content,
// font loading, and container resizing. Text stays selectable and server-rendered.
function drawConnections() {
  const element = canvas.value;
  if (!element) return;
  const bounds = element.getBoundingClientRect();
  const boxes = new Map(Array.from(element.querySelectorAll<HTMLElement>("[data-flow-node]"), (node) => [
    node.dataset.flowNode,
    node.getBoundingClientRect(),
  ]));

  paths.value = flow.value.edges.flatMap((edge) => {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) return [];
    const sameRow = Math.abs(from.top - to.top) < 2;
    const goesRight = to.left > from.left;
    const x1 = (sameRow ? (goesRight ? from.right : from.left) : from.left + from.width / 2) - bounds.left;
    const y1 = (sameRow ? from.top + from.height / 2 : from.bottom) - bounds.top;
    const x2 = (sameRow ? (goesRight ? to.left - 5 : to.right + 5) : to.left + to.width / 2) - bounds.left;
    const y2 = (sameRow ? to.top + to.height / 2 : to.top - 5) - bounds.top;
    const middleY = (y1 + y2) / 2;
    const d = sameRow
      ? `M ${x1} ${y1} L ${x2} ${y2}`
      : `M ${x1} ${y1} C ${x1} ${middleY}, ${x2} ${middleY}, ${x2} ${y2}`;
    return [{ d, ...(edge.label ? { label: edge.label } : {}), x: (x1 + x2) / 2, y: middleY }];
  });
}

function scheduleDraw() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(drawConnections);
}

onMounted(() => {
  observer = new ResizeObserver(scheduleDraw);
  if (canvas.value) observer.observe(canvas.value);
  scheduleDraw();
});

watch(flow, scheduleDraw, { flush: "post" });

onBeforeUnmount(() => {
  observer?.disconnect();
  cancelAnimationFrame(frame);
});
</script>

<template>
  <figure class="doc-flow" :aria-labelledby="`${id}-title`" :aria-describedby="`${id}-description`">
    <figcaption :id="`${id}-title`" class="doc-flow__caption">
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="2" y="2" width="5" height="5" rx="1.5" />
        <rect x="13" y="13" width="5" height="5" rx="1.5" />
        <path d="M7 4.5h5.5a3 3 0 0 1 3 3V13M2 15.5h6M5 12.5v6" />
      </svg>
      {{ flow.title }}
    </figcaption>
    <p :id="`${id}-description`" class="doc-flow__sr-only">{{ flow.description }}</p>

    <div
      ref="canvas"
      class="doc-flow__canvas"
      :style="{ '--columns': flow.columns, '--small-columns': flow.smallColumns ?? 1 }"
    >
      <svg class="doc-flow__connections" aria-hidden="true">
        <defs>
          <marker :id="`${id}-arrow`" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M1 1 7 4 1 7" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
          </marker>
        </defs>
        <g v-for="(path, index) in paths" :key="index">
          <path :d="path.d" :marker-end="`url(#${id}-arrow)`" />
          <text v-if="path.label" :x="path.x" :y="path.y" dy="0.35em" text-anchor="middle">{{ path.label }}</text>
        </g>
      </svg>

      <div
        v-for="(node, index) in flow.nodes"
        :key="node.id"
        :data-flow-node="node.id"
        class="doc-flow__node"
        :class="{ 'doc-flow__node--accent': node.accent, 'doc-flow__node--nested': node.steps }"
        :style="nodeStyle(node, index)"
      >
        <span v-if="node.owner" class="doc-flow__owner">{{ node.owner }}</span>
        <strong class="doc-flow__title" :class="{ 'doc-flow__title--code': node.code }">
          <template v-if="node.code"><template v-for="(part, partIndex) in node.title.split(/(?<=[._])/)" :key="partIndex">{{ part }}<wbr /></template></template>
          <template v-else>{{ node.title }}</template>
        </strong>
        <span v-if="node.detail" class="doc-flow__detail">{{ node.detail }}</span>
        <ol v-if="node.steps" class="doc-flow__steps" aria-label="Private workflow stages">
          <li v-for="(step, stepIndex) in node.steps" :key="step">
            <span class="doc-flow__step-number" aria-hidden="true">0{{ stepIndex + 1 }}</span>
            <span>{{ step }}</span>
          </li>
        </ol>
        <dl v-if="node.items" class="doc-flow__items">
          <div v-for="item in node.items" :key="item.title">
            <dt>{{ item.title }}</dt>
            <dd>{{ item.detail }}</dd>
          </div>
        </dl>
      </div>
    </div>
    <p v-if="flow.note" class="doc-flow__note">{{ flow.note }}</p>
  </figure>
</template>

<style scoped>
.doc-flow {
  --flow-accent: var(--vp-c-brand-1);
  --flow-line: color-mix(in srgb, var(--vp-c-text-2) 52%, var(--vp-c-bg));
  container-type: inline-size;
  margin: 24px 0 32px;
  padding: 22px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
}

.doc-flow__caption {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 24px;
  color: var(--vp-c-text-2);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
}

.doc-flow__caption svg { flex: 0 0 18px; width: 18px; height: 18px; stroke: var(--flow-accent); stroke-width: 1.3; }
.doc-flow__canvas { position: relative; display: grid; grid-template-columns: repeat(var(--columns), minmax(0, 1fr)); gap: 40px 28px; }
.doc-flow__connections { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; color: var(--flow-line); pointer-events: none; }
.doc-flow__connections g > path { fill: none; stroke: currentColor; stroke-width: 1.4; }
.doc-flow__connections text { fill: var(--vp-c-text-2); stroke: var(--vp-c-bg-soft); stroke-width: 7px; stroke-linejoin: round; paint-order: stroke; font-size: 10px; font-weight: 500; }

.doc-flow__node {
  z-index: 1;
  display: flex;
  grid-column: var(--column) / span var(--span);
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  overflow-wrap: anywhere;
}

.doc-flow__node--accent { border-color: color-mix(in srgb, var(--flow-accent) 55%, var(--vp-c-bg)); background: color-mix(in srgb, var(--flow-accent) 7%, var(--vp-c-bg)); }
.doc-flow__node--nested { padding: 18px; border-style: dashed; }
.doc-flow__owner { margin-bottom: 8px; color: var(--vp-c-text-2); font-size: 9px; font-weight: 600; letter-spacing: 0.075em; line-height: 1.5; text-transform: uppercase; }
.doc-flow__node--accent .doc-flow__owner { color: var(--flow-accent); }
.doc-flow__title { color: var(--vp-c-text-1); font-size: 13px; font-weight: 600; line-height: 1.5; }
.doc-flow__title--code { font-family: var(--vp-font-family-mono); font-size: 12px; font-weight: 500; }
.doc-flow__detail { margin-top: 7px; color: var(--vp-c-text-2); font-size: 11px; line-height: 1.6; }

.doc-flow .doc-flow__steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; margin: 18px 0 0; padding: 0; list-style: none; }
.doc-flow .doc-flow__steps li { position: relative; display: flex; flex-direction: column; gap: 8px; margin: 0; padding-top: 12px; border-top: 1px solid var(--flow-line); font-family: var(--vp-font-family-mono); font-size: 11px; line-height: 1.6; }
.doc-flow__steps li + li::before { position: absolute; top: -9px; left: -18px; color: var(--flow-accent); content: "→"; }
.doc-flow__step-number { color: var(--flow-accent); font-size: 10px; }
.doc-flow__items { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 24px; margin: 20px 0 0; }
.doc-flow__items div { padding-left: 12px; border-left: 2px solid var(--vp-c-divider); }
.doc-flow__items dt { font-size: 12px; font-weight: 600; }
.doc-flow__items dd { margin: 5px 0 0; color: var(--vp-c-text-2); font-size: 11px; line-height: 1.6; }
.doc-flow .doc-flow__note { margin: 22px 0 0; padding-top: 16px; border-top: 1px solid var(--vp-c-divider); color: var(--vp-c-text-2); font-size: 12px; line-height: 1.65; }
.doc-flow__sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

@container (max-width: 480px) {
  .doc-flow__canvas { grid-template-columns: repeat(var(--small-columns), minmax(0, 1fr)); column-gap: 20px; }
  .doc-flow__node { grid-row: var(--small-row) !important; grid-column: var(--small-column) / span var(--small-span); padding: 12px; }
  .doc-flow__owner { font-size: 9px; }
  .doc-flow__items { grid-template-columns: 1fr; }
  .doc-flow .doc-flow__steps { grid-template-columns: 1fr; gap: 20px; }
  .doc-flow .doc-flow__steps li { flex-direction: row; align-items: baseline; gap: 12px; padding-top: 0; border: 0; }
  .doc-flow__steps li + li::before { top: -21px; left: 0; content: "↓"; }
}

@media (max-width: 640px) {
  .doc-flow { padding: 16px; }
}

@media print {
  .doc-flow { break-inside: avoid; }
}
</style>
