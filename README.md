# agent-skills-mods

A Claude Code plugin that makes the [agent-skills](https://github.com/addyosmani/agent-skills) workflow readable inside Claude Code. You see `SPEC.md`, `tasks/plan.md` and `tasks/todo.md` as panes, a band above the prompt and the footer, so you don't have to open them in an editor.

It runs next to agent-skills and changes nothing in it. The skills still write plain markdown, and this plugin reads it.

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
│   ◌ T3 Issue and revoke keys · waits on T2        │
│   ○ T4 Rate limit per key                         │
│                                                   │
│ ✓ done ● next ○ to do ◌ waits on a dependency     │
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
| **Spec pane** | The six core areas of `SPEC.md` (Objective, Commands, Project structure, Code style, Testing, Boundaries), each marked present ✓, empty ○ or missing ×. Boundaries show as Always / Ask first / Never columns, followed by the open questions. The header says *awaiting approval* until the spec is approved. Weak sections get a ! and one reason: success criteria with no number or condition, Commands with no runnable line, Code style with no code block. These are hints and never block approval. | Opens when the agent writes `SPEC.md`, or with `/spec-view` |
| **Task board** | Phases, tasks and checkpoints in plan order, with ✓ ● ○ ◌ ♦ glyphs, a progress bar and an ETA. | Opens when the agent writes `tasks/todo.md`, or with `/progress` |
| **ETA as a range** | A median date with optimistic and slow cases, plus where it comes from ("from 4 tasks in 11 days") and how much scope was added. It shows no date until 3 tasks have been finished in the history. | Board pane |
| **History from git** | The first time the plugin sees a plan, it rebuilds past daily progress from the commits of `tasks/todo.md`, so a project that is already under way gets an ETA on day one. It reads back until the file did not exist or held a different plan. Without git, tracking starts that day, and the board says which. A toast reports the result once. | Board pane, under the ETA |
| **Toasts** | When an agent edit finishes a task: `✓ T3 done Issue and revoke keys · Next: T4 Rate limit per key`. When that task is the last before a checkpoint, the toast names the checkpoint's own items instead: `♦ Checkpoint reached: After Tasks 1-2 · All tests pass · Review with human`. At most one per edit, none for unticking. | Over the transcript, after the edit |
| **Answers about progress** | The parsed state (counts, current task and its open criteria, blocked tasks with their dependency chain, open questions, spec gaps, ETA) is the last section of the system prompt, after the cache boundary, so "what's left?" or "why is T3 blocked?" gets a short answer that cites task IDs and the source file instead of a guess. A prompt that names a task (`T3`, `task 3`) or asks about progress opens the board with that task highlighted. Projects without these files add nothing. | The model's answers, and the board |
| **Current task band** | `● T2 title · 2 criteria left · 1/4 done · checkpoint after this task`. Hidden when there is no plan or every task is done. | Above the prompt |
| **Status entry** | `spec ✓ approved · plan 4/9` | Status area |
| **Stage in the footer** | When an agent-skills skill loads, its stage (spec, plan, build, test, review, ship) and the current task are added to the hint line (`· build T2`) and to the mode labels. Claude Code's own text stays. | Hint line and mode labels |
| **Plan guard** | Puts the planning skill's rule *"Never overwrite an incomplete plan"* into practice. A `Write` to `tasks/plan.md` or `tasks/todo.md` is refused when it would drop or rename a task that isn't finished. Edits that tick boxes, add tasks or reword around the open ones still go through. | On every `Write` |

### Commands

| Command | |
|---|---|
| `/progress` | Opens the task board |
| `/progress next` | Prints the next unblocked task with its criteria and any checkpoint after it. It comes straight from the parser and costs no model tokens. |
| `/progress allow-overwrite` | Lets the next turn overwrite an unfinished plan once |
| `/progress refresh` | Re-reads the files and prints the status |
| `/spec-view` | Opens the spec pane. Without a `SPEC.md` it says where the file would go. |

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

## Development

```sh
claude plugin validate .     # manifest, marketplace and hooks module
claude plugin test .         # 42 tests: parser, guard, forecast, and the mod on terminal and desktop
bash statusline/test.sh      # status line against sample projects
claude --plugin-dir .        # run a session with the plugin loaded from this folder
```

Layout:

```
hooks/register.tsx     the mod: commands, guard, panes, band, footer
hooks/lib/parse.ts     SPEC.md / plan.md / todo.md parsers (pure, no Claude Code API)
hooks/lib/forecast.ts  daily snapshots → ETA range
hooks/lib/history.ts   past snapshots rebuilt from git
hooks/lib/guard.ts     the overwrite check
hooks/lib/view.ts      text views shared by panes and commands
types/index.d.ts       the session state contract
statusline/            the status line script and its test
```

History for the ETA is one snapshot per day, stored per project in the plugin's own store. Nothing is written into your repository. Rebuilding it from git runs two read-only commands once per project: `git log` for the commits that touched the task list, and one `git cat-file --batch` for their copies of it. Days the plugin saw for itself win over days rebuilt from git, since they include uncommitted edits.

## Roadmap

The user stories, mockups and chart designs live in the proposal. Next up:

- braille and half-block burn-up and flow charts in the terminal, and SVG charts on desktop;
- `/progress report` (HTML for managers) and `/progress digest` (Slack text).

Upstream, the plan is to propose a documented, parseable file shape to agent-skills: `status:` front matter and stable `T<n>` IDs. That would let any tool, not only this plugin, read progress reliably.

## Status

This uses the early-access mods API, which can change between Claude Code releases. The tests check what the mod hands to Claude Code on each surface, not what the screen finally shows.

MIT licensed.
