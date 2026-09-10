import { getKernelPromptDefinitions, renderModelPrompt, type ModelPromptResolver } from "intention-kernel";

// Load persistence outside the turn, then inject this resolver into createKernel.
const revisions = new Map(getKernelPromptDefinitions().map(definition => [definition.id, Object.freeze({
  template: definition.template,
  revision: "publication-1",
})]));

export const promptResolver: ModelPromptResolver = {
  resolve(reference) {
    const revision = revisions.get(reference.definition.id);
    if (revision === undefined) throw new Error("Publication does not contain the requested prompt.");
    return revision;
  },
};

const preview = renderModelPrompt({ id: "host.greeting", contractVersion: 1, template: "Hello {{name}}", variables: ["name"] }, { name: "Ada" });
if (preview !== "Hello Ada") throw new Error("Prompt preview differs from runtime rendering");
