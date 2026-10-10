---
plan: format-v2
module: format-v2
created: 2026-10-10
---
# Tasks: format-v2

## Phase 1: Foundation

## Task 1: Status line v2 round trip
**Status:** todo

**Description:** `TaskState` gains `owner`, `reviewer` and `pr`. `parseStatusLine` reads three things:
- an `@handle` that is not a reviewer, as the owner;
- `in review`;
- `PR #n` or a PR URL, and `reviewer @x`.

`statusLine()` writes them back in a fixed order: status, owner, dates, step, PR, reviewer. The parser's `Task` exposes `owner`, `reviewer` and `pr`. State JSON adds the fields per task within schema 1.

**Acceptance criteria:**
- [ ] `in review · @amila · started 2026-10-07 · PR #42 · reviewer @bob` parses and writes back the same, and v1 lines parse as before
- [ ] Every stamp path keeps the owner, PR and reviewer: `/progress start`, `done`, `block`, the plugin's own step updates, and a Write of the list
- [ ] `--json` shows `owner`, `reviewer` and `pr` per task, and every field it printed before

**Verification:**
- [ ] Tests pass: `claude plugin test .`
- [ ] Tests pass: `bash scripts/test.sh`

**Dependencies:** None

**Files likely touched:**
- `packages/core/format.ts`
- `packages/core/parse.ts`
- `packages/core/state.ts`
- `tests/parse.test.ts`, `tests/state.test.ts`

**Estimated scope:** M

## Task 2: tasks/team.md and who you are
**Status:** todo

**Description:** `packages/core/team.ts` parses `tasks/team.md`: its front matter `approvals:` and the Handle | Role | Email table. Roles are a comma list. It also answers who an email is.
- The plugin and the CLI read `git config user.email`.
- State gains `team` and `me`.
- `/progress team` lists the team, the required approvals and who you are, or how to set it up.
- `/progress team init` drafts the file from the git authors (`git log --format=%an <%ae>`), with roles left to fill in. If the file exists, it refuses unless given `force`.

**Acceptance criteria:**
- [ ] `team.md` parses, including bad rows (skipped and named), a duplicate email (the first wins, named), no table, and no file
- [ ] `/progress team` names you when your git email is in the file, and otherwise says how to add yourself
- [ ] `/progress team init` writes a draft from the git authors and never overwrites an existing file without `force`

**Verification:**
- [ ] Tests pass: `claude plugin test .` (new `tests/team.test.ts` and mod cases)
- [ ] Manual check: `claude -p --plugin-dir . "/progress team init"` in a scratch git project

**Dependencies:** T1

**Files likely touched:**
- `packages/core/team.ts`
- `packages/core/state.ts`
- `hooks/register.tsx`
- `tests/team.test.ts`, `tests/mod.test.ts`

**Estimated scope:** M

## Checkpoint: Foundation
- [ ] All tests pass: `claude plugin test .`, `bash scripts/test.sh`, `bash statusline/test.sh`
- [ ] v1 task lists and specs read exactly as before
- [ ] Review with human before proceeding

## Phase 2: Owners and review

## Task 3: Assign, claim and unassign, with owners in the panes
**Status:** todo

**Description:** These commands set or clear the owner on the task's Status line, keeping the rest of the line:
- `/progress assign T4 @sara`
- `assign T4 me`
- `claim T4`
- `unassign T4`

The owner then shows on the board pane's task rows, in the band (`▸ T4 Rate limit · @sara`), on the timeline rows, in `/progress task T4`, and in the CLI summary. An unknown handle is still written, with a note that it isn't in `team.md`.

**Acceptance criteria:**
- [ ] Each command writes exactly the Status line and replies with what changed; a task that doesn't exist, or `me` without a known identity, gets a clear refusal
- [ ] Owners show in the board pane, the band, the timeline, `/progress task` and the CLI summary
- [ ] A handle that isn't in `team.md` is written, and the reply says so

**Verification:**
- [ ] Tests pass: `claude plugin test .`
- [ ] Manual check: a real session in a scratch project, `/progress assign T2 @sara`, then `/progress`

**Dependencies:** T2

**Files likely touched:**
- `hooks/register.tsx`
- `packages/core/format.ts`
- `packages/core/view.ts`
- `packages/core/timeline.ts`
- `tests/mod.test.ts`

**Estimated scope:** M

## Task 4: Auto-claim when a task starts
**Status:** todo

**Description:** When the plugin moves an unowned task to in progress, from a source edit, a test run, a commit or `/progress start`, it adds the session person as owner, provided `team.md` knows them. Otherwise nothing changes.

**Acceptance criteria:**
- [ ] With you in `team.md`: the first step on an unowned task writes `@you`, and an owned task keeps its owner
- [ ] Without `team.md`, or with your email not in it, Status lines are written as before

**Verification:**
- [ ] Tests pass: `claude plugin test .`

**Dependencies:** T3

**Files likely touched:**
- `hooks/register.tsx`
- `tests/mod.test.ts`

**Estimated scope:** S

## Task 5: /progress review and the in-review state
**Status:** todo

