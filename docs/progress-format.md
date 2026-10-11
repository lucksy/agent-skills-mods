# The agent-skills progress format (v1, v2, ceremonies)

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

The team-view module (0.39.0) adds answers, sign-offs and an opt-in merge driver. They stay inside v2's rules: optional lines that an older plugin ignores, with every other byte kept.

### Answers to open questions (team-view)

An answer goes on the line below its question in `tasks/plan.md`, indented two spaces:

```markdown
- Q2 (T6): Upstash Redis or self-hosted for the sliding window?
  → A: Upstash · @pm 2026-10-11
```

- An answered question no longer counts as open, so it no longer blocks its task or shows under what needs a decision.
- A new answer replaces the earlier one.
- The answer carries the name of the person who gave it and the date. The name comes from `tasks/team.md` and your git email; when the team file doesn't name you, the answer is written with the date only, and the reply says why. Nobody answers for anyone else, and an agent writes an answer only when the person gives it.
- `/progress answer Q2 "Upstash"` writes it, and so does the live dashboard's **Answer** button.

### Checkpoint sign-offs (team-view)

A checkpoint that a person has reviewed gets a line below its heading in `tasks/todo.md`, and its review box is ticked:

```markdown
## Checkpoint: Approvals
**Signed off:** @amila 2026-10-11
- [x] Review with human before proceeding
```

- `/progress signoff` signs off the checkpoint that is due, in your name with today's date. The live dashboard has a **Sign off** button for it too.
- Nobody signs off for anyone else.

### The merge driver (team-view)

Opt-in. `/progress merge-driver install` shows what it will write and asks first; `/progress merge-driver install yes` writes it. `uninstall` removes exactly these lines again, and `status` says whether it is installed and whether the script it points at still exists.

```gitattributes
# .gitattributes (committed, so everyone's git uses it)
tasks/todo.md   merge=agent-skills
tasks/plan.md   merge=agent-skills
SPEC*.md        merge=agent-skills
specs/*.md      merge=agent-skills
tasks/backlog.md merge=agent-skills
```

```ini
# .git/config (local; each clone runs install once)
[merge "agent-skills"]
    name = agent-skills task-aware merge
    driver = node /absolute/path/to/scripts/agent-skills-progress.mjs --merge %O %A %B %P
```

The `tasks/backlog.md` line came with ceremonies (0.40.0). An install from before it lacks that line: `/progress merge-driver` says so, and running `install` again adds it.

The driver path is the plugin's own script, written as an absolute path. Git runs it for those files only. It needs Node 22.6 or newer.

| Part | Rule |
|---|---|
| Task with the same id on both sides | Each box is ticked if either side ticked it. The Status line with the later stamp wins (done date, then started date). With equal stamps, ours wins. `**Handoff:**` lines are combined and sorted by date. |
| Task on one side only | Kept |
| Task added on both sides with the same number but different titles | Ours keeps the number. Theirs takes the next free number, and its `**Dependencies:**` are rewritten. The driver prints `T14 (theirs) is now T15` to stderr. |
| Task deleted on one side, edited on the other | Conflict markers around that task |
| `approvals:` in front matter | Combined by role. If both sides signed the same role, the earlier signature wins. `status: approved` is worked out again from the result. |
| `tasks/backlog.md` items (ceremonies) | Merged item by item, as tasks are. A B id added on both sides with different titles: ours keeps it, theirs takes the next free B id. A renumbered task in `tasks/todo.md` never takes a number the backlog records on a `**Was:**` line. |
| Other front-matter keys, prose, Open questions | Line-merged with `git merge-file`. If that conflicts, the usual markers appear. |

The driver exits 0 when everything merged cleanly and 1 when it left markers, so git stops for you to resolve them as usual. It never drops content. A *blocked* Status does not beat a later *in progress* one: only the stamp counts.

### "Since you last looked" (team-view)

What you last saw is kept in `<git dir>/agent-skills/seen.json` (the folder `git rev-parse --git-dir` names, usually `.git/`). It is per clone, never committed, and shared by the plugin and the CLI. It holds a small snapshot: task states and owners, spec statuses, answered questions and collisions. Nothing in it goes into the markdown.

## Ceremonies: size, a backlog and sprints

The ceremonies module (0.40.0) adds three things, all optional. A plan with no Size lines, no `tasks/backlog.md` and no `sprint:` reads, forecasts and renders exactly as before.

### Size

A task can have a size on its own line under its Status line:

```markdown
## Task 4: Rate limit per key
**Status:** in progress · @amila · started 2026-10-13
**Size:** M
```

| Size | Points |
|---|---|
| S | ½ |
| M | 1 |
| L | 2 |
| none | 1, the same as M |

- The ETA works in points once enough recorded days carry them, so a plan of large tasks done and small ones left lands sooner than its task count says. The burn-up and pace charts still count tasks.
- People set sizes, with `/progress size T4 M` (`size T4 -` clears it) or the live dashboard's Size picker. An agent keeps the line when it rewrites the section and doesn't invent one.

### The backlog

`tasks/backlog.md` holds work that isn't scheduled. Its items have the same shape as tasks, with `B` ids:

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

