---
status: draft
created: 2026-10-10
---
# Spec: core (shared library and state contract)

Module `core` of the capability map in [SPEC.md](SPEC.md). No dependencies.

## Objective

Give every surface (the Claude Code plugin, the CLI, the dashboard and later the VS Code extension) one library and one data contract. Then a number on the dashboard always matches the pane and the CLI.

Two changes, with no change in behaviour for users:

1. **Move** `hooks/lib/*.ts` to `packages/core/` and update every import (plugin, CLI script, tests).
2. **Contract**: one function builds a versioned state object, `State` v1, which `agent-skills-progress --json` prints and the dashboard embeds.

**Who it's for:** the maintainers of the surfaces. Users see no change.

## Tech Stack

TypeScript run by the Claude Code mods engine (plugin) and by Node ≥ 22.6 type stripping (CLI). No dependencies, runtime or dev. The only test framework is `claude-code/testing`.

## Commands

```sh
claude plugin validate .        # manifest, marketplace and hooks module
claude plugin test .            # all tests (154 before this module)
bash scripts/test.sh            # agent-skills-progress under Node
bash statusline/test.sh         # status line against sample projects
claude --plugin-dir .           # run a session with the plugin loaded from this folder
node scripts/agent-skills-progress.mjs --json   # prints State v1
```

## Project Structure

```
packages/core/          → was hooks/lib: parse, format, forecast, history, logs, chart, svg,
                          pixels, report, view, timeline, graph, doctor, gate, guard, ...
packages/core/state.ts  → NEW: State v1 type and buildState(io)
hooks/register.tsx      → the mod; imports ../packages/core/*
hooks/ui/               → surface modules (unchanged)
scripts/                → CLI; imports ../packages/core/*
tests/                  → tests; import ../packages/core/*
```

`state.ts` replaces the shape built today by `gather()` + `renderJson()` in `cli.ts`. Those two become thin wrappers over `buildState` and `JSON.stringify`.

## Code Style

Follow the current library: pure functions, I/O handed in (`CliIo`, `Runner`), a header comment naming the story, short JSDoc on exports, no classes.

```ts
// The state every surface reads (J2): spec, tasks, plan, history and forecast,
// versioned so the dashboard and other tools can rely on its shape. Pure.

export type State = {
  schema: 1
  /** The day it was built, YYYY-MM-DD; injected so output is deterministic. */
  today: string
  cwd: string
  specs: { file: string; spec: Spec }[]
  /** ...existing CliState fields... */
  needsYou: string[]
}

/** Reads the project through `io`, with history from git when `io.run` is set. */
export async function buildState(io: CliIo, opts: { specFile?: string } = {}): Promise<State> {
```

## Testing Strategy

- **Regression:** every existing test passes unchanged except for import paths: `claude plugin test .`, `bash scripts/test.sh` and `bash statusline/test.sh`.
- **Contract:** a new `tests/state.test.ts` checks that `buildState` on the shared fixtures gives `schema: 1` and the documented fields, and that `--json` output parses back to the same object.
- **Purity guard:** a test reads every file in `packages/core/` and fails if one imports anything other than a sibling module or `node:` built-ins, or uses `$.` (the Claude Code API).
- **Manual:** `claude --plugin-dir .` loads the plugin, and `/progress`, `/spec-view` and `/progress report` work as before.

## Boundaries

- **Always:** keep core free of Claude Code APIs and file or network I/O (pass it in); keep `--json` backward compatible (existing fields stay, new ones are added); bump the version in `.claude-plugin/plugin.json` with the release.
- **Ask first:** any change to State v1 after it ships (that means `schema: 2`); adding any dependency; changing the CLI's flags.
- **Never:** change user-visible output of panes, commands or the CLI in this module; skip or delete tests to get green; leave a duplicate copy of the library in `hooks/lib`.

## Success Criteria

- [ ] `hooks/lib/` no longer exists; `packages/core/` holds the library; nothing imports from `hooks/lib`.
- [ ] `claude plugin validate .` passes; `claude plugin test .`, `bash scripts/test.sh` and `bash statusline/test.sh` all pass.
- [ ] The plugin loads with `claude --plugin-dir .` and from a marketplace install; `/progress` shows the same board as before on this repo.
- [ ] `buildState` returns State v1; `agent-skills-progress --json` prints it, with `schema: 1` and every field it printed before.
- [ ] The purity-guard test passes.
- [ ] The Development section of the README shows the new layout.

## Open Questions

- Q1: Does the mods engine load a hooks module that imports from outside `hooks/` (`../packages/core`)? Answer this first with a one-file spike. **If it can't**, keep the files in `hooks/lib/` as the core, add `state.ts` there, and drop the move. The contract part of this module stands either way.
