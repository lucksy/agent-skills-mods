---
status: approved
created: 2026-10-10
approved: 2026-10-10
---
# Spec: dashboard (project management dashboard, read-only)

Module `dashboard` of the capability map in [SPEC.md](SPEC.md). Depends on `core` (State v1).

## Objective

Give managers, leads and developers the whole project on one page, built from the files agent-skills already writes. The page has five views:

- **Overview:** health, ETA, scope and decisions.
- **Board:** Kanban columns.
- **Roadmap:** timeline, dependencies and critical path.
- **Flow:** burn-up, cumulative flow, aging WIP, cycle time and ETA drift.
- **Spec:** every spec's approval and areas.

The output is one self-contained HTML file. It works offline, can be attached to an email, and can be opened from Claude Code or from any agent through the CLI.

This is phase 1 of the roadmap and it is read-only. Writing back (claim, approve, sign off) belongs to `team-view`, team fields to `format-v2`, and hosting to `team-site`.

**Users and stories:**

- **K1 Manager:** "Is it on track, when will it land, what needs me?" They open the Overview and get health with reasons, the ETA range, how the ETA moved this week, scope added, and the decisions waiting.
- **K2 Lead or developer:** "What's in flight and what's stuck?" The Board shows each task's state, with phase swimlanes, blocked reasons and age.
- **K3 Lead:** "What's the path to done?" The Roadmap shows the run timeline, the dependency graph and the critical path.
- **K4 Manager or lead:** "Are we getting faster or slower?" The Flow view has the charts.
- **K5 PM or designer:** "Is the spec ready?" The Spec view shows each spec's approval, its six areas with their gaps, the boundaries and the open questions.
- **K6 Anyone:** they share a link to a view, such as `progress-dashboard.html#board`, or attach the file to an email.

## Tech Stack

