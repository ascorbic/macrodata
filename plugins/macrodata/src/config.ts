/**
 * Shared configuration utilities
 *
 * All paths are resolved dynamically (not cached at module load)
 * so that config changes take effect without restart.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_ROOT = join(homedir(), ".config", "macrodata");

/**
 * One directory, one spelling of it.
 *
 * The root string is an IDENTITY, not only a path: macrodata-hook.sh passes it
 * in the recall worker's argv and later decides "is that worker mine?" by
 * comparing that argv tail to its own copy of this value. Storage resolves
 * through the kernel, which folds `/a/root/` into `/a/root` and (on macOS)
 * `/tmp` into `/private/tmp`, so two spellings of one directory are one mailbox
 * and one pidfile but two identities — each session reading the other's claim as
 * a foreign root's, deleting a live pidfile, and starting a second worker on the
 * same store.
 *
 * Returns undefined for a root nothing can be managed under, so the caller falls
 * through its ladder. Mirrored by canonicalize_root() in bin/macrodata-hook.sh;
 * test/state-root-parity.test.ts holds the two together.
 */
function canonicalizeRoot(raw: string): string | undefined {
  // A control character makes the root unusable, not merely unusual: `ps`
  // renders a newline as `\012` and the hook's `read -r` splits the process
  // table on it, so the argv comparison can never match again — the worker is
  // invisible to the pass that spawned it, and a new one starts per prompt,
  // without bound.
  // eslint-disable-next-line no-control-regex -- matching them is the point
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  let p = raw;
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (!p) return undefined;
  // Only a directory resolves — a root that does not exist yet has nothing to
  // resolve and keeps its written form, and the shell's `cd -P` can no more
  // resolve a regular file than this can. Whoever creates the directory
  // canonicalizes from then on.
  try {
    if (statSync(p).isDirectory()) return realpathSync(p);
  } catch {
    // Unreadable or absent: hand back what we were given.
  }
  return p;
}

/**
 * Get the macrodata state root directory.
 * Priority: MACRODATA_ROOT env > ~/.config/macrodata/config.json > ~/.config/macrodata
 *
 * Resolved fresh each call so config changes take effect immediately.
 */
export function getStateRoot(): string {
  // Env var takes precedence (useful for testing/overrides)
  if (process.env.MACRODATA_ROOT) {
    const root = canonicalizeRoot(process.env.MACRODATA_ROOT);
    if (root) return root;
  } else {
    // Check config file in default location
    const configPath = join(DEFAULT_ROOT, "config.json");
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        // A non-string `root` falls through to the default rather than reaching
        // join(), which throws on one — and this runs inside hooks, where a throw
        // is a hard failure with no state root to log it against. Being a string
        // is not enough to be a usable path, hence the canonicalize below.
        if (typeof config.root === "string") {
          const root = canonicalizeRoot(config.root);
          if (root) return root;
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return canonicalizeRoot(DEFAULT_ROOT) ?? DEFAULT_ROOT;
}

export function getStateDir(): string {
  return join(getStateRoot(), "state");
}

export function getEntitiesDir(): string {
  return join(getStateRoot(), "entities");
}

export function getJournalDir(): string {
  return join(getStateRoot(), "journal");
}

export function getSignalsDir(): string {
  return join(getStateRoot(), "signals");
}

export function getIndexDir(): string {
  return join(getStateRoot(), ".index");
}

export function getRemindersDir(): string {
  return join(getStateRoot(), "reminders");
}
