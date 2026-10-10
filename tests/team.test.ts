import { describe, expect, test } from 'claude-code/testing'

import { draftTeam, parseTeam, teamText, whoIs } from '../packages/core/team'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'
import { TODO_TEMPLATE } from './fixtures'

// format-v2 T2 (F1): a team in tasks/team.md, and who you are from your git email.

const TEAM = `---
approvals: Product, design , eng
---
# Team

| Handle | Role | Email |
|---|---|---|
| @amila | lead, eng | Amila@Example.com |
| @sara | design | sara@example.com |
| @pm | product | pm@example.com |
`

describe('tasks/team.md (T2)', () => {
  test('people, their roles and emails, and the roles a spec needs', () => {
    const team = parseTeam(TEAM)
    expect(team.members).toEqual([
      { handle: '@amila', roles: ['lead', 'eng'], email: 'amila@example.com' },
      { handle: '@sara', roles: ['design'], email: 'sara@example.com' },
      { handle: '@pm', roles: ['product'], email: 'pm@example.com' },
    ])
    expect(team.approvals).toEqual(['product', 'design', 'eng'])
    expect(team.problems).toEqual([])
  })

  test('columns in any order; a missing @ is added; an empty role or email is allowed', () => {
    const team = parseTeam('| Email | Handle | Roles |\n|-|-|-|\n| bob@x.io | bob | |\n| | @ann | qa |\n')
    expect(team.members).toEqual([
      { handle: '@bob', roles: [], email: 'bob@x.io' },
      { handle: '@ann', roles: ['qa'], email: null },
    ])
    expect(team.approvals).toEqual([])
  })

  test('bad rows are skipped and named; a repeated email or handle keeps the first', () => {
    const team = parseTeam(`${TEAM}| | eng | nobody@example.com |\n| @sam | eng | SARA@example.com |\n| @sara | qa | other@example.com |\n`)
    expect(team.members.map(m => m.handle)).toEqual(['@amila', '@sara', '@pm'])
    expect(team.problems).toEqual([
      'row 4: no handle',
      'row 5: @sam has the email of @sara (sara@example.com); kept @sara',
      'row 6: @sara is listed twice; kept the first',
    ])
  })

  test('no table, or no file, is an empty team', () => {
    expect(parseTeam('# Team\n\nNobody yet.\n')).toEqual({ members: [], approvals: [], problems: ['no Handle | Role | Email table'] })
  })

  test('who you are: your git email, in any case', () => {
    const team = parseTeam(TEAM)
    expect(whoIs(team, 'AMILA@example.COM')?.handle).toBe('@amila')
    expect(whoIs(team, 'stranger@example.com')).toBeNull()
    expect(whoIs(team, null)).toBeNull()
  })

  test('a draft from the git authors: one row per email, handles from names, roles left to fill in', () => {
    const draft = draftTeam([
      { name: 'Amila Perera', email: 'amila@example.com' },
      { name: 'Amila Perera', email: 'AMILA@example.com' },
      { name: 'Sara K', email: 'sara@example.com' },
      { name: 'Sara Kim', email: 'sk@other.org' },
      { name: 'Claude', email: 'noreply@anthropic.com' },
      { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' },
    ])
    expect(draft).toBe(`---
approvals:
---
# Team

Who works on this project. The plugin knows you by your git email (\`git config user.email\`).
Roles are free words (lead, eng, design, product, qa); list in \`approvals:\` the roles that must sign a spec, or leave it empty for one approval.

| Handle | Role | Email |
|---|---|---|
| @amila-perera |  | amila@example.com |
| @sara-k |  | sara@example.com |
| @sara-kim |  | sk@other.org |
`)
    expect(parseTeam(draft).members.length).toBe(3)
  })

  test('/progress team: who is on it, what a spec needs, and who you are', () => {
    const team = parseTeam(TEAM)
    expect(teamText(team, 'sara@example.com')).toBe(`Team · tasks/team.md · 3 people
  @amila  lead, eng
  @sara   design    ← you
  @pm     product
A spec needs approval from: product, design, eng.`)
    expect(teamText(team, 'stranger@example.com')).toMatch(/You are stranger@example\.com, who is not in tasks\/team\.md: add a row with that email\./)
    expect(teamText(team, null)).toMatch(/git config user\.email is not set/)
    expect(teamText(null, 'sara@example.com')).toBe('No tasks/team.md here. /progress team init drafts one from the git authors.')
  })
})

describe('the team in State v1 (T2)', () => {
  const io = (files: Record<string, string>, email: string | null): ProjectIo => ({
    cwd: '/p',
    now: Date.parse('2026-10-09T10:00:00Z'),
    read: async r => files[r] ?? null,
    list: async () => [],
    run: async argv => (argv[1] === 'config' ? { exitCode: email ? 0 : 1, stdout: email ? `${email}\n` : '', stderr: '' } : { exitCode: 128, stdout: '', stderr: '' }),
  })

  test('buildState reads the team and knows you; the JSON leaves emails out', async () => {
    const s = await buildState(io({ 'tasks/todo.md': TODO_TEMPLATE, 'tasks/team.md': TEAM }, 'pm@example.com'))
    expect(s.me?.handle).toBe('@pm')
    expect(s.team?.members.length).toBe(3)
    const json = stateJson(s)
    expect(json.me).toBe('@pm')
    expect(json.team).toEqual({ members: [{ handle: '@amila', roles: ['lead', 'eng'] }, { handle: '@sara', roles: ['design'] }, { handle: '@pm', roles: ['product'] }], approvals: ['product', 'design', 'eng'] })
    expect(JSON.stringify(json)).not.toContain('@example.com')
  })

  test('no team file, or an email it does not know: no team, no you', async () => {
    const none = stateJson(await buildState(io({ 'tasks/todo.md': TODO_TEMPLATE }, 'pm@example.com')))
    expect([none.team, none.me]).toEqual([null, null])
    expect(stateJson(await buildState(io({ 'tasks/team.md': TEAM }, 'x@y.z'))).me).toBeNull()
  })
})
