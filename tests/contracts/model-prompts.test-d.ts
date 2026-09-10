import { expectTypeOf } from "vitest";
import { getKernelPromptDefinitions, renderModelPrompt, type ModelPromptDefinition, type ModelPromptReference, type ModelPromptResolver, type KernelOptions, type ModelRequest } from "../../dist/index.js";

expectTypeOf(getKernelPromptDefinitions()).toEqualTypeOf<readonly ModelPromptDefinition[]>();
const reference: ModelPromptReference = { definition: { id: "example", contractVersion: 1, template: "{{name}}", variables: ["name"] }, values: { name: "Ada" } };
expectTypeOf(renderModelPrompt(reference.definition, reference.values)).toEqualTypeOf<string>();
const resolver: ModelPromptResolver = { resolve: () => ({ revision: "r1", template: "{{name}}" }) };
expectTypeOf<KernelOptions["promptResolver"]>().toEqualTypeOf<ModelPromptResolver | undefined>();
expectTypeOf<ModelRequest<unknown>["prompt"]>().toEqualTypeOf<ModelPromptReference | undefined>();
expectTypeOf(resolver.resolve(reference).revision).toEqualTypeOf<string>();
// @ts-expect-error Revisions are strings, never numeric database keys.
const numericRevision: ModelPromptResolver = { resolve: () => ({ revision: 1, template: "text" }) };
// @ts-expect-error Resolver snapshots must already be loaded, never asynchronous.
const asyncResolver: ModelPromptResolver = { resolve: () => Promise.resolve({ revision: "r1", template: "text" }) };
// @ts-expect-error Values are strings; arbitrary execution objects are not template inputs.
renderModelPrompt(reference.definition, { name: { private: true } });
// @ts-expect-error Public contracts are readonly.
reference.definition.template = "changed";
expectTypeOf(numericRevision).toEqualTypeOf<ModelPromptResolver>();
expectTypeOf(asyncResolver).toEqualTypeOf<ModelPromptResolver>();
