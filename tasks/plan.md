---
status: draft
created: 2026-10-10
---
# Implementation Plan: core + dashboard

## Overview

This plan builds the first two modules of the capability map in [SPEC.md](../SPEC.md):

- **`core`** ([SPEC-core.md](../SPEC-core.md)): move the library to `packages/core` and add a versioned `State` v1.
- **`dashboard`** ([SPEC-dashboard.md](../SPEC-dashboard.md)): a read-only, self-contained HTML dashboard with five views, opened by `/progress dashboard [view]` and `agent-skills-progress --dashboard [out]`.

The risky unknown goes first (Q1). After that, the dashboard is built as a thin end-to-end path first, and each view is added as its own vertical slice.

## Architecture Decisions

- **Two ways in, one state.** The plugin keeps its history in its own store, and the CLI rebuilds history from git. So core exposes:
  - a pure `toState(parts)`, which assembles State v1 from parts already loaded;
  - `buildState(io)` for the CLI, which reads the files through `io` and then calls `toState`.

  The plugin calls `toState` with what `load($)` already gives it. Both paths produce the same State, so their numbers match.
- **Views are rendered in TypeScript, and the script only enhances them.** Each `packages/core/dashboard/<view>.ts` returns an HTML string from State. `page.ts` puts them into one page with tabs. With no JS, all views show stacked in order. The inline script (under 4 KB) adds tabs, arrow keys, `#view` hash state and Board filters.
- **The page's safety rules are built into `page.ts`:**
  - A CSP meta tag (`default-src 'none'` plus inline style and script).
  - Every markdown-derived string goes through `esc()`.
  - The embedded JSON has `<` escaped as `<`.
  - Output is deterministic for a given state and `today`.
- **New numbers come from history the plugin already keeps.** `forecastHistory(snapshots)` replays `forecast()` as of each past day for the ETA drift chart. Aging WIP uses `started` dates from Status lines. Cycle time uses `daysPerTask`.
- **`/progress report` stays unchanged.** It remains the email-safe page with no JS. The dashboard is a separate file, `tasks/progress-dashboard.html`.
- **Story ids in comments:** J1–J3 for core, K1–K6 for the dashboard, as in the specs.

## Dependency Graph

```
T1 spike: import from ../packages/core
 └─ T2 move hooks/lib → packages/core (+ purity guard)
     └─ T3 State v1: toState, buildState, --json
         └─ T4 page shell + Overview figures + CLI --dashboard
             ├─ T5 /progress dashboard [view] in the plugin
             ├─ T6 Overview health + ETA drift figure (forecastHistory)
             │   └─ T10 Flow: ETA drift chart
             ├─ T7 Board
             ├─ T8 Roadmap
             ├─ T9 Flow: burn-up, flow, cycle time, aging WIP
             │   └─ T10
             └─ T11 Spec view
T12 hardening ← T7, T8, T10, T11
T13 docs + release ← T5, T12
```

T7, T8, T9 and T11 are independent once T4 lands, so they can run in parallel.

## Task List

Tasks are tracked in [tasks/todo.md](todo.md).

### Phase 1: Core
- [ ] Task 1: Spike: hooks module importing from ../packages/core
- [ ] Task 2: Move hooks/lib to packages/core with a purity guard
- [ ] Task 3: State v1: toState, buildState and --json

### Checkpoint: Core
- [ ] All tests pass and the plugin loads as before

### Phase 2: Dashboard path end to end
- [ ] Task 4: Dashboard page shell with Overview figures and the CLI --dashboard flag
- [ ] Task 5: /progress dashboard [view] in the plugin
- [ ] Task 6: Overview health and ETA drift figure

### Checkpoint: Dashboard path
- [ ] Both entry points produce a working page, checked in a browser

### Phase 3: Views
- [ ] Task 7: Board view
- [ ] Task 8: Roadmap view
- [ ] Task 9: Flow view: burn-up, flow, cycle time, aging WIP
- [ ] Task 10: Flow view: ETA drift chart
- [ ] Task 11: Spec view

### Checkpoint: Views
- [ ] All five views render from both entry points

### Phase 4: Finish
- [ ] Task 12: Empty states, accessibility and the size and speed budget
- [ ] Task 13: README, version bump and a final browser check

### Checkpoint: Complete
- [ ] Every success criterion in SPEC-core.md and SPEC-dashboard.md met

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| The mods engine won't load modules outside `hooks/` | High | T1 spike first. Fallback: keep the library in `hooks/lib` and still ship State v1. |
| The move breaks imports in a place no test covers (CLI, statusline) | Medium | T2 runs all three test suites plus `claude --plugin-dir .` |
| The plugin's numbers differ from the CLI's | Medium | One `toState`. A test feeds both paths the same parts and compares. |
| Markdown text injects script into the page | High | `esc()` everywhere, JSON `<` escaping, CSP, an explicit test with a hostile title |
| The page grows large on long plans | Low | A budget test in T12: 60 tasks and 90 days of history stay under 250 KB and 200 ms |
| The inline script can't be tested without a browser | Medium | A test checks the script parses. A manual Chrome DevTools check at each checkpoint. Views work without JS. |

## Open Questions

- Q1 (T1, T2): Does the mods engine load `../packages/core` from `hooks/register.tsx`? T1 answers this.
- Q2 (T6): Health is *on track* or *at risk* until a target date exists. Does the target date come from `ceremonies` (sprint end) or from a `format-v2` `target:` field? T6 doesn't block on this.
- Q3 (T4, T5): The output goes to `tasks/progress-dashboard.html`. Should `/progress format` also gitignore it and the report? It's not in this plan unless you say so.
- Q4 (T13): Is it right to keep `/progress report` unchanged, as the email-safe page?
