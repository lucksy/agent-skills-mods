---
plan: team-view
module: team-view
created: 2026-10-11
---
# Tasks: team-view

## Phase 1: Foundation

## Task 1: One actions table for the existing write commands
**Status:** todo

**Description:** `packages/core/actions.ts` gets one table. It maps each action name to an argument check and a pure edit that returns `{ file, text, reply }`. The table covers `start`, `done`, `block`, `unblock`, `tick`, `claim`, `assign`, `unassign`, `review`, `handoff` and `sign`. Each existing `/progress` verb in `hooks/register.tsx` reads its file, calls the action, writes and replies, with no change in behaviour. This task also checks Q1: can a mod start a long-running, detached process? The answer goes under Q1 in tasks/plan.md.

**Acceptance criteria:**
- [ ] Every existing write verb goes through `actions.ts`, and every existing mod test passes unchanged
- [ ] Each action refuses bad args with the same reply as today (unknown task, unknown handle, a done task put up for review)
- [ ] Q1 is answered in tasks/plan.md, with the API call that settles it

**Verification:**
- [ ] Tests pass: `claude plugin test .`
- [ ] Tests pass: `bash scripts/test.sh`

**Dependencies:** None

**Files likely touched:**
- `packages/core/actions.ts`
- `hooks/register.tsx`
- `tests/actions.test.ts`

**Estimated scope:** Medium

## Task 2: Answer questions and sign off checkpoints
**Status:** todo

**Description:** Two new format lines and their actions. `answer` writes `  → A: <text> · @me <date>` under `Q<n>` in tasks/plan.md, and replaces an earlier answer if there is one. `signoff` writes `**Signed off:** @me <date>` under the heading of the checkpoint that is due, and ticks its review box. Both come with commands, `/progress answer Q2 "…"` and `/progress signoff`. The parser exposes answers and sign-offs, and `FORMAT_RULES` describes both lines.

**Acceptance criteria:**
- [ ] Both lines round-trip and keep every other byte. Older files without them parse as before.
- [ ] `/progress answer` refuses an unknown question. `/progress signoff` refuses when no checkpoint is due.
- [ ] Answered questions drop out of "what needs you" and show as answered on the Overview's decisions

**Verification:**
- [ ] Tests pass: `claude plugin test .`
- [ ] Tests pass: `bash scripts/test.sh`

**Dependencies:** T1

**Files likely touched:**
- `packages/core/format.ts`
- `packages/core/parse.ts`
- `packages/core/actions.ts`
- `hooks/register.tsx`
- `tests/format-v2.test.ts`, `tests/mod.test.ts`

**Estimated scope:** Medium

## Checkpoint: Foundation
- [ ] All tests pass: `claude plugin test .`, `bash scripts/test.sh`, `bash statusline/test.sh`
- [ ] Every existing command replies and writes exactly as before
- [ ] Review with human before proceeding

## Phase 2: The team across branches

## Task 3: The board across branches
**Status:** done · started 2026-10-11 · done 2026-10-11

**Description:** `packages/core/branches.ts` decides which refs to read: local branches plus `refs/remotes/*` with a commit in the last 30 days, up to 25 of them, skipping refs at the current commit (Q2). It reads `tasks/todo.md` from every ref through one `git cat-file --batch` and builds one row per task. Each row has the furthest state across refs, the ref it is on, its owner, and the fetch age from `FETCH_HEAD`. Results are cached by ref SHA. The rows show through `/progress branches`, `--branches` and `branches` in `--json`.

**Acceptance criteria:**
- [x] Given a fake batch output, the rows show the furthest state and its ref, and a ref without the file is skipped
- [x] `/progress branches` and `--branches` print the board, with the fetch age, or "never fetched"
- [x] No git command touches the network. Only `for-each-ref`, `cat-file`, `rev-parse` and `log` are run.

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Tests pass: `bash scripts/test.sh` (a temporary repo with two branches)

**Dependencies:** None

**Files likely touched:**
- `packages/core/branches.ts`
- `packages/core/state.ts`
- `hooks/register.tsx`
- `scripts/agent-skills-progress.mjs`
- `tests/branches.test.ts`