**Description:** `/progress review T4 [#42 | PR URL] [@bob]` sets *in review*, with the PR and the reviewer. A done task, or a task with no boxes ticked, gets a refusal that explains why.

The panes show it:
- the board pane's state column reads `review #42 @bob`;
- the timeline's step bar has a review state;
- `/progress task` and the CLI show the PR and the reviewer.

Ticking the last box still makes the task done.

**Acceptance criteria:**
- [ ] The command writes *in review*, the PR and the reviewer, and keeps the owner and dates
- [ ] *In review* shows in the board pane, the timeline, `/progress task` and the CLI; the counts treat it as under way
- [ ] Ticking the last box of a task in review makes it done

**Verification:**
- [ ] Tests pass: `claude plugin test .`

**Dependencies:** T3

**Files likely touched:**
- `hooks/register.tsx`
- `packages/core/view.ts`
- `packages/core/timeline.ts`
- `tests/mod.test.ts`, `tests/parse.test.ts`

**Estimated scope:** M

## Task 6: Dashboard Board: owners, In review column, person filter
**Status:** todo

**Description:** The dashboard's Board shows each card's owner and, for a task in review, its PR and reviewer. It gets an *In review* column between In progress and Blocked, and a person filter (`#board?owner=sara`) next to phase and state. The person filter appears only when some task has an owner.

**Acceptance criteria:**
- [ ] Six columns when a task is in review; each card names its owner, and in review its PR and reviewer
- [ ] The person filter lists the owners, filters the cards and counts, and is kept in the hash
- [ ] Checked in Chrome: filters, light and dark, 360 px, no console messages

**Verification:**
- [ ] Tests pass: `claude plugin test .`

**Dependencies:** T5

**Files likely touched:**
- `packages/core/dashboard/board.ts`
- `packages/core/dashboard/page.ts`
- `tests/dashboard.test.ts`

**Estimated scope:** M

## Task 7: /progress handoff and handoff notes
**Status:** todo

**Description:** `/progress handoff T4 @bob "migration done, tests left"` sets the new owner and adds the line `**Handoff:** 2026-10-10 @sara → @bob: …` under the Status line; earlier notes are kept.
- The parser reads the handoff lines.
- `/progress task` and the dashboard card show the latest note.
- When the task is current, its notes join the section of the system prompt that already carries the parsed state, so the next person's agent reads them.

**Acceptance criteria:**
- [ ] The command writes the new owner and a dated note line, keeping earlier notes and every other byte
- [ ] Handoff notes show in `/progress task`, on the dashboard card, and in the agent's state section when the task is current

**Verification:**
- [ ] Tests pass: `claude plugin test .`

**Dependencies:** T3

**Files likely touched:**
- `packages/core/format.ts`
- `packages/core/parse.ts`
- `hooks/register.tsx`
- `packages/core/dashboard/board.ts`
- `tests/mod.test.ts`

**Estimated scope:** M

## Checkpoint: Owners and review
- [ ] All tests pass
- [ ] In a real session on a scratch project, with a `team.md` of three people: assign, claim, auto-claim, review, handoff
- [ ] Review with human before proceeding

## Phase 3: Approvals

## Task 8: Approvals by role in the spec pane
**Status:** todo

**Description:** `packages/core/approvals.ts` covers the signing rules:
- it reads and writes the spec's `approvals:` front matter (`role @handle date` items);
- it signs every role that the person holds and the spec still lacks;
- it says which roles are still waiting, and on whom;
- it decides when `status:` flips to `approved`, with the date.

The spec pane's `a` uses it when `team.md` has `approvals:`:
- the header shows `2/3 approved · waiting on @sara (design)`;
- `d` (back to draft) clears the signatures;
- without `approvals:`, `a` works as today.

Spec drift (an approved spec edited by the agent) also clears the signatures.

**Acceptance criteria:**
- [ ] Signing records the person's roles with their name and the date; the spec flips to approved only when the last required role signs
- [ ] The pane shows who signed and who it waits on; `d` and spec drift clear the signatures
- [ ] Without `approvals:` in `team.md`, approval behaves exactly as before

**Verification:**
- [ ] Tests pass: `claude plugin test .` (new `tests/approvals.test.ts`, mod cases)

**Dependencies:** T2

**Files likely touched:**
- `packages/core/approvals.ts`
- `packages/core/specedit.ts`
- `hooks/register.tsx`
- `tests/approvals.test.ts`, `tests/mod.test.ts`

**Estimated scope:** M

## Task 9: Approvals in the dashboard's Spec tab and the CLI
**Status:** todo

**Description:**
- The Spec tab shows each required role with its signer and date, or *waiting*, and the picker shows `2/3`.
- The CLI's spec section shows the same.
- State JSON adds each spec's approvals.

**Acceptance criteria:**
- [ ] The Spec tab and the picker show approvals by role, with names and dates
- [ ] `agent-skills-progress` shows them in its spec section, and `--json` carries them

**Verification:**
- [ ] Tests pass: `claude plugin test .`, `bash scripts/test.sh`

**Dependencies:** T8

