---
plan: ceremonies
module: ceremonies
created: 2026-10-11
---
# Tasks: ceremonies

## Phase 1: Foundation

## Task 1: Task size
**Status:** done · started 2026-10-11 · done 2026-10-11

**Description:** A task can have an optional `**Size:** S|M|L` line under its Status line. `size.ts` holds the weights (S ½, M 1, L 2, none 1) and the points of a list. The parser exposes `task.size`. The `size` action writes, replaces or clears the line (`/progress size T4 M`, `size T4 -`), keeping every other byte. Size shows on the board pane, the dashboard's Board cards, `/progress task` and `size` in `--json`. `FORMAT_RULES` describes the line.

**Acceptance criteria:**
- [x] The Size line round-trips, and files without it parse exactly as before
- [x] `/progress size` refuses an unknown task or a size other than S, M, L or `-`
- [x] Size shows on the board pane, the Board cards, `/progress task` and `--json`

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Tests pass: `bash scripts/test.sh`

**Dependencies:** None

**Files likely touched:**
- `packages/core/size.ts`, `packages/core/format.ts`, `packages/core/parse.ts`
- `packages/core/actions.ts`, `hooks/register.tsx`
- `packages/core/dashboard/board.ts`, `packages/core/state.ts`
- `tests/size.test.ts`

**Estimated scope:** Medium

## Task 2: The ETA in points
**Status:** done · started 2026-10-11 · done 2026-10-11

**Description:** Snapshots gain optional `points` and `totalPoints`. `snapshotOf` records them, and the history rebuild fills them from past versions of `todo.md`. `forecast`, `throughput` and the burn-up read points when a snapshot has them and counts otherwise. Before this change, snapshot tests capture the forecast, the charts' series and `--json` for every existing fixture. Those outputs must stay byte-identical when no task has a size.

**Acceptance criteria:**
- [x] Every existing fixture's forecast, chart series and `--json` output is byte-identical before and after
- [x] A plan with L tasks done and S tasks left gets an earlier ETA than the same plan counted by tasks, in a fixture with hand-checked numbers
- [x] Old `history.json` files without points still load and forecast

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Tests pass: `bash scripts/test.sh`

**Dependencies:** T1

**Files likely touched:**
- `packages/core/forecast.ts`, `packages/core/chart.ts`, `packages/core/history.ts`
- `tests/size.test.ts`, `tests/state.test.ts`

**Estimated scope:** Medium

## Task 3: The backlog file
**Status:** done · started 2026-10-11 · done 2026-10-11

**Description:** `parseBacklog` reads `tasks/backlog.md`: `## B<n>: title` items with the same boxes, Size and dependencies as tasks, plus an optional `**Was:** T9 · deferred <date> @who` line. `/progress backlog` lists the items with their sizes. `/progress backlog add "title" [S|M|L]` appends the next B id and creates the file, with its front matter, when it doesn't exist. `backlog` joins `--json`, and `doctor` checks the file for duplicate ids.

**Acceptance criteria:**
- [x] The backlog parses, and with no file everything works as before
- [x] `backlog add` appends the next B id and keeps every other byte; it creates the file when missing
- [x] `doctor` reports duplicate B ids and duplicate `Was:` numbers

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Tests pass: `bash scripts/test.sh`

**Dependencies:** None

**Files likely touched:**
- `packages/core/backlog.ts`, `packages/core/parse.ts`, `packages/core/format.ts`
- `packages/core/actions.ts`, `hooks/register.tsx`, `packages/core/doctor.ts`
- `tests/backlog.test.ts`

**Estimated scope:** Medium

## Task 4: Pull and defer
**Status:** done · started 2026-10-11 · done 2026-10-11

**Description:** `pull B3` moves an item into `todo.md` as a task with `**Status:** todo`, at the end of the last phase. It takes its `Was:` number if it has one, or else the next free number, which counts every `Was:` id. `defer T9` moves an unstarted task to the backlog as the next B id with `**Was:** T9 · deferred <date> @me`. Both keep the task's boxes, size and notes. Both write two files, and both hashes are checked before either is written. The refusals follow the spec's Rules. The merge driver's next-free-number check also counts the `Was:` ids in the working tree's backlog. Per Q1, `/progress merge-driver install` also writes `tasks/backlog.md merge=agent-skills` into `.gitattributes`, and the driver merges the backlog item by item, renumbering a B id taken on both sides. `merge-driver` status says when an existing install lacks the backlog line, and suggests re-running `install`.