**Estimated scope:** Medium

## Task 4: Collision alerts
**Status:** todo

**Description:** `packages/core/collisions.ts` finds collisions in the branch rows and the current list. A task collides when it is in progress or in review on two refs, or when it has two different owners. Done on one ref while in progress on another is not a collision. The band shows `! T4 is also in progress on feat/rate-limit by @bob (2d)` when the current task collides. The board pane marks colliding tasks, and `--json` lists `collisions`.

**Acceptance criteria:**
- [ ] Each collision rule and the done-elsewhere exception are covered by unit tests
- [ ] Starting a task that is under way on another ref shows the collision in the band in the same prompt
- [ ] `--json` has `collisions` with the task, ref, owner and age

**Verification:**
- [ ] Tests pass: `claude plugin test .`
- [ ] Tests pass: `bash scripts/test.sh`

**Dependencies:** T3

**Files likely touched:**
- `packages/core/collisions.ts`
- `packages/core/state.ts`
- `hooks/register.tsx`
- `tests/branches.test.ts`, `tests/mod.test.ts`

**Estimated scope:** Medium

## Task 5: Dashboard Board across branches
**Status:** todo

**Description:** The dashboard's Board gets a "This branch | All branches" switch, kept in the URL as `#board?branches=all`. With all branches, each card shows its furthest state and its ref. Colliding cards get a mark and the collision line, and the fetch age shows above the columns. With JS off, the page shows this branch only.

**Acceptance criteria:**
- [ ] `?branches=all` changes the columns to the furthest states, and each card names its ref
- [ ] Colliding cards are marked, and the mark has a text equivalent
- [ ] The person filter from format-v2 still works together with the branch switch

**Verification:**
- [ ] Tests pass: `claude plugin test .`
- [ ] Manual check: Chrome, light and dark, 360 px

**Dependencies:** T4

**Files likely touched:**
- `packages/core/dashboard/board.ts`
- `packages/core/dashboard/page.ts`
- `tests/dashboard.test.ts`

**Estimated scope:** Small

## Task 6: The Team tab
**Status:** todo

**Description:** A new dashboard tab, `team`, has one row per person in `team.md`, plus "unowned". Each row shows the person's current task and step, their WIP count, their reviews waiting (with ages), handoffs to them and their collisions. A "Waiting on someone" list shows open questions and unsigned approvals by person. It shows no ranking, speed or totals per person. `/progress dashboard team` opens it.

**Acceptance criteria:**
- [ ] One row per team member, plus unowned. Rows are sorted by handle, not by any figure.
- [ ] The review queue shows each PR's age, and handoffs and collisions link to their tasks
- [ ] Without `team.md`, the tab shows owners found in the task list and says how to set up the team

**Verification:**
- [ ] Tests pass: `claude plugin test .`
- [ ] Manual check: Chrome, light and dark, 360 px

**Dependencies:** T4

**Files likely touched:**
- `packages/core/dashboard/team.ts`
- `packages/core/dashboard/page.ts`
- `hooks/register.tsx`
- `tests/dashboard.test.ts`

**Estimated scope:** Medium

## Checkpoint: Branches
- [ ] All tests pass
- [ ] On this repo with two real branches, `/progress branches` shows both, and starting the same task on both shows the collision in the band
- [ ] Review with human before proceeding

## Phase 3: Merge driver

## Task 7: Task-aware merge in core
**Status:** todo

**Description:** `packages/core/merge.ts` exports `mergeTodo(base, ours, theirs)` and `mergeFrontMatter(base, ours, theirs)`, which follow the spec's merge rules. A box is ticked if either side ticked it. The Status line with the later stamp wins, and ours wins a tie (Q3). Handoff lines are combined. A task added on both sides with the same number is renumbered, and its dependencies are rewritten. A delete on one side and an edit on the other gets markers around that task. Approvals are combined by role. Anything else is line-merged by a `merge-file` function that is handed in.

