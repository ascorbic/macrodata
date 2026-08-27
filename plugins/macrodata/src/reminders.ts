/**
 * Pure helpers for the scheduled-reminder pipeline (daemon side).
 *
 * Extracted from the daemon so the sanitization is unit- and property-testable
 * without booting the process. Everything here treats a schedule's
 * id/description/payload/model as UNTRUSTED: a schedule can be planted by any
 * `schedule` MCP-tool call (which model-driven prompt injection can induce),
 * and its fields are later written into state/reminders.md (injected into
 * every session via compose-state-file.ts) or passed to a headless spawn. So
 * we sanitize at this boundary even though the MCP tool also validates —
 * schedule JSON on disk can predate the tool's validation or be hand-edited.
 */

import { Cron } from "croner";

export const DEFAULT_MODEL = "haiku";

// Aliases the Agent tool accepts. An unknown/garbage model can't be pinned —
// it falls back to the cheap default, so an injected schedule can't re-arm an
// expensive model (the cost regression this whole change exists to prevent).
const MODEL_ALIASES: readonly string[] = ["opus", "sonnet", "haiku", "fable"];

/** Map a stored model string to a safe Agent-tool alias, or the cheap default. */
export function resolveModel(model?: string): string {
  if (!model) return DEFAULT_MODEL;
  const bare = model.replace(/^anthropic\//, "").trim();
  if (MODEL_ALIASES.includes(bare)) return bare;
  // Full ids like "claude-opus-4-7" → their alias.
  const m = bare.match(/\b(opus|sonnet|haiku|fable)\b/);
  return m ? m[1] : DEFAULT_MODEL;
}

/** Minimum allowed gap between cron firings. macrodata has no sub-2-minute use
 *  case, and a hot cron on headless delivery is an unbounded spawn-rate hazard
 *  (no coalescing). */
export const MIN_CRON_INTERVAL_MS = 2 * 60 * 1000;

/**
 * True if a cron expression fires more often than every 2 minutes. Walks the
 * firings across a full week (bounded) rather than a fixed small sample, so a
 * tight pair that only recurs hourly or daily is still caught — a 5-run window
 * misses a sparse-early, tight-late layout like `0,10,20,30,40,50,51 * * * *`.
 * A sub-2m gap returns early; a clean cadence walks to the horizon and returns
 * false. Unparseable expressions return false (croner surfaces those
 * elsewhere). Only meaningful for cron type; a once-style ISO datetime yields a
 * single run and is never flagged.
 */
export function cronTooFrequent(expression: string, ref: Date = new Date()): boolean {
  const HORIZON_MS = 7 * 24 * 60 * 60 * 1000; // a week covers daily/weekly periods
  const MAX_SAMPLES = 2000; // bound the walk for near-floor cadences
  try {
    const cron = new Cron(expression);
    const deadline = ref.getTime() + HORIZON_MS;
    let prev: Date | null = null;
    for (let i = 0; i < MAX_SAMPLES; i++) {
      const next = cron.nextRun(prev ?? ref);
      if (!next || next.getTime() > deadline) break;
      // Skip the ref→first gap (ref isn't a firing); compare firing-to-firing.
      if (prev && next.getTime() - prev.getTime() < MIN_CRON_INTERVAL_MS) return true;
      prev = next;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Reduce a schedule id to a safe single-token key. Drops any path component,
 * keeps only [A-Za-z0-9_-], strips leading separators, caps length.
 * Guarantees: no "/" or ".." (no traversal), no leading ".", no
 * quote/glob/newline/bracket — so it can serve as the `[id]` upsert key on a
 * reminders.md entry line and appear in filenames or attributes unquoted.
 */
export function safeId(id: string): string {
  const base = id.replace(/^.*[\\/]/, "");
  const cleaned = base.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned.replace(/^[-_]+/, "") || "reminder";
}

/**
 * The only shape a schedule id may take: one filename-safe token. An id is the
 * `<id>.json` filename under reminders/ and an unquoted XML attribute when the
 * schedule fires, so every path that deletes by id refuses anything outside
 * this set instead of joining it — `join(remindersDir, "../../.claude/settings")`
 * names a file the caller was never allowed to touch. safeId() is the lossy
 * repair for display keys; this is the strict gate in front of the filesystem.
 */
export const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeId(id: string): boolean {
  return SAFE_ID_RE.test(id);
}

/**
 * Why a one-shot expression can't be armed, or null if it can. `new Date` turns
 * an unparseable string into NaN, which is not "in the future" and so reads as
 * already expired: the schedule tool would report success and the daemon would
 * delete the file on its next load. A past date is refused for the same reason.
 */
export function onceExpressionError(expression: string, now: Date = new Date()): string | null {
  const t = new Date(expression).getTime();
  if (Number.isNaN(t)) return `"${expression}" is not a valid date — use an ISO datetime like 2026-01-31T10:00:00`;
  if (t <= now.getTime()) return `${expression} is already in the past`;
  return null;
}

/**
 * Body text for a macOS notification. It lands inside an osascript string
 * literal, so quotes and backslashes go; control characters go too, because a
 * NUL byte makes child_process.spawn throw synchronously (ERR_INVALID_ARG_VALUE)
 * and from a cron callback that exception is fatal to the daemon. Non-string
 * input (a schedule with neither description nor payload) becomes "".
 */
export function notificationText(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(/[\u0000-\u001f\u007f"\\]/g, "").slice(0, 200);
}

/**
 * Neutralize macrodata block openers/closers in free text so an untrusted
 * payload can't close the <macrodata-reminders> wrapper its entry line is
 * injected through, or forge a sibling block. Mirrors the USER_INFO
 * neutralization in macrodata-hook.sh; leaves other markup intact so
 * legitimate payload text (code, etc.) survives.
 */
export function neutralizeTags(s: string): string {
  return s
    .replace(/<\/macrodata/g, "&lt;/macrodata")
    .replace(/<macrodata/g, "&lt;macrodata");
}

export interface ReminderInput {
  id: string;
  description: string;
  payload: string;
  model?: string;
}

/** Delivery modes the daemon executes. "session" is a legacy stored value that
 *  maps to "notify" at fire time (fireSchedule logs the remap). */
export function resolveDelivery(delivery?: string): "notify" | "headless" {
  return delivery === "headless" ? "headless" : "notify";
}

export const REMINDERS_HEADING = "## ⏰ Reminders";

/**
 * One reminders.md entry line for a fired schedule:
 *   - [<id>] fired <YYYY-MM-DD HH:MM> — <payload>
 * The line is the unit of the file — a session removes it with the Edit tool
 * once the reminder is addressed — so the untrusted payload must stay on it:
 * newlines collapse to " / " (a raw newline would let a payload forge a
 * sibling entry or a heading), and macrodata tags are neutralized so the line
 * can't break the compose-state-file wrapper it's injected through.
 */
export function formatReminderEntry(s: ReminderInput, firedAt: Date): string {
  const id = safeId(s.id);
  const pad = (n: number) => String(n).padStart(2, "0");
  const when = `${firedAt.getFullYear()}-${pad(firedAt.getMonth() + 1)}-${pad(firedAt.getDate())} ${pad(firedAt.getHours())}:${pad(firedAt.getMinutes())}`;
  const payload = neutralizeTags(s.payload).replace(/[\r\n]+/g, " / ").trim();
  return `- [${id}] fired ${when} — ${payload}`;
}

/**
 * Upsert an entry line into reminders.md content: replace an existing line for
 * the same schedule id (a re-fired reminder that was never addressed updates
 * in place rather than stacking), else append. The ⏰ heading is asserted
 * whenever it is missing — for a null `existing` (no file yet) and for a file
 * that lost it to hand-editing. Consumers key on the `- ` entry lines, not the
 * heading, so this is for the human reading the file, not for delivery.
 */
export function upsertReminderLine(existing: string | null, entry: string, id: string): string {
  const marker = `- [${safeId(id)}] `;
  const lines = (existing?.trimEnd() || REMINDERS_HEADING).split("\n");
  if (!lines.some((l) => l.startsWith(REMINDERS_HEADING))) lines.unshift(REMINDERS_HEADING);
  const at = lines.findIndex((l) => l.startsWith(marker));
  if (at >= 0) {
    lines[at] = entry;
  } else {
    lines.push(entry);
  }
  return lines.join("\n") + "\n";
}

/**
 * Argv for the "headless" delivery path:
 *   claude --print --model <alias> -- <payload>
 * Flags go first and the payload is the final positional behind a `--`
 * end-of-options sentinel, so a payload that happens to start with "-" is still
 * the prompt, never parsed as a claude flag. (claude is Commander-based and the
 * prompt is positional — `Usage: claude [options] [command] [prompt]`, verified
 * against CLI 2.1.x, which honors `--`.) The model is clamped to a safe alias by
 * resolveModel. spawn uses an arg array (never a shell), so no shell-escaping is
 * needed.
 */
export function buildHeadlessArgs(s: ReminderInput): string[] {
  return ["--print", "--model", resolveModel(s.model), "--", s.payload];
}
