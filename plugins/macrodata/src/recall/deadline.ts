/**
 * A deadline for work that has no cancellation.
 *
 * The recall pipeline runs inside a long-lived worker that serves one state
 * root, so an await that never settles is not a slow request — it is the end of
 * recall for that root, with the process still in `ps` looking healthy. Nothing
 * in the pipeline can be cancelled (a model load in node-llama-cpp least of
 * all), so the only available answer is to notice and let the caller die.
 */

/** Resolved in place of the value when the deadline wins. */
export const WEDGED = Symbol("wedged");

/**
 * setTimeout stores its delay in a signed 32-bit int (~24.9 days). A larger one
 * overflows and the timer fires on the NEXT TICK — so an operator who widens a
 * budget past the limit gets no budget at all, and every request is declared
 * wedged the moment it starts, which exits the worker in a loop.
 */
export const TIMER_MAX_MS = 2 ** 31 - 1;

/**
 * Race `p` against `ms`, resolving to WEDGED if the deadline wins.
 *
 * Resolves rather than rejects: a rejection here would be indistinguishable from
 * the awaited work's own failure, which is recoverable and must not be treated
 * as a reason to end the process. The loser keeps running — nothing can stop it
 * — so this is only safe where a deadline miss is terminal.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof WEDGED> {
  // Clamped here as well as at the config edge, because the failure is silent
  // and its blast radius is the whole worker: too large overflows into
  // fire-immediately, and a negative or NaN delay is treated by setTimeout as 1.
  const delay = Number.isFinite(ms) ? Math.min(Math.max(ms, 1), TIMER_MAX_MS) : TIMER_MAX_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof WEDGED>((resolve) => {
    timer = setTimeout(() => resolve(WEDGED), delay);
  });
  // Cleared on both paths: an uncleared timer keeps the event loop alive for the
  // whole budget after the work is done, which in a 20-minute cold budget would
  // hold a worker open long past any request.
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}