**Files likely touched:**
- `packages/core/dashboard/spec.ts`
- `packages/core/cli.ts`
- `packages/core/state.ts`
- `tests/spec.test.ts`

**Estimated scope:** S

## Checkpoint: Approvals
- [ ] All tests pass
- [ ] In a real session, two people (two emails) sign a spec that needs two roles: it flips on the second signature
- [ ] Review with human before proceeding

## Phase 4: Modules

## Task 10: Module rows, /progress modules and --modules
**Status:** todo

**Description:** `packages/core/modules.ts` builds one row per module of the capability map, from the first table under a "Capability Map" heading in `SPEC.md`: its id, responsibility and dependencies. Each row then gets:
- **spec:** its `SPEC-<id>.md` status and approval date;
- **plan:** the active plan or archived plans whose `module:` names it, or whose plan name contains the id; their done/total, started and finished dates;
- **state:** not started, speccing, planned, building or done.

`/progress modules` replies with a table, and `agent-skills-progress --modules` prints it. State gains `modules`.

**Acceptance criteria:**
- [ ] On this repo: core ✓ and dashboard ✓ (both from the archived core-dashboard plan, 14/14), format-v2 building, the others not started
- [ ] A missing or free-form capability map gives an explanatory message, never an error
- [ ] `--modules` and `--json` show the rows

**Verification:**
- [ ] Tests pass: `claude plugin test .` (new `tests/modules.test.ts`), `bash scripts/test.sh`
- [ ] Manual check: `/progress modules` on this repo

**Dependencies:** T1

**Files likely touched:**
- `packages/core/modules.ts`
- `packages/core/state.ts`
- `hooks/register.tsx`
- `scripts/agent-skills-progress.mjs`
- `tests/modules.test.ts`

**Estimated scope:** M

## Task 11: /progress modules <id>: an archived module's timeline
**Status:** todo

**Description:** `/progress modules dashboard` prints that module's run timeline, the same rows as `/progress timeline`. It reads them from its plan: the active plan, or the archived `todo.md` with that archive's `history.json` for dates. `--modules <id>` does the same in the CLI.

**Acceptance criteria:**
- [ ] On this repo, `/progress modules dashboard` prints the archived plan's timeline with its done dates
- [ ] An unknown id lists the modules; a module with no plan says so

**Verification:**
- [ ] Tests pass: `claude plugin test .`, `bash scripts/test.sh`

**Dependencies:** T10

**Files likely touched:**
- `packages/core/modules.ts`
- `hooks/register.tsx`
- `scripts/agent-skills-progress.mjs`
- `tests/modules.test.ts`

**Estimated scope:** S

## Task 12: Dashboard Modules tab
**Status:** todo

**Description:** A Modules tab appears when a capability map exists. Each module is a row showing:
- its state glyph, id and responsibility;
- what it depends on;
- its spec's approval;
- a progress bar (done/total) and its dates.

The active module's row links to the Overview. `/progress dashboard modules` opens on it.

**Acceptance criteria:**
- [ ] The tab shows a row per module, with glyphs and words; it is absent when there is no capability map
- [ ] Checked in Chrome on this repo: light and dark, 360 px, no console messages

**Verification:**
- [ ] Tests pass: `claude plugin test .`

**Dependencies:** T10

**Files likely touched:**
- `packages/core/dashboard/modules.ts`
- `packages/core/dashboard/page.ts`
- `tests/modules.test.ts`

**Estimated scope:** S

## Checkpoint: Modules
- [ ] All tests pass
- [ ] This repo's modules show: core and dashboard done, format-v2 building
- [ ] Review with human before proceeding

## Phase 5: Finish

## Task 13: Format docs and rules, README, version 0.38.0, final checks
**Status:** todo

**Description:**
- `docs/progress-format.md` gains a v2 section.
- `FORMAT_RULES`, which Claude is told every session, includes owners, *in review*, handoffs and approvals.
- `/progress format` writes those rules into AGENTS.md.
- The README documents the commands.
- The version is 0.38.0.
- Final checks run in a real session and in Chrome, and the release follows the same steps as 0.37.0.

**Acceptance criteria:**
- [ ] The format doc and the rules cover v2; `/progress format` writes them into AGENTS.md
- [ ] The README documents team, assign, claim, review, handoff and modules, and the version is 0.38.0
- [ ] Every success criterion in SPEC-format-v2.md is checked

**Verification:**
- [ ] Tests pass: `claude plugin test .`, `bash scripts/test.sh`, `bash statusline/test.sh`
- [ ] Build succeeds: `claude plugin validate .`
- [ ] Manual check: a real session in a scratch team project; the dashboard in Chrome

**Dependencies:** T4, T6, T7, T9, T11, T12

**Files likely touched:**
- `docs/progress-format.md`
- `packages/core/format.ts`
- `README.md`
- `.claude-plugin/plugin.json`
- `SPEC-format-v2.md`

**Estimated scope:** M

## Checkpoint: Complete
- [ ] All tests pass and `claude plugin validate .` is clean
- [ ] Every success criterion in SPEC-format-v2.md is met
- [ ] Review with human before release
