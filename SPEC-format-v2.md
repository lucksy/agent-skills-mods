---
status: approved
created: 2026-10-10
approved: 2026-10-10
---
# Spec: format-v2 (a team on one plan, and every module at a glance)

Module `format-v2` of the capability map in [SPEC.md](SPEC.md). Depends on `core` (State v1) and shows in `dashboard`.

## Objective

Make agent-skills work for a team rather than one developer, with the markdown in git staying the only source of truth. No server and no accounts.

1. **A team, set up in one file.** `tasks/team.md` lists each person's handle, role and git email. The plugin works out who you are from `git config user.email`.
2. **Who owns what.** Each task can carry an owner (`@sara`). Anyone can assign a task (`/progress assign T4 @sara`) or take one (`/progress claim T4`); roles are shown, not enforced. An agent that starts an unowned task claims it for whoever is running the session.
3. **In review.** A task can be *in review*, with its PR and reviewer: `/progress review T4 #42 @bob`.
4. **Named approvals by role.** A project can list the roles that must approve a spec (`approvals: product, design, eng` in `team.md`). The spec pane's `a` signs for your roles, with your name and the date, and the spec counts as approved once every listed role has signed. A project that lists no roles works exactly as today: one approval.
5. **Handoffs.** `/progress handoff T4 @bob "migration done, tests left"` reassigns the task and leaves a dated note under it, which the next person's agent reads.
6. **Every module at a glance.** Today only the active plan shows; an archived module disappears. A **Modules** view reads the capability map in `SPEC.md`, each `SPEC-<id>.md` and `tasks/archive/*`, and shows one row per module: its spec's approval, its plan's tasks done, and its dates. It appears as `/progress modules` and as a dashboard tab, and `/progress modules <id>` prints an archived module's run timeline.

**Users and stories**

- **F1 Lead:** "I set the team up once." They run `/progress team init`, which drafts `tasks/team.md` from the git authors; they fill in the roles.
- **F2 Manager or lead:** "I hand T4 to Sara." They run `/progress assign T4 @sara`. Sara's name then shows on the board, the timeline, the Status line and the dashboard.
- **F3 Developer:** "I take T5." They run `/progress claim T5`, or just start working on it: their agent claims it for them.
- **F4 Developer:** "T4 is up for review." They run `/progress review T4 #42 @bob`, and the task moves to *in review* with the PR and the reviewer.
- **F5 PM, designer, eng lead:** "Is the spec signed off, and by whom?" The spec pane shows `2/3 approved · waiting on @sara (design)`. Each approver presses `a`, and the last signature approves the spec.
- **F6 Developer:** "I'm handing T4 to Bob." They run `/progress handoff T4 @bob "…"`. The task changes owner and keeps a dated note.
- **F7 Manager:** "Where are we across modules?" They run `/progress modules`, or open the dashboard's Modules tab, and see `core ✓ 3/3 · dashboard ✓ 14/14 · format-v2 ● 2/9`.

## The format, v2

Every addition is optional, so a v1 file still parses. Older plugin versions read *in review* as *todo*, and they ignore the new tokens.

**`tasks/team.md`**

```markdown
---
approvals: product, design, eng
---
# Team

| Handle | Role | Email |
|---|---|---|
| @amila | lead, eng | amila@example.com |
| @sara | design | sara@example.com |
| @pm | product | pm@example.com |
```

**A task's Status line.** New tokens join the line in any order. They are an `@owner` that is not a reviewer, `PR #n` (or a PR URL), and `reviewer @x`.

```markdown
## Task 4: Rate limit per key
**Status:** in review · @amila · started 2026-10-07 · PR #42 · reviewer @bob
**Handoff:** 2026-10-09 @sara → @amila: migration done, tests left
```

**A spec's front matter** records each role's signature. `status: approved` is written once every required role has signed.

```yaml
status: draft
created: 2026-10-10
approvals: product @pm 2026-10-08, design @sara 2026-10-09
```

**A task list's front matter** names the module it builds, so the Modules view can find it, archived or not: `module: format-v2`.

## Tech Stack

The same as `core` and `dashboard`. TypeScript in `packages/core` with no new dependencies. The plugin's commands live in `hooks/register.tsx`. The dashboard's views render in TypeScript, and the Modules view needs no new charts.

## Commands

```sh
# User-facing (plugin)
/progress team                   # who is on the team, their roles, and who you are
/progress team init              # drafts tasks/team.md from the git authors (asks before overwriting)
/progress assign T4 @sara        # owner; `assign T4 me`; `unassign T4`
/progress claim T4               # = assign T4 me
/progress review T4 #42 @bob     # in review, with PR and reviewer (both optional)
/progress handoff T4 @bob "note" # new owner, dated note under the task
/progress modules [id]           # every module at a glance; with an id, that module's run timeline
/progress dashboard modules      # the dashboard on its Modules tab
/spec-view <id>, then a          # sign for your roles (or approve, without team.md)

# CLI
node scripts/agent-skills-progress.mjs --modules     # the modules table
node scripts/agent-skills-progress.mjs --json        # State v1 gains owner, reviewer, pr, approvals, team, modules

# Development
claude plugin validate . && claude plugin test . && bash scripts/test.sh && bash statusline/test.sh
```

