import { createHash } from "node:crypto";

/** Hash a JSON-compatible definition using deterministic key ordering. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined && typeof entry !== "function")
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
