# Changesets

This repo uses [changesets](https://github.com/changesets/changesets) for
release automation — **versioning only, no npm publish** (the plugin installs
via the Claude Code marketplace, not npm).

## Workflow

1. With a change, add a changeset: `bunx changeset` (pick a bump, write a summary).
2. Merge the PR (the changeset `.md` rides along on `main`).
3. A **"ci: release"** PR is opened automatically. Merging it:
   - runs `bun run version` → `changeset version` bumps the root `macrodata`
     package and writes the root `CHANGELOG.md`, then `scripts/version.ts` syncs
     that version into `plugin.json` + `marketplace.json`. The nested
     `@macrodata/opencode` package is changeset-ignored, and its version is
     deliberately left alone — see the note in `scripts/version.ts`;
   - runs `bunx changeset tag` → creates a `macrodata@X.Y.Z` git tag and a
     GitHub Release of the same name (no npm publish).
4. `/plugin update` + `/reload-plugins` picks up the released version.
