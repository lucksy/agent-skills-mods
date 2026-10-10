# agent-skills-mods

A Claude Code plugin that makes the [agent-skills](https://github.com/addyosmani/agent-skills) workflow readable inside Claude Code. You see `SPEC.md`, `tasks/plan.md` and `tasks/todo.md` as panes, a band above the prompt and the footer, so you don't have to open them in an editor.

It runs next to agent-skills and changes nothing in it. The skills still write plain markdown, and this plugin reads it. For people outside the terminal, `/progress dashboard` writes the same project as one page: Overview, Board, Roadmap, Flow charts and Spec.

```
╭ Plan ─────────────────────────────────────────────╮
│ 1/4 done ███████░░░░░░░░░░░░░░░░░░░░░             │
│ ETA 23 Oct (fast 19 Oct, slow 28 Oct)             │
│   · from 4 tasks in 11 days · +2 added            │
│                                                   │
│ Phase 1: Foundation                               │
│   ✓ T1 Monorepo scaffold · 3/3                    │
│   ● T2 Prisma schema for keys · 1/3               │
│   ○ Checkpoint: After Tasks 1-2                   │
│ Phase 2: Core                                     │
│   · T3 Issue and revoke keys · waits on T2        │
│   ○ T4 Rate limit per key                         │
│                                                   │
│ ✓ done ● next ○ to do · waits on a dependency     │
│ ♦ needs you                                       │
╰───────────────────────────────────────────────────╯
● T2 Prisma schema for keys · 2 criteria left · 1/4 done · checkpoint after this task
› _
macbook@amila:aihqlk [Opus 5.5] · ✓spec ✓plan ●build 1/4 ○review ○ship · T2 Prisma schema for keys
▸▸ auto mode on (shift+tab to cycle) · build T2                          focus · build
```

## Install

At a Claude Code terminal prompt:

```
/plugin marketplace add lucksy/agent-skills-mods
/plugin install agent-skills-mods@agent-skills-mods
/reload-plugins
```

Or from a shell: `claude plugin marketplace add lucksy/agent-skills-mods && claude plugin install agent-skills-mods@agent-skills-mods`. This needs Claude Code with mods (function hooks), and was built and tested on 2.1.295.

## What you get

| | What it does | Where it shows |
|---|---|---|
| **Spec pane** | `SPEC.md` with *awaiting approval* (amber) or *approved* and its date on the right, then the six core areas numbered (`✓ 1 Objective`), each with a summary on the right: `4 success criteria`, `4 runnable`, `vitest · 80%`, or for a weak one its short reason in amber (`no example`, `nothing runnable`, `1 vague criterion`); `missing` and `empty` show the same way. Boundaries follow as three framed columns (Always green, Ask first amber, Never red), then open questions, then the keys: `↵ open section` (shows a present area's full text as Markdown) · `a approve` (writes `status: approved` and the date into front matter; `d back to draft` undoes it) · `e edit in $EDITOR` (a windowed `$VISUAL`/`$EDITOR`, else the default app). Module specs (`SPEC-<id>.md`, or `specs/<module>.md` from a capability map) get a picker on top. | Opens when the agent writes a spec, or with `/spec-view [id]` |
| **Plan pane** | One pane with three tabs, `[ Timeline ] [ Charts ] [ Tasks ]`, switched with ←/→ or a click, with `r report · c copy digest` beside them. **Tasks:** `tasks · Phase 1 of 3` with `3/9 · 44%` on the right, then phases with each task's state in a right-hand column (`✓`, `now`, `2/5`, `waits T3`, `blocked`, `after T4`), the current task's row shaded with its boxes under it (`✓ ApiKey model · ☐ revoked → 401 · ☐ tests`), why a blocked task is blocked, `◆ Checkpoint 1` rows, and phases not under way folded to one line (`Phase 3 · console 0/2`). **Timeline:** the run timeline described below. **Charts:** the burn-up and flow charts side by side when the pane is wide, each with a legend of coloured swatches (`⠒⠒ done 4  ⠒⠒ scope 9  forecast ≈ 23 Oct (19–28 Oct)`, `█ done 4  █ in progress 1  █ blocked 1  █ to do 3`), then a bar per phase (`Phase 1 · keys ████████░░ 3/4`, filling in as the tab opens) and the pace (`Tasks done per day ▁▃▁▅ · 4 in 12 days · 0.36/day`). | `/progress` (Tasks), `/progress timeline`, `/progress charts` |
| **Ticking from the board** | Click a task on the Tasks tab to open it (▾) and see all its boxes; click a box to tick or untick it in `tasks/todo.md`. The Status line, toasts and notifications follow as for the agent's own edits. Click the task again to close it. | Tasks tab |
| **Run timeline** | A header (`api-keys  9 tasks · 3 phases · spec ✓ approved`, `11d in · about 9 days to go → checkpoint 3 ≈ 23 Oct (slow case 28 Oct)`, `Commits: 7, tests 24 passing · last /review 2d ago`), the spec and plan milestones with their dates, then each phase as a tree (`├─ └─ │`) with a three-step `▬▬▬` build · test · commit bar per task (green done, amber running, red slow), `done 30 Sep`, `testing · 1d`, `after T4 ▫▫▫ starts ≈10 Oct`, `♦ needs you: Q2, ...`, checkpoints with what they ask, and `/review → /ship` at the end. | Timeline tab |
| **Dependency graph** | A fourth tab, `[ Graph ]`: the tasks as a tree from the ones that wait on nothing (`✓ T1 …`, `├─▶ ◐ T2 …`), a task with two parents drawn once and pointed to from the other, loops listed, and the critical path (`T2 → T3 → T4`), the longest chain of unfinished tasks. | Graph tab, `/progress graph` |
| **Headline figures** | The Charts tab opens with four figures (DONE `3 of 4`, FORECAST `≈ 23 Oct` with its range, SCOPE CHANGE `+2 tasks`, NEEDS A DECISION with the first item), a now-bar of tasks by state, and below the charts a bar per task of the days it took, the current one with its days so far. | Charts tab |
| **ETA as a range** | A median date with optimistic and slow cases, plus where it comes from ("from 4 tasks in 11 days") and how much scope was added. It shows no date until 3 tasks have been finished in the history. | Board pane |
| **History for a project already under way** | The first time the plugin sees a plan, it rebuilds past daily progress so the charts and ETA work on day one. Sources, best first: what the plugin saw itself; the commits of `tasks/todo.md` (back to where the current plan began); Claude Code's session logs, which hold every edit the agent made to the list, committed or not; and commit messages that name a task (`T3`, `Task 3`), which date tasks between the others. The git sources are read automatically. The session logs are read only if you say yes: when git leaves too little history, the band above the prompt asks once (on first sight of the plan, or at the next session's start if the logs had nothing yet). A toast and the board say where the history comes from. | Board pane, under the ETA; `/progress history` |
| **Charts** | A burn-up (scope and done per day, plus a dotted forecast line to the median ETA) drawn in braille dots, and a flow chart (tasks done, in progress, blocked and to do, per day) drawn in half-blocks. Each chart fits the pane's width, is redrawn when the pane is resized, and sweeps in from the left when `/progress charts` opens it. Under each chart, a line gives the latest numbers and names each color, so the colors never carry the meaning on their own. Charts need two days of history. On kitty and Ghostty (outside tmux) the terminal charts are real pictures instead: anti-aliased lines, a soft fill under done, the forecast as a shaded cone with a dashed line to the median date, and stacked colour bands for the flow, painted by the plugin into a PNG of a few KB with the axis labels and legends kept as text beside it. The `chartStyle` option picks `auto` (the default), `pixels` or `cells`. On desktop, VS Code and mobile the same charts are interactive SVG: hover a day for its numbers; the forecast shows as a band from fast to slow. | `/progress charts` |
| **Digest** | Four lines for Slack, copied to the clipboard: progress and the current task, the ETA, this week's sparkline with tasks done and added, and what needs a decision (checkpoints reached, open questions, a spec waiting for approval). | `/progress digest` |
| `/progress standup` | Done since the last working day, today's task with its step and boxes left, what is blocked and why, what needs a decision, and progress with the ETA. Copied to the clipboard. |
| **Dashboard** | One page in five tabs, for managers, leads, designers and anyone without Claude Code. **Overview:** health (on track, or at risk with each reason), the four headline figures with how far the ETA moved this week, tasks by state, what needs you, and the task under way. **Board:** to do, waiting, in progress, blocked and done, a card per task (its open boxes, days running, what it waits on or the question blocking it), checkpoints after their task, filters for phase and state and lanes by phase. **Roadmap:** the run timeline, the dependency tree and the critical path. **Flow:** burn-up with the forecast cone, cumulative flow, cycle time, aging work in progress and ETA drift, drawn by [Nivo](https://nivo.rocks) with tooltips in words. **Spec:** every spec file with its approval, six areas, boundaries, open questions and success criteria. Tabs and filters live in the address (`#board?state=blocked`), so a view can be linked to. It is one file that makes no outside requests (a Content-Security-Policy forbids them); without JavaScript every view still shows, stacked, and each chart its one-line summary. Light and dark; works on a phone. | `/progress dashboard [view]` writes `tasks/progress-dashboard.html` and opens it |
| **A team** | `tasks/team.md` lists each person's handle, role and git email; the plugin knows you by `git config user.email`. Roles are shown, never enforced. `/progress team init` drafts the file from the git authors, and `/progress team` shows who is on it, what a spec needs and who you are. | `/progress team [init]` |
| **Owners** | Anyone can assign a task (`/progress assign T4 @sara`, `claim T4`, `unassign T4`), and work you start on an unowned task claims it for you. The owner shows on the band, the board, the timeline, `/progress task`, the dashboard (with a person filter) and the CLI. | Status line: `in progress · @sara · …` |
| **In review** | `/progress review T4 #42 @bob` puts a task in review with its PR and reviewer: an In review column on the dashboard's Board, `review #42 @bob` on the board pane, and the timeline. Ticking its last box still makes it done. | Status line: `in review · @sara · PR #42 · reviewer @bob` |
| **Handoffs** | `/progress handoff T4 @bob "migration done, tests left"` gives the task to Bob and leaves a dated note under it. The note shows in `/progress task` and on the dashboard card, and the next person's agent reads it with the current task. | `**Handoff:** 2026-10-10 @sara → @bob: …` |
| **Approvals by role** | With `approvals: product, design, eng` in `tasks/team.md`, the spec pane's `a` signs for your roles, with your name and the date, and the spec counts as approved only on the last signature. The pane and the dashboard's Spec tab show `2/3 approved · waiting on @sara (design)`. | Spec front matter: `approvals: design @sara 2026-10-09, …` |
| **Modules** | Every module of `SPEC.md`'s capability map at a glance: its spec, its plans (archived ones included, so a finished module stays visible), progress and dates. `/progress modules <id>` prints one module's run timeline, from its archive if it is done. | `/progress modules [id]`, the dashboard's Modules tab |
| **HTML report** | One self-contained page for people without Claude Code: done, ETA, pace and added scope as headline figures, a bar of tasks by state, both charts, days per task, and what needs a decision. No scripts and no external requests, so it opens offline and can be attached to an email. Light and dark. | `/progress report` writes `tasks/progress-report.html` and opens it in your default browser |
| **Toasts** | When an agent edit finishes a task: `✓ T3 done Issue and revoke keys · Next: T4 Rate limit per key`. When that task is the last before a checkpoint, the toast names the checkpoint's own items instead: `♦ Checkpoint reached: After Tasks 1-2 · All tests pass · Review with human`. At most one per edit, none for unticking. | Over the transcript, after the edit |
| **Answers about progress** | The parsed state (counts, current task and its open criteria, blocked tasks with their dependency chain, open questions, spec gaps, ETA) is the last section of the system prompt, after the cache boundary, so "what's left?" or "why is T3 blocked?" gets a short answer that cites task IDs and the source file instead of a guess, laid out as cards in a text block: a header naming its source (`Checkpoint 1 · 1 task left    from tasks/todo.md`), the task with its glyph and open boxes, a blocked task's dependency chain (`T6 ← T5 ← T4`) and the open question, then one sentence on what you can do. A prompt that names a task (`T3`, `task 3`) or asks about progress opens the board with that task highlighted. Projects without these files add nothing. | The model's answers, and the board |
| **Current task band** | `▸ T4 Rate limit per key   3 criteria · 2 verifications   checkpoint after this task`: open acceptance criteria and verifications counted apart. While the agent works the ▸ turns (◐ ◓ ◑ ◒). Hidden when there is no plan or every task is done. | Above the prompt |
| **Band alerts** | Under the current task, an amber line each when the task has run over twice the usual days per task (`! T4 has run 8d, over twice the usual 3d a task`) or scope has grown more than 20% since the plan began (`! scope grew from 9 to 12 tasks (+33%) since 29 Sep`). | Above the prompt |
| **Status entry** | `spec ✓ approved · plan ████░░░░░ 4/9` | Status area |
| **Stage in the footer** | When an agent-skills skill loads, its stage (spec, plan, build, test, review, ship) and the current task are added to the hint line (`· build T2`) and to the mode labels. Claude Code's own text stays. | Hint line and mode labels |
| **Spinner in plan terms** | Off by default. Turned on with the `planSpinner` option, the spinner's random word becomes the task and step: `Working on T4` until the agent takes a step, then `Building T4` for source edits, `Testing T4` for a test command, `Committing T4` for `git commit`. | The spinner, while a turn runs |
| **Plan guard** | Puts the planning skill's rule *"Never overwrite an incomplete plan"* into practice. A `Write` to `tasks/plan.md` or `tasks/todo.md` is refused when it would drop or rename a task that isn't finished. Edits that tick boxes, add tasks or reword around the open ones still go through. | On every `Write` |
| **Spec gate** | Off by default. Turned on with the `specGate` option, an edit to a source file while the spec still awaits approval raises one toast a turn (`♦ Spec gate · src/keys.ts changed while SPEC.md awaits approval`) and tells the model to pause and ask for approval. Specs, plans, docs and Markdown files don't count. It warns and never blocks. | Toast, and a note to the model after the edit |
| **Checkpoint gate** | Off by default. With `checkpointGate` on, an edit to a source file while a reached checkpoint still has open review items raises one toast a turn (`♦ Checkpoint gate · src/keys.ts changed before "After Tasks 1-2" was reviewed`) and tells the agent to stop, run the checks and ask you to review. Never blocks. | Toast, and a note to the model after the edit |
| **Spec drift** | When the agent changes an approved spec, it goes back to `status: draft` in the same edit, keeping its last approval date. A toast says so (`○ SPEC.md changed after approval: back to draft · /spec-view diff shows what changed`) and the agent is told to ask you to approve again. Needs `progressFormat`. | Toast, and a note to the model |
| **Notifications** | Through your own notification channel (the one Claude Code uses): `Checkpoint reached` with its review items, `All tasks done`, and `Tests failed on T4` the first time a test run fails on the current task. Turn off with `notifications`. | System notification |

### Commands

| Command | |
|---|---|
| `/progress` | Opens the plan pane on its Tasks tab; ←/→ (or a click) switches tabs, `r` writes the report, `c` copies the digest |
| `/progress timeline` | Opens the plan pane on the run timeline |
| `/progress charts` | Opens the plan pane on the charts |
| `/progress digest` | Copies the four-line digest and shows it |
| `/progress report` | Writes `tasks/progress-report.html` and opens it in your default browser (from the terminal, VS Code or the desktop app; elsewhere it prints the path) |
| `/progress dashboard [view]` | Writes `tasks/progress-dashboard.html` and opens it, on `overview`, `board`, `roadmap`, `flow`, `spec` or `modules`. Uses the plugin's own history, so its ETA matches the board |
| `/progress team` · `team init [force]` | The team and who you are · a first `tasks/team.md` from the git authors |
| `/progress assign T4 @sara` · `assign T4 me` · `claim T4` · `unassign T4` | Sets or clears a task's owner |
| `/progress review T4 #42 @bob` | Puts a task in review, with its PR and reviewer (both optional) |
| `/progress handoff T4 @bob "note"` | Gives a task to someone else, with a dated note |
| `/progress modules [id]` | Every module of the capability map, or one module's run timeline |
| `/progress format` | Applies the progress format to the files here and writes its rules into `AGENTS.md` or `CLAUDE.md` |
| `/progress history` | Lists the history sources and what each added |
| `/progress history logs on` / `off` | Reads Claude Code's session logs for this project, or stops using them |
| `/progress next` | Prints the next unblocked task with its criteria and any checkpoint after it. It comes straight from the parser and costs no model tokens. |
| `/progress task T4` | One task in detail: state, step, days spent or expected date, acceptance and verification boxes apart, what it waits on and what waits on it, the checkpoint after it, and the commits that name it. The board focuses it. |
| `/progress start T4` · `done T4` · `block T6 "why"` · `unblock T6` | Sets a task's state yourself: in progress from today, every box ticked, blocked with a numbered question added to `tasks/plan.md` (`- Q3 (T6): why`), or unblocked. Written into its Status line. |
| `/progress allow-overwrite` | Lets the next turn overwrite an unfinished plan once |
| `/progress archive` / `archive force` | Moves the plan to `tasks/archive/<date>-<plan>/` (todo.md, plan.md, history.json and a README of what was left open) so the next `/plan` starts clean. An unfinished plan needs `force`. |
| `/progress doctor` / `doctor fix` | Lists problems in the task list, plan and specs by file: duplicate task numbers, dependencies on missing tasks, dependency loops, tasks with no boxes or no verification, unnumbered open questions, missing spec sections, and progress-format gaps. `fix` applies the fixable ones. |
| `/progress refresh` | Re-reads the files and prints the status |
| `/spec-view [id]` | Opens the spec pane. `/spec-view auth` shows `specs/auth.md`, else `SPEC-auth.md`. Without a spec it says where the file would go. |
| `/spec-view diff` | What changed in the spec since it was approved (or since its last commit): a +/− count and the diff, also drawn as a highlighted diff under the spec pane. |

Options, set in `/config` or under `pluginConfigs` in settings:

| Option | Default | |
|---|---|---|
| `progressFormat` | on | Keep the progress format: Status lines and front matter, and tell Claude its rules |
| `planSpinner` | off | Spinner in plan terms |
| `specGate` | off | Warn when source files change before the spec is approved |
| `checkpointGate` | off | Warn when source files change while a reached checkpoint waits for your review |
| `notifications` | on | Native notifications when a checkpoint is reached, the last task is done, or tests start failing |
| `chartStyle` | auto | Terminal charts: `auto` pictures on kitty and Ghostty, characters elsewhere; `pixels`; `cells` |

The board command is `/progress` because Claude Code already has a built-in `/tasks`.

### What the parser reads

Both task formats the planning skill writes:

- `## Task N: title` sections with acceptance and verification checkboxes and a `**Dependencies:**` line. A task is done when all its boxes are ticked, and blocked while a task it depends on isn't done.
- `- [ ] Task N: title` lines under `### Phase …` headings, the plan's task index.

It also reads `## Checkpoint: …` and `### Checkpoint: …` blocks, which attach to the task just before them.

Anything else with checkboxes is shown as a plain checklist. A file with nothing to parse gives an empty board, never an error.

For `SPEC.md`, optional `status: draft | approved` front matter decides approval. Without it, the spec counts as approved once a plan exists, because planning only starts after the spec gate.

## Status line (optional)

Mods can't change the status line, which is your own script. One ships here:

```
✓spec ✓plan ●build 4/9 ○review ○ship · T4 Rate limit per key
```

Copy it somewhere stable and point `statusLine` at it in `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "bash ~/.claude/agent-skills-status.sh" }
```

It prints `user@host:dir [model]` first. Set `ASM_STATUS_PREFIX=0` to print only the stage, so you can append it to a status line you already have. Projects without these files get the plain line. It needs `jq`.

## Progress format (E1)

agent-skills records progress only as checkboxes. This plugin extends its files with a small, documented format so state and dates persist in the repository and read the same in every agent and editor: `status` / `created` / `approved` front matter on specs and plans, `plan` / `created` on the task list, and one line per task:

```markdown
## Task 4: Rate limit per key
**Status:** in progress · started 2026-10-09 · step test
```

The plugin keeps it for you: Claude is told the rules every session (and the spec, planning, build and test skills carry them when they load); a `Write` of the task list gets its front matter and Status lines; an `Edit` that ticks a task's last box marks it done with the date in the same edit; source edits, test runs and commits move the current task to in progress at that step; the spec pane's Approve button records the approval date. `/progress format` applies it to a project already under way and writes the rules into `AGENTS.md` (or `CLAUDE.md`) so other agents keep it too. Turn it off with the `progressFormat` option.

The format is described in [docs/progress-format.md](docs/progress-format.md); the proposal to adopt it upstream, with eval cases in agent-skills' own schema, is in [docs/upstream/](docs/upstream/).

## Other agents: agent-skills-progress

Cursor, Gemini CLI, Codex or a CI job get the same summary from a script with no dependencies. It uses the plugin's parser, git history and forecast, so its numbers match the panes:

```
╭─ keys ───────────────────────────────────────────────────────────────╮
│ agent-skills · API keys                                              │
│ ♦spec ✓plan ●build 1/4 ○review ○ship                                 │
│ ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  25% 1 of 4 tasks           │
│ ETA 23 Oct (fast 19 Oct, slow 28 Oct)                                │
│ from 4 tasks in 11 days                                              │
╰──────────────────────────────────────────────────────────────────────╯

── Spec · SPEC.md ──────────────────────────────────────────────────────
  ♦ awaiting approval  4/6 core areas
  ! Objective                       ✓ Commands
  ...
── Tasks · tasks/todo.md ───────────────────────────────────────────────
  Phase 1: Foundation
    ✓ T1 Monorepo scaffold · 3/3
    ● T2 Prisma schema for keys · 1/3
  ...
── Next · T2 ───────────────────────────────────────────────────────────
── Needs you · 2 ───────────────────────────────────────────────────────
```

```sh
node scripts/agent-skills-progress.mjs [dir]          # the full summary, in colour on a terminal
node scripts/agent-skills-progress.mjs --brief        # one line: ✓spec ✓plan ●build 1/4 ○review ○ship · T2 ...
node scripts/agent-skills-progress.mjs --timeline     # the run timeline, as the plan pane draws it
node scripts/agent-skills-progress.mjs --json         # the parsed state for other tools (State v1)
node scripts/agent-skills-progress.mjs --dashboard    # the dashboard page, to tasks/progress-dashboard.html (or --dashboard out.html)
node scripts/agent-skills-progress.mjs --modules      # every module of the capability map (--modules <id>: one module's timeline)
node scripts/agent-skills-progress.mjs --spec auth    # specs/auth.md or SPEC-auth.md
```

Other options: `--no-git`, `--no-color` (or `NO_COLOR=1`), `--color` (or `FORCE_COLOR=1`), `--width <n>`. A braille spinner shows on stderr while it reads git.

`--json` prints State v1, marked `"schema": 1`. It holds every spec file, the task list (each task with its Status line, its blocker and the checkpoint after it), the plan's status and open questions, the forecast, the daily snapshots, the band's alerts and what needs a person. Fields are only added within v1; a change to existing ones would come as `schema: 2`. The type is `StateJson` in `packages/core/state.ts`.

It needs Node 22.6 or newer (it runs the plugin's TypeScript through Node's type stripping) and nothing else.

## Development

```sh
claude plugin validate .     # manifest, marketplace and hooks module
claude plugin test .         # 310 tests: parser, guard, forecast, state, team and approvals, modules, the dashboard's views, and the mod on terminal and desktop
bash statusline/test.sh      # status line against sample projects
bash scripts/test.sh         # agent-skills-progress under Node, and that packages/core imports only itself
claude --plugin-dir .        # run a session with the plugin loaded from this folder
npm --prefix packages/charts ci && npm --prefix packages/charts run build   # rebuild the dashboard's chart bundle
```

The dashboard's charts are [Nivo](https://nivo.rocks) (React), bundled by esbuild from `packages/charts/` into the committed, generated `packages/core/dashboard/charts-bundle.ts`. The plugin and the CLI install nothing. Rebuild only after changing `packages/charts/`; `scripts/test.sh` checks that the bundle parses and stays under 600 KB.

Layout:

```
hooks/register.tsx         the mod: commands, guard, panes, band, footer
packages/core/parse.ts     SPEC.md / plan.md / todo.md parsers (pure, no Claude Code API)
packages/core/forecast.ts  daily snapshots → ETA range
packages/core/history.ts   past snapshots from git commits and commit messages
packages/core/logs.ts      past snapshots from Claude Code's session logs
packages/core/chart.ts     burn-up and flow charts as Raster cells
packages/core/svg.ts       the same charts as SVG
packages/core/report.ts    digest and HTML report
packages/core/steps.ts     tool calls as build, test and commit
packages/core/guard.ts     the overwrite check
packages/core/view.ts      text views shared by panes and commands
packages/core/gate.ts      the spec gate warning
packages/core/format.ts    the progress format: front matter, Status lines, stamping
packages/core/specedit.ts  approve / draft in front matter, the editor to open
packages/core/pixels.ts    pixel charts: RGBA canvas and PNG encoder
packages/core/cli.ts       the summary agent-skills-progress prints
packages/core/timeline.ts  the run timeline as rows of coloured segments
packages/core/state.ts     State v1: what every surface reads, and the --json contract
packages/core/health.ts    on track, or at risk with each reason
packages/core/team.ts      tasks/team.md, and who you are from a git email
packages/core/approvals.ts approvals by role: sign, status, who a spec waits on
packages/core/modules.ts   the capability map's modules with their specs and plans
packages/core/module-timeline.ts  one module's run timeline, from its archive
packages/core/dashboard/   the dashboard page: shell and tabs, one module per view, the generated chart bundle
packages/charts/           the chart bundle's source (React + Nivo, dev dependencies only) and its build
hooks/ui/                  surface modules: the tabs, the animated bar, the turning task marker
scripts/                   agent-skills-progress, its test, and the core purity check
types/index.d.ts           the session state contract
statusline/                the status line script and its test
```

History for the ETA is one snapshot per day, stored per project in the plugin's own store. Nothing is written into your repository except the report or dashboard you ask for. Rebuilding it from git runs three read-only commands once per project: `git log` for the commits that touched the task list, one `git cat-file --batch` for their copies of it, and `git log` for commit messages. Session logs are read from `~/.claude/projects/<project>/` (or `$CLAUDE_CONFIG_DIR`) only after you allow it; their format is Claude Code's own, so a line the plugin does not understand is skipped. Days the plugin saw for itself win over every other source, since they include uncommitted edits.

## Roadmap

The user stories, mockups and chart designs live in the proposal; every story in it is now built except the upstream one below.

The next modules are mapped in [SPEC.md](SPEC.md) (`/progress modules` shows where each stands): a board across branches, Agile ceremonies, a team site, and a VS Code extension. Teams (format-v2) shipped in 0.38.0; its format is in [docs/progress-format.md](docs/progress-format.md).

Upstream, the plan is to propose the progress format to agent-skills (issue text and eval cases in [docs/upstream/](docs/upstream/)), so any tool, not only this plugin, can read progress reliably.

## Status

This uses the early-access mods API, which can change between Claude Code releases. The tests check what the mod hands to Claude Code on each surface, not what the screen finally shows.

MIT licensed.
