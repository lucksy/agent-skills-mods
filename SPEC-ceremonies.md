---
status: approved
created: 2026-10-11
approved: 2026-10-11
---
# Spec: ceremonies (sprints, a backlog, and the team's standup, review, retro and inbox)

Module `ceremonies` of the capability map in [SPEC.md](SPEC.md). Depends on `format-v2` (owners, in review, approvals, `tasks/team.md`) and `dashboard` (the page and its views). It reuses team-view's board across branches, its write actions and its live server, so it builds after team-view. The source is the "Agile ceremonies as commands" section of the roadmap brainstorm (https://claude.ai/artifact/CUFyfevjs8VdhZGPNW4jEt).

## Objective

A team on one plan can now see who is doing what. It still can't run its week from the plan. It can't commit to a sprint, plan against its real pace, park work for later, or hold a standup, review or retro without retyping what the files already say. This module adds those ceremonies as commands and dashboard tabs. They are built from the markdown and git history the plugin already reads. Kanban stays the default: a plan with no sprint works exactly as it does today.

1. **Size.** A task can have a size, `**Size:** S`, `M` or `L`. Sizes weight the ETA, the sprint's capacity and the retro. A task without a size counts as one task, as it does today, so a plan with no sizes gets the same forecast it gets now.
2. **A backlog.** `tasks/backlog.md` holds work that isn't scheduled yet. `/progress pull B3` moves an item into `tasks/todo.md` under the next free task number. `/progress defer T7` moves a task that hasn't started back to the backlog.
3. **Sprints, optional.** `/progress sprint start` writes `sprint:` (its dates) and `commit:` (the committed task ids) into `tasks/todo.md`'s front matter. While a sprint runs, the band, the board pane and the dashboard show days left, committed against done, and scope added since the start.
4. **Sprint planning.** `/progress sprint plan` proposes which tasks fit. It lists the ready tasks in dependency order and stops when they fill the capacity, which is the team's recent pace times the sprint's working days. It lists the not-ready tasks with the reason each one isn't ready. It writes nothing; it prints the `sprint start` line to run.
5. **Refinement.** `/progress ready` lists every task that isn't ready to start, with the reasons: no size, no owner, no acceptance or verification boxes, an open question, or a dependency on the backlog.
6. **Team standup.** `/progress standup team` gives one block per person: done since the last working day, today, and blockers. It reads Status lines across branches and the commits that name tasks. `/progress standup` (just you) stays as it is.
7. **Sprint review.** `/progress report sprint` covers committed against done, scope added, what carries over, and a demo checklist. The checklist comes from the done tasks' acceptance boxes and the checkpoints signed off during the sprint.
8. **Retro.** `/progress retro` lists the slowest tasks against their size, the scope added, the longest blocks, and how the ETA drifted over the sprint. It reports bottlenecks in the work, never people.
9. **Decisions inbox.** `/progress inbox` and a dashboard Inbox tab show everything waiting on you, filtered by your handle and roles: open questions, spec approvals for your roles, checkpoints to sign off, reviews requested of you, and handoffs to you. The live dashboard gives each item its button.

**Users and stories**

- **C1 Lead, Monday morning:** "What fits in the next two weeks?" They run `/progress sprint plan 10`. It shows `capacity ≈ 9–12 points (pace 1.1/day, slow case 0.9)` and the proposed tasks in order, each with its size and running total. Below that come the not-ready tasks with their reasons. They run the `sprint start` line it prints.
- **C2 Developer:** "T9 isn't for this sprint." They run `/progress defer T9`, and T9 moves to `tasks/backlog.md` as B4, keeping its boxes and size. Later `/progress pull B4` brings it back as the next free T number.
- **C3 Whole team, daily:** "Standup in one message." The lead runs `/progress standup team` and pastes it into Slack. `@amila: done T3 · today T4 (test, 2 boxes left) · blocked —` and one line like it per person, plus unowned work.
- **C4 Lead, before planning:** "What isn't ready?" They run `/progress ready` and get `T11 no size, no verification · T12 waits on Q3 · T14 no owner`.
- **C5 Manager, end of sprint:** "Did we deliver what we committed?" They open the dashboard's Sprint tab, or run `/progress report sprint`. It shows `7 of 9 committed done · +2 added · 2 carry over` and the demo checklist.
- **C6 Team, retro:** "Where did time go?" They run `/progress retro` and see `T6 (S) took 6d, the usual S is 1.5d · blocked 3d on Q2 · scope +2 · ETA slipped 4d`. No names are attached.
- **C7 PM or designer:** "What's waiting on me?" They open the Inbox tab on the live dashboard. It shows Q4 to answer, the ceremonies spec to sign for product, and checkpoint 2 to sign off. Each item has its button.

