import DefaultTheme from "vitepress/theme";

import DocFlow from "./components/DocFlow.vue";
import KernelFlow from "./components/KernelFlow.vue";
import KernelHome from "./components/KernelHome.vue";
import TraceWalkthrough from "./components/TraceWalkthrough.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("DocFlow", DocFlow);
    app.component("KernelFlow", KernelFlow);
    app.component("KernelHome", KernelHome);
    app.component("TraceWalkthrough", TraceWalkthrough);
  },
};
