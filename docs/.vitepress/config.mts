import { defineConfig } from "vitepress";
import process from "node:process";
import { version } from "../../package.json";

const basePath = (process.env.DOCS_BASE ?? "").replace(/^\/+|\/+$/g, "");
const base = basePath.length > 0 ? `/${basePath}/` : "/";
const githubRepository = process.env.GITHUB_REPOSITORY ?? "simtlix/intention-kernel";

const evaluationSidebar = {
  text: "Evaluation",
  items: [
    { text: "Overview", link: "/guide/evaluation" },
    { text: "Evaluate from your project", link: "/guide/evaluation/quick-start" },
    { text: "Writing scenarios", link: "/guide/evaluation/scenarios" },
    { text: "Assertions and evaluators", link: "/guide/evaluation/assertions" },
    { text: "Running evaluations", link: "/guide/evaluation/running" },
    { text: "Reports and agent iteration", link: "/guide/evaluation/reports" },
  ],
};

const architectureSidebar = [
  {
    text: "Architecture",
    items: [
      { text: "Execution model", link: "/architecture/" },
      { text: "Core concepts", link: "/guide/core-concepts" },
      { text: "Runtime invariants", link: "/invariants" },
      { text: "Adapter boundaries", link: "/adapters" },
      { text: "Competitive analysis", link: "/competitive-analysis" },
    ],
  },
];

const apiSidebar = [
  {
    text: "API reference",
    items: [
      { text: "Overview and imports", link: "/api" },
      { text: "Runtime package", link: "/reference/intention-kernel" },
      { text: "Testing package", link: "/reference/testing/intention-kernel" },
    ],
  },
  {
    text: "Runtime functions",
    items: [
      { text: "createKernel", link: "/reference/intention-kernel.createkernel" },
      { text: "defineAgent", link: "/reference/intention-kernel.defineagent" },
      { text: "defineCapability", link: "/reference/intention-kernel.definecapability" },
    ],
  },
  {
    text: "Runtime contracts",
    collapsed: true,
    items: [
      { text: "CapabilityDefinition", link: "/reference/intention-kernel.capabilitydefinition" },
      { text: "CapabilityExecutionContext", link: "/reference/intention-kernel.capabilityexecutioncontext" },
      { text: "ModelGateway", link: "/reference/intention-kernel.modelgateway" },
      { text: "Durability", link: "/reference/intention-kernel.durability" },
      { text: "KernelEvent", link: "/reference/intention-kernel.kernelevent" },
      { text: "TurnResult", link: "/reference/intention-kernel.turnresult" },
    ],
  },
  {
    text: "Testing functions",
    items: [
      { text: "runEvaluation", link: "/reference/testing/intention-kernel.runevaluation" },
      { text: "parseEvaluationSuite", link: "/reference/testing/intention-kernel.parseevaluationsuite" },
      { text: "createAgentEvaluationAdapter", link: "/reference/testing/intention-kernel.createagentevaluationadapter" },
      { text: "evaluateAssertions", link: "/reference/testing/intention-kernel.evaluateassertions" },
      { text: "parseEvaluationReport", link: "/reference/testing/intention-kernel.parseevaluationreport" },
      { text: "createMemoryDurability", link: "/reference/testing/intention-kernel.creatememorydurability" },
      { text: "createEventCollector", link: "/reference/testing/intention-kernel.createeventcollector" },
    ],
  },
  {
    text: "Testing contracts",
    items: [
      { text: "EvaluationSuite", link: "/reference/testing/intention-kernel.evaluationsuite" },
      { text: "EvaluationScenario", link: "/reference/testing/intention-kernel.evaluationscenario" },
      { text: "EvaluationStep", link: "/reference/testing/intention-kernel.evaluationstep" },
      { text: "EvaluationVariant", link: "/reference/testing/intention-kernel.evaluationvariant" },
      { text: "EvaluationAssertion", link: "/reference/testing/intention-kernel.evaluationassertion" },
      { text: "EvaluationEvaluator", link: "/reference/testing/intention-kernel.evaluationevaluator" },
      { text: "EvaluationContext", link: "/reference/testing/intention-kernel.evaluationcontext" },
      { text: "EvaluationOptions", link: "/reference/testing/intention-kernel.evaluationoptions" },
      { text: "EvaluationAdapter", link: "/reference/testing/intention-kernel.evaluationadapter" },
      { text: "EvaluationSession", link: "/reference/testing/intention-kernel.evaluationsession" },
      { text: "EvaluationReport", link: "/reference/testing/intention-kernel.evaluationreport" },
      { text: "EvaluationError", link: "/reference/testing/intention-kernel.evaluationerror" },
    ],
  },
];

