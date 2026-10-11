---
status: approved
created: 2026-10-11
approved: 2026-10-11
---
# Spec: team-view (the team across branches, and a dashboard that writes)

Module `team-view` of the capability map in [SPEC.md](SPEC.md). Depends on `format-v2` (owners, in review, approvals, `tasks/team.md`) and `dashboard` (the page and its views).

## Objective

Once format-v2 lands, a team can share one plan, but each person still sees only their own branch. Two people can start the same task without knowing it. A merge of `tasks/todo.md` can bring back conflict markers. The dashboard is read-only. This module turns what git already holds into a view of the whole team. It still needs no server and no accounts, and it never touches the network.

1. **A board across branches.** The plugin reads `tasks/todo.md` from every local branch and every remote-tracking ref already fetched, using `git cat-file --batch`. For each task it shows the furthest state it has reached on any branch, along with that branch's name and how long ago it was fetched. The plugin never runs `git fetch`.
2. **Collision alerts.** A task is a collision when it is in progress or in review on two branches, or when it has two different owners. Collisions show in the band, on the board pane, in `--json` and on the dashboard: `! T4 is also in progress on feat/rate-limit by @bob (2d)`.
3. **A task-aware merge driver.** `git merge` of `tasks/todo.md` merges task by task, and a spec's `approvals:` merges role by role. Anything it can't merge cleanly falls back to ordinary conflict markers. It is opt-in: `/progress merge-driver install` asks first.
4. **"Since you last looked."** Once per session, and on `/progress since`, you get a short list of what changed while you were away. It covers tasks done, things assigned or handed to you, questions answered, specs that went back to draft and new collisions, each with who did it.
5. **A live local dashboard that writes.** `--serve` serves the dashboard on 127.0.0.1 only, behind a per-run token, and reloads it when the files change. Its buttons run the same edits the plugin's commands do: task moves, ownership, approvals and answers to questions. Each edit writes to the markdown, which stays the only source of truth.
6. **A Team tab.** Each person's current task and step, their WIP, the review queue, handoffs waiting, collisions and decisions waiting on someone. It doesn't rank people. This answers format-v2's Q2: the "by person" view lives here, not on the Overview.

**Users and stories**

- **V1 Lead:** "What is everyone doing, across all the branches?" They run `/progress branches`, or open the dashboard's Board with `?branches=all`. Each card shows its furthest state and the branch it's on.
- **V2 Developer:** "Is anyone else on T4?" They start T4. If T4 is already in progress on `feat/rate-limit`, the band shows the collision with the owner and its age before they write any code.
- **V3 Developer:** "My merge shouldn't break the plan." `git merge feat/rate-limit` merges `tasks/todo.md` by task: ticked boxes win, the later-stamped Status wins, and a task number taken on both sides is renumbered and reported.
- **V4 Anyone:** "What happened while I was out?" Their first prompt of the day starts with `Since you last looked (2026-10-09): T3 done by @bob · Q2 answered by @pm · T6 assigned to you`.
- **V5 PM or designer (no terminal):** "I want to sign the spec and answer Q2 without a terminal." A developer runs `--serve` for them, or they run it themselves. They press **Sign** on the Spec tab and **Answer** on a question. The markdown changes on disk, with their name and the date.
- **V6 Lead:** "Who is overloaded, and what is waiting on review?" The Team tab shows WIP per person and the review queue with ages.

## The format additions

Every addition is optional and stays inside v2's rules. An older plugin ignores these lines.

**An answer to an open question** (in `tasks/plan.md`), on the line below the question:

```markdown
- Q2 (T6): Upstash Redis or self-hosted for the sliding window?
  → A: Upstash · @pm 2026-10-11
```

**A checkpoint signed off** (in `tasks/todo.md`), on the line below the heading. Signing also ticks the checkpoint's review box:

```markdown
## Checkpoint: Approvals
**Signed off:** @amila 2026-10-11
- [x] Review with human before proceeding
```

**The merge driver**, written only by `/progress merge-driver install`:

```gitattributes
# .gitattributes (committed)
tasks/todo.md   merge=agent-skills
tasks/plan.md   merge=agent-skills
SPEC*.md        merge=agent-skills
specs/*.md      merge=agent-skills
```

```ini
# .git/config (local, each clone)
[merge "agent-skills"]
    name = agent-skills task-aware merge
    driver = node scripts/agent-skills-progress.mjs --merge %O %A %B %P
```

**"Last looked" state** lives in `<git dir>/agent-skills/seen.json`. It is per clone and never committed. The plugin and the CLI share it.

## Merge rules

