#!/usr/bin/env bun
// Composer for a SINGLE macrodata state file, emitted as its own SessionStart
// hook so it lands in its own ~10K hook-output envelope. Claude Code caps each
// hook output string independently (anthropics/claude-code#44086 — overflow is
// a hard cliff to a 2K preview), and multiple SessionStart hooks run in
// parallel, so one file per hook gives each state file its own budget instead
// of all of them fighting inside a single envelope.
//
// Invoked once per state file:  bun compose-state-file.ts today.md
//
// Each file is head-keep truncated to its own cap — chars AND lines, whichever
// hits first — with a visible in-band marker when clipped. The truncation is
// HARD (the channel is a hard cliff), but the marker is the soft-pressure /
// forcing-function layer: it points at the intact file on disk and nudges
// toward distill / wikilink-out / journal-relocate rather than deletion.
//
// Caps are generous pragmatic defaults (start-high, tune-down). Per-file
// tuning = edit the BUDGETS table below; the char cap is the binding
// constraint at launch and the line cap starts dormant (a concision lever for
// later). They are defaults to tune empirically, not derived constants.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getStateDir } from "../src/config.js";

interface Budget {
  chars: number;
  lines: number;
}

const DEFAULT_BUDGET: Budget = { chars: 9000, lines: 150 };

// Per-file overrides keyed by filename. Empty for now — every state file uses
// the generous default. Tune individual files down here as their content gets
// offloaded (e.g. workspace's PR-log → journal/entity, identity's niche
// patterns → a reference file).
const BUDGETS: Record<string, Budget> = {};

// Appended after the file content inside the wrapper tag. Used to bake
// standing instructions into a section (e.g. flags surface directive).
const SUFFIXES: Record<string, string> = {
  "flags.md": "\n\nIf the 🔴 section above has items, surface them to the user at the start of your first reply — one line each — before addressing their prompt. Flags only reach the user when said out loud.",
  "reminders.md": "\n\nThe `- [id] fired …` lines in this block are reminders that fired while no session was open. Relay them to the user at the start of your first reply with their fired-at times; once addressed, remove the line from state/reminders.md with the Edit tool.",
};

// Files that emit nothing at all when absent or empty (no wrapper tag).
const SILENT_WHEN_EMPTY = new Set(["flags.md", "reminders.md"]);
// reminders.md keeps its heading after the last entry is removed, so for it
// "empty" is "no `- ` entry line" — a heading alone would otherwise be composed
// into every session with an instruction that has nothing to act on.
const HAS_ITEMS: Record<string, (raw: string) => boolean> = {
  "reminders.md": (raw) => /^- /m.test(raw),
};

const arg = process.argv[2];
if (!arg) {
  console.error("usage: compose-state-file.ts <file.md>");
  process.exit(1);
}

// basename() guards against path traversal from a malformed arg; the filename
// is otherwise trusted (hardcoded in plugin.json).
const file = basename(arg).endsWith(".md") ? basename(arg) : `${basename(arg)}.md`;
const tag = file.replace(/\.md$/, ""); // today.md -> today
const budget = BUDGETS[file] ?? DEFAULT_BUDGET;

// Neutralize literal macrodata tag-openers so file content (e.g. docs about
// this format) can't close the wrapper early or forge a sibling block. Runs
// before head-keep so the escaped size is what the budget accounts for.
function neutralizeTags(s: string): string {
  return s.replaceAll("</macrodata", "&lt;/macrodata").replaceAll("<macrodata", "&lt;macrodata");
}

// A char-unit slice can split a surrogate pair, leaving a lone high surrogate
// that serializes to U+FFFD. Drop a trailing lone high surrogate.
function dropLoneHighSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

function readStateFile(): string {
  const path = join(getStateDir(), file);
  if (!existsSync(path)) return "_Empty_";
  try {
    return readFileSync(path, "utf8").trim() || "_Empty_";
  } catch {
    return "_unavailable_";
  }
}

interface Kept {
  out: string;
  truncated: boolean;
}

// Head-keep to the smaller of the line cap and the char cap, whichever bites
// first: drop excess lines from the tail, then char-trim the remainder (snapped
// back to a line boundary so it never cuts mid-line).
function headKeep(content: string, b: Budget): Kept {
  const totalLines = content.split("\n").length;
  if (content.length <= b.chars && totalLines <= b.lines) {
    return { out: content, truncated: false };
  }
  const marker = `\n…\n[display-truncated: ${content.length} chars / ${totalLines} lines → cap is ${b.chars} chars / ${b.lines} lines; distill toward it. Full file intact at state/${file}; shrink by distilling, linking detail out to an entity ([[wikilink]]), or moving append-only content to the journal — don't delete.]`;

  let kept = content;
  if (totalLines > b.lines) kept = kept.split("\n").slice(0, b.lines).join("\n");

  const room = Math.max(0, b.chars - marker.length);
  if (kept.length > room) {
    kept = kept.slice(0, room);
    const nl = kept.lastIndexOf("\n");
    if (nl >= room * 0.8) kept = kept.slice(0, nl);
    kept = dropLoneHighSurrogate(kept);
  }
  // Hard floor on the whole output: if a (degenerate) cap is smaller than the
  // marker itself, `room` is 0 and we'd otherwise emit the full marker and blow
  // the cap. Bound the final string so "output never exceeds the cap" holds.
  let out = kept + marker;
  if (out.length > b.chars) out = out.slice(0, b.chars);
  return { out, truncated: true };
}

const raw = readStateFile();
const empty = raw === "_Empty_" || raw === "_unavailable_" || HAS_ITEMS[file]?.(raw) === false;
if (SILENT_WHEN_EMPTY.has(file) && empty) {
  process.exit(0);
}
const suffix = SUFFIXES[file] ?? "";
const { out } = headKeep(suffix + neutralizeTags(raw), budget);
process.stdout.write(`<macrodata-${tag}>\n${out}\n</macrodata-${tag}>`);
