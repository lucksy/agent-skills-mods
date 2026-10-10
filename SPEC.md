---
status: approved
created: 2026-10-10
approved: 2026-10-10
---
# Capability Map: agent-skills-mods as a team tool

agent-skills-mods grows from a single-developer view in Claude Code into a team tool for any agent, with git as the shared board. The brainstorm behind this map is the doc "agent-skills-mods: Roadmap Brainstorm" (https://claude.ai/artifact/CUFyfevjs8VdhZGPNW4jEt).

| Module id | Responsibility | Depends on |
|---|---|---|
| core | `hooks/lib` moved into `packages/core`; a versioned `state.json` contract read by every surface | — |
| dashboard | Multi-view HTML dashboard (Overview, Board, Roadmap, Flow, Spec) built from today's data, opened by `/progress dashboard` and the CLI's `--dashboard`; read-only | core |
| format-v2 | Progress format v2: owner, in review, named approvals, `tasks/team.md`, handoff notes; a Modules view across the capability map, archived plans included (added 2026-10-10) | core, dashboard |
| team-view | Board across branches, collision alerts, task-aware merge driver, "since you last looked", live local dashboard with write actions | format-v2, dashboard |
| ceremonies | Sprint view, team standup, sprint report, retro, decisions inbox | format-v2, dashboard |
| team-site | GitHub Action building the dashboard to Pages, portfolio across repos, risk radar | dashboard |
| vscode | VS Code extension: tree view, CodeLens, Problems panel, the dashboard in a webview | core, dashboard |

Build order: core → dashboard → format-v2 → team-view, ceremonies → team-site → vscode

Each module has its own spec, named by module id: `SPEC-core.md`, `SPEC-dashboard.md`, and so on. This map is the index of what exists. A Jira, Linear or GitHub Issues mirror is out of scope until team-site ships.
