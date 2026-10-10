import { describe, expect, test } from 'claude-code/testing'

import { approvalStatus, clearApprovals, parseApprovals, signSpec } from '../packages/core/approvals'
import { driftedSpec, readFrontMatter } from '../packages/core/format'
import { parseSpec } from '../packages/core/parse'
import { parseTeam } from '../packages/core/team'
import { SPEC, TODO_TEMPLATE } from './fixtures'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'
import { dashboardHtml } from '../packages/core/dashboard/page'
import { renderCli } from '../packages/core/cli'

// format-v2 T8 (F5): a spec signed by role. status: approved only once every
// required role has signed; with no approvals: in tasks/team.md, nothing changes.

const TEAM = parseTeam('---\napprovals: product, design, eng\n---\n| Handle | Role | Email |\n|---|---|---|\n| @amila | lead, eng | a@x.io |\n| @sara | design | s@x.io |\n| @pm | product | p@x.io |\n| @kim | design, eng | k@x.io |\n')
const who = (h: string) => TEAM.members.find(m => m.handle === h)!

describe('approvals by role (T8)', () => {
  test('the approvals line reads and writes back', () => {
    expect(parseApprovals('product @pm 2026-10-08, design @sara 2026-10-09')).toEqual([
      { role: 'product', handle: '@pm', day: '2026-10-08' },
      { role: 'design', handle: '@sara', day: '2026-10-09' },
    ])
    expect(parseApprovals(undefined)).toEqual([])
    expect(parseApprovals('nonsense, eng @amila 2026-10-01')).toEqual([{ role: 'eng', handle: '@amila', day: '2026-10-01' }])
  })

  test('a signature records the person, their role and the day; the spec stays a draft until every role has signed', () => {
    const one = signSpec(SPEC, who('@sara'), TEAM.approvals, '2026-10-09')
    expect(one.signed).toEqual(['design'])
    expect(one.complete).toBe(false)
    expect(readFrontMatter(one.text).fields).toMatchObject({ status: 'draft', approvals: 'design @sara 2026-10-09' })
    const two = signSpec(one.text, who('@pm'), TEAM.approvals, '2026-10-10')
    expect(readFrontMatter(two.text).fields.status).toBe('draft')
    const three = signSpec(two.text, who('@amila'), TEAM.approvals, '2026-10-11')
    expect(three.complete).toBe(true)
    expect(readFrontMatter(three.text).fields).toMatchObject({ status: 'approved', approved: '2026-10-11', approvals: 'design @sara 2026-10-09, product @pm 2026-10-10, eng @amila 2026-10-11' })
  })

  test('a person with two roles signs both at once; a role already signed is not signed again', () => {
    const kim = signSpec(SPEC, who('@kim'), TEAM.approvals, '2026-10-09')
    expect(kim.signed).toEqual(['design', 'eng'])
    const again = signSpec(kim.text, who('@sara'), TEAM.approvals, '2026-10-10')
    expect(again.signed).toEqual([])
    expect(again.text).toBe(kim.text)
  })

  test('who it waits on, by name and role', () => {
    const one = signSpec(SPEC, who('@sara'), TEAM.approvals, '2026-10-09').text
    const st = approvalStatus(parseSpec(one).approvals, TEAM)
    expect(st.text).toBe('1/3 approved · waiting on @pm (product), @amila or @kim (eng)')
    expect(st.waiting).toEqual([{ role: 'product', who: ['@pm'] }, { role: 'eng', who: ['@amila', '@kim'] }])
    const nobody = parseTeam('---\napprovals: legal\n---\n| Handle | Role | Email |\n|---|---|---|\n| @sara | design | s@x.io |\n')
    expect(approvalStatus([], nobody).text).toBe('0/1 approved · waiting on legal (nobody on the team has it)')
  })

  test('back to draft, and spec drift, clear every signature', () => {
    const signed = signSpec(signSpec(SPEC, who('@kim'), TEAM.approvals, '2026-10-09').text, who('@pm'), TEAM.approvals, '2026-10-09').text
    expect(readFrontMatter(signed).fields.status).toBe('approved')
    expect(readFrontMatter(clearApprovals(signed)).fields).not.toHaveProperty('approvals')
    const drifted = driftedSpec(signed, signed.replace('Developers create', 'Admins create'))!
    expect(readFrontMatter(drifted).fields).toMatchObject({ status: 'draft' })
    expect(readFrontMatter(drifted).fields).not.toHaveProperty('approvals')
  })
})

describe('approvals in the Spec tab, the CLI and the JSON (T9)', () => {
  const TEAM_MD = '---\napprovals: design, eng\n---\n| Handle | Role | Email |\n|---|---|---|\n| @amila | lead, eng | a@x.io |\n| @sara | design | s@x.io |\n'
  const signedOnce = '---\nstatus: draft\ncreated: 2026-10-01\napprovals: design @sara 2026-10-09\n---\n' + SPEC.replace(/^---[\s\S]*?---\n/, '')
  const state = (spec = signedOnce, team: string | null = TEAM_MD) => {
    const files: Record<string, string> = { 'SPEC.md': spec, 'tasks/todo.md': TODO_TEMPLATE, ...(team ? { 'tasks/team.md': team } : {}) }
    const io: ProjectIo = { cwd: '/p', now: Date.parse('2026-10-09T10:00:00Z'), read: async r => files[r] ?? null, list: async r => (r ? [] : Object.keys(files).filter(f => !f.includes('/'))) }
    return buildState(io)
  }
  const specTab = (html: string) => html.match(/<section[^>]*id="view-spec"[\s\S]*?<\/section>\s*<!-- \/view-spec -->/)![0]
  const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

  test('the Spec tab lists each role with its signer and day, or who it waits on', async () => {
    const tab = specTab(dashboardHtml(await state()))
    expect(tab).toMatch(/<div class="card spec-appr">/)
    expect(words(tab)).toMatch(/Approvals 1\/2 .*✓ design @sara 9 Oct 2026 .*○ eng waiting on @amila/)
    expect(words(tab)).toContain('1/2 approved · waiting on @amila (eng)')
  })

  test('without approvals: in team.md, the tab is as before', async () => {
    const tab = specTab(dashboardHtml(await state(signedOnce, null)))
    expect(tab).not.toContain('spec-appr')
    expect(words(tab)).toContain('Awaiting approval')
  })

  test('the CLI says who signed and who it waits on', async () => {
    const out = renderCli(await state(), { color: false, width: 90 })
    expect(out).toMatch(/approvals 1\/2 approved · waiting on @amila \(eng\) · ✓ design @sara 9 Oct/)
  })

  test("the JSON carries each spec's signatures", async () => {
    const json = stateJson(await state())
    expect(json.spec!.approvals).toEqual([{ role: 'design', handle: '@sara', day: '2026-10-09' }])
    expect(json.specs[0]!.approvals).toEqual([{ role: 'design', handle: '@sara', day: '2026-10-09' }])
  })
})
