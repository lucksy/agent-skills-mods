import { describe, expect, test } from 'claude-code/testing'

import { DASHBOARD_SCRIPT, dashboardHtml } from '../packages/core/dashboard/page'
import { inline, plainInline } from '../packages/core/dashboard/html'
import { headline } from '../packages/core/report'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'
import { SPEC, TODO_T2_DONE, TODO_T3_DONE, TODO_NONE_DONE, TODO_TEMPLATE, gitOutput } from './fixtures'

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
