import { describe, expect, test } from 'claude-code/testing'

import type { Snapshot } from '../packages/core/forecast'
import { parseTasks } from '../packages/core/parse'
import { retro, retroText, type RetroInput } from '../packages/core/retro'
import type { TodoVersion } from '../packages/core/sprint'

// ceremonies T9 (C6): the retro. Bottlenecks in the work, never people.

type Row = { n: number; title: string; size?: 'S' | 'M' | 'L'; status: string }
const plan = (sprint: string | null, rows: Row[]) =>
  `---\nplan: gateway\n${sprint ?? ''}---\n# Tasks: gateway\n\n${rows
    .map(r => `## Task ${r.n}: ${r.title}\n**Status:** ${r.status}\n${r.size ? `**Size:** ${r.size}\n` : ''}- [${r.status.startsWith('done') ? 'x' : ' '}] works\n`)
    .join('\n')}`

const SPRINT = 'sprint: 2026-10-12..2026-10-23\ncommit: T6, T7, T8\n'
const done = (owner: string, started: string, finished: string) => `done · ${owner} · started ${started} · done ${finished}`
/** S tasks took 1, 2 and 1 days before the sprint; T6 (S) took 6 in it. M took 3 and 2, T7 (M) 4 after a 2-day block. T8 is the only L. */
const ROWS: Row[] = [
  { n: 1, title: 'Scaffold', size: 'S', status: done('@amila', '2026-10-01', '2026-10-02') },
  { n: 2, title: 'Schema', size: 'S', status: done('@sara', '2026-10-02', '2026-10-04') },
  { n: 3, title: 'Keys', size: 'S', status: done('@amila', '2026-10-05', '2026-10-06') },
  { n: 4, title: 'Rate limit', size: 'M', status: done('@bob', '2026-10-05', '2026-10-08') },
  { n: 5, title: 'Docs', size: 'M', status: done('@sara', '2026-10-07', '2026-10-09') },
  { n: 6, title: 'Metrics', size: 'S', status: done('@amila', '2026-10-13', '2026-10-19') },
  { n: 7, title: 'Alerts', size: 'M', status: done('@bob', '2026-10-13', '2026-10-17') },
  { n: 8, title: 'Audit', size: 'L', status: done('@sara', '2026-10-14', '2026-10-19') },
  { n: 9, title: 'Billing', status: 'todo' },
]
const NOW = plan(SPRINT, ROWS)
const at = (day: string, rows: Row[]): TodoVersion => ({ day, list: parseTasks(plan(SPRINT, rows)) })
const swap = (n: number, status: string) => ROWS.map(r => (r.n === n ? { ...r, status } : r))
const VERSIONS: TodoVersion[] = [
  at('2026-10-14', swap(7, 'blocked · @bob · started 2026-10-13')),
  at('2026-10-15', swap(7, 'blocked · @bob · started 2026-10-13')),
  at('2026-10-16', swap(7, 'blocked · @bob · started 2026-10-13')),
  at('2026-10-17', ROWS),
  at('2026-10-20', swap(9, 'blocked · @amila')),
]
/** An archived plan's M task took 4 days. */
const ARCHIVED = [parseTasks(plan(null, [{ n: 1, title: 'Old', size: 'M', status: done('@bob', '2026-09-01', '2026-09-05') }]))]
/** 4 tasks done by the 12th from 0 on the 1st; 6 by the 23rd, with 4 added. */
const SNAPS: Snapshot[] = [
  { day: '2026-10-01', done: 0, total: 10 },
  { day: '2026-10-12', done: 4, total: 10 },
  { day: '2026-10-23', done: 6, total: 14 },
]
const INPUT: RetroInput = { list: parseTasks(NOW), versions: VERSIONS, archived: ARCHIVED, snapshots: SNAPS, sprint: parseTasks(NOW).meta!.sprint!, today: '2026-10-26' }

describe('the retro (T9)', () => {
  test('slow against size: over twice the median for its size, here and in archived plans', () => {
    const r = retro(INPUT)
    // S: 1, 2, 1, 6 → median 1½; T6's 6 is over 3. M: 3, 2, 4 (archived), 4 → median 3½; T7's 4 is not slow.
    expect(r.slow).toEqual([{ id: 'T6', title: 'Metrics', size: 'S', days: 6, usual: 1.5 }])
    // Only one L task has ever been done.
    expect(r.cantCompare).toEqual([{ size: 'L', done: 1 }])
  })

  test('block lengths: the days between the first and last copy where the task was blocked, in the sprint', () => {
    expect(retro(INPUT).blocks).toEqual([{ id: 'T7', title: 'Alerts', days: 2, from: '2026-10-14', to: '2026-10-16' }])
  })

  test('the ETA drift over the sprint, and the scope added', () => {
    const r = retro(INPUT)
    // On the 12th: 6 left at 4 per 11 days → 17 days → 29 Oct. On the 23rd: 8 left at 6 per 22 days → 30 days → 22 Nov.
    expect(r.drift).toEqual({ days: 24, from: '2026-10-29', to: '2026-11-22' })
    expect(r.added).toEqual([])
    // T9 was not in the plan the day the sprint began.
    const grown = retro({ ...INPUT, versions: [at('2026-10-12', ROWS.slice(0, 8)), ...VERSIONS] })
    expect(grown.added).toEqual([{ id: 'T9', title: 'Billing' }])
    expect(retroText(grown)).toContain('\nScope: +1 added after the start: T9 Billing\n')
  })

  test('the text: rows keyed by task, with no owner and no per-person figure anywhere', () => {
    const text = retroText(retro(INPUT))
    expect(text.split('\n')).toEqual([
      'Retro · sprint 12 Oct – 23 Oct',
      'Slow against their size',
      '  T6 Metrics (S) took 6d, the usual S is 1½d',
      '  Not compared: L (1 done; 3 needed)',
      'Longest blocks',
      '  T7 Alerts blocked 2d (14 Oct – 16 Oct)',
      'Scope: nothing added after the start',
      'ETA: slipped 24d over the sprint (29 Oct → 22 Nov)',
    ])
    for (const out of [text, JSON.stringify(retro(INPUT))]) {
      expect(out).not.toMatch(/@\w/)
      for (const name of ['amila', 'sara', 'bob']) expect(out).not.toContain(name)
    }
  })

  test('with no sprint it covers the whole plan, and says what it cannot compare', () => {
    const list = parseTasks(plan(null, ROWS.slice(0, 2)))
    const r = retro({ list, versions: [], archived: [], snapshots: SNAPS.slice(0, 1), sprint: null, today: '2026-10-26' })
    expect(retroText(r).split('\n')).toEqual([
      'Retro · the whole plan (no sprint)',
      'Slow against their size',
      '  Not compared: S (2 done; 3 needed)',
      'Longest blocks: none',
      'Scope: the plan has not grown',
      'ETA: not enough history for a forecast to drift',
    ])
  })

  test('with no sprint, scope added is the growth of the plan since its first day', () => {
    const r = retro({ ...INPUT, sprint: null })
    expect(retroText(r)).toContain('Scope: +4 tasks since 1 Oct')
    // The whole plan: T1–T8 all counted, the archived M too.
    expect(r.slow.map(s => s.id)).toEqual(['T6'])
  })
})