**Acceptance criteria:**
- [x] Pull and defer round-trip a task with its boxes, size and notes intact. A deferred number is never given to another task, by pull or by `/plan`'s next free number.
- [x] Defer refuses a task that is started, in review or done, or that has dependents, and names the dependents. Pull refuses unknown dependencies.
- [x] A stale hash on either file writes neither, from the command and from `POST /action`
- [x] With the driver installed, a real `git merge` of two branches that each ran `backlog add` gives a clean `backlog.md` with both items and distinct B ids

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Tests pass: `bash scripts/test.sh`

**Dependencies:** T3

**Files likely touched:**
- `packages/core/backlog.ts`, `packages/core/actions.ts`, `packages/core/mergedriver.ts`
- `hooks/register.tsx`
- `packages/core/merge.ts`
- `tests/backlog.test.ts`, `tests/actions.test.ts`, `tests/serve.test.ts`, `tests/mergedriver.test.ts`

**Estimated scope:** Medium

## Checkpoint: Foundation
- [ ] All tests pass: `claude plugin test .`, `bash scripts/test.sh`, `bash statusline/test.sh`
- [ ] With no sizes and no backlog, every output is byte-identical to 0.39.0
- [ ] Review with human before proceeding

## Phase 2: Sprints

## Task 5: Readiness and /progress ready
**Status:** done · started 2026-10-11 · done 2026-10-11

**Description:** `readiness(task, list, plan, backlog)` in `sprint.ts` returns why a task isn't ready to start. Blocking reasons are: no acceptance boxes, no verification boxes, an open question that names it, a dependency not done, and a dependency on a backlog item. Recommended reasons are no size and no owner. `/progress ready` lists every not-ready task with its reasons (`T11 no size, no verification · T12 waits on Q3`), or `✓ every task is ready`. `--ready` prints the same list.

**Acceptance criteria:**
- [x] Each reason has a fixture, and blocking reasons are told apart from recommended ones
- [x] Done tasks and tasks in progress are never listed
- [x] `/progress ready` and `--ready` print the same list

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Tests pass: `bash scripts/test.sh`

**Dependencies:** T1, T3

**Files likely touched:**
- `packages/core/sprint.ts`, `hooks/register.tsx`, `scripts/agent-skills-progress.mjs`
- `tests/sprint.test.ts`

**Estimated scope:** Small

## Task 6: Starting a sprint, and the sprint now
**Status:** done · started 2026-10-11 · done 2026-10-11

**Description:** The `sprint-start` action writes `sprint: <today>..<end>` and `commit: T4, T5, …` into `todo.md`'s front matter, replacing a previous sprint. It refuses unknown or done tasks and an end date before today. `sprintNow` works out the working days left (Mon–Fri), committed against done (as tasks and points), and the scope added: tasks not in `commit:` that first appear in `todo.md`'s history after the start. That history comes from `history.ts`'s reader, limited to commits since the start. The band and the board pane show `sprint · 4d left · 5/8 committed · +1`. `/progress sprint` and `--sprint` print the full view, and `sprint` joins `--json`. With no `sprint:`, nothing shows.

**Acceptance criteria:**
- [x] `sprint start` writes exactly the two front-matter lines and keeps every other byte; each refusal is tested
- [x] Scope added is right for a task added before the start, one added after, and one pulled after, in a fixture history
- [x] With no sprint, the band, the board pane and `--json` are unchanged; after the end date the line reads `sprint ended <date>`

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Tests pass: `bash scripts/test.sh` (a temporary repo with commits before and after a start)

**Dependencies:** T1

**Files likely touched:**
- `packages/core/sprint.ts`, `packages/core/format.ts`, `packages/core/actions.ts`
- `packages/core/view.ts`, `packages/core/state.ts`, `hooks/register.tsx`
- `tests/sprint.test.ts`

**Estimated scope:** Medium

## Task 7: Sprint planning against pace
**Status:** todo

**Description:** `sprintPlan(state, days)` works out the pace in points per working day over the last 10 working days. It gives a capacity range of the usual case and the slow case times `days`. It walks the ready tasks (T5) in dependency order, counting a dependency proposed earlier as met, and adds them until the slow case is full. Then it marks the ones that fit only in the usual case. Below the proposal it lists the not-ready tasks with their reasons, then prints the `/progress sprint start <end> T…` line. With under 3 tasks done it says so and proposes by count. It writes nothing.

**Acceptance criteria:**
- [ ] Against fixed history, the capacity range and the proposal match hand-checked numbers
- [ ] A task whose dependency is proposed earlier is proposed; one whose dependency is not ready is not
- [ ] With under 3 tasks done, it says so and still proposes; no file changes in any case

**Verification:**
- [ ] Tests pass: `claude plugin test .`
- [ ] Tests pass: `bash scripts/test.sh`

**Dependencies:** T2, T5, T6

**Files likely touched:**
- `packages/core/sprint.ts`, `hooks/register.tsx`
- `tests/sprint.test.ts`

**Estimated scope:** Small

