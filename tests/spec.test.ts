import { describe, expect, test } from 'claude-code/testing'

import { dashboardHtml } from '../packages/core/dashboard/page'
import { SPEC_STYLE, specHtml } from '../packages/core/dashboard/spec'
import { buildState, type ProjectIo } from '../packages/core/state'
import { areaSummary, specApproval } from '../packages/core/view'
import { GOOD_SPEC, SPEC, TODO_T3_DONE, WEAK_SPEC } from './fixtures'

// The Spec view (K5): is the spec ready? One section per spec file, a picker between them.

const NOW = Date.parse('2026-10-09T10:00:00Z')
const io = (files: Record<string, string>, run?: ProjectIo['run']): ProjectIo => ({
  cwd: '/work/keys',
  now: NOW,
  read: async rel => files[rel] ?? null,
  list: async rel => Object.keys(files).filter(f => (rel ? f.startsWith(`${rel}/`) && !f.slice(rel.length + 1).includes('/') : !f.includes('/'))).map(f => f.split('/').pop()!),
  run,
})
/** The text of an element, tags dropped and entities read back. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const section = (html: string, id: string) => html.match(new RegExp(`<section[^>]*id="view-${id}"[\\s\\S]*?</section>\\s*<!-- /view-${id} -->`))?.[0] ?? ''
/** One spec file's article in the view. */
const article = (html: string, file: string) => html.match(new RegExp(`<article class="spec"[^>]*data-file="${file.replace(/[.]/g, '\\.')}"[\\s\\S]*?</article>`))?.[0] ?? ''

const APPROVED = `---\nstatus: approved\ncreated: 2026-10-01\napproved: 2026-10-05\n---\n${GOOD_SPEC}`
const MANY = { 'SPEC.md': SPEC, 'SPEC-core.md': APPROVED, 'SPEC-dashboard.md': WEAK_SPEC, 'specs/billing.md': GOOD_SPEC }

