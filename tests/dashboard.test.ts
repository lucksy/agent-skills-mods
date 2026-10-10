import { describe, expect, test } from 'claude-code/testing'

import { DASHBOARD_SCRIPT, chartMount, chartsScript, dashboardHtml } from '../packages/core/dashboard/page'
import { CHARTS_JS } from '../packages/core/dashboard/charts-bundle'
import { inline, plainInline } from '../packages/core/dashboard/html'
import { headline } from '../packages/core/report'
import { health } from '../packages/core/health'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'
import { GOOD_SPEC, SPEC, TODO_T2_DONE, TODO_T3_DONE, TODO_NONE_DONE, TODO_TEMPLATE, gitOutput } from './fixtures'

// The dashboard (K1–K6): one self-contained page built from State v1.

const NOW = Date.parse('2026-10-09T10:00:00Z')
const io = (files: Record<string, string>, run?: ProjectIo['run']): ProjectIo => ({
  cwd: '/work/keys',
  now: NOW,
  read: async rel => files[rel] ?? null,
  list: async rel => Object.keys(files).filter(f => (rel ? f.startsWith(`${rel}/`) && !f.slice(rel.length + 1).includes('/') : !f.includes('/'))).map(f => f.split('/').pop()!),
  run,
})
const git = (copies: [string, string | null][]): ProjectIo['run'] => {
  const out = gitOutput(copies)
  return async (argv, opts) => ({ exitCode: 0, stdout: argv[1] === 'log' ? (argv.some(a => a.includes('%B')) ? '' : out.log) : out.answer(argv, opts?.stdin), stderr: '' })
}
const HISTORY = git([['2026-10-08', TODO_T3_DONE], ['2026-10-03', TODO_T2_DONE], ['2026-09-29', TODO_NONE_DONE]])
const project = () => buildState(io({ 'SPEC.md': SPEC, 'tasks/todo.md': TODO_T3_DONE }, HISTORY))