## Project Structure

```
packages/core/team.ts            → NEW: parse tasks/team.md; who you are from a git email; roles; required approvals
packages/core/format.ts          → Status line v2 tokens (owner, in review, PR, reviewer); Handoff lines; approvals front matter; FORMAT_RULES v2
packages/core/parse.ts           → Task gains owner, reviewer, pr, handoffs; 'in review' state
packages/core/approvals.ts       → NEW: sign a spec for a person's roles; is it approved; who it waits on
packages/core/modules.ts         → NEW: capability map rows + SPEC-<id>.md + active and archived plans → module rows
packages/core/state.ts           → State v1 gains team, me, modules; JSON fields added (still schema 1)
packages/core/dashboard/board.ts → owner on cards, an In review column, a person filter (#board?owner=sara)
packages/core/dashboard/spec.ts  → approvals by role, with names and dates
packages/core/dashboard/modules.ts → NEW: the Modules tab
hooks/register.tsx               → team, assign, claim, unassign, review, handoff, modules; `a` signs by role; auto-claim on start
scripts/agent-skills-progress.mjs → --modules
docs/progress-format.md          → the v2 section
tests/team.test.ts, tests/modules.test.ts, tests/approvals.test.ts, plus cases in mod.test.ts and dashboard.test.ts
```

## Code Style

The same as `core`: pure functions in `packages/core`, I/O handed in, and commands as thin plugin wrappers that read, call core, write and reply.

```ts
/** `/progress assign T4 @sara` (F2): the owner set on the task's Status line, every other byte kept. Pure. */
export function assignTask(todo: string, id: string, owner: string | null): { text: string; changed: boolean } {
```

## Testing Strategy

- **Unit (plugin tests):**
  - the Status line v2 round-trip, and v1 lines still parsing;
  - `team.md` parsing, including bad rows, duplicate emails and no file;
  - working out who you are from an email;
  - signing a spec by role: partial, complete, a person with two roles, and no `team.md`;
  - Modules rows from a capability map with the active plan and archived ones;
  - every change to a file keeps every other byte.
- **Mod tests (`tests/mod.test.ts`):** each new command against the in-memory project: what it writes, what it replies, and refusals such as an unknown task, an unknown handle, or a done task put up for review. Also auto-claim, both when the person has a handle and when there is no `team.md`.
- **CLI (`scripts/test.sh`):** `--modules`, and the new `--json` fields.
- **Manual:**
  - in a real session on this repo: set up a team, assign, review, sign a spec by two roles;
  - in Chrome: the dashboard's Board with owners and the person filter, the Spec tab with approvals, and the Modules tab, in light and dark, at 360 px.

## Boundaries

- **Always:**
  - Keep every v2 addition optional, so v1 files read as before.
  - Keep `status:` the single word every tool reads; approvals only decide when it flips.
  - Change only the line a command is about, keeping every other byte.
  - Name the person and the date in what a command writes.
  - Keep the plugin's own `tasks/team.md` out of the user's way: draft it only when asked.
- **Ask first:**
  - Changing State v1's existing fields.
  - Writing to git: commits, branches, the `gh` CLI.
  - Reading anything beyond the repository and `git config`.
  - Adding a dependency.
- **Never:**
  - Treat a role as a security boundary. These are files in git, and anyone can edit them; roles are shown, never enforced.
  - Mark a spec approved for someone else.
  - Rank or score people. Show who owns what, never who is fastest.
  - Send anything outside the machine.

## Success Criteria

- [ ] `tasks/team.md` parses; `/progress team` shows the team and who you are; `/progress team init` drafts it from git authors and never overwrites without asking.
- [ ] `assign`, `claim`, `unassign`, `review` and `handoff` write exactly their line. Owners show on the board pane, the timeline, the band, the Board tab (with a person filter and an In review column) and in `--json`.
- [ ] Starting an unowned task in a session claims it for you when `team.md` knows you; without `team.md`, nothing changes.
- [ ] With `approvals:` set, `a` in the spec pane signs for your roles, and the spec flips to `status: approved` with the date only when every role has signed. The pane and the Spec tab show who signed and who it still waits on. Without `approvals:`, approval works exactly as before.
- [ ] `/progress modules`, `--modules` and the Modules tab show one row per module in the capability map, with spec approval, done/total and dates, including archived plans. `/progress modules <id>` prints an archived module's run timeline.
- [ ] `docs/progress-format.md` documents v2; the rules Claude is told include the new tokens; `/progress format` writes them into AGENTS.md.
- [ ] All tests pass; the README documents the commands; checked in a real session and in Chrome.

## Open Questions

- Q1: Should `/progress handoff` also draft its note from the session (files touched, open boxes), or take only the note typed? This spec takes the typed note; drafting can follow.
- Q2: Should the Overview get a short "by person" line (Sara: T4, T6 · Bob: review of T4), or leave that to `team-view`'s Team tab?