| Part | Rule |
|---|---|
| Task with the same id on both sides | Each box is ticked if either side ticked it. The Status line with the later stamp wins (done date, then started date). With equal stamps, ours wins. `**Handoff:**` lines are combined and sorted by date. |
| Task on one side only | Kept |
| Task added on both sides with the same number but different titles | Ours keeps the number. Theirs takes the next free number, and its `**Dependencies:**` are rewritten. The driver prints `T14 (theirs) is now T15` to stderr. |
| Task deleted on one side, edited on the other | Conflict markers around that task |
| `approvals:` in front matter | Combined by role. If both sides signed the same role, the earlier signature wins. `status: approved` is worked out again from the result. |
| Other front-matter keys, prose, Open questions | Line-merged with `git merge-file`. If that conflicts, the usual markers appear. |

The driver exits 0 when everything merged cleanly, and 1 when it left markers. It never drops content.

## Tech Stack

The same as `format-v2`: TypeScript in `packages/core` with no new dependencies. The server uses Node's `node:http` and `node:fs` `watch`, wired in the CLI. Its request handling is a pure function in `packages/core`. Live updates use Server-Sent Events, and the page refetches itself when an event arrives. The live mode's inline script is separate from the static page's and stays under 4 KB.

## Commands

```sh
# User-facing (plugin)
/progress branches                   # the board across branches: furthest state, branch, fetch age
/progress since                      # what changed since you last looked (also shown once per session)
/progress answer Q2 "Upstash"        # answer with your name and the date
/progress signoff                    # sign off the checkpoint that is due
/progress merge-driver [install|uninstall|status]   # install and uninstall ask first
/progress dashboard team             # the dashboard on its Team tab
/progress dashboard live             # start --serve (see Q1) and open the page

# CLI
node scripts/agent-skills-progress.mjs --branches
node scripts/agent-skills-progress.mjs --since
node scripts/agent-skills-progress.mjs --serve [--port 7357] [--no-open]   # 127.0.0.1 only; prints the URL with its token
node scripts/agent-skills-progress.mjs --merge %O %A %B %P                 # called by git, not by people
node scripts/agent-skills-progress.mjs --json        # State v1 gains branches, collisions, since (still schema 1)

# Development
claude plugin validate . && claude plugin test . && bash scripts/test.sh && bash statusline/test.sh
```

**The live server's API.** Every request needs the token, sent as the `X-Agent-Skills-Token` header or as `?token=` on the page URL. Requests whose `Origin` isn't the server's own get 403.

```
GET  /                  the dashboard, live mode
GET  /events            SSE: "changed" when a watched file changes
POST /action            { action, args, rev } → 200 { reply } | 409 { reply: "changed since you loaded it, reload" } | 400 { reply }
```

`action` is one of `start`, `done`, `block`, `unblock`, `tick`, `claim`, `assign`, `unassign`, `review`, `handoff`, `sign`, `signoff`, `answer`. Each action calls the same core function as its `/progress` command. `rev` is the hash of the file as the page loaded it, and a write goes ahead only if the file still has that hash.

## Project Structure

```
packages/core/branches.ts        → NEW: refs to read; todo.md per ref through cat-file --batch; the board across branches
packages/core/collisions.ts      → NEW: collisions from branch rows and the current list
packages/core/merge.ts           → NEW: three-way merge of a task list and of front matter (pure; text in, text and conflicts out)
packages/core/since.ts           → NEW: the change list between a stored snapshot and now
packages/core/actions.ts         → NEW: one table of actions (name → validate args → pure edit), shared by the plugin commands and the server
packages/core/serve.ts           → NEW: handle(request, io) → response; token, origin and rev checks (no sockets)
packages/core/format.ts          → answer lines, Signed off lines; FORMAT_RULES for both
packages/core/state.ts           → State gains branches, collisions, since; JSON fields added
packages/core/dashboard/team.ts  → NEW: the Team tab
packages/core/dashboard/board.ts → branch on cards, ?branches=all, collision marks
packages/core/dashboard/page.ts  → live mode: action buttons, the SSE client, the 409 notice
hooks/register.tsx               → branches, since (and once per session), answer, signoff, merge-driver, dashboard team|live; collisions in the band
scripts/agent-skills-progress.mjs → --branches, --since, --serve, --merge
docs/progress-format.md          → answers, sign-offs, the merge driver
tests/branches.test.ts, tests/merge.test.ts, tests/since.test.ts, tests/serve.test.ts, plus cases in mod.test.ts and dashboard.test.ts
```

## Code Style

The same as `core`: pure functions in `packages/core`, with I/O handed in. Commands and the server are thin wrappers that read, call core, write and reply.

```ts
/** The task-aware merge (V3): base, ours and theirs in, the merged text and what needed markers out. Pure; never drops content. */
export function mergeTodo(base: string, ours: string, theirs: string): { text: string; conflicts: string[]; renumbered: [string, string][] } {
```

## Testing Strategy

