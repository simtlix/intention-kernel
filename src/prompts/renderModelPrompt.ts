import { KernelConfigurationError } from "../contracts/errors.js";
import type { ModelPromptDefinition } from "../contracts/prompt.js";

const MAX_BYTES = 1_048_576;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function object(value: unknown): boolean { return typeof value === "object" && value !== null && !Array.isArray(value); }

function invalid(): never {
  throw new KernelConfigurationError({ code: "INVALID_MODEL_PROMPT", message: "The model prompt violates its interpolation contract or size limit.", retryable: false });
}

function bounded(value: unknown): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_BYTES) invalid();
}

function placeholders(template: string, names: ReadonlySet<string>): readonly { start: number; end: number; name: string }[] {
  const result: { start: number; end: number; name: string }[] = [];
  const pattern = /\{\{|\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    if (match[0] !== "{{") invalid();
    const end = template.indexOf("}}", match.index + 2);
    if (end < 0) invalid();
    const name = template.slice(match.index + 2, end);
    if (!NAME.test(name) || !names.has(name)) invalid();
    result.push({ start: match.index, end: end + 2, name });
    pattern.lastIndex = end + 2;
  }
  return result;
}

/**
 * Render bounded literal instructions with exact, one-pass `{{variable}}` substitution.
 *
 * @param definition - Valid unique ID, positive version, default template and up to 128 variable names.
 * @param values - Own string properties matching every declared variable, with no extra names.
 * @param template - Optional pinned replacement; it may omit placeholders but cannot add names.
 * @returns Instructions of at most 1 MiB UTF-8; inserted values are never reparsed.
 * @throws {@link KernelConfigurationError} with `INVALID_MODEL_PROMPT` for invalid definitions,
 * malformed placeholders, missing/extra values, or any template/value/output above 1 MiB.
 * @example
 * ```ts
 * renderModelPrompt({ id: "greeting", contractVersion: 1, template: "Hello {{name}}", variables: ["name"] }, { name: "Ada" });
 * ```
 */
export function renderModelPrompt(definition: ModelPromptDefinition, values: Readonly<Record<string, string>>, template?: string): string {
  if (!object(definition) || typeof definition.id !== "string" ||
    !/^[A-Za-z][A-Za-z0-9._-]{0,199}$/.test(definition.id) || !Number.isSafeInteger(definition.contractVersion) || definition.contractVersion < 1 ||
    !Array.isArray(definition.variables) || definition.variables.length > 128) invalid();
  const names = new Set<string>();
  for (const name of definition.variables) {
    if (typeof name !== "string" || !NAME.test(name) || names.has(name)) invalid();
    names.add(name);
  }
  bounded(definition.template);
  placeholders(definition.template, names);
  if (!object(values)) invalid();
  const keys = Reflect.ownKeys(values);
  if (keys.length !== names.size || keys.some(key => typeof key !== "string" || !names.has(key))) invalid();
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(values, name);
    if (property === undefined || !("value" in property)) invalid();
    bounded(property.value);
  }
  const effective = template === undefined ? definition.template : template;
  bounded(effective);
  const tokens = placeholders(effective, names);
  const pieces: string[] = [];
  let cursor = 0;
  let bytes = 0;
  for (const token of tokens) {
    const literal = effective.slice(cursor, token.start);
    const value = values[token.name];
    bounded(value);
    bytes += Buffer.byteLength(literal) + Buffer.byteLength(value);
    if (bytes > MAX_BYTES) invalid();
    pieces.push(literal, value);
    cursor = token.end;
  }
  const tail = effective.slice(cursor);
  if (bytes + Buffer.byteLength(tail) > MAX_BYTES) invalid();
  return pieces.join("") + tail;
}
