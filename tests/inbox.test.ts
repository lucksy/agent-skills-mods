import { describe, expect, test } from 'claude-code/testing'

import { branchRows } from '../packages/core/branches'
import { inbox, inboxItems, inboxText } from '../packages/core/inbox'
import { overviewDecisions } from '../packages/core/dashboard/overview'
import { buildState, stateJson, type ProjectIo, type State } from '../packages/core/state'
import { SPEC, TODO_T2_DONE } from './fixtures'

// ceremonies T11 (C7): the decisions inbox, by handle and role.

const NOW = Date.parse('2026-10-09T10:00:00Z')
const io = (files: Record<string, string>, email: string | null = null): ProjectIo => ({
  cwd: '/work/keys',
  now: NOW,
  read: async rel => files[rel] ?? null,
  list: async rel => Object.keys(files).filter(f => (rel ? f.startsWith(`${rel}/`) && !f.slice(rel.length + 1).includes('/') : !f.includes('/'))).map(f => f.split('/').pop()!),
  // Only `git config user.email` answers: no history.
  run: async argv => (argv[1] === 'config' && email ? { exitCode: 0, stdout: `${email}\n`, stderr: '' } : { exitCode: 128, stdout: '', stderr: '' }),
})

const TEAM = `---\napprovals: product, eng\n---\n# Team\n\n| Handle | Role | Email |\n|---|---|---|\n| @amila | eng | amila@example.com |\n| @Sara | eng, design | sara@example.com |\n| @pm | product | pm@example.com |\n`
const own = (todo: string, id: string, title: string, line: string) => todo.replace(`## Task ${id}: ${title}\n`, `## Task ${id}: ${title}\n**Status:** ${line}\n`)
// T2 done on 6 Oct with its checkpoint open; T3 in review by @sara since 5 Oct, reviewer @amila; T4 handed from @sara to @pm.
const TODO = own(
  own(own(TODO_T2_DONE, '2', 'Prisma schema for keys', 'done · @amila · started 2026-10-03 · done 2026-10-06'), '3', 'Issue and revoke keys', 'in review · @sara · started 2026-10-05 · PR #42 · reviewer @amila'),
  '4',
  'Rate limit per key',
  'todo · @pm\n**Handoff:** 2026-10-08 @sara → @pm: limits agreed, tests left',
)
const PLAN = '# Plan\n\n## Open Questions\n- Q1 (T4): @pm, Upstash or self-hosted?\n- Q2: Which region first?\n'
const SPEC_B = `---\nstatus: draft\ncreated: 2026-10-01\napprovals: product @pm 2026-10-02\n---\n# Spec: Billing\n\n## Objective\nx\n`
const FILES = { 'SPEC.md': SPEC, 'SPEC-billing.md': SPEC_B, 'tasks/todo.md': TODO, 'tasks/plan.md': PLAN, 'tasks/team.md': TEAM }
const state = (files: Record<string, string> = FILES, email: string | null = null) => buildState(io(files, email))
const kinds = (items: { kind: string; text: string }[]) => items.map(i => `${i.kind}: ${i.text}`)

