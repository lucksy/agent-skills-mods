# Privacy

agent-skills-mods (Spec & Plan Board for agent-skills) runs entirely on your machine. It has no server, makes no network requests, and sends nothing to its author, to Anthropic or to anyone else.

## What it reads

- Your project's spec, plan and task files (`SPEC.md`, `SPEC-<id>.md`, `specs/`, `tasks/`) and its git history, read-only.
- Your git email (`git config user.email`) and the names and emails of the project's git authors, only to match people to `tasks/team.md` and to draft that file when you run `/progress team init`.
- Claude Code's `installed_plugins.json` and the session's skill list, only to tell whether agent-skills is installed.
- This project's Claude Code session logs, only after you say yes to the band's question, and only the lines that write the task list.
- Your prompts, only to see whether they name a task (such as `T3`) so the board can open on it. Prompts are never stored, written to a file or passed to any program.

## What it stores, and where

- In your project, as plain files you can read and delete: the progress format's status lines, `tasks/team.md` (names, handles, roles and git emails) when you create it, reports and dashboards you ask for, and archived plans.
- In Claude Code's local plugin store on your machine: daily progress snapshots and the history sources behind the forecast. Uninstalling the plugin stops all reads and writes; removing the plugin's data from Claude Code removes the store.
- In your git directory (`.git/agent-skills/seen.json`, never committed): what you last looked at, for "since you last looked".

Nothing is kept anywhere else.

## What it sends

Nothing leaves your machine. The live dashboard (`/progress dashboard live`) listens on 127.0.0.1 only, with a new random token each run. The full list of programs the plugin starts, and why, is in the README under [What it runs, reads, writes and sends](README.md#what-it-runs-reads-writes-and-sends).

## Children

The plugin is a developer tool and is not intended for users under 18.

## Contact

Questions: open an issue at https://github.com/lucksy/agent-skills-mods/issues.
