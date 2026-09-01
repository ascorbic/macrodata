/**
 * withDeadline — the recall worker's only defense against an await that never
 * settles.
 *
 * The worker holds the single-worker claim for its state root, so a pipeline
 * that hangs takes recall down in the one way nothing outside the process can
 * see or fix: it stays in `ps`, the hook reads it as healthy, and any
 * replacement stands down against its claim. These pin the properties the worker
 * depends on — the value wins when it arrives in time, the deadline resolves
 * (never rejects) when it doesn't, the timer stops on every exit path, and a
 * budget too large for setTimeout to hold is clamped rather than overflowed into
 * firing immediately.
 */

import { describe, test, expect } from "bun:test";
import { TIMER_MAX_MS, WEDGED, withDeadline } from "../src/recall/deadline.ts";

const after = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

/**
 * Run `fn` with the timer calls it makes recorded.
 *
 * The work promise must be built BEFORE this is entered — a timer created by the
 * work itself is indistinguishable here from the deadline's own, and would read
 * as a leak forever.
 */
async function withTimerLedger<T>(fn: () => Promise<T>) {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const created: unknown[] = [];
  const cleared: unknown[] = [];
  globalThis.setTimeout = ((...a: Parameters<typeof realSet>) => {
    const id = realSet(...a);
    created.push(id);
    return id;
  }) as typeof realSet;
  globalThis.clearTimeout = ((id: Parameters<typeof realClear>[0]) => {
    cleared.push(id);
    return realClear(id);
  }) as typeof realClear;
  try {
    return { result: await fn(), created, cleared };
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

describe("withDeadline", () => {
  test("resolves with the value when the work finishes in time", async () => {
    expect(await withDeadline(after(5, "hits"), 1000)).toBe("hits");
  });

  test("resolves to WEDGED when the deadline wins", async () => {
    expect(await withDeadline(after(1000, "hits"), 5)).toBe(WEDGED);
  });

  test("a never-settling promise still yields WEDGED", async () => {
    expect(await withDeadline(new Promise<string>(() => {}), 5)).toBe(WEDGED);
  });

  // A rejection here would be indistinguishable from the pipeline's own failure,
  // which the worker recovers from — so rejections must pass through untouched
  // rather than be folded into the wedge signal.
  test("passes a rejection through instead of swallowing it", async () => {
    // Settled through one channel so a resolve and a reject are compared as the
    // same kind of value: a rejection swallowed into WEDGED would otherwise read
    // as a pass in a test that only asserts "did not resolve with the value".
    const settled = await withDeadline(Promise.reject(new Error("pipeline blew up")), 1000).then(
      (v) => (v === WEDGED ? "wedged" : "resolved"),
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(settled).toBe("pipeline blew up");
  });

  // An uncleared timer keeps the event loop alive for the whole budget after the
  // work is done. On the 20-minute cold budget that holds a worker open long past
  // any request it was serving — and the worker is the process the single-worker
  // claim belongs to, so the next session stands down against a wedge that has
  // already finished its work.
  describe("stops its timer", () => {
    test("when the value wins", async () => {
      const work = after(5, "hits");
      const { result, created, cleared } = await withTimerLedger(() => withDeadline(work, 1000));
      expect(result).toBe("hits");
      expect(created.length).toBe(1);
      expect(cleared).toEqual(created);
    });

    test("when the deadline wins", async () => {
      const work = new Promise<string>(() => {});
      const { result, created, cleared } = await withTimerLedger(() => withDeadline(work, 5));
      expect(result).toBe(WEDGED);
      expect(created.length).toBe(1);
      expect(cleared).toEqual(created);
    });

    // The path a `.then(onFulfilled)` cleanup misses: the rejection travels out
    // of withDeadline untouched, and the timer it left behind travels with it.
    test("when the work rejects", async () => {
      const work = Promise.reject(new Error("pipeline blew up"));
      const { created, cleared } = await withTimerLedger(() =>
        withDeadline(work, 1000).catch(() => "caught"),
      );
      expect(created.length).toBe(1);
      expect(cleared).toEqual(created);
    });
  });

  // setTimeout stores its delay in a signed 32-bit int. A larger one overflows
  // and fires on the NEXT TICK, so an operator who widens a budget past the limit
  // gets no budget at all: every request is declared wedged the moment it starts,
  // which exits the worker in a loop. The clamp is what makes a too-large budget
  // merely large.
  describe("clamps a delay setTimeout cannot hold", () => {
    for (const [label, ms] of [
      ["past the 32-bit ceiling", TIMER_MAX_MS + 1],
      ["Number.MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["NaN", Number.NaN],
    ] as const) {
      test(`${label} still lets the work finish`, async () => {
        expect(await withDeadline(after(5, "hits"), ms)).toBe("hits");
      });
    }

    // Clamped up to 1 rather than rejected: a nonsensical budget is still a
    // budget, and setTimeout would treat it as 1 regardless.
    test("a negative delay wedges immediately rather than never", async () => {
      expect(await withDeadline(after(1000, "hits"), -1)).toBe(WEDGED);
    });
  });
});
