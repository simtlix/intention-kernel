// Only snapshots traversed by this module are trusted. A caller-frozen root can
// still contain mutable children, so Object.isFrozen alone is not sufficient.
const snapshots = new WeakSet<object>();

/** Freeze runner-owned JSON evidence once, retaining shared immutable children. */
export function freezeEvaluationData<T>(value: T): T {
  if (value === null || typeof value !== "object" || snapshots.has(value)) return value;
  for (const child of Object.values(value)) freezeEvaluationData(child);
  Object.freeze(value);
  snapshots.add(value);
  return value;
}

/** Isolate external evidence; runner-owned snapshots need no aggregate copy. */
export function evaluationSnapshot<T>(value: T): T {
  if (value === null || typeof value !== "object" || snapshots.has(value)) return value;
  return freezeEvaluationData(structuredClone(value));
}
