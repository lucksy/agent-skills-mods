---
status: approved
created: 2026-10-11
approved: 2026-10-11
---
# Implementation Plan: ceremonies

## Overview

This plan builds [SPEC-ceremonies.md](../SPEC-ceremonies.md), module `ceremonies` of the capability map in [SPEC.md](../SPEC.md). It covers:
- an optional task size, and the ETA in points;
- a backlog (`tasks/backlog.md`) with pull and defer;
- refinement (`/progress ready`);
- optional sprints: start, the sprint now, planning against pace, the sprint review and the retro;
- the team standup;
- the decisions inbox;
- two dashboard tabs, Sprint and Inbox, with live buttons.

The previous plan (team-view, 13 of 13) is archived in `tasks/archive/2026-10-11-team-view/`.

## Architecture Decisions

- **Points without a new forecast.** `size.ts` gives each task a weight: S ½, M 1, L 2, and no size 1. Snapshots gain optional `points` and `totalPoints`. The forecast reads points when a snapshot has them and counts otherwise, using the same method. With no Size lines every task weighs 1, so points equal counts and every output stays byte-identical. T2 locks that in with snapshot tests on the existing fixtures before anything else reads points.
- **The backlog is a second task list, not a second parser.** `parseBacklog` reuses the task parser with a `B` id prefix, plus the `Was:` line. `backlog.ts` holds pure moves: `(todo, backlog) → (todo, backlog)`. The next free T number is the highest of `todo.md`'s ids and every `Was:` id, plus one, so a deferred number is never reused.
- **A move writes two files.** `ActionResult.writes` already carries several files. Pull and defer write both, each behind its own hash check. If either file is stale, neither is written.
- **Sprints live in front matter; past sprints come from history.** `sprint:` and `commit:` sit in `todo.md`'s front matter. `sprint.ts` gets the versions of `todo.md` from `history.ts`'s existing `cat-file` reader. From them it works out when each task appeared, when it was done and when it was blocked, plus every past `sprint:` value. Nothing new is committed. Results are cached by commit SHA, like the history.
- **One readiness function.** `readiness(task, list, plan, backlog)` returns its reasons. `/progress ready`, `sprint plan` and the Sprint tab all call it, so they can't disagree.
- **Measure the work.** `retro.ts` and `standup.ts` group by task and size, never by person. The standup shows people only as owners of tasks, as the Team tab does. No function returns a per-person rate or count.
- **The inbox reuses what exists.** The Overview's "needs you" and the Team tab's "waiting on someone" already find open questions, approvals and due checkpoints. `inbox.ts` lifts that logic into one function, adds reviews and handoffs, and filters by handle and role. The Overview and Team tab then call it, which removes two copies.
- **New writes are actions.** `size`, `backlog-add`, `pull`, `defer` and `sprint-start` join `ACTION_NAMES`, so the live server and the commands share them, as in team-view T1.
- **State v1 grows, it doesn't change.** `task.size`, `sprint`, `backlog` and `inbox` are added within schema 1.
- **Story ids:** C1–C7, as in the spec. The spec's open questions keep the defaults the approved spec states (S ½ · M 1 · L 2; `defer` included; commit subjects only; retro as a section of the Sprint tab; Mon–Fri with no holidays).

## Dependency Graph

```
T1 Size line, size action, size on cards and --json
 ├─ T2 the ETA in points (byte-identical without sizes)
 │   └─ T7 sprint plan  ← also T5, T6
 └─ T5 readiness + /progress ready  ← also T3
T3 backlog.md: parse, /progress backlog, backlog add
 └─ T4 pull and defer (two-file writes, Was: numbers)
T6 sprint start + the sprint now (band, board pane, --sprint)
 └─ T8 past sprints from history + /progress report sprint
     └─ T9 /progress retro  ← also T2
T10 team standup                      (independent)
T11 inbox core + /progress inbox       (independent)
T12 dashboard Sprint tab + sprint filter on the Board  ← T4, T8, T9
T13 dashboard Inbox tab, live buttons  ← T11
T14 docs, rules, README, 0.40.0, final checks  ← all
```

T1, T3, T6, T10 and T11 can start in parallel. After the foundation, the sprint track (T5–T9) and the team track (T10–T11) don't touch the same files except `hooks/register.tsx` and `actions.ts`, so merge them one after the other.

## Task List

Tasks are tracked in [tasks/todo.md](todo.md).

### Phase 1: Foundation
- [x] Task 1: Task size
- [x] Task 2: The ETA in points
- [x] Task 3: The backlog file
- [x] Task 4: Pull and defer

### Checkpoint: Foundation
- [x] Tests pass; with no sizes and no backlog, every output is byte-identical to 0.39.0

### Phase 2: Sprints
- [x] Task 5: Readiness and /progress ready
- [x] Task 6: Starting a sprint, and the sprint now
- [x] Task 7: Sprint planning against pace
- [x] Task 8: Past sprints and the sprint review
- [x] Task 9: The retro

### Checkpoint: Sprints
- [x] In a real git repo with two weeks of history, plan, start, review and retro agree

### Phase 3: Team
- [x] Task 10: The team standup
- [x] Task 11: The decisions inbox

### Phase 4: Dashboard
- [x] Task 12: The Sprint tab
- [x] Task 13: The Inbox tab

### Checkpoint: Dashboard
- [x] In Chrome, Pull, Size, Answer and Sign change the markdown and the page reloads

### Phase 5: Close
- [x] Task 14: Docs, rules, README, 0.40.0 and final checks

### Checkpoint: Complete
- [x] Every success criterion in the spec is met; review with human

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Points change an existing ETA, chart or `--json` count | High | Unsized tasks weigh exactly 1. T2 adds snapshot tests of every existing fixture's output before and after, which must match byte for byte. |
| Two people defer or pull on different branches and take the same number | Medium | The merge driver already renumbers a task number taken on both sides. T4 makes its next-free-number check count the backlog's `Was:` ids too, and (Q1) the driver also merges `tasks/backlog.md` item by item. |
| Reading `todo.md` history for sprints is slow | Medium | It reuses `history.ts`'s single `cat-file --batch` and its SHA cache. Only commits since the earliest `sprint:` start are read. |
| The standup's commit matching picks up the wrong task (`T4` in "IT4 fixes") | Low | Matches only a task id at the start of the subject, followed by `:` or a space, for an id in the plan. Tested with near misses. |
| The retro or standup reads as a judgement of people | High | No per-person figures anywhere. The functions return rows keyed by task. A test asserts that no retro or standup output contains a per-person count or rate. |
| A pull or defer leaves one file written and the other not | High | Both hashes are checked before either write. The live server returns a 409 and writes neither. |
| Lifting the inbox logic changes the Overview or Team tab | Medium | T11 keeps their existing tests unchanged and green before it removes the old copies. |

## Open Questions

- Q1 (T4): Should `/progress merge-driver install` also add `tasks/backlog.md` to `.gitattributes`? Concurrent `backlog add` on two branches would then merge item by item, instead of producing conflict markers. It changes what `install` writes for people who already have the driver, so they would need to re-run it.
  → A: Yes · @lucksy 2026-10-11
