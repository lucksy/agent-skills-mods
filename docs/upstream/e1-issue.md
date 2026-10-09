# Issue: a documented, parseable progress shape for SPEC.md and the task files

**Proposed for:** addyosmani/agent-skills · planning-and-task-breakdown, spec-driven-development
**Story:** E1, "As a tool author, I want a documented, parseable shape for task and spec files, so that any viewer (an editor extension, CI, a companion plugin) can read progress reliably."

## Problem

The skills hand work forward through markdown, and record progress only as checkboxes. Anything that shows progress has to guess:

- whether SPEC.md was approved (today it is inferred from a plan existing);
- which task is under way when an earlier one is still open;
- when a task started and finished, so a forecast needs git history or session logs;
- what a task's id is, when headings get renumbered.

## Proposal (backward compatible)

All additions are optional; existing files keep parsing, and checkboxes stay the source of truth for done.

1. **Front matter on SPEC.md and tasks/plan.md:** `status: draft | approved`, `created`, `approved` (dates as `YYYY-MM-DD`). The spec skill writes `status: draft` and changes it to `approved` only when the human approves.
2. **Front matter on tasks/todo.md:** `plan: <short-name>`, `created`.
3. **One Status line per task**, under its heading: `**Status:** todo`, `**Status:** in progress · started 2026-10-09 · step test`, `**Status:** done · started … · done …`, `**Status:** blocked`.
4. **Stable `T<n>` ids:** task numbers are never renumbered; new tasks take the next number. Dependencies are written `T1, T3`.
5. **Numbered open questions that name what they block:** `- Q2 (T6): …`.

The full description is [../progress-format.md](../progress-format.md).

## Evidence

[agent-skills-mods](https://github.com/lucksy/agent-skills-mods) keeps this format in Claude Code today (it tells the agent the rules, completes writes, carries Status changes on edits) and draws the spec pane, task board, run timeline, charts and an HTML report from it. Its `scripts/agent-skills-progress.mjs` prints the same summary for any agent from the same parser, with `--json` for other tools.

## Changes to send as PRs

- `skills/spec-driven-development/SKILL.md`: the front matter, and "set `status: approved` only on the human's approval".
- `skills/planning-and-task-breakdown/SKILL.md`: the todo front matter, the Status line in the task template, stable ids, `T<n>` dependencies, numbered questions.
- `skills/incremental-implementation/SKILL.md`: update the Status line when starting and finishing a task.
- Eval cases, as CONTRIBUTING.md requires: [evals/](evals/) holds the behavioural evals to add to `evals/cases/planning-and-task-breakdown.json` and `evals/cases/spec-driven-development.json`, with the fixtures they name.
