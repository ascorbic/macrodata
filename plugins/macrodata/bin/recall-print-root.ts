#!/usr/bin/env bun
/**
 * Prints the resolved macrodata state root, and nothing else, for shell callers.
 *
 * macrodata-hook.sh runs on every prompt, so it resolves the root in bash rather
 * than paying a `bun` start per message — a second copy of getStateRoot()'s
 * precedence (MACRODATA_ROOT, then the root recorded in the config file, then the
 * default dir). A shell copy of that ladder passes its own tests and then diverges
 * silently the first time the real resolver grows a case, so this is the oracle
 * test/state-root-parity.test.ts holds it against.
 */

import { getStateRoot } from "../src/config.ts";

console.log(getStateRoot());
