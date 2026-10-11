import { describe, expect, test } from 'claude-code/testing'

import { branchRows, type Ref } from '../packages/core/branches'
import { parseTasks, withBlockers } from '../packages/core/parse'
import { lastWorkingDay, parseCommits, standupLogArgv, standupTeam, standupTeamText, taskOfSubject, type Commit } from '../packages/core/standup'
import { parseTeam } from '../packages/core/team'

// ceremonies T10 (C3): the team standup, from Status lines across branches and commit subjects.

const MON = '2026-10-12'
const NOW = Date.parse(`${MON}T09:00:00Z`)

const TEAM = parseTeam(`---
approvals: product
---
# Team

| Handle | Role | Email |
|---|---|---|
| @sara | design | sara@example.com |
| @amila | lead, eng | amila@example.com |
| @pm | product | pm@example.com |
| @bob | eng | bob@example.com |
`)

const HERE = `---
plan: gateway
---
## Task 1: Scaffold
**Status:** done · @amila · started 2026-10-08 · done 2026-10-09
- [x] builds

## Task 2: Schema
**Status:** done · @sara · started 2026-10-05 · done 2026-10-07
- [x] table

## Task 3: Keys
**Status:** in progress · @amila · started 2026-10-09 · step test
- [x] issue
- [ ] revoke
- [ ] rotate

## Task 4: Rate limit
**Status:** in progress · @sara · started 2026-10-09
- [ ] 429

## Task 5: Docs
**Status:** in progress · started 2026-10-10
- [ ] readme

## Task 6: Metrics
- [ ] count

## Task 7: Audit
**Status:** in review · @amila · started 2026-10-06 · PR #42 · reviewer @bob
- [x] log
- [ ] retention
`
const FEAT = HERE.replace('## Task 6: Metrics\n', '## Task 6: Metrics\n**Status:** done · @bob · started 2026-10-09 · done 2026-10-12\n')
const OLD = HERE.replace('## Task 6: Metrics\n', '## Task 6: Metrics\n**Status:** blocked · @pm\n')

const ref = (name: string, sha: string, remote = false): Ref => ({ ref: `refs/${remote ? 'remotes' : 'heads'}/${name}`, name, sha, ms: NOW, remote })
const here = withBlockers(parseTasks(HERE), [{ file: 'tasks/plan.md', text: 'Q2 (T4): Upstash or self-hosted?' }])
const board = branchRows({ name: 'main', list: here }, [{ ref: ref('origin/feat/metrics', '1', true), text: FEAT }, { ref: ref('docs', '2'), text: null }], null)
const day = (d: string) => Date.parse(`${d}T10:00:00Z`) / 1000
const COMMITS: Commit[] = parseCommits(
  [
    `amila@example.com\t${day('2026-10-09')}\tT3: revoke endpoint`,
    `Amila@Example.com\t${day('2026-10-09')}\tIT4 fix the build`,
    `sara@example.com\t${day('2026-10-12')}\tT44 nothing like it`,
    `sara@example.com\t${day('2026-10-09')}\tT4 try a token bucket`,
    `stranger@example.com\t${day('2026-10-09')}\tT5: docs`,
    `bob@example.com\t${day('2026-10-08')}\tT6: before the window`,
    'not a commit line',
  ].join('\n'),
)

describe('the last working day', () => {
  test('Monday reaches back to Friday; the weekend too; other days the day before', () => {
    expect(lastWorkingDay('2026-10-12')).toBe('2026-10-09')
    expect(lastWorkingDay('2026-10-11')).toBe('2026-10-09')
    expect(lastWorkingDay('2026-10-10')).toBe('2026-10-09')
    expect(lastWorkingDay('2026-10-13')).toBe('2026-10-12')
  })
})

describe('commits that name a task', () => {
  const ids = new Set(['T3', 'T4'])
  test('a plan task id at the start, then a colon or a space', () => {
    expect(taskOfSubject('T3: revoke', ids)).toBe('T3')
    expect(taskOfSubject('T4 bucket', ids)).toBe('T4')
  })
  test('near misses do not match', () => {
    expect(taskOfSubject('IT4 fix', ids)).toBeNull()
    expect(taskOfSubject('T44 more', ids)).toBeNull()
    expect(taskOfSubject('T4', ids)).toBeNull()
    expect(taskOfSubject('T4-bucket', ids)).toBeNull()
    expect(taskOfSubject('fix T4: later', ids)).toBeNull()
    expect(taskOfSubject('T9: not in the plan', ids)).toBeNull()
  })
  test('one git log over HEAD and the refs the board read with the file, by full name; nothing that fetches', () => {
    expect(standupLogArgv(board, '2026-10-09')).toEqual(['git', 'log', '--since=2026-10-09T00:00:00Z', '--no-merges', '--format=%ae%x09%at%x09%s', 'HEAD', 'refs/remotes/origin/feat/metrics'])
    expect(standupLogArgv(null, '2026-10-09').slice(-1)).toEqual(['HEAD'])
  })
  test('parses email, day (UTC) and subject; skips other lines', () => {
    expect(COMMITS).toHaveLength(6)
    expect(COMMITS[1]).toEqual({ email: 'amila@example.com', day: '2026-10-09', subject: 'IT4 fix the build' })
  })
})