/** The text of an element, tags dropped and entities read back. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const section = (html: string, id: string) => html.match(new RegExp(`<section[^>]*id="view-${id}"[\\s\\S]*?</section>\\s*<!-- /view-${id} -->`))?.[0] ?? ''

describe('the dashboard page (K6)', () => {
  test('one self-contained page: no external requests, a CSP that forbids them, light and dark', async () => {
    const html = dashboardHtml(await project())
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">`)
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i)
    expect(html).not.toMatch(/url\(\s*['"]?\s*(?:https?:)?\/\//i)
    expect(html).toMatch(/@media \(prefers-color-scheme: ?dark\)/)
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">')
  })

  test('the state is embedded as JSON that cannot end its script block', async () => {
    const s = await project()
    const html = dashboardHtml(s)
    const block = html.match(/<script type="application\/json" id="asm-state">([\s\S]*?)<\/script>/)
    expect(block).not.toBeNull()
    expect(block![1]).not.toContain('<')
    expect(JSON.parse(block![1]!)).toEqual(JSON.parse(JSON.stringify(stateJson(s))))
  })

  test('markdown text is escaped everywhere, a hostile task title included', async () => {
    const hostile = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys', '## Task 2: </script><script>alert(1)</script> & "keys"')
    const html = dashboardHtml(await buildState(io({ 'tasks/todo.md': hostile })))
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;keys&quot;')
    expect(html.match(/<script\b/g)!.length).toBe(2)
  })

  test('the same state gives the same bytes', async () => {
    const s = await project()
    expect(dashboardHtml(s)).toBe(dashboardHtml(s))
  })

  // That the script parses is checked under Node in scripts/test.sh: the engine runs no code from strings.
  test('the script is small; without it every view is shown, with a link to each', async () => {
    expect(DASHBOARD_SCRIPT.length).toBeLessThan(4096)
    const html = dashboardHtml(await project())
    expect(html).toMatch(/<nav[^>]*aria-label="Views"[\s\S]*?role="tablist"/)
    expect(html).toMatch(/<a [^>]*role="tab"[^>]*href="#overview"[^>]*>Overview<\/a>/)
    expect(html).toMatch(/<section [^>]*id="view-overview"[^>]*role="tabpanel"/)
    // Panels are hidden by the script, never by the markup.
    expect(html).not.toMatch(/<section [^>]*\bhidden\b/)
  })

  test('the footer says where the history came from in one clean sentence, whichever surface wrote it', async () => {
    const s = await project()
    for (const history of ['history since 29 Sep: 3 days from git', 'History tracked from 10 Oct.']) {
      const foot = text(dashboardHtml({ ...s, history }).match(/<footer[\s\S]*?<\/footer>/)![0])
      expect(foot).toMatch(/markdown\. History (since 29 Sep: 3 days from git|tracked from 10 Oct)\. The data/)
    }
  })

  test('a link to one spec (#spec-<file>) opens the Spec view on it, and the picker says which is chosen', () => {
    // The script runs only in a browser (checked in Chrome); here, that it handles those addresses.
    expect(DASHBOARD_SCRIPT).toContain("id.startsWith('spec-')")
    expect(DASHBOARD_SCRIPT).toContain('aria-current')
  })

  test('it opens on the view asked for, else the Overview', async () => {
    const s = await project()
    expect(dashboardHtml(s, { view: 'overview' })).toContain('data-view="overview"')
    expect(dashboardHtml(s, { view: 'nope' as never })).toContain('data-view="overview"')
  })

  test('the header names the project, its stage and the day', async () => {
    const html = dashboardHtml(await project())
    expect(html).toContain('<title>API keys · dashboard</title>')
    const head = text(html.match(/<header[\s\S]*?<\/header>/)![0])
    expect(head).toContain('API keys')
    expect(head).toMatch(/♦ spec ✓ plan ● build 3\/4 ○ review ○ship|spec.*plan.*build 3\/4.*review.*ship/)
    expect(head).toContain('9 Oct 2026')
  })
})

describe('inline markdown in questions and boxes', () => {
  test('code, strong and emphasis become tags; everything else is escaped', () => {
    expect(inline('Use `pnpm test` for *on track* or **at risk** <b>')).toBe('Use <code>pnpm test</code> for <em>on track</em> or <strong>at risk</strong> &lt;b&gt;')
    expect(inline('2 * 3 * 4 and a_b_c stay as they are')).toBe('2 * 3 * 4 and a_b_c stay as they are')
    expect(inline('`<script>`')).toBe('<code>&lt;script&gt;</code>')
  })
  test('plain text drops the markers', () => {
    expect(plainInline('Health is *on track* or **at risk**, see `ceremonies`')).toBe('Health is on track or at risk, see ceremonies')
  })
})

describe('Overview (K1)', () => {
  test('the four figures are the ones the charts tab shows', async () => {
    const s = await project()
    const overview = text(section(dashboardHtml(s), 'overview'))
    for (const f of headline({ ...s })) {
      expect(overview).toContain(f.label)
      expect(overview).toContain(f.value)
      expect(overview).toContain(f.sub.slice(0, 40))
    }
  })

  test('tasks by state as a bar, each part named in words, not only in colour', async () => {
    const overview = section(dashboardHtml(await project()), 'overview')
    expect(overview).toMatch(/role="img" aria-label="3 done, 1 in progress, 0 blocked, 0 to do"/)
    expect(text(overview)).toMatch(/✓ 3 done .*● 1 in progress .*■ 0 blocked .*○ 0 to do/)
  })

  test('what needs you, each item from the state, and what is under way now', async () => {
    const s = await project()
    const overview = text(section(dashboardHtml(s), 'overview'))
    expect(s.needsYou.length).toBeGreaterThan(0)
    for (const n of s.needsYou) expect(overview).toContain(plainInline(n))
    expect(overview).toContain('T4 Rate limit per key')
    expect(overview).toContain('60 requests per minute by default')
  })

  test('the ETA says what it is based on', async () => {
    const s = await project()
    expect(s.forecast?.kind).toBe('range')
    expect(text(section(dashboardHtml(s), 'overview'))).toContain(s.forecast!.kind === 'range' ? s.forecast!.basis : '')
  })

  test('an empty folder gets a page that says how to start, not an error', async () => {
    const html = dashboardHtml(await buildState(io({})))
    const overview = text(section(html, 'overview'))
    expect(html).toContain('<title>Project · dashboard</title>')
    expect(overview).toContain('No task list yet')
    expect(overview).toContain('tasks/todo.md')
  })

  test('nothing waiting reads as good news', async () => {
    const done = TODO_T3_DONE.replace(/- \[ \]/g, '- [x]')
    const s = await buildState(io({ 'tasks/todo.md': done }))
    expect(s.needsYou).toEqual([])
    expect(text(section(dashboardHtml(s), 'overview'))).toContain('Nothing is waiting on you')
  })
})

describe('health (K1)', () => {
  const approved = SPEC.replace('status: draft', 'status: approved')
  const files = (todo: string, extra: Record<string, string> = {}) => ({ 'SPEC.md': approved, 'tasks/todo.md': todo, ...extra })

  test('on track when nothing below holds', async () => {
    const h = health(await buildState(io(files(TODO_T3_DONE), HISTORY)))
    expect(h).toEqual({ status: 'on track', reasons: [] })
  })

  test('at risk, with every reason: a band alert, a blocked task, a draft spec under way, an unsigned checkpoint', async () => {
    const long = `---\nplan: keys\ncreated: 2026-09-01\n---\n${TODO_T3_DONE.replace('## Task 4: Rate limit per key\n', '## Task 4: Rate limit per key\n**Status:** in progress · started 2026-09-10 · step build\n')}`
    expect(health(await buildState(io(files(long)))).reasons).toEqual([expect.stringMatching(/^T4 has run 29d, over twice the usual/)])

    const plan = '# Plan\n\n## Open Questions\n- Q1 (T4): Redis or in memory?\n'
    expect(health(await buildState(io(files(TODO_T3_DONE, { 'tasks/plan.md': plan })))).reasons).toEqual(['T4 is blocked: Q1 (T4): Redis or in memory?'])

    expect(health(await buildState(io({ 'SPEC.md': SPEC, 'tasks/todo.md': TODO_T3_DONE })))).toEqual({ status: 'at risk', reasons: ['Building while SPEC.md awaits approval'] })

    expect(health(await buildState(io(files(TODO_T2_DONE)))).reasons).toEqual(['Checkpoint after T2 is not signed off: After Tasks 1-2'])
  })

  test('a spec waiting before any work starts is not a risk yet', async () => {
    expect(health(await buildState(io({ 'SPEC.md': SPEC, 'tasks/todo.md': TODO_NONE_DONE }))).status).toBe('on track')
  })

  test('the Overview leads with it: a word and a glyph, then each reason', async () => {
    const risky = text(section(dashboardHtml(await buildState(io({ 'SPEC.md': SPEC, 'tasks/todo.md': TODO_T2_DONE }))), 'overview'))
    expect(risky).toMatch(/^\s*Overview ! At risk · 2 reasons Building while SPEC\.md awaits approval Checkpoint after T2 is not signed off: After Tasks 1-2/)
    const fine = text(section(dashboardHtml(await buildState(io(files(TODO_T3_DONE), HISTORY))), 'overview'))
    expect(fine).toMatch(/^\s*Overview ✓ On track Nothing is late, blocked or waiting on a sign-off\./)
  })

  test('the Forecast figure says how far the ETA moved', async () => {
    const forecastFig = (html: string) => text(html.match(/<div class="fig f-forecast"[\s\S]*?<\/div>/)![0])
    expect(forecastFig(dashboardHtml(await project()))).toMatch(/[+−]\d+ d since 8 Oct|no change since 8 Oct/)
    const once = await buildState(io({ 'tasks/todo.md': TODO_T3_DONE }))
    expect(forecastFig(dashboardHtml(once))).not.toMatch(/since/)
  })
})

describe('the chart bundle (K4)', () => {
  test('it is inlined only when the page has a chart to draw', async () => {
    expect(chartsScript('<p>no charts here</p>')).toBe('')
    expect(chartsScript(chartMount({ kind: 'line', data: [], colors: ['--done'] }, 'Tasks done: 3 of 4.'))).toBe(`<script>${CHARTS_JS}</script>`)
    // A project without two days of history has no chart: the page carries only its own two scripts.
    expect(dashboardHtml(await buildState(io({ 'tasks/todo.md': TODO_T3_DONE }))).match(/<script\b/g)!.length).toBe(2)
    // With history the Flow view draws, and the bundle comes along.
    expect(dashboardHtml(await project())).toContain(`<script>${CHARTS_JS}</script>`)
  })

  test('the bundle cannot end its script block, and is generated, not hand-written', () => {
    expect(CHARTS_JS.length).toBeGreaterThan(1000)
    expect(CHARTS_JS).not.toMatch(/<\/script/i)
    expect(CHARTS_JS).not.toContain('<!--')
  })

  test('a mount carries its spec as escaped JSON and its summary as text, for pages without JS', () => {
    const html = chartMount({ kind: 'line', data: [{ id: '</div>"x', data: [{ x: '1', y: 2 }] }], colors: ['--done'] }, 'Tasks done: 3 of 4 <ok>.')
    expect(html).toMatch(/^<div class="chart" data-chart="\{&quot;kind&quot;:&quot;line&quot;/)
    expect(html).toMatch(/<\/p><\/div>$/)
    expect(html).not.toContain('</div>"x')
    expect(html).toContain('&lt;/div&gt;\\&quot;x')
    expect(html).toContain('<p class="chart-text">Tasks done: 3 of 4 &lt;ok&gt;.</p>')
  })
})

describe('Board (K2)', () => {
  // T1 done; T2 under way since 7 Oct with a checkpoint after it; T3 waits on T2; T4 blocked by a question.
  const todo = TODO_TEMPLATE.replace('## Task 2: Prisma schema for keys\n', '## Task 2: Prisma schema for keys\n**Status:** in progress · started 2026-10-07 · step test\n')
  const plan = '# Plan\n\n## Open Questions\n- Q1 (T4): Redis or in memory?\n'
  const board = async () => section(dashboardHtml(await buildState(io({ 'tasks/todo.md': todo, 'tasks/plan.md': plan }))), 'board')
  /** The ids of the cards in a column of the flat board. */
  const column = (html: string, key: string) => {
    const col = html.match(new RegExp(`<section class="col" data-col="${key}"[\\s\\S]*?</section>`))![0]
    return [...col.matchAll(/data-task="(T\d+)"/g)].map(m => m[1])
  }

  test('a tab of its own, after the Overview, in the order of the spec', async () => {
    const html = dashboardHtml(await buildState(io({ 'tasks/todo.md': todo })))
    expect([...html.matchAll(/role="tab" id="tab-(\w+)"/g)].map(m => m[1])).toEqual(['overview', 'board', 'roadmap', 'flow', 'spec'])
    expect(dashboardHtml(await buildState(io({ 'tasks/todo.md': todo })), { view: 'board' })).toContain('data-view="board"')
  })

  test('five columns; each task once, in the column its state puts it', async () => {
    const html = (await board()).split('<div class="swim')[0]!
    expect([...html.matchAll(/data-col="(\w+)"/g)].map(m => m[1])).toEqual(['todo', 'waiting', 'doing', 'blocked', 'done'])
    expect([column(html, 'todo'), column(html, 'waiting'), column(html, 'doing'), column(html, 'blocked'), column(html, 'done')]).toEqual([[], ['T3'], ['T2'], ['T4'], ['T1']])
    expect(text(html)).toMatch(/To do 0 .*Waiting 1 .*In progress 1 .*Blocked 1 .*Done 1/)
  })

  test('each card says what a person needs to know about it', async () => {
    const t = text(await board())
    expect(t).toMatch(/T2 Prisma schema for keys .*2 of 3 open · started 7 Oct · 2 d · step test/)
    expect(t).toMatch(/T3 Issue and revoke keys .*waits on T2/)
    expect(t).toMatch(/T4 Rate limit per key .*Q1 \(T4\): Redis or in memory\?/)
    expect(t).toMatch(/T1 Monorepo scaffold .*all 3 done/)
  })

  test('the checkpoint shows right after the task it follows, with what is open', async () => {
    const html = await board()
    expect(html).toMatch(/data-task="T2"[\s\S]*?<\/li>\s*<li class="cp"[^>]*>[\s\S]*?After Tasks 1-2[\s\S]*?2 of 2 open/)
  })

  test('grouped by phase: a lane per phase, its tasks only', async () => {
    const swim = (await board()).split('<div class="swim')[1]!
    const lanes = [...swim.matchAll(/<section class="lane" data-phase="(\d+)"[\s\S]*?<h3[^>]*>([^<]+)<\/h3>([\s\S]*?)<\/section>\s*<!-- \/lane -->/g)]
    expect(lanes.map(l => [l[1], l[2], [...l[3]!.matchAll(/data-task="(T\d+)"/g)].map(m => m[1])])).toEqual([
      ['1', 'Phase 1: Foundation', ['T2', 'T1']],
      ['2', 'Phase 2: Core', ['T3', 'T4']],
    ])
  })

  test('filters for phase and state, and the grouping switch; without JS the plain board shows', async () => {
    const html = await board()
    expect(html).toMatch(/<select [^>]*id="board-phase"[\s\S]*?<option value="">All phases<\/option><option value="1">Phase 1: Foundation<\/option><option value="2">Phase 2: Core<\/option>/)
    expect(html).toMatch(/<select [^>]*id="board-state"[\s\S]*?<option value="blocked">Blocked<\/option>/)
    expect(html).toMatch(/<input type="checkbox" id="board-group"/)
    // The controls and the lanes need the script; the columns do not.
    expect(html).toMatch(/<div class="board-tools js-only"/)
    expect(html).toMatch(/<div class="swim js-only"/)
    expect(DASHBOARD_SCRIPT).toContain('board-phase')
  })

  test('an empty column says so, and a project without tasks gets one message', async () => {
    expect(text(await board())).toMatch(/To do 0 Nothing here/)
    expect(text(section(dashboardHtml(await buildState(io({}))), 'board'))).toContain('No task list yet')
  })
})