## Task 8: Past sprints and the sprint review
**Status:** done · started 2026-10-11 · done 2026-10-11

**Description:** `pastSprints` finds every `sprint:` value in `todo.md`'s history, and in archived plans' `history.json` where it is recorded. `sprintReview(sprint)` gives committed against done, scope added, what carries over, and a demo checklist. The checklist holds the done tasks' acceptance boxes and the checkpoints signed off between the start and end dates. `/progress report sprint` prints the current or last ended sprint and copies it to the clipboard; `report sprint 2026-10-13` picks a past one. `--sprint` gains the review once the sprint has ended.

**Acceptance criteria:**
- [x] Two past sprints are rebuilt from a fixture history, with nothing new committed
- [x] Committed vs done, added and carry over match hand-checked numbers
- [x] The demo checklist lists exactly the done tasks' acceptance boxes and the checkpoints signed off in the sprint

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Tests pass: `bash scripts/test.sh`

**Dependencies:** T6

**Files likely touched:**
- `packages/core/sprint.ts`, `packages/core/history.ts`, `hooks/register.tsx`
- `scripts/agent-skills-progress.mjs`
- `tests/sprint.test.ts`

**Estimated scope:** Medium

## Task 9: The retro
**Status:** done · started 2026-10-11 · done 2026-10-11

**Description:** `retro(state, sprint)` in `retro.ts` gives:
- the slowest tasks: days in progress against the median for their size over this plan and the archived plans, listed when over 2× that median;
- the longest blocks: the days between the first and last history versions where the task was blocked;
- scope added;
- the ETA drift over the sprint, from `etaDrift`.

Rows are keyed by task, with no owner and no per-person figure. `/progress retro` prints it for the current or last sprint; with no sprint it covers the whole plan. `--retro` prints the same.

**Acceptance criteria:**
- [x] Slow vs size, block lengths and drift match a hand-checked fixture history
- [x] No output contains an owner handle or a per-person count (tested)
- [x] With no sprint and with under 3 done tasks of a size, it says what it can't compare

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Tests pass: `bash scripts/test.sh`

**Dependencies:** T2, T8

**Files likely touched:**
- `packages/core/retro.ts`, `hooks/register.tsx`, `scripts/agent-skills-progress.mjs`
- `tests/retro.test.ts`

**Estimated scope:** Small

## Checkpoint: Sprints
- [ ] All tests pass: `claude plugin test .`, `bash scripts/test.sh`, `bash statusline/test.sh`
- [ ] In a real temporary git repo with two weeks of commits, `sprint plan`, `sprint start`, `report sprint` and `retro` agree with each other
- [ ] Review with human before proceeding

## Phase 3: Team

## Task 10: The team standup
**Status:** done · started 2026-10-11 · done 2026-10-11

**Description:** `standupTeam(state, branches, commits, today)` in `standup.ts` builds one block per person in `team.md`, then one for unowned work. Each block has three parts:
- done since the last working day (Friday on a Monday) on any branch the board across branches reads;
- today: their tasks in progress or in review, with step and boxes left;
- blocked: with the reason.

Commits count when their subject starts with a plan task id followed by `:` or a space, and their author email maps to that person in `team.md`. They are read with one `git log` over the same refs, since the last working day. `/progress standup team` prints the standup and copies it. `--standup-team` prints the same. `/progress standup` is unchanged.

**Acceptance criteria:**
- [x] Monday reaches back to Friday; a task done on another branch counts; near-miss subjects (`IT4 fix`, `T44` with no T44) don't match
- [x] With no `team.md`, it groups by owner handle as written; people with nothing show `nothing under way`
- [x] `/progress standup` (just you) is byte-identical to before

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Tests pass: `bash scripts/test.sh` (two branches, two authors)

**Dependencies:** None

**Files likely touched:**
- `packages/core/standup.ts`, `packages/core/branches.ts`, `hooks/register.tsx`
- `scripts/agent-skills-progress.mjs`
- `tests/standup.test.ts`

**Estimated scope:** Medium

## Task 11: The decisions inbox
**Status:** done · started 2026-10-11 · done 2026-10-11

**Description:** `inbox(state, who)` in `inbox.ts` collects what waits on a person:
- open questions (all of them, or those that mention them);
- spec approvals for their roles, across `SPEC*.md`;
- the checkpoint that is due;
- reviews where they are the reviewer;
- handoffs to them.

`who` is a handle, `me` or `all`. With no `team.md`, `me` sees everything. The Overview's "needs you" and the Team tab's "waiting on someone" then call `inbox` instead of their own copies. `/progress inbox [@handle|all]` and `--inbox` print it, and `inbox` (for `me`) joins `--json`.

