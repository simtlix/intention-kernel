import { EvaluationError } from "./schema.js";

export async function withDeadline<T>(signal: AbortSignal, milliseconds: number, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal.aborted) throw new EvaluationError("EVALUATION_CANCELLED");
  const timeout = new AbortController();
  const combined = AbortSignal.any([signal, timeout.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(new EvaluationError(signal.aborted ? "EVALUATION_CANCELLED" : "EVALUATION_TIMEOUT")); };
    combined.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { timeout.abort(); }, milliseconds);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => execute(combined)), stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) combined.removeEventListener("abort", abort);
  }
}