- `/progress backlog add "Per-tenant quotas" L` appends the next B id, and makes the file when there is none.
- `/progress pull B3` moves an item into `tasks/todo.md`, after its last task, as `**Status:** todo`. It keeps its boxes, size and notes.
- `/progress defer T9` moves a task that hasn't started into the backlog as the next B id. Its number is recorded on `**Was:**`, so it is never given to another task. The next free task number counts both `tasks/todo.md` and every `Was:`. A pulled item takes its `Was:` number back when nothing has reused it.
- Defer refuses a task that is in progress, in review or done, or that another task depends on (the reply names them). Pull refuses an item whose Dependencies name a task that isn't in `tasks/todo.md`.
- A pull or a defer writes both files. Both must still be as the command or the page read them, or neither is written.
- A task can depend on a backlog item (`**Dependencies:** B3`). It isn't ready until that item is pulled and done.

### A sprint

A running sprint is two lines in `tasks/todo.md`'s front matter, written by `/progress sprint start 2026-10-24 T4 T5 T7`:

```yaml
plan: gateway
created: 2026-10-01
sprint: 2026-10-13..2026-10-24
commit: T4, T5, T7
```

- The start is the day it was started. A sprint ends on its end date; the next `sprint start` replaces both lines. There is no `sprint end`.
- Past sprints are rebuilt from the git history of `tasks/todo.md`, so nothing is committed for them. Scope added is the tasks that appeared after the start and are not in `commit:`. Carry over is the committed tasks not done on the end date.
- Working days are Monday to Friday, with no holidays.

### What the ceremonies read

| Ceremony | Command | Reads |
|---|---|---|
| Refinement | `/progress ready` | Each task not started: acceptance and verification boxes, open questions naming it, dependencies (blocking); a size and, once the plan uses owners, an owner (recommended) |
| Sprint planning | `/progress sprint plan [days]` | Ready tasks in dependency order against the pace (points per working day over the last 10), filling the slow case, then the usual case. Writes nothing; prints the `sprint start` line |
| The sprint now | `/progress sprint` | Days left, committed against done (tasks and points), added |
| Sprint review | `/progress report sprint [day]` | Committed against done, added, carry over, and a demo checklist: the done tasks' acceptance boxes and the checkpoints signed off in the sprint |
| Retro | `/progress retro` | Tasks over twice the median days for their size, the longest blocks (from the history of `blocked` Status lines), scope added, ETA drift. About the work, never about people |
| Team standup | `/progress standup team` | Per person in `tasks/team.md`: done since the last working day on any branch the board reads, or named at the start of their commit subjects (`T4: …`); today; blocked |
| Decisions inbox | `/progress inbox [@handle\|all]` | Open questions, specs to sign for your roles, the checkpoint due, reviews requested of you, handoffs to you |

No ceremony gives a per-person figure: no velocity, points or speed for anyone.

## What a viewer can show from it

- Spec and plan approval, with dates (the run timeline's first two milestones).
- The task under way even when an earlier one is still open, and its step in the build loop.
- Days per task and a done date for each task without git history, so a forecast works on any machine.
- Blocked tasks and the question that blocks them.
- (v2) Who owns each task, what is in review and with whom, handoff notes, who has signed a spec and who it waits on, and every module of the capability map with its progress.
- (team-view) Answers to open questions and who gave them, who signed off each checkpoint, each task's furthest state across branches, tasks under way on two branches or with two owners, and what changed since you last looked.
- (ceremonies) Each task's size and the ETA in points, the backlog, the running and past sprints with what was committed, added and carried over, and what waits on each person.

## How the plugin keeps it

With the `progressFormat` option on (the default):

1. **Claude is told the rules** every session, as a system-prompt section wherever agent-skills files or skills are in use, and appended to the spec, planning, build and test skills when they load.
2. **Writes are completed.** A `Write` of `tasks/todo.md` gets front matter and a Status line per task; a spec or plan gets `status: draft` and `created`.
3. **Edits carry state.** An `Edit` that ticks a task's last box is widened to set that task `done` with today's date in the same edit, so the file on disk is the file the agent last saw.
4. **Work moves tasks.** A source edit, a test run or a commit sets the current task `in progress` at that step, and claims it for you when it has no owner and `tasks/team.md` knows you (v2); the change is written into `tasks/todo.md` at the end of the turn, or with the agent's next edit of it.
5. **Approval is recorded.** The spec pane's Approve button writes `status: approved` and the date; with `approvals:` in `tasks/team.md` it signs for your roles instead, and approves on the last signature (v2).
6. **Answers and sign-offs are written for you.** `/progress answer` and `/progress signoff`, and the live dashboard's buttons, write the lines above with your name (from `tasks/team.md` and your git email) and the date. Every write, from a command or the dashboard, goes through the same actions, and the live dashboard writes only when the file is still as the page loaded it.
7. **Moves keep ids stable.** `/progress pull`, `defer`, `size` and `sprint start` write through the same actions as the live dashboard's Pull, Defer and Size buttons, with your name and the date where the format records one.
8. **`/progress format`** applies the format to an existing project and writes the rules into `AGENTS.md` (or `CLAUDE.md`) between marker comments, so other agents and future sessions keep it without the plugin.

`scripts/agent-skills-progress.mjs --json` prints the parsed state for other tools.
