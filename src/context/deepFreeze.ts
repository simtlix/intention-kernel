/** Recursively freeze a snapshot that contains data but no executable services. */
export function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || visited.has(value)) return value;
  visited.add(value);

  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, visited);
  }
  return Object.freeze(value);
}
