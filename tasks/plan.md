---
status: draft
created: 2026-10-10
---
# Implementation Plan: format-v2

## Overview

This plan builds [SPEC-format-v2.md](../SPEC-format-v2.md), module `format-v2` of the capability map in [SPEC.md](../SPEC.md). It covers:
- a team in `tasks/team.md`, with identity from the git email;
- owners, with assign, claim and auto-claim;
- *in review* with a PR and a reviewer;
- handoff notes;
- named spec approvals by role;
- a Modules view across the capability map, archived plans included.

The previous plan (core + dashboard, 14 of 14) is archived in `tasks/archive/2026-10-10-core-dashboard/`.

## Architecture Decisions

- **The Status line keeps every token it carries.** Today `statusLine()` rewrites the whole line from status, dates and step. As soon as the plugin stamps a task in progress, it would erase an owner, a PR or a reviewer. So T1 extends `TaskState` with `owner`, `reviewer` and `pr`, and makes every stamp a round trip.
- **Identity lives in one place.** `packages/core/team.ts` parses `tasks/team.md` and answers who an email is. The plugin reads `git config user.email` with `$.process.run`; the CLI reads it with Node. Nothing else knows about people.
- **Approval stays one word.** `status: approved` is still what every tool reads. The new `approvals:` front-matter line only records who signed for which role, and decides when the plugin may flip `status:`. Without an `approvals:` line in `team.md`, the spec pane's `a` does exactly what it does today.
- **Modules come from files only.** Each row is built from:
  - the capability map table in `SPEC.md`;
  - each module's `SPEC-<id>.md`;
  - the active `tasks/todo.md`;
  - `tasks/archive/*/` (`todo.md` and `history.json`).

  A plan names its module with `module:` in its front matter; a list is allowed (`module: core, dashboard`). Without it, the plan's name is matched against the module ids, so the archived `core-dashboard` counts for both.
- **Commands are thin.** Each `/progress` verb reads, calls a pure function in core, writes one file and replies, like `start`/`done`/`block` today. Every write changes only its own line and keeps every other byte.
- **State v1 grows, it doesn't change.** New fields (`owner`, `reviewer`, `pr`, `handoffs` per task; `team`, `me`, `approvals`, `modules`) are added within schema 1. No existing field changes.
- **Story ids:** F1–F7, as in the spec.

## Dependency Graph

```
T1 Status line v2 round trip (owner, in review, PR, reviewer)
 ├─ T2 team.md + who you are (/progress team, team init)
 │   ├─ T3 assign / claim / unassign, owners in the panes
 │   │   ├─ T4 auto-claim on start
 │   │   ├─ T5 /progress review + in review in the panes
 │   │   │   └─ T6 dashboard Board: owners, In review, person filter
 │   │   └─ T7 /progress handoff + handoff notes
 │   └─ T8 approvals by role in the spec pane
 │       └─ T9 approvals in the Spec tab and the CLI
 └─ T10 modules rows + /progress modules + --modules
     ├─ T11 /progress modules <id>: an archived module's timeline
     └─ T12 dashboard Modules tab
T13 format docs, rules, README, 0.38.0, final checks ← all
```

T2 and T10 can run in parallel after T1. So can T8–T9 and T3–T7, and T11–T12.

## Task List

Tasks are tracked in [tasks/todo.md](todo.md).

### Phase 1: Foundation
- [x] Task 1: Status line v2 round trip
- [x] Task 2: tasks/team.md and who you are

### Checkpoint: Foundation
- [x] Tests pass; v1 files read as before

### Phase 2: Owners and review
- [x] Task 3: Assign, claim and unassign, with owners in the panes
- [x] Task 4: Auto-claim when a task starts
- [x] Task 5: /progress review and the in-review state
- [x] Task 6: Dashboard Board: owners, In review column, person filter
- [x] Task 7: /progress handoff and handoff notes

### Checkpoint: Owners and review
- [x] A team can assign, review and hand off in a real session

### Phase 3: Approvals
- [x] Task 8: Approvals by role in the spec pane
- [ ] Task 9: Approvals in the dashboard's Spec tab and the CLI

### Checkpoint: Approvals
- [ ] A spec signed by two roles flips to approved only on the last signature

### Phase 4: Modules
- [ ] Task 10: Module rows, /progress modules and --modules
- [ ] Task 11: /progress modules <id>: an archived module's timeline
- [ ] Task 12: Dashboard Modules tab

### Checkpoint: Modules
- [ ] This repo's own modules show: core and dashboard done, format-v2 under way

### Phase 5: Finish
- [ ] Task 13: Format docs and rules, README, version 0.38.0, final checks

### Checkpoint: Complete
- [ ] Every success criterion in SPEC-format-v2.md met; released

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Stamping a Status line drops the new tokens | High | T1 first, with round-trip tests for every stamp path (start, done, block, auto-step, Write completion) |
| This session's installed plugin (0.36) rewrites this repo's `tasks/todo.md` and drops v2 tokens | Medium | Don't put v2 tokens in this repo's own task list until 0.38 is installed. Check them in fixtures and a scratch project. |
| `git config user.email` is missing, or differs per repo | Medium | Without a match you're "unknown": commands that need you say so and name the fix (an Email row in `team.md`). Auto-claim does nothing. |
| The capability map table is written freely by people | Medium | Parse the first table under a heading containing "Capability Map", by its header names. Anything else gives no rows and an explanatory message, never an error. |
| Two people sign a spec at once, in different branches | Low | `approvals:` is one line, so git shows the conflict plainly. The merge driver is `team-view`'s work. |
| Older plugin versions read *in review* as *todo* | Low | Documented in the format doc. The checkboxes stay the source of truth for done. |

## Open Questions

- Q1: Should a handoff note also be drafted from the session (files touched, open boxes), or take only the typed note? This plan takes the typed note.
- Q2: Should the Overview get a short "by person" line, or leave that to `team-view`'s Team tab? This plan leaves it out.
