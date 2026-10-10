---
plan: core-dashboard
created: 2026-10-10
---
# Tasks: core + dashboard

## Phase 1: Core

## Task 1: Spike: hooks module importing from ../packages/core
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** Find out whether the mods engine loads a hooks module that imports a file outside `hooks/` (SPEC-core Q1). Add `packages/core/spike.ts`, import it from `hooks/register.tsx`, check it loads, record the answer in tasks/plan.md under Q1, then remove the spike.

**Acceptance criteria:**
- [x] Q1 in tasks/plan.md records yes or no, with the evidence (validate output, a session log or the error)
- [x] The spike files are removed and the tree is back to clean

**Verification:**
- [x] `claude plugin validate .` with the spike in place
- [x] Manual check: `claude --plugin-dir .` session, `/progress` opens, no load error

**Dependencies:** None

**Files likely touched:**
- `packages/core/spike.ts` (temporary)
- `hooks/register.tsx` (temporary)
- `tasks/plan.md`

**Estimated scope:** XS

## Task 2: Move hooks/lib to packages/core with a purity guard
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** Run `git mv hooks/lib packages/core` and update the imports in the plugin, CLI and tests. Add a test that fails if any core file imports something other than a sibling module or a `node:` built-in, or uses the Claude Code API. If T1 said no, skip the move and add only the purity guard over `hooks/lib`. This is a mechanical move, so it touches more than 5 files.

**Acceptance criteria:**
- [x] `hooks/lib/` is gone, and nothing imports from it (`grep -r "hooks/lib"` finds only docs history)
- [x] The purity-guard test passes
- [x] README Development layout lists `packages/core/`

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Tests pass: `bash scripts/test.sh` and `bash statusline/test.sh`
- [x] Build succeeds: `claude plugin validate .`
- [x] Manual check: `claude --plugin-dir .`, `/progress` and `/spec-view` look as before on this repo

**Note:** the engine only lets plugin tests import relative files and `claude-code`, not `node:fs`. So the guard is `scripts/purity.mjs`, run by `bash scripts/test.sh`, rather than a plugin test.

**Dependencies:** T1

**Files likely touched:**
- `hooks/lib/*` → `packages/core/*`
- `hooks/register.tsx`, `hooks/ui/*.tsx`
- `scripts/agent-skills-progress.mjs`
- `tests/*.test.ts`, `tests/purity.test.ts`
- `README.md`

**Estimated scope:** M (mechanical, many files)

## Task 3: State v1: toState, buildState and --json
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** Add `packages/core/state.ts`, holding:
- the State v1 type: `schema: 1`, `today`, every spec file with its parsed spec, the list, the plan, the forecast, snapshots, dates, alerts, `needsYou`, the history note and commits;
- a pure `toState(parts)`;
- `buildState(io)`, which replaces `gather()` in `cli.ts`.

`renderJson` prints State v1 and keeps every field it printed before.

**Acceptance criteria:**
- [x] `buildState` on the fixtures returns `schema: 1` and the documented fields
- [x] `agent-skills-progress --json` keeps all fields printed before, adds the new ones, and parses back to the same object
- [x] `toState` called with the same parts the CLI used gives the same State (the plugin and CLI paths agree)

**Verification:**
- [x] Tests pass: `claude plugin test .` (new `tests/state.test.ts`)
- [x] Tests pass: `bash scripts/test.sh`

**Dependencies:** T2

**Files likely touched:**
- `packages/core/state.ts`
- `packages/core/cli.ts`
- `tests/state.test.ts`
- `scripts/test.sh`

**Estimated scope:** M

## Checkpoint: Core
- [x] All tests pass: `claude plugin test .`, `bash scripts/test.sh`, `bash statusline/test.sh`
- [x] The plugin loads with `claude --plugin-dir .` and behaves as before
- [x] Review with human before proceeding

## Phase 2: Dashboard path end to end

## Task 4: Dashboard page shell with Overview figures and the CLI --dashboard flag
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** Build `dashboardHtml(state, { view? })` in `packages/core/dashboard/page.ts`. It contains:
- a tablist for the five views, with only Overview filled in for now and the others showing "coming";
- CSS tokens for light and dark;
- the CSP meta tag;
- the embedded State JSON, with `<` escaped;
- the inline script for tabs and `#view` hash state.