export default defineConfig({
  base,
  lang: "en-US",
  title: "Intention Kernel",
  titleTemplate: ":title · Intention Kernel",
  description: "A capability-first TypeScript runtime for durable, observable, model-driven agents.",
  srcExclude: ["superpowers/**"],
  appearance: "dark",
  cleanUrls: false,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", href: `${base}favicon-32x32.png?v=2`, sizes: "32x32", type: "image/png" }],
    ["link", { rel: "icon", href: `${base}favicon.svg?v=2`, type: "image/svg+xml" }],
    ["link", { rel: "apple-touch-icon", href: `${base}apple-touch-icon.png?v=2`, sizes: "180x180" }],
    ["meta", { name: "theme-color", content: "#0b0f15" }],
  ],
  markdown: {
    lineNumbers: true,
  },
  themeConfig: {
    socialLinks: [{ icon: "github", link: `https://github.com/${githubRepository}` }],
    logo: {
      light: "/intention-kernel-lockup-light.svg?v=2",
      dark: "/intention-kernel-lockup-dark.svg?v=2",
      alt: "Intention Kernel",
    },
    siteTitle: false,
    nav: [
      { text: "Guide", link: "/guide/", activeMatch: "^/guide/(?!evaluation)" },
      { text: "Architecture", link: "/architecture/" },
      { text: "Examples", link: "/examples/" },
      { text: "Evaluation", link: "/guide/evaluation" },
      { text: "API", link: "/api", activeMatch: "^/(api|reference/)" },
      {
        text: version,
        items: [
          { text: "Release policy", link: "/releases" },
          { text: "Changelog", link: "/changelog" },
        ],
      },
    ],
    search: {
      provider: "local",
    },
    sidebar: {
      "/guide/": [
        {
          text: "Start",
          items: [
            { text: "Overview", link: "/guide/" },
            { text: "Installation and first agent", link: "/guide/getting-started" },
            { text: "Core concepts", link: "/guide/core-concepts" },
          ],
        },
        {
          text: "Build",
          items: [
            { text: "Capabilities", link: "/guide/capabilities" },
            { text: "Model gateways", link: "/guide/models" },
            { text: "Durability and effects", link: "/guide/durability" },
            { text: "Grounded responses", link: "/guide/grounding" },
          ],
        },
        {
          text: "Operate",
          items: [
            { text: "Events and traces", link: "/guide/events" },
            { text: "Nested workflows", link: "/guide/subgraphs" },
            { text: "Testing your application", link: "/guide/testing" },
            { text: "Adapter contracts", link: "/adapters" },
            { text: "Runtime invariants", link: "/invariants" },
          ],
        },
        evaluationSidebar,
        {
          text: "Library development",
          collapsed: true,
          items: [
            { text: "Repository testing", link: "/development/testing" },
            { text: "Repository examples", link: "/development/examples" },
          ],
        },
      ],
      "/architecture/": architectureSidebar,
      "/api": apiSidebar,
      "/invariants": architectureSidebar,
      "/adapters": architectureSidebar,
      "/competitive-analysis": architectureSidebar,
      "/examples/": [
        {
          text: "Application examples",
          items: [
            { text: "Examples", link: "/examples/" },
            { text: "Evaluate from your project", link: "/guide/evaluation/quick-start" },
            { text: "Testing strategy", link: "/guide/testing" },
            { text: "Nested workflow", link: "/guide/subgraphs" },
          ],
        },
      ],
      "/development/": [
        {
          text: "Library development",
          items: [
            { text: "Repository testing", link: "/development/testing" },
            { text: "Repository examples", link: "/development/examples" },
            { text: "Repository evaluation tutorial", link: "/development/evaluation-tutorial" },
            { text: "Publishing from GitHub", link: "/development/releasing" },
            { text: "Using the installed package", link: "/guide/evaluation/quick-start" },
          ],
        },
      ],
      "/reference/": apiSidebar,
    },
    outline: {
      level: [2, 3],
      label: "On this page",
    },
    docFooter: {
      prev: "Previous",
      next: "Next",
    },
    lastUpdated: {
      text: "Updated",
      formatOptions: {
        dateStyle: "medium",
        timeStyle: "short",
      },
    },
    footer: {
      message: 'Released under the <a href="https://www.apache.org/licenses/LICENSE-2.0">Apache License 2.0</a>.',
      copyright: `Intention Kernel ${version}`,
    },
  },
});