**Acceptance criteria:**
- [ ] Each row of the spec's merge-rules table has a test
- [ ] A property test over generated base/ours/theirs: every task appears in the result or inside markers, and none is dropped
- [ ] The result reports `conflicts` and `renumbered`

**Verification:**
- [ ] Tests pass: `claude plugin test .`

**Dependencies:** None

**Files likely touched:**
- `packages/core/merge.ts`
- `tests/merge.test.ts`

**Estimated scope:** Medium

## Task 8: The merge driver, installed and run by git
**Status:** todo

**Description:** The CLI's `--merge %O %A %B %P` reads the three files and picks the merge by path. For a task list it calls `mergeTodo`, and for a spec or plan it calls `mergeFrontMatter` plus `git merge-file`. It writes `%A`, prints renumbers to stderr and exits 0 or 1. `/progress merge-driver install` asks first, then writes the `.gitattributes` lines and the `.git/config` entry with an absolute script path. `uninstall` removes both. `status` reports installed, missing or a broken path.

**Acceptance criteria:**
- [ ] In `scripts/test.sh`, a real `git merge` of two branches that ticked boxes and moved different tasks is clean, with no markers
- [ ] A delete on one side and an edit on the other leaves markers around that task only, and git reports the conflict
- [ ] `install` asks before it writes, writes exactly the spec's lines, and `uninstall` restores both files byte for byte

**Verification:**
- [ ] Tests pass: `claude plugin test .`
- [ ] Tests pass: `bash scripts/test.sh`

**Dependencies:** T7

**Files likely touched:**
- `scripts/agent-skills-progress.mjs`
- `hooks/register.tsx`
- `scripts/test.sh`
- `tests/mod.test.ts`

**Estimated scope:** Medium

## Checkpoint: Merge
- [ ] All tests pass
- [ ] On a scratch clone of this repo, install the driver and merge two branches that each edited `tasks/todo.md`: the result is clean
- [ ] Review with human before proceeding

## Phase 4: Since you last looked

## Task 9: Since you last looked
**Status:** todo

**Description:** `packages/core/since.ts` compares a stored snapshot with now. The snapshot holds task states and owners, spec statuses, answers and collisions. The comparison lists what changed, each item with who did it: done, assigned or handed to you, answered, spec back to draft, a new collision. The snapshot lives in `<git dir>/agent-skills/seen.json`. The plugin shows the list once per session, on the first prompt (at most 6 items, then "and N more"), and updates the snapshot. `/progress since` and `--since` show the full list.

**Acceptance criteria:**
- [ ] Each kind of change is tested. Nothing changed shows nothing. The first run, with no snapshot, shows nothing and stores one.
- [ ] The plugin shows it once per session, not on later prompts
- [ ] The plugin and the CLI read and write the same `seen.json`

**Verification:**
- [ ] Tests pass: `claude plugin test .`
- [ ] Tests pass: `bash scripts/test.sh`

**Dependencies:** T2, T4

**Files likely touched:**
- `packages/core/since.ts`
- `hooks/register.tsx`
- `scripts/agent-skills-progress.mjs`
- `tests/since.test.ts`, `tests/mod.test.ts`

**Estimated scope:** Medium

## Phase 5: Live dashboard

## Task 10: The live server
**Status:** todo

**Description:** `packages/core/serve.ts` exports `handle(request, io)`. It checks the token (header or `?token=`) and the `Origin` on writes, and serves `GET /` in live mode and `POST /action`. A write runs the action from T1 only when the file's hash equals `rev`, and returns 409 otherwise. The CLI's `--serve [--port] [--no-open]` binds 127.0.0.1, makes a random token and prints the URL. It watches `tasks/`, `SPEC*.md` and `specs/`, and sends `changed` on `GET /events`.

**Acceptance criteria:**
- [ ] Handler tests cover a missing or wrong token (401), a foreign `Origin` (403), a stale `rev` (409, nothing written), bad args (400) and each action's happy path
- [ ] `scripts/test.sh` starts `--serve` on a random port, POSTs an action, finds the file changed on disk, and sees a `changed` event
- [ ] The server listens on 127.0.0.1 only and sends no CORS headers

