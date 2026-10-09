# The agent-skills progress format (v1)

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

## What a viewer can show from it

- Spec and plan approval, with dates (the run timeline's first two milestones).
- The task under way even when an earlier one is still open, and its step in the build loop.
- Days per task and a done date for each task without git history, so a forecast works on any machine.
- Blocked tasks and the question that blocks them.

## How the plugin keeps it

With the `progressFormat` option on (the default):

1. **Claude is told the rules** every session, as a system-prompt section wherever agent-skills files or skills are in use, and appended to the spec, planning, build and test skills when they load.
2. **Writes are completed.** A `Write` of `tasks/todo.md` gets front matter and a Status line per task; a spec or plan gets `status: draft` and `created`.
3. **Edits carry state.** An `Edit` that ticks a task's last box is widened to set that task `done` with today's date in the same edit, so the file on disk is the file the agent last saw.
4. **Work moves tasks.** A source edit, a test run or a commit sets the current task `in progress` at that step; the change is written into `tasks/todo.md` at the end of the turn, or with the agent's next edit of it.
5. **Approval is recorded.** The spec pane's Approve button writes `status: approved` and the date.
6. **`/progress format`** applies the format to an existing project and writes the rules into `AGENTS.md` (or `CLAUDE.md`) between marker comments, so other agents and future sessions keep it without the plugin.

`scripts/agent-skills-progress.mjs --json` prints the parsed state for other tools.