The no-JS page shows every view stacked. The Overview shows done/total, the ETA range, scope added, the current task and the decisions waiting. Add `--dashboard [out]` to the CLI, defaulting to `tasks/progress-dashboard.html`. It prints the path and size.

**Acceptance criteria:**
- [x] `node scripts/agent-skills-progress.mjs --dashboard` writes the page; the Overview numbers equal those `--json` prints
- [x] A task titled `</script><script>alert(1)</script>` renders as text; the page has no `http(s)://` in `src`, `href` or `url(`, and carries the CSP meta tag
- [x] The same state and `today` give byte-identical HTML, and the inline script parses (`new Function`)

**Verification:**
- [x] Tests pass: `claude plugin test .` (new `tests/dashboard.test.ts`)
- [x] Tests pass: `bash scripts/test.sh` (new `--dashboard` cases, including an empty project)
- [x] Manual check: open the file in Chrome; tabs and `#overview` work; no console errors or network requests

**Dependencies:** T3

**Files likely touched:**
- `packages/core/dashboard/page.ts`
- `packages/core/dashboard/overview.ts`
- `scripts/agent-skills-progress.mjs`
- `tests/dashboard.test.ts`
- `scripts/test.sh`

**Estimated scope:** M

## Task 5: /progress dashboard [view] in the plugin
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** Add the `dashboard` subcommand to `/progress`, with an optional view argument. It builds State with `toState` from what `load($)` gives, writes `tasks/progress-dashboard.html`, and opens it at `#<view>` the way `writeReport` opens the report. Where no browser can be opened, it prints the path. Update the command's description, argument hint and unknown-argument message.

**Acceptance criteria:**
- [x] `/progress dashboard` writes the page and opens it; `/progress dashboard board` opens on `#board`; an unknown view gets a message listing the five
- [x] With no task list, it still writes a page with an explanatory Overview instead of failing
- [x] The page uses the plugin's own history, so its ETA matches the board pane

**Verification:**
- [x] Tests pass: `claude plugin test .` (`tests/mod.test.ts` cases for the subcommand)
- [x] Manual check: `claude --plugin-dir .` on this repo, then `/progress dashboard`, and the browser opens the page

**Dependencies:** T4

**Files likely touched:**
- `hooks/register.tsx`
- `tests/mod.test.ts`

**Estimated scope:** S

## Task 6: Overview health and ETA drift figure
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** Add `forecastHistory(snapshots)` to `forecast.ts`, which replays `forecast()` as of each past day. The Overview gets two additions:
- **Health:** *on track* or *at risk*, listing every reason: band alerts, blocked tasks, building while the spec is a draft, and checkpoints reached but not signed off.
- **ETA drift:** how the median moved over the last 7 days, in ±days.

**Acceptance criteria:**
- [x] `forecastHistory` gives one forecast per snapshot day, and its last entry equals `forecast()` for the whole history
- [x] Health is *at risk*, with the matching reasons, for fixtures with an alert, a blocked task, a draft spec plus tasks in progress, or an unsigned checkpoint; it is *on track* otherwise
- [x] ETA drift shows "+N d", "−N d" or "no change", or a "needs history" message when there's too little history

**Verification:**
- [x] Tests pass: `claude plugin test .`

**Dependencies:** T4

**Files likely touched:**
- `packages/core/forecast.ts`
- `packages/core/dashboard/overview.ts`
- `tests/dashboard.test.ts`
- `tests/parse.test.ts`

**Estimated scope:** S

## Task 14: Nivo chart bundle and its build
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** Set up `packages/charts/`:
- `package.json` with dev dependencies only: `react`, `react-dom`, `@nivo/core`, `@nivo/line`, `@nivo/bar`, `@nivo/scatterplot`, `esbuild`;
- `src/charts.tsx`, which mounts a chart into each `[data-chart]` element from the embedded State JSON, themed from the page's CSS tokens for light and dark;
- `build.mjs`, which bundles a minified IIFE and writes `packages/core/dashboard/charts-bundle.ts` (`@generated`, `export const CHARTS_JS`).