## The format additions

Every addition is optional and stays inside the v2 rules: an older plugin ignores these lines, and every other byte of a file is kept.

**Size**, on its own line under the Status line:

```markdown
## Task 4: Rate limit per key
**Status:** in progress · @amila · started 2026-10-13
**Size:** M
```

Weights: S = ½, M = 1, L = 2 points. A task without a size counts as 1 point, the same as M. So with no Size lines, every count, chart and forecast is unchanged.

**A sprint**, in `tasks/todo.md`'s front matter, written by `/progress sprint start`:

```yaml
plan: gateway
created: 2026-10-01
sprint: 2026-10-13..2026-10-24
commit: T4, T5, T7, T8
```

A sprint ends on its end date. There is no `sprint end` command. The next `sprint start` replaces both lines. Past sprints are rebuilt from the git history of `tasks/todo.md`, the same way `history.ts` rebuilds daily progress, so nothing new is committed for them.

**`tasks/backlog.md`**, in the same task shape as `todo.md` but with `B` ids:

```markdown
---
backlog: gateway
---
# Backlog

## B3: Per-tenant quotas
**Size:** L
- [ ] Quota per tenant in the config
- [ ] Verify: pnpm --filter gateway test

## B4: Audit log export
**Was:** T9 · deferred 2026-10-14 @amila
- [ ] CSV export of the audit log
```

`**Was:** T9` records the number a deferred task had. That number is never reused: the next free task number counts both `todo.md` and every `Was:` in the backlog, so T ids stay stable ids. A pulled item keeps its `Was:` number if it has one. Otherwise it takes the next free number.

## Rules

| Rule | Detail |
|---|---|
| Ready | Has acceptance and verification boxes. Every dependency is done, in the sprint, or earlier in the same proposal. No open question names it. It doesn't depend on a backlog item. Size and owner are *recommended*: they are listed as reasons but don't block the proposal. |
| Pace | Points done per working day (Mon–Fri) over the last 10 working days of history. The capacity range uses the forecast's usual and slow cases. With under 3 tasks done, `sprint plan` says so and proposes by count only. |
| Scope added | Tasks in the sprint that are not in `commit:`: tasks created or pulled after the start date, read from the history of `todo.md`. |
| Carry over | Tasks in `commit:` that aren't done on the end date. |
| Defer | Refused for a task that is in progress, in review or done, or that another task depends on. The refusal names the dependents. |
| Pull | Refused when an id in the item's dependencies doesn't exist in `todo.md`. |
| Standup "done" | A task done since the last working day (Friday on a Monday) on any branch the board across branches reads. Also any commit whose subject names a task id (`T4:` or `T4 `) by that person (matched by `team.md` email) on those branches. |
| Block length | Days between the first and last version of `todo.md` in history where the task was blocked, to the day. |
| Retro "slow" | A task's days in progress against the median for its size over this plan and its archived plans. Shown when it is over 2× that median. |

## Tech Stack

The same as `core` and `dashboard`. TypeScript in `packages/core` with no new dependencies. Commands live in `hooks/register.tsx`, writes go through `packages/core/actions.ts`, and charts are drawn by the existing Nivo bundle in `packages/charts`.

## Commands

