import { describe, expect, test } from 'claude-code/testing'

import { DASHBOARD_SCRIPT, chartMount, chartsScript, dashboardHtml } from '../packages/core/dashboard/page'
import { CHARTS_JS } from '../packages/core/dashboard/charts-bundle'
import { inline, plainInline } from '../packages/core/dashboard/html'
import { headline } from '../packages/core/report'
import { health } from '../packages/core/health'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'
import { branchRows } from '../packages/core/branches'
import { collisions } from '../packages/core/collisions'
import { parseTasks } from '../packages/core/parse'
import { teamView } from '../packages/core/dashboard/team'
import { LIVE_SCRIPT, LIVE_STALE } from '../packages/core/dashboard/live'
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
    expect(html).toMatch(/^<div class="chart" role="img" aria-label="Tasks done: 3 of 4 &lt;ok&gt;\." data-chart="\{&quot;kind&quot;:&quot;line&quot;/)
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
    expect([...html.matchAll(/role="tab" id="tab-(\w+)"/g)].map(m => m[1])).toEqual(['overview', 'board', 'team', 'roadmap', 'flow', 'spec'])
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
    // Hidden until the script runs: the controls' own layout must not override that.
    const css = dashboardHtml(await buildState(io({ 'tasks/todo.md': todo }))).match(/<style>([\s\S]*?)<\/style>/)![1]!
    expect(css).not.toMatch(/(^|[}\n])\.board-tools\{[^}]*display:/)
    expect(css).toContain('.js .board-tools{display:flex}')
  })

  test('an empty column says so, and a project without tasks gets one message', async () => {
    expect(text(await board())).toMatch(/To do 0 Nothing here/)
    expect(text(section(dashboardHtml(await buildState(io({}))), 'board'))).toContain('No task list yet')
  })
})