- **Unit (plugin tests):**
  - branch rows built from a fake `cat-file` batch, covering the furthest state, a missing file on a branch, and stale fetch ages;
  - collisions: the same task on two branches, two owners, and done on one branch while in progress on another (not a collision);
  - every merge-rules row, plus "never drops content": every task in base, ours and theirs appears in the result or inside markers;
  - since: each kind of change, nothing changed, and no stored snapshot (first run says nothing);
  - the server handler: a missing or wrong token, a foreign `Origin`, a stale `rev` (409), each action's happy path, and bad args;
  - answer and sign-off lines round-trip, keeping every other byte.
- **Mod tests (`tests/mod.test.ts`):** each new command against the in-memory project, the collision line in the band, "since" shown once per session and not twice, and the merge-driver install asking before it writes.
- **CLI (`scripts/test.sh`):**
  - a real temporary git repo with two branches that edit `tasks/todo.md`, merged with the driver installed: a clean result, then a deliberate delete-versus-edit conflict;
  - `--branches`, `--since` and the new `--json` fields;
  - `--serve` started on a random port: GET with a token, POST an action, then the file on disk has changed.
- **Manual:**
  - in a real session on this repo with two branches: the collision in the band, `/progress since` the next day;
  - in Chrome: the live dashboard, pressing Sign, Answer and Claim and watching the markdown change and the page reload; a second tab editing the same task to see the 409; the Team tab in light and dark at 360 px.

## Boundaries

- **Always:**
  - Read other branches only through git objects already on the machine (`git cat-file`, `git for-each-ref`). Never check out, stash or fetch.
  - Bind the server to 127.0.0.1, require the token on every request, and check `Origin` on writes.
  - Write a file only when its hash still matches what the page or command read.
  - Have every write go through `actions.ts`, so the dashboard and the commands can't drift apart.
  - Name the person and the date in everything an action writes.
  - Keep every v2 rule: optional additions, every other byte kept, roles shown but never enforced.
- **Ask first:**
  - Installing or removing the merge driver (it writes `.gitattributes` and `.git/config`).
  - Changing State v1's existing fields.
  - Commits, pushes, branches and the `gh` CLI. The server and the actions only edit files.
  - Adding a dependency.
  - Binding the server to anything other than 127.0.0.1.
- **Never:**
  - Run `git fetch`, or send anything off the machine.
  - Rank or score people on the Team tab or anywhere else. Show load and queues, never speed.
  - Let the merge driver drop content or resolve a delete-versus-edit silently.
  - Sign, approve or answer for anyone other than the person running the session or the server.
  - Let a team-site (static) build offer write buttons.

## Success Criteria

- [x] `/progress branches`, `--branches` and the Board's `?branches=all` show each task's furthest state across local branches and fetched refs, with the branch name and fetch age. No command touches the network (checked by running with networking off).
- [x] Starting a task that is in progress or in review on another branch shows the collision in the band within the same prompt. Collisions also appear on the board pane, the dashboard and `--json`.
- [x] With the driver installed, merging two branches that each ticked boxes and moved different tasks gives a clean `tasks/todo.md` with no markers, in a real `git merge` in `scripts/test.sh`. A delete-versus-edit leaves markers around that task only. A task number taken on both sides is renumbered and reported.
- [x] `/progress merge-driver install` asks first, writes exactly the `.gitattributes` lines and the `.git/config` entry, and `uninstall` removes them again.
- [x] The first prompt of a session shows "Since you last looked" when something changed, and nothing when nothing did. `/progress since` and `--since` show the same list.
- [x] `--serve` serves the dashboard on 127.0.0.1 with a token. Each of the 13 actions changes exactly its line on disk. A stale page gets a 409 and writes nothing. The page reloads within 2 s of a file change.
- [x] The Team tab shows each person's current task and step, WIP, the review queue with ages, handoffs and collisions, with no ranking.
- [x] `docs/progress-format.md` documents answers, sign-offs and the merge driver. The rules Claude is told include the new lines.
- [x] All tests pass. The README documents the commands. Checked in a real session and in Chrome.

## Open Questions

- Q1: Can a mod start a long-running process? If it can, `/progress dashboard live` starts `--serve` itself. If it can't, the command prints the exact `node … --serve` line to run (or `! node …` for Claude Code). The first task checks this against the mods API.
- Q2: Which refs count as "the team"? This spec reads local branches plus `refs/remotes/*` with a commit in the last 30 days, up to 25 refs, skipping refs that point at the same commit as the current branch. Should the limit or the window be a setting?
  → A: No setting yet, until someone actually needs a different window or limit · @lucksy 2026-10-11
- Q3: For the merge driver's "later Status wins", should *blocked* beat a later *in progress*? A block is usually news the other side needs. This spec uses the later stamp only.
  → A: Keep "later stamp wins". A blocked Status line has no date of its own to compare against, and the blocking question stays in plan.md either way, so that news isn't lost · @lucksy 2026-10-11