```sh
# User-facing (plugin)
/progress size T4 M                    # S, M, L, or `size T4 -` to clear
/progress backlog                      # the backlog, with sizes
/progress backlog add "Per-tenant quotas" [S|M|L]
/progress pull B3                      # into todo.md as the next free task number (or its Was: number)
/progress defer T9                     # an unstarted task to the backlog, recorded as Was: T9
/progress ready                        # not-ready tasks and why
/progress sprint                       # the sprint now: days left, committed vs done, added
/progress sprint plan [days]           # proposal against pace; default 10 working days; writes nothing
/progress sprint start 2026-10-24 T4 T5 T7   # writes sprint: and commit:; start date is today
/progress standup team                 # one block per person; copied to the clipboard
/progress report sprint                # sprint review: committed vs done, added, carry over, demo checklist
/progress retro                        # slowest vs size, scope added, longest blocks, ETA drift
/progress inbox [@handle|all]          # what is waiting on you (default), on someone else, or on anyone
/progress dashboard sprint | inbox     # the dashboard on its Sprint or Inbox tab

# CLI
node scripts/agent-skills-progress.mjs --sprint | --retro | --inbox [@handle] | --standup-team
node scripts/agent-skills-progress.mjs --json   # State v1 gains task.size, sprint, backlog, inbox (still schema 1)

# Development
claude plugin validate . && claude plugin test . && bash scripts/test.sh && bash statusline/test.sh
```

## Project Structure

