# The agent-skills progress format (v1, v2)

agent-skills hands work from skill to skill through markdown: `SPEC.md`, `tasks/plan.md` and `tasks/todo.md`. The skills record progress only as checkboxes. That is enough for the agent, but a viewer (this plugin, an editor extension, a CI job, a manager's report) has to guess the rest: whether the spec was approved, which task is under way, when each one started and finished.

This format adds that state to the same files, in plain markdown, so it survives sessions, travels with git and reads the same in every agent and editor. Every addition is optional: a file without it still parses, and the checkboxes stay the source of truth for what is done.

agent-skills-mods keeps the format today (see [How the plugin keeps it](#how-the-plugin-keeps-it)). The proposal to adopt it upstream is in [upstream/e1-issue.md](upstream/e1-issue.md).

## SPEC.md, specs/&lt;module&gt;.md, SPEC-&lt;id&gt;.md, tasks/plan.md

Front matter at the top of the file:

```markdown
---
status: draft          # draft | approved
created: 2026-09-28
approved: 2026-09-29   # only once status is approved
---
# Spec: API keys for the gateway
```

- `status` is `draft` until the person approves the document. The agent never approves it on its own.
- `created` and `approved` are calendar days, `YYYY-MM-DD`.
- Without `status`, a viewer infers approval from the next stage existing (a plan means the spec was approved), as agent-skills implies today.

## tasks/todo.md

Front matter names the plan and the day it began:

```markdown
---
plan: api-keys
created: 2026-09-29
---
# Tasks: API keys
```

Each task section keeps the planning skill's template and adds one line under its heading:

```markdown
## Task 4: Rate limit per key
**Status:** in progress · started 2026-10-09 · step test

**Acceptance criteria:**
- [x] 429 with Retry-After after 60 req/min
- [ ] Limit read from the plan, not hardcoded

**Verification:**
- [ ] Tests pass: `pnpm --filter gateway test`

**Dependencies:** T3
```

| Status | Written as |
|---|---|
| not started | `**Status:** todo` |
| under way | `**Status:** in progress · started YYYY-MM-DD · step build \| test \| commit` |
| finished | `**Status:** done · started YYYY-MM-DD · done YYYY-MM-DD` |
| needs a decision | `**Status:** blocked` (the question goes under Open questions in `tasks/plan.md`, naming the task) |

Rules:

- **Stable ids.** `## Task N:` is task `T<N>`. Numbers are never reused or renumbered; a new task takes the next free number.
- **Boxes win.** A task is done when every box in its section is ticked. A Status line that says otherwise is corrected to match.
- **Dependencies** are written `**Dependencies:** T1, T3` or `None`.
- **Open questions** in `tasks/plan.md` are numbered and name what they block: `- Q2 (T6): Upstash Redis or self-hosted for the sliding window?`.

## v2: teams (format-v2)

Every addition is optional: a v1 file reads as before. Older plugin versions read *in review* as *todo* and ignore the new tokens; the checkboxes stay the source of truth for done.

### tasks/team.md

Who works on the project, and the roles that must approve a spec:

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

- A person is known by their git email (`git config user.email`), in any case.
- Roles are free words, separated by commas. They are shown, never enforced: these are files in git, and anyone can edit them.
- Without `approvals:`, a spec needs one approval, as in v1.
- `/progress team init` drafts the file from the git authors.

### A task's Status line

Three tokens join the line, in any order. The plugin writes them back as status, owner, dates, step, PR, reviewer:

- an owner, `@handle`;
- `PR #n`, or a link to the pull request;
- `reviewer @handle`.

There is also a new state, `in review`.

```markdown
## Task 4: Rate limit per key
**Status:** in review · @amila · started 2026-10-07 · PR #42 · reviewer @bob
**Handoff:** 2026-10-09 @sara → @amila: migration done, tests left
```

| Status | Written as |
|---|---|
| owned | `**Status:** in progress · @sara · started YYYY-MM-DD · step build` |
| in review | `**Status:** in review · @sara · started YYYY-MM-DD · PR #42 · reviewer @bob` |

Rules:

- **Every token is kept** whenever a line is rewritten.
- **People set ownership.** Owner and reviewer change through `/progress assign`, `claim`, `unassign`, `review` and `handoff`. An agent that starts an unowned task claims it for whoever runs the session, if `tasks/team.md` knows them; it never replaces an owner.
- **In review** counts as under way. Work that goes on leaves it in review; ticking the last box makes it done.
- **Handoff lines** sit under the Status line, oldest first, and are never removed. The next person's agent reads them with the current task.

### A spec's approvals

When `tasks/team.md` lists `approvals:`, each signature goes into the spec's front matter:

```yaml
status: draft
created: 2026-10-01
approvals: design @sara 2026-10-09, product @pm 2026-10-10
```

- A person signs every required role they hold that nobody has signed yet.
- `status: approved`, with `approved:` dated, is written with the last required signature, so every tool that reads `status:` keeps working.
- Back to draft, or a change to an approved spec, clears every signature.
- Nobody signs for anyone else.

### A task list's module

`module: <id>` in a task list's front matter names the module of `SPEC.md`'s capability map that it builds; a comma list is allowed. Without it, a plan counts for every module id its name contains, so `core-dashboard` counts for `core` and `dashboard`. Archived plans under `tasks/archive/` count too, which is how a finished module stays visible.

## What a viewer can show from it

- Spec and plan approval, with dates (the run timeline's first two milestones).
- The task under way even when an earlier one is still open, and its step in the build loop.
- Days per task and a done date for each task without git history, so a forecast works on any machine.
- Blocked tasks and the question that blocks them.
- (v2) Who owns each task, what is in review and with whom, handoff notes, who has signed a spec and who it waits on, and every module of the capability map with its progress.

## How the plugin keeps it

With the `progressFormat` option on (the default):

1. **Claude is told the rules** every session, as a system-prompt section wherever agent-skills files or skills are in use, and appended to the spec, planning, build and test skills when they load.
2. **Writes are completed.** A `Write` of `tasks/todo.md` gets front matter and a Status line per task; a spec or plan gets `status: draft` and `created`.
3. **Edits carry state.** An `Edit` that ticks a task's last box is widened to set that task `done` with today's date in the same edit, so the file on disk is the file the agent last saw.
4. **Work moves tasks.** A source edit, a test run or a commit sets the current task `in progress` at that step, and claims it for you when it has no owner and `tasks/team.md` knows you (v2); the change is written into `tasks/todo.md` at the end of the turn, or with the agent's next edit of it.
5. **Approval is recorded.** The spec pane's Approve button writes `status: approved` and the date; with `approvals:` in `tasks/team.md` it signs for your roles instead, and approves on the last signature (v2).
6. **`/progress format`** applies the format to an existing project and writes the rules into `AGENTS.md` (or `CLAUDE.md`) between marker comments, so other agents and future sessions keep it without the plugin.

`scripts/agent-skills-progress.mjs --json` prints the parsed state for other tools.