describe('the items (T11)', () => {
  test('every kind, in the Overview order: checkpoints, plan questions, specs to sign, the spec\'s questions, reviews, handoffs', async () => {
    expect(kinds(inbox(await state(), 'all'))).toEqual([
      'checkpoint: checkpoint 1, after T2: tests · review with you',
      'question: Q1 (T4): @pm, Upstash or self-hosted?',
      'question: Q2: Which region first?',
      'approval: approve SPEC.md',
      'approval: approve SPEC-billing.md',
      'question: Should keys expire by default?',
      'review: T3 Issue and revoke keys',
      'handoff: T4 Rate limit per key',
    ])
  })

  test('who each waits on, what it holds up, and its age in days', async () => {
    const items = inboxItems(await state())
    const by = (text: string) => items.find(i => i.text.startsWith(text))!
    expect(by('checkpoint')).toMatchObject({ who: [], tasks: ['T3', 'T4'], age: 3 })
    expect(by('Q1')).toMatchObject({ who: ['@pm'], tasks: ['T4'], q: 'Q1', file: 'tasks/plan.md', age: null })
    expect(by('Q2')).toMatchObject({ who: [], tasks: [] })
    // Roles still to sign, with who holds each: a role already signed is not asked again.
    expect(by('approve SPEC.md')).toMatchObject({ who: ['@pm', '@amila', '@Sara'], roles: [{ role: 'product', who: ['@pm'] }, { role: 'eng', who: ['@amila', '@Sara'] }], file: 'SPEC.md' })
    expect(by('approve SPEC-billing.md')).toMatchObject({ who: ['@amila', '@Sara'], roles: [{ role: 'eng', who: ['@amila', '@Sara'] }], age: 8 })
    expect(by('T3')).toMatchObject({ kind: 'review', who: ['@amila'], pr: '#42', owner: '@sara', ref: null, age: 4 })
    expect(by('T4')).toMatchObject({ kind: 'handoff', who: ['@pm'], from: '@sara', note: 'limits agreed, tests left', age: 1 })
  })

  test('filtered by handle: what names them and what names nobody; any case, with or without @', async () => {
    expect(kinds(inbox(await state(), '@pm'))).toEqual([
      'checkpoint: checkpoint 1, after T2: tests · review with you',
      'question: Q1 (T4): @pm, Upstash or self-hosted?',
      'question: Q2: Which region first?',
      'approval: approve SPEC.md',
      'question: Should keys expire by default?',
      'handoff: T4 Rate limit per key',
    ])
    expect(kinds(inbox(await state(), 'PM'))).toEqual(kinds(inbox(await state(), '@pm')))
  })

  test('filtered by role: a spec waits on whoever holds a role still unsigned', async () => {
    const sara = kinds(inbox(await state(), '@sara'))
    expect(sara).toContain('approval: approve SPEC.md')
    expect(sara).toContain('approval: approve SPEC-billing.md')
    expect(sara).not.toContain('review: T3 Issue and revoke keys')
    expect(kinds(inbox(await state(), '@amila'))).toContain('review: T3 Issue and revoke keys')
    expect(kinds(inbox(await state(), '@pm'))).not.toContain('approval: approve SPEC-billing.md')
  })

  test('me is who the git email says; an email not in team.md, or no team.md at all, sees everything', async () => {
    expect(inbox(await state(FILES, 'pm@example.com'))).toEqual(inbox(await state(), '@pm'))
    expect(inbox(await state(FILES, 'nobody@example.com'))).toEqual(inbox(await state(), 'all'))
    const { 'tasks/team.md': _, ...noTeam } = FILES
    const s = await state(noTeam, 'pm@example.com')
    expect(inbox(s)).toEqual(inbox(s, 'all'))
    // With no roles to sign, a spec waits on anyone.
    expect(inbox(s).find(i => i.kind === 'approval')).toMatchObject({ who: [], roles: [] })
  })

  test('a review with no reviewer waits on anyone on the team but its owner; one on another branch says where', async () => {
    const todo = own(TODO_T2_DONE, '4', 'Rate limit per key', 'in review · @amila · started 2026-10-07')
    const s = await state({ ...FILES, 'tasks/todo.md': todo })
    expect(inbox(s, 'all').find(i => i.kind === 'review')).toMatchObject({ text: 'T4 Rate limit per key', who: ['@Sara', '@pm'] })
    const theirs = own(TODO_T2_DONE, '3', 'Issue and revoke keys', 'in review · @bob · started 2026-10-06 · PR #7 · reviewer @pm')
    const b = branchRows({ name: 'main', list: s.list }, [{ ref: { ref: 'refs/heads/feat/keys', name: 'feat/keys', sha: 'b1', ms: NOW, remote: false }, text: theirs }], null)
    const withBranches: State = { ...s, branches: b }
    expect(inbox(withBranches, '@pm').filter(i => i.kind === 'review')).toMatchObject([{ text: 'T4 Rate limit per key', ref: null }, { text: 'T3 Issue and revoke keys', pr: '#7', ref: 'feat/keys', owner: '@bob', age: 3 }])
  })

  test('done and signed-off work waits on nobody; an approved spec neither', async () => {
    const signed = TODO.replace('- [ ] All tests pass', '- [x] All tests pass').replace('- [ ] Review with human before proceeding', '- [x] Review with human before proceeding')
    const s = await state({ 'SPEC.md': SPEC.replace('status: draft', 'status: approved'), 'tasks/todo.md': signed, 'tasks/team.md': TEAM })
    expect(kinds(inbox(s, 'all'))).toEqual(['review: T3 Issue and revoke keys', 'handoff: T4 Rate limit per key'])
  })
})

