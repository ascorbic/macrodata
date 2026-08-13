#!/usr/bin/env bun
/**
 * Prints the resolved macrodata state root, and nothing else, for shell callers.
 *
 * Exists so recall-supervisor.sh does not have to reimplement getStateRoot()'s
 * precedence (MACRODATA_ROOT, then the root recorded in the config file, then
 * the default dir). A shell copy of that ladder passes its own tests and then
 * diverges silently the first time the real resolver grows a case.
 */

import { getStateRoot } from "../src/config.ts";

console.log(getStateRoot());