- Plain TypeScript in `packages/core/` that renders HTML strings with template literals, in the same style as `report.ts` and `svg.ts`.
- Views are rendered in TypeScript at build time. A small inline script (under 4 KB, no framework) only adds tab switching, filters, keyboard navigation and URL hash state.
- **Charts are [Nivo](https://nivo.rocks)** (decided 2026-10-10): `@nivo/line` for burn-up, cumulative flow and ETA drift; `@nivo/bar` for aging WIP; `@nivo/scatterplot` for cycle time. Nivo charts are interactive, with hover tooltips.
  - Nivo and React are bundled with esbuild into one IIFE, built from `packages/charts/`. That folder has its own `package.json` and holds the only dependencies, all of them dev dependencies.
  - The build writes `packages/core/dashboard/charts-bundle.ts` (`export const CHARTS_JS = "…"`, marked `@generated`). The file is committed, so neither the plugin nor the CLI installs anything, and the mods engine loads it as an ordinary relative module.
  - The page inlines the bundle only when it contains a chart. Each chart mounts into `<div data-chart="…">` from the embedded State JSON. With JS off, each chart shows its one-line text summary.
- The Overview's tasks-by-state bar and the Roadmap's dependency tree stay HTML, since they are a meter and a tree rather than charts.

## Commands

```sh
# User-facing
/progress dashboard                 # writes tasks/progress-dashboard.html and opens it in the browser
/progress dashboard board           # same, opening on a view: overview | board | roadmap | flow | spec
node scripts/agent-skills-progress.mjs --dashboard [out.html]   # any agent or CI; default out: tasks/progress-dashboard.html

# Development
claude plugin validate .
claude plugin test .
bash scripts/test.sh
claude --plugin-dir .
```

`/progress dashboard` opens the browser the same way `/progress report` does: from the terminal, VS Code or the desktop app, and elsewhere it prints the path. The CLI writes the file and prints its path and size.

## Project Structure

```
packages/core/dashboard/page.ts      → dashboardHtml(state, { view? }): shell, tabs, CSS tokens, the inline script
packages/core/dashboard/overview.ts  → health, headline figures, decisions, risks
packages/core/dashboard/board.ts     → Kanban columns and cards, phase swimlanes
packages/core/dashboard/roadmap.ts   → timeline rows as HTML, dependency graph, critical path
packages/core/dashboard/flow.ts      → chart sections and their text alternatives
packages/core/dashboard/spec.ts      → one section per spec file
packages/core/dashboard/charts-bundle.ts → @generated: CHARTS_JS, the Nivo bundle as a string
packages/charts/                     → the chart bundle's source: package.json (dev deps), src/charts.tsx, build.mjs
packages/core/forecast.ts            → + forecastHistory(snapshots): the forecast replayed as of each past day
hooks/register.tsx                   → `/progress dashboard [view]` subcommand
scripts/agent-skills-progress.mjs    → `--dashboard [out]` flag
tests/dashboard.test.ts              → view and page tests on tests/fixtures.ts
README.md                            → command table, what you get, layout
```

## Code Style

Match `report.ts`. Escape all text that comes from markdown with `esc()`, write small local helpers, use CSS custom properties with a dark-mode override, and never use external URLs.

```ts
/** The Board (K2): a column per state, a card per task, phase swimlanes when asked. Pure. */
export function boardHtml(s: State): string {
  const card = (t: Task) =>
    `<li class="card s-${t.status}" data-phase="${esc(t.phase ?? '')}" data-state="${t.status}">
<b>${esc(t.id)}</b> ${esc(t.title)}<span class="meta">${openBoxes(t)} open${age(s, t)}</span>${blockedBy(t)}</li>`
  return COLUMNS.map(c => `<section class="col" aria-labelledby="col-${c.key}">
<h3 id="col-${c.key}">${c.label} <span class="n">${tasksIn(s, c).length}</span></h3>
<ul>${tasksIn(s, c).map(card).join('')}</ul></section>`).join('')
}
```

**Conventions:**

- Story ids (K1–K6) go in header comments.
- The state is embedded as `<script type="application/json" id="state">` with `<` escaped as `<`.
- A Content-Security-Policy meta tag (`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:`) enforces "no external requests".

## Views: what each shows

| View | Content | Data source in State v1 |
|---|---|---|
| Overview | **Health:** *on track* or *at risk*, with each reason listed: band alerts, blocked tasks, building while the spec is a draft, unsigned checkpoints. Done/total, ETA median with its fast–slow range, ETA drift over 7 days (±days), scope added, decisions waiting, current task. | list, forecast, forecastHistory, needsYou, alerts |
| Board | Columns: to do · waiting (on a dependency) · in progress · blocked · done. Each card shows id, title, open boxes, age in days if in progress, and the blocking question if blocked. Checkpoints sit between their tasks. A toggle groups cards by phase. Filters for phase and state. | list.tasks, dates, plan.openQuestions |
| Roadmap | The run timeline (the same rows `/progress timeline` prints, as styled HTML), the dependency tree with loops listed, and the critical path highlighted. | timeline(), graphLines(), criticalPath() |
| Flow | Burn-up with the forecast cone, cumulative flow, aging WIP (days in progress against the usual days per task), cycle time per done task, and ETA drift (the median and range as of each past day). Each chart is a Nivo chart with tooltips and a one-line text summary, which is what shows without JS. With too little history it shows "needs N days" instead. | snapshots, forecast, dates, forecastHistory |
| Spec | One section per spec file (`SPEC.md`, `SPEC-*.md`, `specs/*.md`) with a picker. Each shows approval and its date, the six areas with state and hint, boundaries in three columns, and open questions. | specs |

There is no "off track" state until a target date exists (see Q1).

## Testing Strategy

**Unit tests** go in `tests/dashboard.test.ts`, running under `claude plugin test`, with the fixtures in `tests/fixtures.ts`:

- Each view renders the expected ids, counts and dates for the fixture plan.
- The Overview figures equal the ones `renderJson` and `headline()` give for the same state.
- Empty states work: no spec, no task list, no history, all done, one task. Each renders a message and never throws.
- Escaping: a task titled `</script><script>alert(1)</script>` renders as text, and the embedded JSON contains no `</script`.
- No external requests: the page has no `http://` or `https://` in any `src`, `href` or `url(`, and carries the CSP meta tag.
- Determinism: the same state and `today` produce byte-identical HTML.
- Budget: a generated 60-task fixture with 90 days of history renders in under 200 ms. The page is under 250 KB without charts, and the chart bundle is under 600 KB (React 19 + Nivo measured 547 KB; limit raised from 450 KB on 2026-10-10).
- `forecastHistory` and each chart's data (the series it is handed) get their own unit tests. The page includes the bundle only when it has charts.

**Script check:** under Node in `scripts/test.sh` (the engine runs no code from strings), the inline script and the chart bundle both pass `node --check`.

**CLI:** `scripts/test.sh` gets cases for `--dashboard` on the sample projects: the file is written, the path and size are printed, and an empty project still gives a page.

**Manual browser check (Chrome DevTools MCP):** before marking done, check the following on this repo's own tasks and on a fixture project:

- Tabs, arrow-key navigation, hash links, the back button and the filters all work.
- There are no console errors and no network requests.
- Every chart draws, shows a tooltip on hover, and follows the light and dark theme.
- Light and dark themes both work.
- The page has no horizontal scroll at 360 px width.

## Boundaries

- **Always:**
  - Escape markdown-derived text.
  - Keep the page self-contained and working without JS: every view is rendered and stacked, and the script only adds tabs and filters.
  - Reuse core functions rather than re-deriving numbers.
  - Run `claude plugin test .` and `bash scripts/test.sh` before each commit.
  - Update the README command table and "What you get".
  - Bump the plugin version per release.
- **Ask first:**
  - Adding any dependency beyond the chart bundle's (Nivo, React, esbuild; dev only, in `packages/charts/`).
  - Changing `/progress report` or its output.
  - Writing anywhere other than the requested output file.
  - Changing State v1.
  - Adding a view not listed here.
  - Changing CI.
- **Never:**
  - External requests, CDNs, web fonts or analytics in the page: the chart bundle is inlined, never fetched.
  - Writing to `SPEC.md`, `tasks/*.md` or git from the dashboard: this module is read-only.
  - Per-person metrics or rankings.
  - Committing a generated dashboard to this repo.
  - Removing or skipping tests to get green.

## Success Criteria

- [ ] `/progress dashboard [view]` writes `tasks/progress-dashboard.html` and opens it on that view. Where it can't open a browser, it prints the path.
- [ ] `agent-skills-progress --dashboard [out]` writes the same page for the same state and `today`.
- [ ] The page has five views reached by tabs and by `#overview|board|roadmap|flow|spec`. Arrow keys move between tabs, and the back button restores the previous view and filters.
- [ ] Overview, Board, Roadmap, Flow and Spec show the content in the Views table, and their numbers match `/progress` and `--json` for the same project.
- [ ] With JS disabled, all five views are readable, stacked in order.
- [ ] No network requests while the page loads and is used, and a CSP meta tag is present.
- [ ] Empty and partial projects render with explanatory messages and no errors.
- [ ] Light and dark themes both work. The page has no horizontal scroll at 360 px. Tabs use `role="tablist"`, and every chart has a text alternative.
- [ ] The 60-task, 90-day fixture renders in under 200 ms. The page is under 250 KB without charts, and the chart bundle is under 600 KB (React 19 + Nivo measured 547 KB; limit raised from 450 KB on 2026-10-10).
- [ ] The Flow charts are Nivo charts with hover tooltips, drawn from the embedded state, and readable in light and dark.
- [ ] All tests pass, including the new dashboard, CLI and escaping tests. The README documents the command and the CLI flag.

## Open Questions

- Q1: Health has two states, *on track* and *at risk*, because there's no target date to judge *off track*. Should a target date come with `ceremonies` (sprint end) or `format-v2` (`target:` in the plan's front matter)?
- Q2: Where should the output go? `tasks/progress-dashboard.html` sits next to the report for consistency. Should `/progress format` also add both generated files to `.gitignore`?
- Q3: Should `/progress report` stay as it is (email-safe, no JS) or later become the dashboard's printable Overview? This spec keeps it unchanged.