**Acceptance criteria:**
- [x] Each item kind is tested, filtered by handle, by role, for `all`, and with no `team.md`
- [x] The Overview and Team tab tests pass unchanged after they switch to `inbox`
- [x] `/progress inbox` with nothing waiting prints `✓ Nothing is waiting on you.`

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Tests pass: `bash scripts/test.sh`

**Dependencies:** None

**Files likely touched:**
- `packages/core/inbox.ts`, `packages/core/dashboard/overview.ts`, `packages/core/dashboard/team.ts`
- `packages/core/state.ts`, `hooks/register.tsx`
- `tests/inbox.test.ts`

**Estimated scope:** Medium

## Phase 4: Dashboard

## Task 12: The Sprint tab
**Status:** todo

**Description:** A Sprint tab (`#sprint`) has these parts:
- The sprint's dates and days left.
- A burn-down in points with the ideal line, drawn by the existing Nivo bundle, with its one-line summary for a page without JS.
- Committed vs done, added, and carry over.
- The demo checklist.
- Once the sprint has ended, a Retro section from T9.
- A Backlog section listing items with sizes. On the live page each item has **Pull**, each task card gets a Size picker, and not-started tasks get **Defer**.

With no sprint, the tab shows the backlog and the `sprint plan` proposal as text. The Board gains `?sprint=1` to show only committed and added tasks. `/progress dashboard sprint` opens the tab.

**Acceptance criteria:**
- [ ] The tab renders with a sprint, after one ended, and with none; with no sprint and no backlog the other tabs are byte-identical
- [ ] On the live page, Pull, Defer and Size change the markdown, and a stale page gets a 409
- [ ] Light and dark at 360 px and desktop, keyboard reachable, with no chart wider than the page

**Verification:**
- [ ] Tests pass: `claude plugin test .` (dashboard and serve tests)
- [ ] Manual check: in Chrome, static and live

**Dependencies:** T4, T8, T9

**Files likely touched:**
- `packages/core/dashboard/sprint.ts`, `packages/core/dashboard/page.ts`, `packages/core/dashboard/board.ts`
- `packages/core/dashboard/live.ts`
- `tests/dashboard.test.ts`

**Estimated scope:** Medium

## Task 13: The Inbox tab
**Status:** done · started 2026-10-11 · done 2026-10-11

**Description:** An Inbox tab (`#inbox`, `?who=all` or `?who=sara`) lists T11's items grouped by kind, each with what it blocks and its age. On the live page each item gets the button it already has elsewhere: **Answer**, **Sign**, **Sign off**, or a link to the review's PR. `/progress dashboard inbox` opens it. The static page has no buttons.

**Acceptance criteria:**
- [x] The tab renders for `me`, a named handle and `all`, and with nothing waiting
- [x] On the live page, Answer and Sign from the Inbox change the markdown; the static build has no write buttons
- [x] Light and dark at 360 px and desktop, keyboard reachable

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Manual check: in Chrome, static and live

**Dependencies:** T11

**Files likely touched:**
- `packages/core/dashboard/inbox.ts`, `packages/core/dashboard/page.ts`, `packages/core/dashboard/live.ts`
- `tests/dashboard.test.ts`

**Estimated scope:** Small

## Checkpoint: Dashboard
- [ ] All tests pass: `claude plugin test .`, `bash scripts/test.sh`, `bash statusline/test.sh`
- [ ] In Chrome, Pull, Size, Answer and Sign change the markdown and the page reloads
- [ ] Review with human before proceeding

## Phase 5: Close

## Task 14: Docs, rules, README, 0.40.0 and final checks
**Status:** todo

**Description:** `docs/progress-format.md` gets a ceremonies section covering Size, `sprint:` and `commit:`, and `backlog.md` with `Was:`. `FORMAT_RULES` and the skill rules Claude is told include them. The README documents every new command and the two tabs, and the "next modules" line moves on to team-site. The version goes to 0.40.0 in `plugin.json`. Then the final checks: a real session on this repo, and Chrome.

**Acceptance criteria:**
- [ ] The docs, rules and README cover every command and format line in the spec
- [ ] Every success criterion in SPEC-ceremonies.md is checked off with evidence
- [ ] `claude plugin validate .` passes at 0.40.0

**Verification:**
- [ ] Tests pass: `claude plugin validate . && claude plugin test . && bash scripts/test.sh && bash statusline/test.sh`
- [ ] Manual check: a real session (size, defer, pull, sprint plan and start, standup team, retro, inbox)

**Dependencies:** T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13

**Files likely touched:**
- `docs/progress-format.md`, `packages/core/format.ts`, `README.md`
- `.claude-plugin/plugin.json`

**Estimated scope:** Small

## Checkpoint: Complete
- [ ] Every success criterion in the spec is met
- [ ] Review with human before proceeding