describe('Spec view (K5)', () => {
  test('every spec file has its own section, in the order State gives, and a picker that links to each', async () => {
    const s = await buildState(io(MANY))
    expect(s.specFiles.length).toBe(4)
    const html = specHtml(s)
    expect([...html.matchAll(/<article class="spec"[^>]*data-file="([^"]+)"/g)].map(m => m[1])).toEqual(s.specFiles)
    const picker = html.match(/<nav class="spec-pick"[^>]*aria-label="Spec files"[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(picker).not.toBe('')
    const links = [...picker.matchAll(/<a href="#(spec-[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    // And one link back to all of them, which the page's script reads as the Spec view.
    expect(picker).toContain('<a class="pk-all" href="#spec">')
    expect(links.map(l => text(l[2]!).trim().split(' ')[0])).toEqual(s.specFiles)
    // Each link lands on its section.
    for (const [, id] of links) expect(html).toContain(`<article class="spec" id="${id}"`)
    // The ids are the page's own: they never name a view.
    for (const [, id] of links) expect(['overview', 'board', 'roadmap', 'flow', 'spec']).not.toContain(id)
  })

  test('the picker needs no script: CSS shows the chosen spec alone, and all of them without a choice', async () => {
    expect(SPEC_STYLE).toMatch(/:target/)
    expect(SPEC_STYLE).toMatch(/:has\(/)
    const html = dashboardHtml(await buildState(io(MANY)))
    // Still only the page's own two scripts.
    expect(html.match(/<script\b/g)!.length).toBe(2)
  })

  test('a single spec gets no picker', async () => {
    const html = specHtml(await buildState(io({ 'SPEC.md': SPEC })))
    expect(html).not.toContain('spec-pick')
    expect(html.match(/<article class="spec"/g)!.length).toBe(1)
  })

  test('the file name and title head each section', async () => {
    const html = specHtml(await buildState(io(MANY)))
    expect(text(article(html, 'SPEC.md'))).toMatch(/^\s*SPEC\.md API keys/)
    expect(text(article(html, 'SPEC-core.md'))).toMatch(/^\s*SPEC-core\.md Rate limits/)
    expect(text(article(html, 'specs/billing.md'))).toMatch(/^\s*specs\/billing\.md Rate limits/)
  })

  test('approval: approved with its date, or awaiting approval, each with a glyph and words', async () => {
    const html = specHtml(await buildState(io(MANY)))
    const core = article(html, 'SPEC-core.md')
    expect(core).toMatch(/class="appr a-approved"/)
    expect(text(core)).toContain('✓ Approved 5 Oct 2026')
    expect(text(core)).toContain('Written 1 Oct 2026')
    const draft = article(html, 'SPEC.md')
    expect(draft).toMatch(/class="appr a-awaiting"/)
    expect(text(draft)).toContain('♦ Awaiting approval')
    expect(text(draft)).not.toContain('Written')
  })

  test('a spec without front matter counts as approved once a plan exists, as the spec pane says', async () => {
    const s = await buildState(io({ 'SPEC.md': GOOD_SPEC, 'tasks/todo.md': TODO_T3_DONE }))
    expect(specApproval(s.spec, true)).toBe('approved')
    const t = text(article(specHtml(s), 'SPEC.md'))
    expect(t).toContain('✓ Approved')
    expect(t).toContain('a plan exists')
    const alone = text(article(specHtml(await buildState(io({ 'SPEC.md': GOOD_SPEC }))), 'SPEC.md'))
    expect(alone).toContain('♦ Awaiting approval')
  })

  test('the six areas, each with the state and hint the spec pane shows', async () => {
    const s = await buildState(io(MANY))
    const html = specHtml(s)
    for (const { file, spec } of s.specs) {
      const a = article(html, file)
      const rows = [...a.matchAll(/<li class="area ar-(\w+)" data-area="(\w+)">([\s\S]*?)<\/li>/g)]
      expect(rows.map(r => r[2])).toEqual(['objective', 'commands', 'structure', 'style', 'testing', 'boundaries'])
      spec.areas.forEach((area, i) => {
        const sum = areaSummary(area, spec.successCriteria)
        const row = rows[i]!
        const tone = area.state !== 'present' ? area.state : area.hint ? 'weak' : 'ok'
        expect(row[1]).toBe(tone)
        const t = text(row[3]!)
        expect(t).toContain(area.label)
        if (sum.text) expect(t).toContain(sum.text)
        if (area.hint) expect(t).toContain(area.hint)
        // A word, not only a colour.
        expect(t).toMatch({ ok: /✓/, weak: /!/, empty: /○/, missing: /×/ }[tone]!)
      })
    }
    // The weak spec shows each rule it trips.
    const weak = text(article(html, 'SPEC-dashboard.md'))
    expect(weak).toContain('1 vague criterion')
    expect(weak).toContain('nothing runnable')
    expect(weak).toContain('no example')
  })

  test('boundaries in three columns, each headed with its word', async () => {
    const a = article(specHtml(await buildState(io({ 'SPEC.md': SPEC }))), 'SPEC.md')
    const cols = [...a.matchAll(/<div class="bnd b-(\w+)">([\s\S]*?)<\/div>/g)]
    expect(cols.map(c => c[1])).toEqual(['always', 'ask', 'never'])
    expect(text(cols[0]![2]!)).toMatch(/Always .*run tests before commits .*validate inputs/)
    expect(text(cols[1]![2]!)).toMatch(/Ask first .*database schema changes/)
    expect(text(cols[2]![2]!)).toMatch(/Never .*commit secrets .*log API keys/)
  })

  test('an empty boundary column says so', async () => {
    const a = article(specHtml(await buildState(io({ 'SPEC.md': WEAK_SPEC }))), 'SPEC.md')
    const cols = [...a.matchAll(/<div class="bnd b-(\w+)">([\s\S]*?)<\/div>/g)]
    expect(text(cols[1]![2]!)).toContain('None written')
  })

  test('open questions and success criteria', async () => {
    const html = specHtml(await buildState(io(MANY)))
    expect(text(article(html, 'SPEC.md'))).toMatch(/Open questions .*♦ Should keys expire by default\?/)
    expect(text(article(html, 'SPEC-core.md'))).toContain('No open questions.')
    expect(text(article(html, 'SPEC-core.md'))).toMatch(/Success criteria 2 .*60 requests per minute per key by default .*Over the limit returns 429 with Retry-After/)
    expect(text(article(html, 'SPEC.md'))).toContain('No success criteria written yet.')
  })

  test('markdown in a spec renders its inline marks, and anything else is escaped', async () => {
    const md = `---\nstatus: draft\n---\n# Spec: <b>Keys</b> for the \`gateway\` *API*\n\n## Boundaries\n- Always: run \`pnpm test\`\n- Never: </script><script>alert(1)</script>\n\n## Open Questions\n- Is *this* **fine**?\n`
    const html = specHtml(await buildState(io({ 'SPEC.md': md })))
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>Keys')
        // The parser keeps the title's marks; it drops most from list items, and what it keeps renders.
    expect(html).toContain('&lt;b&gt;Keys&lt;/b&gt; for the <code>gateway</code> <em>API</em>')
    expect(html).toContain('Is <em>this</em> fine?')
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('with no spec, the view says where one would go and what writes it', async () => {
    for (const files of [{}, { 'tasks/todo.md': TODO_T3_DONE }]) {
      const s = await buildState(io(files))
      const t = text(specHtml(s))
      expect(t).toContain('No spec yet')
      expect(t).toContain('SPEC.md')
      expect(t).toContain('project root')
      expect(t).toContain('spec step')
      expect(text(section(dashboardHtml(s), 'spec'))).toContain('No spec yet')
    }
  })

  test('the page shows it as the Spec tab, and the same state gives the same bytes', async () => {
    const s = await buildState(io(MANY))
    const view = section(dashboardHtml(s, { view: 'spec' }), 'spec')
    expect(view).toContain('<article class="spec"')
    expect(specHtml(s)).toBe(specHtml(s))
  })
})
