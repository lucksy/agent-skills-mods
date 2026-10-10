---
status: approved
created: 2026-10-11
approved: 2026-10-11
---
# Implementation Plan: team-view

## Overview

This plan builds [SPEC-team-view.md](../SPEC-team-view.md), module `team-view` of the capability map in [SPEC.md](../SPEC.md). It covers:
- one actions table behind every write, plus answers to questions and checkpoint sign-offs;
- a board across branches, read from git objects already on the machine;
- collision alerts;
- the Team tab;
- a task-aware merge driver, opt-in;
- "since you last looked";
- a live local dashboard (`--serve`) whose buttons run the same actions.

The previous plan (format-v2, 13 of 13) is archived in `tasks/archive/2026-10-10-format-v2/`, with its open checkpoint boxes listed in its README.

## Architecture Decisions

- **One actions table.** `packages/core/actions.ts` maps each action name to an argument check and a pure edit (`text in → text out, reply`). The plugin's `/progress` verbs and the server's `POST /action` both call it, so the dashboard and the commands can't drift apart. T1 moves today's write verbs onto it with no change in behaviour, before anything new uses it.
- **Other branches come from git objects only.** `git for-each-ref` lists the refs. `git cat-file --batch` reads `<ref>:tasks/todo.md` for every ref in one process, the same pattern `history.ts` uses. The plugin never checks out, stashes or fetches. Fetch age comes from the mtime of `FETCH_HEAD`.
- **The furthest state.** Each task's states are ranked done > in review > in progress > blocked > todo. The board shows the furthest one and the branch it is on. A collision is a separate check: the task is under way (in progress or in review) on two refs, or it has two different owners.
- **The merge driver is pure core plus a thin CLI.** `mergeTodo(base, ours, theirs)` and `mergeFrontMatter` take text and return text, never dropping content. The CLI's `--merge %O %A %B %P` reads the files, calls core, writes `%A` and exits 0 or 1. Prose and anything the driver doesn't own falls back to `git merge-file`.
- **"Last looked" is per clone.** `<git dir>/agent-skills/seen.json` (found with `git rev-parse --git-dir`) holds a compact snapshot: task states and owners, spec statuses, answered questions, collisions. The plugin and the CLI share it. It is never committed.
- **The server is a handler plus wiring.** `packages/core/serve.ts` exports `handle(request, io)`, which checks the token, `Origin` and `rev`, and returns `{ status, headers, body }` with no sockets. The CLI wires it to `node:http`, `fs.watch` and SSE. The static dashboard stays exactly as it is; only live mode adds the buttons and its own script, under 4 KB.
- **State v1 grows, it doesn't change.** `branches`, `collisions` and `since` are added within schema 1.
- **Story ids:** V1–V6, as in the spec.

## Dependency Graph

```
T1 actions table (existing verbs) + Q1 check
 ├─ T2 answer + signoff (format lines, actions, commands)
 │   ├─ T10 serve handler + --serve (token, origin, rev, SSE)
 │   │   └─ T11 live page: buttons, SSE client, 409 notice   ← also T5, T6
 │   │       └─ T12 /progress dashboard live
 │   └─ T9 since (seen.json, once per session, /progress since, --since)   ← also T4
T3 branches.ts + /progress branches + --branches
 ├─ T4 collisions: band, board pane, --json
 │   ├─ T5 dashboard Board: ?branches=all, collision marks
 │   └─ T6 Team tab
 └─ (T9 reads collisions)
T7 mergeTodo + front-matter merge (pure)
 └─ T8 --merge + /progress merge-driver + real git merge test
T13 docs, rules, README, 0.39.0, final checks ← all
```

T3 and T7 can start in parallel with T1. T5 and T6 can run in parallel, and so can the merge track (T7–T8) and the branches track (T3–T6).

## Task List

Tasks are tracked in [tasks/todo.md](todo.md).

### Phase 1: Foundation
- [ ] Task 1: One actions table for the existing write commands
- [ ] Task 2: Answer questions and sign off checkpoints