**Verification:**
- [ ] Tests pass: `claude plugin test .`
- [ ] Tests pass: `bash scripts/test.sh`

**Dependencies:** T2

**Files likely touched:**
- `packages/core/serve.ts`
- `scripts/agent-skills-progress.mjs`
- `tests/serve.test.ts`
- `scripts/test.sh`

**Estimated scope:** Medium

## Task 11: Write buttons on the live dashboard
**Status:** todo

**Description:** In live mode only, the page gets buttons that POST actions with the file's `rev`:
- Board cards: start, done, block, claim, review;
- criteria boxes: tick;
- Spec tab: sign;
- Overview decisions: answer;
- the checkpoint that is due: sign off.

A small script, under 4 KB, sends each action, shows the reply, reloads the page on `changed`, and shows "changed since you loaded it, reload" on a 409. The static page has no buttons and no script for them.

**Acceptance criteria:**
- [ ] The static `--dashboard` output has no live buttons or live script, and its byte size is unchanged apart from T5 and T6
- [ ] Each button sends its action with the right args and `rev`, and the page reloads within 2 s of the write
- [ ] The buttons can be reached and pressed by keyboard, and each has a label

**Verification:**
- [ ] Tests pass: `claude plugin test .`
- [ ] Manual check: Chrome, pressing Sign, Answer and Claim; a second tab to see the 409; light and dark, 360 px

**Dependencies:** T10, T5, T6

**Files likely touched:**
- `packages/core/dashboard/page.ts`
- `packages/core/dashboard/board.ts`
- `packages/core/dashboard/spec.ts`
- `packages/core/dashboard/overview.ts`
- `tests/dashboard.test.ts`

**Estimated scope:** Medium

## Task 12: /progress dashboard live
**Status:** todo

**Description:** `/progress dashboard live` gives you the live dashboard from Claude Code. If Q1 found that a mod can start a long-running process, it starts `--serve` and opens the URL. If not, it prints the exact `! node … --serve` line. Either way, it says how to stop the server.

**Acceptance criteria:**
- [ ] The command follows Q1's answer, and a mod test covers its reply
- [ ] When it starts the server, a second call reuses the running one instead of starting another

**Verification:**
- [ ] Tests pass: `claude plugin test .`
- [ ] Manual check: in a real session on this repo

**Dependencies:** T11

**Files likely touched:**
- `hooks/register.tsx`
- `tests/mod.test.ts`

**Estimated scope:** Small

## Checkpoint: Live
- [ ] All tests pass
- [ ] In Chrome, Sign, Answer and Claim change the markdown and the page reloads; a stale tab gets the 409
- [ ] Two people (two git emails) sign a spec that needs two roles, through the live dashboard (carried over from format-v2's Approvals checkpoint)
- [ ] Review with human before proceeding

## Phase 6: Close

## Task 13: Docs, rules, README, 0.39.0 and final checks
**Status:** todo

**Description:** `docs/progress-format.md` documents answers, sign-offs and the merge driver. The rules Claude is told include the answer and sign-off lines. The README documents every new command and flag. The version goes to 0.39.0 and the plugin description is updated. Run all suites and check every success criterion in the spec.

**Acceptance criteria:**
- [ ] The docs and README cover every command in the spec's Commands section
- [ ] `/progress format` writes the new rules into AGENTS.md (or CLAUDE.md), checked in a real session
- [ ] Every success criterion in SPEC-team-view.md is ticked, with how it was checked

**Verification:**
- [ ] Tests pass: `claude plugin validate . && claude plugin test . && bash scripts/test.sh && bash statusline/test.sh`

**Dependencies:** T1–T12

**Files likely touched:**
- `docs/progress-format.md`
- `packages/core/format.ts`
- `README.md`
- `.claude-plugin/plugin.json`
- `SPEC-team-view.md`

**Estimated scope:** Medium

## Checkpoint: Complete
- [ ] All tests pass
- [ ] Every success criterion in the spec is met
- [ ] Review with human before proceeding