```
packages/core/format.ts            → Size line; sprint:/commit: front matter; backlog.md shape; FORMAT_RULES gain them
packages/core/parse.ts             → Task gains size; TaskList gains sprint; parseBacklog
packages/core/size.ts              → NEW: weights, points of a list, pace in points
packages/core/forecast.ts          → snapshots gain optional points; forecast in points (identical when no sizes)
packages/core/backlog.ts           → NEW: pull and defer (pure: text in, texts out), next free number counting Was:
packages/core/sprint.ts            → NEW: readiness, sprint plan proposal, sprint now, review, past sprints from history
packages/core/standup.ts           → NEW: the team standup from branches.ts and commit subjects
packages/core/retro.ts             → NEW: slow vs size, block lengths, scope added, ETA drift over a sprint
packages/core/inbox.ts             → NEW: decisions waiting on a person, by handle and roles, across SPEC*.md and the plan
packages/core/actions.ts           → size, pull, defer, backlog-add, sprint-start join ACTION_NAMES (so the live page gets them)
packages/core/state.ts             → State v1 gains sprint, backlog, inbox; TaskJson gains size
packages/core/dashboard/sprint.ts  → NEW: Sprint tab: burn-down in points, committed vs done, added, carry over, demo checklist, retro, backlog with Pull
packages/core/dashboard/inbox.ts   → NEW: Inbox tab, `#inbox?who=all`
packages/core/dashboard/board.ts   → size on cards; a sprint filter (`#board?sprint=1`)
packages/core/view.ts              → band and board pane: `sprint · 4d left · 5/8 committed · +1`
hooks/register.tsx                 → the commands above
scripts/agent-skills-progress.mjs  → --sprint, --retro, --inbox, --standup-team
docs/progress-format.md            → the ceremonies section
tests/size.test.ts, backlog.test.ts, sprint.test.ts, standup.test.ts, retro.test.ts, inbox.test.ts, plus cases in mod, dashboard, actions, serve tests
```

## Code Style

The same as `core`: pure functions in `packages/core` with I/O handed in, and commands as thin plugin wrappers that read, call core, write and reply. Every write is an action in `actions.ts`.

```ts
/** `/progress defer T9` (C2): the task out of todo.md and into backlog.md as the next B id, with `Was: T9`. Pure. */
export function deferTask(todo: string, backlog: string | null, id: string, by: string, today: string):
  { ok: true; todo: string; backlog: string; item: string } | { ok: false; reason: string } {
```

## Testing Strategy

- **Unit (plugin tests):**
  - the Size line round-trip, and the same forecast with and without `M` on every task;
  - backlog parsing, pull and defer keeping every other byte, `Was:` numbers never reused, and each refusal;
  - readiness reasons;
  - the sprint plan proposal against fixed history (capacity range, dependency order, stopping at capacity, fewer than 3 done);
  - sprint now, scope added and carry over from fixture versions of `todo.md`;
  - team standup from fixture branches and commit subjects, including Monday reaching back to Friday and unowned work;
  - the retro's slow-vs-size and block lengths;
  - the inbox filtered by handle, by role, for `all`, and with no `team.md`.
- **Mod tests (`tests/mod.test.ts`):** each command against the in-memory project: what it writes, what it replies, the refusals, and the sprint line in the band.
- **CLI (`scripts/test.sh`):**
  - a real temporary git repo with two weeks of commits to `todo.md` (a sprint started, tasks done, one added, one blocked), then `--sprint`, `--retro`, `--standup-team` and `--json`;
  - `--serve` with the new actions: POST `pull`, then both files on disk have changed.
- **Manual:**
  - in a real session on this repo: size a few tasks, plan and start a sprint, defer and pull, run the standup and the retro;
  - in Chrome: the Sprint and Inbox tabs, static and live (Pull, Size, Answer, Sign), in light and dark, at 360 px.

## Boundaries

- **Always:**
  - Keep every addition optional. A plan with no sizes, no sprint and no backlog reads, forecasts and renders exactly as before (checked by snapshot tests on the existing fixtures).
  - Keep T ids stable: never renumber, never reuse a deferred task's number.
  - Send every write through `actions.ts` with the person and the date. Write only when the file's hash still matches.
  - Read other branches and history only from git objects already on the machine.
  - Report bottlenecks in the work (waits, blocks, slow sizes). Show people only as owners of tasks.
- **Ask first:**
  - Changing the forecast's method beyond weighting by size.
  - Changing State v1's existing fields.
  - Adding a dependency.
  - Commits, pushes and the `gh` CLI.
  - A new committed file other than `tasks/backlog.md`.
- **Never:**
  - Rank, score or compare people: no per-person velocity, points or speed anywhere, including the standup and the retro.
  - Start a sprint, defer a task or pull an item without the user's command or button.
  - Run `git fetch` or send anything off the machine.
  - Drop a task's boxes, notes or history when it moves between `todo.md` and `backlog.md`.

## Success Criteria

- [x] `/progress size` writes and clears the Size line. With no sizes, the forecast, the charts and `--json` counts are byte-identical to 0.39.0 on every existing fixture. With sizes, the ETA uses points.
- [x] `/progress defer` and `/progress pull` move a task between `todo.md` and `backlog.md` keeping its boxes and notes. A deferred number is never given to another task. Each refusal in Rules is tested.
- [x] `/progress ready` lists every not-ready task with its reasons. `/progress sprint plan` proposes ready tasks in dependency order up to the capacity range, shows the pace it used, and writes nothing.
- [x] `/progress sprint start` writes exactly `sprint:` and `commit:`. While the sprint runs, the band, the board pane and the Sprint tab show days left, committed vs done, and added.
- [x] `/progress standup team` gives one block per person in `team.md` plus unowned work, from Status lines across branches and commit subjects, and copies it.
- [x] `/progress report sprint` and the Sprint tab show committed vs done, added, carry over, and the demo checklist. Past sprints are rebuilt from git history with nothing new committed.
- [x] `/progress retro` shows the slowest tasks against their size, the longest blocks, scope added and ETA drift, with no per-person figure.
- [x] `/progress inbox` and the Inbox tab show what waits on you by handle and role. On the live page each item's button works, and a stale page gets a 409.
- [x] `docs/progress-format.md` documents Size, sprints and the backlog. The rules Claude is told include them. The README documents the commands.
- [ ] All tests pass. Checked in a real session and in Chrome.

## Open Questions

- Q1: Are the size weights right: S = ½, M = 1, L = 2, with an unsized task counting as M? An unsized M keeps today's forecast unchanged. The alternative is 1/2/4 or 1/3/5 points, which separates sizes more but moves every existing ETA once sizes appear.
- Q2: Should `defer` be in this module? You chose the backlog with `pull`; `defer` is its reverse and what sprint planning needs. This spec includes it.
- Q3: Should the team standup read commit subjects only (`T4: …`), or also commit bodies and branch names (`feat/T4-rate-limit`)? This spec uses subjects only.
- Q4: Should the retro have its own dashboard tab? The roadmap doc lists a Retro view. This spec puts it on the Sprint tab as a section, shown once a sprint has ended, so the dashboard grows by two tabs (Sprint, Inbox) rather than three.
- Q5: Working days are Mon–Fri with no holidays. Should holidays or a team calendar be a setting now, or wait until someone needs one (as team-view did with its branch window)?