describe('the Overview reads the inbox (T11)', () => {
  test('its decisions are needsYou, item for item: the figure above them counts the same list', async () => {
    for (const files of [FILES, { ...FILES, 'SPEC.md': SPEC.replace('status: draft', 'status: approved') }, { 'tasks/todo.md': TODO }]) {
      const s = await state(files)
      expect(overviewDecisions(s).map(i => i.text)).toEqual(s.needsYou)
    }
  })
})

describe('/progress inbox and --inbox (T11)', () => {
  test('grouped by kind, each line with who, what it holds up and its age', async () => {
    expect(inboxText(await state(), '@pm').split('\n')).toEqual([
      'Inbox · @pm · 6 waiting',
      'Checkpoints to sign off',
      '  ♦ checkpoint 1, after T2: tests · review with you · holds up T3, T4 · 3 d',
      'Questions to answer',
      '  ♦ Q1 (T4): @pm, Upstash or self-hosted? · holds up T4',
      '  ♦ Q2: Which region first?',
      '  ♦ Should keys expire by default?',
      'Specs to sign',
      '  ♦ approve SPEC.md · as product',
      'Handoffs',
      '  ♦ T4 Rate limit per key · from @sara: limits agreed, tests left · 1 d',
    ])
  })

  test('for anyone: a spec says who it waits on, a review its PR and owner', async () => {
    const text = inboxText(await state(), 'all')
    expect(text.split('\n')[0]).toBe('Inbox · anyone · 8 waiting')
    expect(text).toContain('  ♦ approve SPEC-billing.md · waiting on @amila or @Sara (eng) · 8 d')
    expect(text).toContain('  ♦ T3 Issue and revoke keys · PR #42 by @sara · 4 d')
  })

  test('me: you by your git email; without team.md it says nothing is filtered', async () => {
    expect(inboxText(await state(FILES, 'amila@example.com')).split('\n')[0]).toBe('Inbox · you (@amila) · 6 waiting')
    const { 'tasks/team.md': _, ...noTeam } = FILES
    expect(inboxText(await state(noTeam)).split('\n')[0]).toBe('Inbox · everything waiting (no tasks/team.md, so nothing is filtered) · 8 waiting')
  })

  test('nothing waiting', async () => {
    const s = await state({ 'tasks/todo.md': '## Task 1: A\n- [x] a\n' })
    expect(inboxText(s)).toBe('✓ Nothing is waiting on you.')
    expect(inboxText(s, '@sara')).toBe('✓ Nothing is waiting on @sara.')
    expect(inboxText(s, 'all')).toBe('✓ Nothing is waiting on anyone.')
  })

  test('--json: the inbox for me joins State v1', async () => {
    const json = stateJson(await state(FILES, 'pm@example.com'))
    expect(json.schema).toBe(1)
    expect(json.inbox?.map(i => i.text)).toEqual(inbox(await state(), '@pm').map(i => i.text))
  })
})