Start with one placeholder chart, the tasks-done line, to prove the whole path. First check that the mods engine loads the large generated module.

**Acceptance criteria:**
- [x] `npm --prefix packages/charts ci && npm --prefix packages/charts run build` writes `charts-bundle.ts`; the bundle is under 600 KB and passes `node --check`
- [x] The plugin loads with the generated module imported (`claude plugin validate .`, the tests, and a `claude -p --plugin-dir .` session); `scripts/purity.mjs` still passes
- [x] A page with a `data-chart` mount draws the placeholder chart in Chrome under the page's CSP, with no console errors and no requests

**Verification:**
- [x] Tests pass: `claude plugin test .` and `bash scripts/test.sh`
- [x] Build succeeds: `claude plugin validate .`
- [x] Manual check: the placeholder chart draws in light and dark

**Notes:**
- The bundle is 547 KB with React 19, since react-dom alone is 205 KB. On 2026-10-10 the user raised the limit from 450 to 600 KB rather than switch to React 18 (498 KB) or Preact (374 KB, which Nivo doesn't support).
- A session with the plugin loaded measured 11.48 s against 11.07 s before the bundle, over 4 pairs, which is within the noise.
- esbuild must not read the repository's tsconfig, whose JSX factory is the mods engine's `h`. `build.mjs` passes its own.
- A rebuild from the lockfile is byte-identical.
- T9 needs named tooltip and axis formats in the bundle, because JSON specs can't carry functions.

**Dependencies:** T4

**Files likely touched:**
- `packages/charts/package.json`, `packages/charts/package-lock.json`
- `packages/charts/src/charts.tsx`
- `packages/charts/build.mjs`
- `packages/core/dashboard/charts-bundle.ts` (generated)
- `scripts/test.sh`

**Estimated scope:** M

## Checkpoint: Dashboard path
- [x] All tests pass
- [x] The CLI and `/progress dashboard` produce a working page on this repo, checked in Chrome: tabs, hash, back button, light and dark, no network requests
- [x] Review with human before proceeding

## Phase 3: Views

## Task 7: Board view
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** `board.ts` draws five columns: to do, waiting, in progress, blocked and done. Each card shows:
- id and title;
- open boxes;
- age in days while in progress;
- the blocking question while blocked.

Checkpoint rows sit between their tasks. A toggle groups the board by phase. Phase and state filters are kept in the hash (`#board?phase=2&state=blocked`).

**Acceptance criteria:**
- [x] Each fixture task appears once, in the column matching its parsed status, with the right open-box count and age
- [x] A blocked card names its question; checkpoints appear after the task they follow
- [x] Filters and the phase toggle change what is shown and survive a reload and the back button

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Manual check: filters and the toggle work in Chrome; with JS off the full board is shown

**Dependencies:** T4

**Files likely touched:**
- `packages/core/dashboard/board.ts`
- `packages/core/dashboard/page.ts`
- `tests/dashboard.test.ts`

**Estimated scope:** S

## Task 8: Roadmap view
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** `roadmap.ts` draws three things:
- the run timeline as styled HTML, using the same rows as `/progress timeline` with each segment tone mapped to a CSS class;
- the dependency tree from `graphLines()`, with loops listed;
- the critical path from `criticalPath()`, highlighted.

**Acceptance criteria:**
- [x] The timeline rows' text equals `plain()` of the rows `/progress timeline` prints for the fixture
- [x] The dependency tree lists every task, and loops when the fixture has one
- [x] The critical path is shown as `T2 → T3 → T4` and its tasks are marked in the tree

**Verification:**
- [x] Tests pass: `claude plugin test .`

**Dependencies:** T4

**Files likely touched:**
- `packages/core/dashboard/roadmap.ts`
- `packages/core/dashboard/page.ts`
- `tests/dashboard.test.ts`

**Estimated scope:** S

## Task 9: Flow view: burn-up, cumulative flow, cycle time, aging WIP (Nivo)
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** `flow.ts` gives each chart a `<div data-chart="…">` mount point, a one-line text summary, and the series the chart is handed, built from State in TypeScript and so testable. The chart bundle from T14 draws:
- burn-up: `@nivo/line`, with scope, done, and the forecast band to the ETA;
- cumulative flow: `@nivo/line`, stacked areas for done, in progress, blocked and to do;
- cycle time: `@nivo/scatterplot`, days per done task, from `daysPerTask`;
- aging WIP: `@nivo/bar`, days in progress for each open task, against the usual days per task.

With too little history, a chart shows "needs N days" instead. Without JS, the summaries show.

**Acceptance criteria:**
- [x] For the fixture with history, each chart's series match the state (the same numbers as `/progress charts`), and each summary names its latest numbers
- [x] Aging WIP marks tasks running over twice the usual days, the same threshold as the band alert
- [x] Without enough history, each chart shows its "needs" message and the bundle is left out of the page

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Manual check in Chrome: all four charts draw, tooltips on hover, light and dark, no console errors or requests

**Notes:**
- Built by a workflow agent on branch `t9-flow-view`, reviewed independently, merged with fixes.
- Tooltips are words carried on each datum (`tip`). The bundle reads the named fields `format`, `dashed`, `cone` and `guides`.
- Checked in Chrome on a project with git history: all four charts draw, tooltips work, light and dark, no console messages.
- Review fixes:
  - `chartMount` moved to `html.ts`, which removed the copy kept to avoid an import cycle.
  - The legends use the page's state glyphs.
  - The custom line layer honours `lineWidth`.
  - An outdated script-count assertion was fixed.
- Not done: aging WIP leaves out a started task that is now blocked, as the band alert does. Cycle-time dots sit on the axis ends; see T12.

**Dependencies:** T4, T14

**Files likely touched:**
- `packages/charts/src/charts.tsx`
- `packages/core/dashboard/charts-bundle.ts` (regenerated)
- `packages/core/dashboard/flow.ts`
- `packages/core/dashboard/page.ts`
- `tests/dashboard.test.ts`

**Estimated scope:** M

## Task 10: Flow view: ETA drift chart (Nivo)
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** An ETA drift chart: for each past day from `forecastHistory`, the median ETA with its fast–slow range. It is drawn with `@nivo/line` plus a custom layer for the range band, and goes in the Flow view under the other charts.

**Acceptance criteria:**
- [x] One point and range for each day with a range forecast, with days without one left out
- [x] The text summary says how far the median moved since the first range forecast
- [x] Below 2 range forecasts it shows its "needs" message

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Manual check in Chrome: the chart draws, with a tooltip on hover

**Notes:**
- Dates go up the side as milliseconds on a linear scale. Nivo's time scale on y runs downward, which drew a slipping finish as a falling line. Ticks are whole days, evenly spaced, and the bundle's `day` format now labels numbers.
- The summary compares the first range forecast with today's: "moved N d later/sooner since <day>: from X to Y", or "has held at X since <day>".
- Checked in Chrome on a project with git history: the line climbs as the finish slips, the cone and tooltips work, no console messages.

**Dependencies:** T6, T9

**Files likely touched:**
- `packages/charts/src/charts.tsx`
- `packages/core/dashboard/charts-bundle.ts` (regenerated)
- `packages/core/dashboard/flow.ts`
- `tests/dashboard.test.ts`

**Estimated scope:** S

## Task 11: Spec view
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** `spec.ts` draws one section per spec file (`SPEC.md`, `SPEC-*.md`, `specs/*.md`), with a picker. Each section shows:
- approval and its date;
- the six areas with state and hint;
- boundaries in three columns;
- open questions.

**Acceptance criteria:**
- [x] Every spec file in State appears in the picker, and each section's area states and hints match the spec pane's `areaSummary`
- [x] Approval shows *approved* with its date, or *awaiting approval*
- [x] With no spec, the view says where one would go

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Manual check: on this repo the picker lists SPEC.md, SPEC-core.md and SPEC-dashboard.md

**Notes:**
- Built by a workflow agent on branch `t11-spec-view`, reviewed (ready), merged.
- The picker is in-page links plus CSS `:target`, so it works without JS. The page script now opens the Spec view for a `#spec-<file>` link and sets `aria-current` on the chosen spec.
- Success criteria show without checkboxes, because the parser drops `[ ]`/`[x]`.
- Boundaries and lists are split at commas by the shared spec parser, as in the spec pane. That needs a parser change, outside this task.

**Dependencies:** T4

**Files likely touched:**
- `packages/core/dashboard/spec.ts`
- `packages/core/dashboard/page.ts`
- `tests/dashboard.test.ts`

**Estimated scope:** S

## Checkpoint: Views
- [x] All tests pass
- [x] All five views render from the CLI and from `/progress dashboard` on this repo and on a fixture project
- [x] Review with human before proceeding

## Phase 4: Finish

## Task 12: Empty states, accessibility and the size and speed budget
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** Go through every view for an empty or partial project: no spec, no list, no history, all done, one task. Finish the keyboard tabs (`role="tablist"` and arrow keys), the chart text alternatives and the layout at 360 px. Add a generated fixture with 60 tasks and 90 days of history, and test the budget against it.

**Acceptance criteria:**
- [x] Each empty or partial fixture renders every view with a message and no exception
- [x] The 60-task, 90-day fixture renders in under 200 ms, and the page is under 250 KB
- [x] Tabs work with arrow keys, every chart has `role="img"` with a label, and the page has no horizontal scroll at 360 px

**Verification:**
- [x] Tests pass: `claude plugin test .`
- [x] Manual check: Chrome DevTools at 360 px, keyboard only, light and dark, no console errors

**Notes:**
- Every view renders words, never an empty panel, across seven project shapes: empty, spec only, list only, all done, one task, no tasks, two specs and no plan.
- The 60-task, 90-day plan renders well under 200 ms. The page is under 250 KB without the bundle.
- Each chart mount is `role="img"` with its summary as the label. Cycle time keeps a day of room either side.
- In the bundle, a chart narrower than 480 px gives its date axis three ticks (first, middle, last); at 360 px the burn-up's labels ran together. It redraws when its width crosses 480 px.
- Checked in Chrome at 360 px: no view scrolls the page sideways (Roadmap rows scroll inside their card); arrow keys, Home and End move between tabs; no console messages.

**Dependencies:** T7, T8, T10, T11

**Files likely touched:**
- `packages/core/dashboard/*.ts`
- `tests/dashboard.test.ts`
- `tests/fixtures.ts`

**Estimated scope:** M

## Task 13: README, version bump and a final browser check
**Status:** done · started 2026-10-10 · done 2026-10-10

**Description:** Document `/progress dashboard [view]` and `--dashboard [out]` in the README: the command table, "What you get", the CLI section and the layout. Bump the version to 0.37.0 in `.claude-plugin/plugin.json`. Do a final browser check on this repo.

**Acceptance criteria:**
- [x] The README documents both entry points and the five views
- [x] The version is 0.37.0
- [x] Every success-criteria box in SPEC-core.md and SPEC-dashboard.md is checked

**Verification:**
- [x] Tests pass: `claude plugin test .`, `bash scripts/test.sh`, `bash statusline/test.sh`
- [x] Build succeeds: `claude plugin validate .`
- [x] Manual check: `/progress dashboard` on this repo in Chrome, all views, no network requests

**Notes:**
- README: the dashboard in "What you get", `/progress dashboard [view]` in Commands, `--dashboard` in the CLI section, the new files in Layout, and the next modules in Roadmap.
- Version 0.37.0.
- Final checks in Chrome:
  - With scripts removed, all five views show stacked with their chart summaries, and the Board's controls stay hidden. They had been showing: their own `display:flex` overrode the hiding rule. Fixed and tested.
  - The committed files alone (git archive, no node_modules) load in a real session, and `/progress dashboard` works there.
- A real marketplace install from GitHub is checked after the push.

**Dependencies:** T5, T12

**Files likely touched:**
- `README.md`
- `.claude-plugin/plugin.json`
- `SPEC-core.md`, `SPEC-dashboard.md`

**Estimated scope:** S

## Checkpoint: Complete
- [x] All tests pass and `claude plugin validate .` is clean
- [ ] Every success criterion in SPEC-core.md and SPEC-dashboard.md is met (one left: the marketplace install, checked after the push)
- [x] Review with human before release