### Checkpoint: Foundation
- [ ] Tests pass; every existing command replies and writes exactly as before

### Phase 2: The team across branches
- [ ] Task 3: The board across branches
- [ ] Task 4: Collision alerts
- [ ] Task 5: Dashboard Board across branches
- [ ] Task 6: The Team tab

### Checkpoint: Branches
- [ ] Two real branches show on the board and collide in the band

### Phase 3: Merge driver
- [ ] Task 7: Task-aware merge in core
- [ ] Task 8: The merge driver, installed and run by git

### Checkpoint: Merge
- [ ] A real `git merge` of two edited task lists comes out clean

### Phase 4: Since you last looked
- [ ] Task 9: Since you last looked

### Phase 5: Live dashboard
- [ ] Task 10: The live server
- [ ] Task 11: Write buttons on the live dashboard
- [ ] Task 12: /progress dashboard live

### Checkpoint: Live
- [ ] In Chrome, Sign, Answer and Claim change the markdown and the page reloads

### Phase 6: Close
- [ ] Task 13: Docs, rules, README, 0.39.0 and final checks

### Checkpoint: Complete
- [ ] Every success criterion in the spec is met; review with human

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The T1 refactor changes a reply or a write | High | T1 changes no behaviour. The existing mod tests for every verb must pass unchanged before T2 starts. |
| `cat-file` over many refs is slow on big repos | Medium | One batch process. Refs are capped at 25 and limited to 30 days (Q2). Results are cached by ref SHA, so an unchanged ref isn't read twice. |
| The merge driver loses or garbles a task | High | A "never drops content" property test over generated base/ours/theirs. A real `git merge` in `scripts/test.sh`. Anything unsure falls back to markers. |
| Git runs the driver where Node or the script isn't found | Medium | `install` writes an absolute path to the plugin's script and checks that `node --version` is 22.6 or newer. `status` reports a broken path. |
| A web page on another site posts to the local server | High | 127.0.0.1 only, a random per-run token, an `Origin` check on writes, and no CORS headers. Handler tests cover each refusal. |
| Two tabs or a tab and an agent edit the same file | Medium | The `rev` hash check: a stale write gets a 409 and writes nothing. |
| A mod can't start a long-running process (Q1) | Low | `/progress dashboard live` prints the exact command instead. Only T12 depends on it. |
| "Since you last looked" turns into noise | Low | One line, at most 6 items, then "and N more · /progress since". Nothing when nothing changed. |

## Open Questions

- Q1 (T12): Can a mod start a long-running process? If it can, `/progress dashboard live` starts `--serve` itself. If it can't, it prints the command. T1 checks the mods API and records the answer here.
  → A: Yes, for the session's life, but not detached. `$.process.run(argv, { timeoutMs })` can't: it reads the whole output, so a server holds the call until the timeout (30 s by default, ten minutes at most) and then it is killed and the call rejects. `$.process.spawn({ argv, cwd, env })` can: it streams the child's output, and "a child for the session's life" is its documented use (a `void (async () => { for await (const x of $.process.spawn(...)) … })()` loop that outlives the hook). The child dies when the loop ends, on `return()`, on `next.signal` aborting, or when the module unloads, so `--serve` stops with the session. T12 starts it with `$.process.spawn`, reads the URL line from its stdout, and keeps one child per project. Evidence: `.claude-plugin/types/claude-code/index.d.ts`, `process.run` and `process.spawn` on `$` (the `process:` member) and `ProcessRunInit.timeoutMs`; hooks/register.tsx uses only `$.process.run` today · @claude 2026-10-11
- Q2 (T3): Which refs count as "the team"? The default is local branches plus `refs/remotes/*` with a commit in the last 30 days, up to 25 refs, skipping refs that point at the current branch's commit. Should the limit or the window be a setting?
- Q3 (T7): In a merge, should *blocked* beat a later *in progress*? The default is the later stamp only.