describe('/progress standup team (C3)', () => {
  const st = standupTeam({ list: here, team: TEAM, dates: {}, spec: null }, board, COMMITS, MON)

  test('a line per person in handle order, then unowned work', () => {
    expect(standupTeamText(st).split('\n')).toEqual([
      'Team standup · gateway · Mon 12 Oct · done since Fri 9 Oct',
      '@amila: done T1, T3 (commits) · today T3 (test, 2 boxes left), T7 (in review) · blocked —',
      '@bob: done T6 · today — · blocked —',
      '@pm: nothing under way',
      '@sara: done T4 (commits) · today — · blocked T4 (waits on Q2)',
      'Unowned: done — · today T5 (1 box left) · blocked —',
    ])
  })

  test('a task done on another branch counts, and is no longer under way', () => {
    const bob = st.people.find(p => p.who === '@bob')!
    expect(bob.done).toEqual([{ id: 'T6', note: null }])
    expect(st.people.flatMap(p => p.today).some(i => i.id === 'T6')).toBe(false)
  })

  test('work under way or blocked on another branch says where', () => {
    const b = branchRows({ name: 'main', list: here }, [{ ref: ref('feat/old', '3'), text: OLD }, { ref: ref('feat/x', '4'), text: HERE.replace('## Task 6: Metrics\n', '## Task 6: Metrics\n**Status:** in progress · @bob · started 2026-10-12\n') }], null)
    const lines = standupTeamText(standupTeam({ list: here, team: TEAM, dates: {}, spec: null }, b, [], MON)).split('\n')
    expect(lines).toContain('@pm: done — · today — · blocked T6 (on feat/old)')
    expect(lines).toContain('@bob: done — · today T6 (on feat/x) · blocked —')
  })

  test('done by history when the Status line has no day', () => {
    const plain = parseTasks('## Task 1: A\n- [x] a\n\n## Task 2: B\n- [ ] b\n')
    const s = standupTeam({ list: plain, team: null, dates: { T1: { day: '2026-10-09', isEstimate: false } }, spec: null }, null, [], MON)
    expect(standupTeamText(s).split('\n')[1]).toBe('Unowned: done T1 · today — · blocked —')
  })

  test('without tasks/team.md: grouped by owner handle as written; commits are not matched to anyone', () => {
    const list = parseTasks(HERE.replace(/@sara/g, '@Sara-K'))
    const lines = standupTeamText(standupTeam({ list, team: null, dates: {}, spec: null }, null, COMMITS, MON)).split('\n')
    expect(lines.slice(1)).toEqual([
      '@amila: done T1 · today T3 (test, 2 boxes left), T7 (in review) · blocked —',
      '@Sara-K: done — · today T4 (1 box left) · blocked —',
      'Unowned: done — · today T5 (1 box left) · blocked —',
    ])
  })

  test('someone the work names who is not in tasks/team.md still gets a line', () => {
    const list = parseTasks(HERE.replace('**Status:** in progress · started 2026-10-10', '**Status:** in progress · @ann · started 2026-10-10'))
    const s = standupTeam({ list, team: TEAM, dates: {}, spec: null }, null, [], MON)
    expect(s.people.map(p => [p.who, p.listed])).toEqual([['@amila', true], ['@ann', false], ['@bob', true], ['@pm', true], ['@sara', true], [null, true]])
  })

  test('no task list', () => {
    expect(standupTeamText(standupTeam({ list: null, team: TEAM, dates: {}, spec: null }, null, [], MON), false)).toBe('Team standup · Plan · Mon 12 Oct · done since Fri 9 Oct\nNo task list yet.')
  })

  test('no per-person count, total or rate anywhere: people show only as owners of tasks', () => {
    const text = standupTeamText(st)
    for (const line of text.split('\n').slice(1)) {
      const counts = [...line.matchAll(/\b(\d+)\s+(\w+)/g)].map(m => m[2])
      expect(counts.every(w => w === 'box' || w === 'boxes')).toBe(true)
    }
    expect(text).not.toMatch(/\b(points?|tasks|commits?:|velocity|per day|%)/)
  })
})
