import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getKernelPromptDefinitions, renderModelPrompt } from "../../src/index.js";

describe("identified prompt contracts", () => {
  const definition = { id: "test.prompt", contractVersion: 1, template: "Hello {{name}}", variables: ["name"] };
  it("renders once and never expands inserted instructions", () => {
    expect(renderModelPrompt(definition, { name: "{{name}}" })).toBe("Hello {{name}}");
    expect(renderModelPrompt(definition, { name: "Ada" }, "Welcome {{name}}!")).toBe("Welcome Ada!");
  });
  it("rejects undeclared, missing, malformed and oversized inputs", () => {
    expect(() => renderModelPrompt(definition, { unauthorized: "x" })).toThrow();
    expect(() => renderModelPrompt(definition, {})).toThrow();
    for (const template of ["{{name.path}}", "{{unknown}}", "{{name", "name}}", "{{ name }}"]) {
      expect(() => renderModelPrompt(definition, { name: "Ada" }, template)).toThrow();
    }
    expect(() => renderModelPrompt({ ...definition, variables: ["name", "name"] }, { name: "Ada" })).toThrow();
    expect(() => renderModelPrompt({ ...definition, contractVersion: 0 }, { name: "Ada" })).toThrow();
    expect(() => renderModelPrompt(definition, { name: "x".repeat(1_048_577) })).toThrow();
  });
  it("preserves every assembled baseline and identifies its source call site", () => {
    const baseline = JSON.parse(readFileSync(new URL("./model-prompts-baseline.json", import.meta.url), "utf8")) as { source: string; id: string; template: string }[];
    const catalog = getKernelPromptDefinitions();
    expect(catalog).toHaveLength(baseline.length);
    for (const entry of baseline) {
      expect(catalog.find(item => item.id === entry.id)?.template).toBe(entry.template);
      const source = readFileSync(new URL(`../../${entry.source}`, import.meta.url), "utf8");
      expect(source).toContain(JSON.stringify(entry.id));
      expect(source).not.toMatch(/\bsystem\s*:/);
    }
  });
  it("exposes distinct immutable definitions with renderable defaults", () => {
    const catalog = getKernelPromptDefinitions();
    expect(catalog.length).toBeGreaterThanOrEqual(24);
    expect(new Set(catalog.map(item => item.id)).size).toBe(catalog.length);
    expect(Object.isFrozen(catalog)).toBe(true);
    for (const item of catalog) {
      expect(Object.isFrozen(item)).toBe(true);
      expect(Object.isFrozen(item.variables)).toBe(true);
      expect(renderModelPrompt(item, {})).toBe(item.template);
    }
  });
});
