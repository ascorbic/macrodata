/**
 * In-process model singletons via node-llama-cpp (Metal GPU) — the -nlc variant's
 * replacement for the external llama-server HTTP endpoints (:8091 embed, :8090
 * rerank) and the shell script that kept those servers alive. Models load ONCE
 * per process (lazy): fine for the long-lived worker and the one-shot reindex /
 * `--query` CLI, but NOT the per-fire
 * hook — in its default async mode the hook never loads models, the worker does
 * (MACRODATA_RECALL_MODE=sync is the explicit inline-debug override).
 *
 * Same GGUFs as the llama-server setup; embedding pooling is driven by the model's
 * own GGUF metadata (Qwen3-Embedding ships last-token pooling).
 */
import { getLlama, resolveModelFile } from "node-llama-cpp";

const EMBED_URI = process.env.MACRODATA_EMBED_MODEL ?? "hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0";
const RERANK_URI = process.env.MACRODATA_RERANK_MODEL ?? "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";

// Memoize the promise but DROP it on rejection: a transient load failure (offline
// with a cold HF cache, Metal allocation under pressure) must not brick the
// long-lived worker — the next request retries instead of inheriting the rejection.
function memoAsync<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () =>
    (p ??= load().catch((e) => {
      p = undefined;
      throw e;
    }));
}

// Circuit breaker between memoAsync's retry-on-rejection and the loaders: the
// retry exists for TRANSIENT failures, but under sustained Metal pressure each
// failed cycle can strand another ~600MB weights copy (loadModel succeeds,
// context-create fails, dispose may wedge — node-llama-cpp never reclaims on
// GC), and hook fires arrive seconds apart. Unbounded retry is a positive-
// feedback leak amplifier on unified memory: each leaked copy worsens the
// pressure that caused the failure, until the machine swap-storms. After
// MAX_CONSECUTIVE failures the circuit opens for COOLDOWN_MS — requests fail
// fast (recall degrades to nothing, which the mailbox protocol tolerates)
// instead of eating RAM. A post-cooldown success resets the count.
const MAX_CONSECUTIVE = 3;
const COOLDOWN_MS = 10 * 60_000;
function breaker<T>(load: () => Promise<T>, label: string): () => Promise<T> {
  let failures = 0;
  let openUntil = 0;
  return async () => {
    if (failures >= MAX_CONSECUTIVE && Date.now() < openUntil) {
      throw new Error(`[models] ${label} circuit open after ${failures} consecutive load failures; retrying after cooldown`);
    }
    try {
      const v = await load();
      failures = 0;
      return v;
    } catch (e) {
      failures++;
      if (failures >= MAX_CONSECUTIVE) {
        openUntil = Date.now() + COOLDOWN_MS;
        console.error(`[models] ${label} failed ${failures}x consecutively — circuit open ${COOLDOWN_MS / 60_000}min (weights may have leaked; restart the worker to reclaim)`);
      }
      throw e;
    }
  };
}

const llama = memoAsync(() => getLlama());

// If context creation fails AFTER the model loaded (Metal alloc pressure — the
// exact case the retry exists for), dispose the model before rethrowing: node-
// llama-cpp does NOT reclaim models on GC, so a bare retry would load a second
// copy of the weights and compound the pressure that caused the failure.
//
// The dispose itself must not hold the rethrow hostage: a wedged Metal dispose
// (same pressure that broke context-create) would leave the memoized promise
// forever-pending — memoAsync's rejection-drop only fires on rejection, so the
// long-lived worker would brick with every request awaiting a promise that
// never settles. Bound the cleanup; on timeout the weights may leak, which the
// retry path already tolerates and the warn makes visible.
async function disposeBounded(model: { dispose(): Promise<void> }, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 10_000); });
  // The rejection handler is attached BEFORE the race, not in a catch around
  // it: when the timeout wins, the still-pending dispose promise leaves the
  // race unobserved, and a wedge that eventually ERRORS (the most plausible
  // wedge outcome) would then reject with no handler — an unhandled rejection
  // that kills the long-lived worker long after this function returned.
  const disposed = model.dispose().then(
    () => "ok" as const,
    (de) => { console.warn(`[models] ${label} model dispose failed after context-init error (weights may leak): ${String(de)}`); return "ok" as const; },
  );
  const winner = await Promise.race([disposed, timeout]);
  if (winner === "timeout") console.warn(`[models] ${label} model dispose timed out after context-init error (weights may leak)`);
  clearTimeout(timer);
}

// The first search in a process pays for a possible multi-GB HF download plus
// two model loads; every later one runs against weights already in memory. That
// gap is minutes wide, so callers that time-box a search need to know which one
// they are about to do — and they cannot infer it from results, because a search
// that returns nothing looks the same whether the models loaded or never did.
// Set beside the memoized loads, which run at most once each.
let embedLoaded = false;
let rankLoaded = false;

/** Whether both model loads have completed in this process. */
export function modelsLoaded(): boolean {
  return embedLoaded && rankLoaded;
}

async function loadEmbed() {
  const model = await (await llama()).loadModel({ modelPath: await resolveModelFile(EMBED_URI) });
  try {
    const ctx = await model.createEmbeddingContext({ contextSize: 4096 });
    embedLoaded = true;
    return ctx;
  } catch (e) {
    await disposeBounded(model, "embed");
    throw e;
  }
}
export const embedContext = memoAsync(breaker(loadEmbed, "embed"));

async function loadRank() {
  const model = await (await llama()).loadModel({ modelPath: await resolveModelFile(RERANK_URI) });
  try {
    const ctx = await model.createRankingContext({ contextSize: 4096 });
    rankLoaded = true;
    return ctx;
  } catch (e) {
    await disposeBounded(model, "rerank");
    throw e;
  }
}
export const rankContext = memoAsync(breaker(loadRank, "rerank"));

// Which GPU backend resolved (metal/cuda/false) — for the smoke/CLI to report.
export async function gpuInfo(): Promise<string> {
  const l = await llama();
  return l.gpu ? (await l.getGpuDeviceNames()).join(",") || String(l.gpu) : "cpu";
}