describe('Board with a team (format-v2 T6)', () => {
  // T1 done by @amila; T2 in review (owner @amila, PR #42, reviewer @sara); T3 waiting, owned by @sara; T4 unowned.
  const own = (todo: string, id: string, title: string, line: string) => todo.replace(`## Task ${id}: ${title}\n`, `## Task ${id}: ${title}\n**Status:** ${line}\n`)
  const todo = own(own(own(TODO_TEMPLATE, '1', 'Monorepo scaffold', 'done · @amila · started 2026-09-29 · done 2026-10-01'), '2', 'Prisma schema for keys', 'in review · @amila · started 2026-10-07 · PR #42 · reviewer @sara'), '3', 'Issue and revoke keys', 'todo · @sara')
  const board = async (t = todo) => section(dashboardHtml(await buildState(io({ 'tasks/todo.md': t }))), 'board')
  const column = (html: string, key: string) => {
    const col = html.match(new RegExp(`<section class="col" data-col="${key}"[\\s\\S]*?</section>`))?.[0] ?? ''
    return [...col.matchAll(/data-task="(T\d+)"/g)].map(m => m[1])
  }

  test('an In review column between In progress and Blocked, only when a task is in review', async () => {
    const flat = (await board()).split('<div class="swim')[0]!
    expect([...flat.matchAll(/data-col="(\w+)"/g)].map(m => m[1])).toEqual(['todo', 'waiting', 'doing', 'review', 'blocked', 'done'])
    expect(column(flat, 'review')).toEqual(['T2'])
    expect(column(flat, 'doing')).toEqual([])
    const none = (await board(TODO_TEMPLATE)).split('<div class="swim')[0]!
    expect([...none.matchAll(/data-col="(\w+)"/g)].map(m => m[1])).not.toContain('review')
  })

  test('cards name their owner, and a card in review its PR and reviewer', async () => {
    const t = text(await board())
    expect(t).toMatch(/T2 Prisma schema for keys .*@amila · PR #42 · reviewer @sara/)
    expect(t).toMatch(/T3 Issue and revoke keys .*waits on T2 .*@sara/)
    expect(await board()).toMatch(/data-task="T3"[^>]*data-owner="sara"/)
    expect(await board()).toMatch(/data-task="T4"[^>]*data-owner=""/)
  })

  test('a person filter lists the owners; without owners there is none', async () => {
    const html = await board()
    expect(html).toMatch(/<select [^>]*id="board-owner"[\s\S]*?<option value="">Everyone<\/option><option value="amila">@amila<\/option><option value="sara">@sara<\/option><option value="-">No owner<\/option>/)
    expect(await board(TODO_TEMPLATE)).not.toContain('id="board-owner"')
    expect(DASHBOARD_SCRIPT).toContain('board-owner')
    expect(DASHBOARD_SCRIPT.length).toBeLessThan(4096)
  })
})

// team-view T2: an answered question leaves Needs you and shows as answered on the Overview.
describe('Overview decisions (team-view T2)', () => {
  test('answered questions show with the answer, who and when; open ones still need you', async () => {
    const plan = '# Plan\n\n## Open Questions\n\n- Q1 (T3): argon2 or bcrypt?\n  → A: argon2id · @amila 2026-10-08\n- Q2 (T4): Upstash or <self-hosted>?\n'
    const s = await buildState(io({ 'tasks/todo.md': TODO_TEMPLATE, 'tasks/plan.md': plan }))
    expect(s.needsYou).toEqual(['Q2 (T4): Upstash or <self-hosted>?'])
    const html = section(dashboardHtml(s), 'overview')
    expect(html).toMatch(/<h4>Answered <span class="n">1<\/span><\/h4>/)
    expect(text(html)).toContain('Q1 (T3): argon2 or bcrypt? → argon2id · @amila 8 Oct')
    expect(html).toContain('Upstash or &lt;self-hosted&gt;?')
    expect(stateJson(s).plan!.answered).toEqual([{ q: 'Q1', question: 'Q1 (T3): argon2 or bcrypt?', answer: { text: 'argon2id', by: '@amila', day: '2026-10-08' } }])
  })

  test('with nothing answered the Overview has no Answered list', async () => {
    const html = section(dashboardHtml(await buildState(io({ 'tasks/todo.md': TODO_TEMPLATE, 'tasks/plan.md': '# Plan\n\n## Open Questions\n\n- Q1: x?\n' }))), 'overview')
    expect(html).not.toContain('Answered')
  })
})

describe('Board across branches (team-view T5)', () => {
  // Here (main): T2 in progress by @amila since 7 Oct. On origin/feat/rate-limit: T2 in progress by @bob
  // since 8 Oct (a collision), T3 in progress by @bob, T4 in review by @sara. docs has no task list.
  const own = (todo: string, id: string, title: string, line: string) => todo.replace(`## Task ${id}: ${title}\n`, `## Task ${id}: ${title}\n**Status:** ${line}\n`)
  const here = own(TODO_TEMPLATE, '2', 'Prisma schema for keys', 'in progress · @amila · started 2026-10-07')
  const theirs = own(own(own(TODO_TEMPLATE, '2', 'Prisma schema for keys', 'in progress · @bob · started 2026-10-08'), '3', 'Issue and revoke keys', 'in progress · @bob · started 2026-10-08'), '4', 'Rate limit per key', 'in review · @sara · started 2026-10-05 · PR #7')
  const DAY = 86_400_000
  const ref = (name: string, sha: string, remote = false) => ({ ref: `refs/${remote ? 'remotes' : 'heads'}/${name}`, name, sha, ms: NOW - DAY, remote })
  const state = async (fetchedAt: number | null = NOW - DAY) => {
    const s = await buildState(io({ 'tasks/todo.md': here }))
    const b = branchRows({ name: 'main', list: parseTasks(here) }, [{ ref: ref('origin/feat/rate-limit', 'a1', true), text: theirs }, { ref: ref('docs', 'b2'), text: null }], fetchedAt)
    return { ...s, branches: b, collisions: collisions(b, NOW) }
  }
  const board = async (fetchedAt?: number | null) => section(dashboardHtml(await state(fetchedAt)), 'board')
  /** The all-branches board, and the ids of the cards in one of its columns. */
  const across = (html: string) => html.match(/<div class="across js-only"[\s\S]*?<!-- \/across -->/)?.[0] ?? ''
  const column = (html: string, key: string) => {
    const col = html.match(new RegExp(`<section class="col" data-col="${key}"[\\s\\S]*?</section>`))?.[0] ?? ''
    return [...col.matchAll(/data-task="(T\d+)"/g)].map(m => m[1])
  }
  const card = (html: string, id: string) => html.match(new RegExp(`<li class="card[^"]*" data-task="${id}"[\\s\\S]*?</li>`))?.[0] ?? ''

  test('a This branch | All branches switch, only when the branches were read', async () => {
    expect(await board()).toMatch(/<label>Branches <select id="board-branches"><option value="">This branch<\/option><option value="all">All branches<\/option><\/select><\/label>/)
    const plain = section(dashboardHtml(await buildState(io({ 'tasks/todo.md': here }))), 'board')
    expect(plain).not.toContain('board-branches')
    expect(plain).not.toContain('class="across')
    expect(DASHBOARD_SCRIPT).toContain('board-branches')
  })

  test('?branches=all changes the columns to the furthest states, and each card names its ref', async () => {
    const all = across(await board())
    expect([...all.matchAll(/data-col="(\w+)"/g)].map(m => m[1])).toEqual(['todo', 'waiting', 'doing', 'review', 'blocked', 'done'])
    expect([column(all, 'doing'), column(all, 'review'), column(all, 'done'), column(all, 'todo'), column(all, 'waiting')]).toEqual([['T2', 'T3'], ['T4'], ['T1'], [], []])
    expect(text(card(all, 'T3'))).toMatch(/T3 Issue and revoke keys .*on origin\/feat\/rate-limit .*@bob/)
    expect(text(card(all, 'T4'))).toMatch(/T4 Rate limit per key .*on origin\/feat\/rate-limit .*@sara/)
    expect(text(card(all, 'T2'))).toMatch(/on main .*@amila/)
    expect(card(all, 'T3')).toMatch(/data-owner="bob"/)
    // This branch's columns stay as they were: T3 still waits on T2 here.
    const flat = (await board()).split('<div class="swim')[0]!
    expect(column(flat, 'waiting')).toEqual(['T3'])
  })

  test('the fetch age shows above the columns, or that this clone never fetched', async () => {
    expect(text(across(await board()))).toMatch(/^ ?Each task at its furthest state on main and 1 other branch · last fetched 8 Oct \(1 d ago\)/)
    expect(text(across(await board(null)))).toContain('never fetched: remote branches are as of the last fetch')
  })

  test('colliding cards are marked, the mark has a text equivalent, and the collision line shows', async () => {
    const html = await board()
    for (const c of [card(across(html), 'T2'), card(html, 'T2')]) {
      expect(c).toMatch(/<li class="card c-doing clash"/)
      expect(c).toContain('<span class="c-flag" role="img" aria-label="Collision">!</span>')
      expect(text(c)).toContain('T2 is also in progress on origin/feat/rate-limit by @bob (1d)')
    }
    expect(card(across(html), 'T3')).not.toContain('c-flag')
  })

  test('without JS the page shows this branch only', async () => {
    const html = await board()
    expect(html).toContain('<div class="across js-only"')
    const css = dashboardHtml(await state()).match(/<style>([\s\S]*?)<\/style>/)![1]!
    expect(css).toContain('.js .across.js-only{display:none}')
    expect(css).toContain('.js.allb .across.js-only{display:block}')
  })

  test('the person filter still works with the switch: one hash keeps both', async () => {
    const html = await board()
    expect(html).toMatch(/id="board-owner"[\s\S]*?<option value="bob">@bob<\/option>/)
    expect(DASHBOARD_SCRIPT).toMatch(/q\.set\('branches'/)
    expect(DASHBOARD_SCRIPT).toMatch(/q\.set\('owner'/)
    expect(DASHBOARD_SCRIPT.length).toBeLessThan(4096)
  })
})

describe('Team (team-view T6)', () => {
  // tasks/team.md lists @sara, @zed, @amila and @pm, out of order; approvals need product and eng.
  // Here (main): T1 done by @amila; T2 in progress by @amila since 7 Oct, step test; T3 in review by @sara
  // since 5 Oct, PR #42, reviewer @amila; T4 handed from @sara to @pm. On origin/feat/rate-limit, @bob
  // (not in team.md) also has T2 in progress: a collision. Q1 asks @pm about T4; Q2 names nobody.
  const TEAM = `---\napprovals: product, eng\n---\n# Team\n\n| Handle | Role | Email |\n|---|---|---|\n| @sara | eng, design | sara@example.com |\n| @zed | qa | zed@example.com |\n| @amila | eng | amila@example.com |\n| @pm | product | pm@example.com |\n`
  const own = (todo: string, id: string, title: string, line: string) => todo.replace(`## Task ${id}: ${title}\n`, `## Task ${id}: ${title}\n**Status:** ${line}\n`)
  const here = own(
    own(
      own(own(TODO_TEMPLATE, '1', 'Monorepo scaffold', 'done · @amila · started 2026-09-29 · done 2026-10-01'), '2', 'Prisma schema for keys', 'in progress · @amila · started 2026-10-07 · step test'),
      '3',
      'Issue and revoke keys',
      'in review · @sara · started 2026-10-05 · PR #42 · reviewer @amila',
    ),
    '4',
    'Rate limit per key',
    'todo · @pm\n**Handoff:** 2026-10-08 @sara → @pm: limits agreed, tests left',
  )
  const theirs = own(TODO_TEMPLATE, '2', 'Prisma schema for keys', 'in progress · @bob · started 2026-10-08')
  const plan = '# Plan\n\n## Open Questions\n- Q1 (T4): @pm, Upstash or self-hosted?\n- Q2: Which region first?\n'
  const DAY = 86_400_000
  const ref = (name: string, sha: string, remote = false) => ({ ref: `refs/${remote ? 'remotes' : 'heads'}/${name}`, name, sha, ms: NOW - DAY, remote })
  const state = async (files: Record<string, string> = { 'SPEC.md': SPEC, 'tasks/todo.md': here, 'tasks/plan.md': plan, 'tasks/team.md': TEAM }) => {
    const s = await buildState(io(files))
    const b = branchRows({ name: 'main', list: parseTasks(files['tasks/todo.md']!) }, [{ ref: ref('origin/feat/rate-limit', 'a1', true), text: theirs }], NOW - DAY)
    return { ...s, branches: b, collisions: collisions(b, NOW) }
  }
  const tab = async (files?: Record<string, string>) => section(dashboardHtml(await state(files)), 'team')
  const person = (html: string, key: string) => html.match(new RegExp(`<li class="person[^"]*" data-person="${key}"[\\s\\S]*?</li>\\s*<!-- /person -->`))?.[0] ?? ''

  test('a Team tab after the Board, and /progress dashboard team opens on it', async () => {
    const html = dashboardHtml(await state(), { view: 'team' })
    expect([...html.matchAll(/role="tab" id="tab-(\w+)"/g)].map(m => m[1])).toEqual(['overview', 'board', 'team', 'roadmap', 'flow', 'spec'])
    expect(html).toContain('data-view="team"')
  })

  test('one row per team member, plus anyone else who owns a task, plus unowned; sorted by handle, never by a figure', async () => {
    const html = await tab()
    expect([...html.matchAll(/data-person="([^"]*)"/g)].map(m => m[1])).toEqual(['amila', 'bob', 'pm', 'sara', 'zed', '-'])
    expect(teamView(await state()).people.map(p => p.handle)).toEqual(['@amila', '@bob', '@pm', '@sara', '@zed', null])
    expect(text(person(html, 'bob'))).toContain('not in tasks/team.md')
    expect(text(person(html, 'sara'))).toContain('eng, design')
    expect(text(person(html, '-'))).toMatch(/Unowned/)
  })

  test("each row: the current task and step, WIP, reviews waiting with ages, handoffs and collisions", async () => {
    const amila = text(person(await tab(), 'amila'))
    expect(amila).toMatch(/Now T2 Prisma schema for keys · step test/)
    expect(amila).toMatch(/Work in progress 1 · T2 Reviews/)
    expect(amila).toMatch(/Reviews waiting T3 Issue and revoke keys · PR #42 · 4 d/)
    expect(amila).toContain('T2 is also in progress on origin/feat/rate-limit by @bob (1d)')
    const pm = text(person(await tab(), 'pm'))
    expect(pm).toMatch(/Handoffs T4 Rate limit per key · from @sara 8 Oct: limits agreed, tests left/)
    const bob = text(person(await tab(), 'bob'))
    expect(bob).toMatch(/Now T2 Prisma schema for keys on origin\/feat\/rate-limit/)
    expect(bob).toContain('T2 is also in progress on origin/feat/rate-limit by @bob (1d)')
    const zed = text(person(await tab(), 'zed'))
    expect(zed).toMatch(/Now nothing in progress/)
    expect(zed).toMatch(/Work in progress 0 Reviews/)
  })

  test('no ranking, speed or totals per person: nothing done is counted', async () => {
    const amila = person(await tab(), 'amila')
    expect(amila).not.toContain('T1')
    expect(text(await tab())).not.toMatch(/\bdone\b|per day|velocity|rank/i)
  })

  test('the review queue shows each PR with its age; handoffs and collisions link to their tasks', async () => {
    const html = await tab()
    const queue = html.match(/<div class="card queue"[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(text(queue)).toMatch(/Review queue T3 Issue and revoke keys · PR #42 · @sara → reviewer @amila · 4 d/)
    expect(text(queue)).toContain('Age counts from the day the task started')
    expect(queue).toContain('<a href="#card-T3">T3</a>')
    expect(person(html, 'pm')).toContain('<a href="#card-T4">T4</a>')
    expect(person(html, 'amila')).toMatch(/<p class="p-clash"><a href="#card-T2">/)
  })

  test("the Board's cards are the link targets: one id each, on this branch's columns only", async () => {
    const board = section(dashboardHtml(await state()), 'board')
    expect(board.match(/id="card-T2"/g)).toHaveLength(1)
    expect(board.split('<div class="swim')[0]).toContain('id="card-T2"')
    expect(DASHBOARD_SCRIPT).toContain("'card-'")
    expect(DASHBOARD_SCRIPT.length).toBeLessThan(4096)
  })

  test('waiting on someone: open questions by the person they name, unsigned approvals by who holds the role', async () => {
    const view = teamView(await state())
    expect(view.waiting.map(w => [w.who, w.items.map(i => i.text)])).toEqual([
      ['@amila', ['sign SPEC.md as eng']],
      ['@pm', ['Q1 (T4): @pm, Upstash or self-hosted?', 'sign SPEC.md as product']],
      ['@sara', ['sign SPEC.md as eng']],
      // SPEC.md's own open question names nobody either.
      [null, ['Q2: Which region first?', 'Should keys expire by default?']],
    ])
    const t = text((await tab()).match(/<div class="card waiting"[\s\S]*?<!-- \/waiting -->/)?.[0] ?? '')
    expect(t).toMatch(/Waiting on someone @amila sign SPEC\.md as eng/)
    expect(t).toMatch(/Q1 \(T4\): @pm, Upstash or self-hosted\? · holds up T4/)
    expect(t).toMatch(/Not addressed to anyone Q2: Which region first\?/)
  })

  test('without tasks/team.md: the owners found in the task list, and how to set up the team', async () => {
    const html = await tab({ 'tasks/todo.md': here, 'tasks/plan.md': plan })
    expect([...html.matchAll(/data-person="([^"]*)"/g)].map(m => m[1])).toEqual(['amila', 'bob', 'pm', 'sara', '-'])
    expect(text(html)).toContain('No tasks/team.md yet: these are the people named in the task list. /progress team init drafts one from the git authors.')
    expect(html).not.toContain('not in tasks/team.md')
  })

  test('a project with nobody named still gets a tab that says how to start', async () => {
    const t = text(section(dashboardHtml(await buildState(io({ 'tasks/todo.md': TODO_TEMPLATE }))), 'team'))
    expect(t).toContain('/progress team init')
    expect(t).toMatch(/Unowned/)
  })
})

describe('write buttons on the live dashboard (team-view T11)', () => {
  // T1 done; T2 in progress (a box ticked); T3 waits on T2; T4 to do. Q1 open in the plan; the spec a draft.
  const plan = '# Plan\n\n## Open Questions\n\n- Q1 (T4): Redis or in memory?\n'
  const files = { 'SPEC.md': SPEC, 'tasks/todo.md': TODO_TEMPLATE, 'tasks/plan.md': plan }
  const REV = '0123456789abcdef'
  const live = async (over: Record<string, string> = {}) => dashboardHtml(await buildState(io({ ...files, ...over })), { live: { rev: REV } })
  /** A card on this branch's plain columns, up to the line that closes it (its boxes are a list of their own). */
  const card = (html: string, id: string) => html.match(new RegExp(`<li class="card[^"]*" data-task="${id}"[^>]*id="card-${id}"[\\s\\S]*?\\n</li>`))?.[0] ?? ''
  /** What a screen reader reads of some markup: aria-hidden glyphs dropped. */
  const spoken = (html: string) => text(html.replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, '')).trim()
  /** Each button: its action, its args, what it shows and what it is called. */
  const buttons = (html: string) =>
    [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(m => ({
      attrs: m[1]!,
      act: /data-act="(\w+)"/.exec(m[1]!)?.[1] ?? null,
      args: /data-args="([^"]*)"/.exec(m[1]!) ? JSON.parse(/data-args="([^"]*)"/.exec(m[1]!)![1]!.replace(/&quot;/g, '"')) : null,
      label: spoken(m[2]!),
      name: /aria-label="([^"]*)"/.exec(m[1]!)?.[1] ?? spoken(m[2]!),
    }))

  test('the static page has no buttons, no live script and no rev: byte for byte the page without `live`', async () => {
    const s = await buildState(io(files))
    const html = dashboardHtml(s)
    expect(dashboardHtml(s, { live: undefined })).toBe(html)
    for (const mark of ['<button', 'data-act=', 'data-rev=', 'live-msg', 'EventSource', 'connect-src', '.act{']) expect(html).not.toContain(mark)
    expect([...html.matchAll(/<script>/g)].length).toBe(1)
  })

  test('the live page: a CSP that lets it call its own server only, the rev on the body, one small script of its own', async () => {
    const html = await live()
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'"`)
    expect(html).toContain(`<body data-view="overview" data-rev="${REV}">`)
    expect(html).toContain(`<script>${LIVE_SCRIPT}</script>`)
    // Under 4 KB; scripts/test.sh checks that it parses (node --check).
    expect(new TextEncoder().encode(LIVE_SCRIPT).length).toBeLessThan(4096)
    // It never blocks on the browser's own dialogs; it sends the token and the rev, and reloads on `changed`.
    expect(LIVE_SCRIPT).not.toMatch(/\b(?:prompt|alert|confirm)\(/)
    for (const bit of ["'x-agent-skills-token': tok", 'rev: b.dataset.rev', "addEventListener('changed'", 'r.status === 409', JSON.stringify(LIVE_STALE)]) expect(LIVE_SCRIPT).toContain(bit)
  })

  test('replies are said in one polite live region', async () => {
    const html = await live()
    expect(html.match(/<div id="live-msg" class="live-msg" role="status" aria-live="polite"><\/div>/g)?.length).toBe(1)
  })

  test('Board cards: what can happen next, each button naming its task and carrying its args', async () => {
    const html = section(await live(), 'board')
    const of = (id: string) => buttons(card(html, id)).filter(b => b.act && b.act !== 'tick' || b.attrs.includes('data-open'))
    const say = (id: string) => of(id).map(b => b.name)
    expect(say('T1')).toEqual([])
    expect(say('T2')).toEqual(['Done T2', 'Review T2', 'Claim T2', 'Hand off T2', 'Block T2'])
    expect(say('T3')).toEqual(['Start T3', 'Claim T3', 'Assign T3', 'Block T3'])
    expect(of('T2').filter(b => b.act).map(b => [b.act, b.args])).toEqual([['done', { id: 'T2' }], ['review', { id: 'T2' }], ['claim', { id: 'T2' }]])
    // Each accessible name starts with what the button shows.
    for (const b of buttons(html)) expect(b.name.startsWith(b.label.replace(/…$/, '').split(' ')[0]!) || b.attrs.includes('aria-pressed')).toBe(true)
  })

  test('a text an action needs is asked in an inline form, labelled, closed until its button opens it', async () => {
    const t2 = card(section(await live(), 'board'), 'T2')
    const form = t2.match(/<form class="act-form" id="([^"]+)" hidden data-act="handoff"[\s\S]*?<\/form>/)!
    expect(t2).toContain(`aria-expanded="false" aria-controls="${form[1]}"`)
    expect(form[0]).toContain('data-args="{&quot;id&quot;:&quot;T2&quot;}"')
    expect(text(form[0])).toContain('To')
    expect(form[0]).toMatch(/<label>To <input name="to" required/)
    expect(form[0]).toMatch(/<label>What the next person needs to know <input name="note" required/)
    expect(buttons(form[0]).map(b => b.label)).toEqual(['Hand off T2', 'Cancel'])
    expect(t2).toMatch(/<label>Why is T2 blocked\? <input name="why" required/)
  })

  test('form ids are unique, though a card shows in the columns and in its lane', async () => {
    const html = section(await live({ 'tasks/todo.md': TODO_TEMPLATE }), 'board')
    const ids = [...html.matchAll(/ id="(f-[^"]+)"/g)].map(m => m[1])
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(html).toContain(`aria-controls="${id}"`)
  })

  test('criteria boxes toggle: pressed when ticked, named by the task; on the Board and in the Overview\'s Now', async () => {
    const html = await live()
    const ticks = buttons(card(section(html, 'board'), 'T2')).filter(b => b.act === 'tick')
    expect(ticks.map(b => [b.args, b.attrs.includes('aria-pressed="true"'), b.label])).toEqual([
      [{ id: 'T2', index: 0 }, true, 'T2: Key table with hashed secret'],
      [{ id: 'T2', index: 1 }, false, 'T2: Migration runs on a clean database'],
      [{ id: 'T2', index: 2 }, false, 'T2: Tests pass: pnpm test keys'],
    ])
    expect(buttons(section(html, 'overview')).filter(b => b.act === 'tick').map(b => b.args)).toEqual([0, 1, 2].map(index => ({ id: 'T2', index })))
  })

  test('Overview decisions: Answer for a question, Sign for the spec, Sign off for the checkpoint that is due', async () => {
    const html = section(await live({ 'tasks/todo.md': TODO_T2_DONE }), 'overview')
    const acts = buttons(html).filter(b => b.act && b.act !== 'tick' || b.attrs.includes('data-open'))
    expect(acts.map(b => b.name)).toEqual(['Sign off checkpoint 1, after T2', 'Answer Q1', 'Sign SPEC.md'])
    expect(acts.filter(b => b.act).map(b => [b.act, b.args])).toEqual([['signoff', {}], ['sign', { spec: 'SPEC.md' }]])
    expect(html).toMatch(/<form class="act-form" id="[^"]+" hidden data-act="answer" data-args="\{&quot;q&quot;:&quot;Q1&quot;\}"[^>]*><label>Your answer to Q1 <input name="text" required/)
  })

  test('the Board\'s due checkpoint has Sign off; the Spec tab signs a spec awaiting approval, not an approved one', async () => {
    const html = await live({ 'tasks/todo.md': TODO_T2_DONE })
    expect(section(html, 'board')).toContain('aria-label="Sign off checkpoint After Tasks 1-2"')
    expect(buttons(section(html, 'spec')).map(b => [b.name, b.args])).toEqual([['Sign SPEC.md', { spec: 'SPEC.md' }]])
    const approved = await live({ 'SPEC.md': GOOD_SPEC })
    expect(buttons(section(approved, 'spec'))).toEqual([])
  })

  test('the all-branches cards and the Team tab have no buttons: they show, the board\'s own cards act', async () => {
    const html = await live()
    expect(section(html, 'team')).not.toContain('<button')
    expect((html.match(/<div class="across js-only"[\s\S]*?<!-- \/across -->/)?.[0] ?? '')).not.toContain('<button')
  })

  test('every button is a real button with a type, and its name names what it acts on', async () => {
    const html = await live({ 'tasks/todo.md': TODO_T2_DONE })
    const all = buttons(html)
    expect(all.length).toBeGreaterThan(10)
    for (const b of all) {
      expect(b.attrs).toMatch(/type="(?:button|submit)"/)
      if (b.label !== 'Cancel') expect(b.name).toMatch(/T\d|Q\d|SPEC|checkpoint/)
    }
  })
})

