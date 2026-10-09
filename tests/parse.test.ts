import { describe, expect, test } from 'claude-code/testing'

import { parsePlan, parseSpec, parseTasks, withBlockers } from '../hooks/lib/parse'
import { checkOverwrite } from '../hooks/lib/guard'
import { gateWarning, isSourceFile } from '../hooks/lib/gate'
import { forecast, record, shortDay, snapshotOf, type Snapshot } from '../hooks/lib/forecast'
import {
  combine,
  doneDaysFromGit,
  doneDaysFromMessages,
  earliestDays,
  mergeHistory,
  parseLog,
  parseMessages,
  snapshotsFromDoneDays,
  snapshotsFromGit,
  splitBatch,
} from '../hooks/lib/history'
import { historyFromLogs, logsDir, textAfter } from '../hooks/lib/logs'
import { spinnerWord, stepOf } from '../hooks/lib/steps'
import { digestText, sparkline } from '../hooks/lib/report'
import { burnupSvg, flowSvg } from '../hooks/lib/svg'
import { burnup, COLOR, daily, flow, toBase64 } from '../hooks/lib/chart'
import { bandText, blockChain, taskDates, completionToast, forecastText, progressBrief, taskInPrompt, nextText, statusText, timelineRows } from '../hooks/lib/view'
import {
  CHECKLIST,
  GOOD_SPEC,
  PLAN_INDEX,
  SPEC,
  TODO_CP_DONE,
  TODO_T2_DONE,
  TODO_T3_DONE,
  TODO_TEMPLATE,
  TODO_NONE_DONE,
  gitOutput,
  decodeCells,
  WEAK_SPEC,
} from './fixtures'

describe('parseTasks', () => {
  test('template: ## Task N sections, dependencies and checkpoints', async () => {
    const list = parseTasks(TODO_TEMPLATE)
    expect(list.kind).toBe('tasks')
    expect(list.total).toBe(4)
    expect(list.done).toBe(1)
    expect(list.tasks.map(t => t.status)).toEqual(['done', 'next', 'waiting', 'todo'])
    expect(list.current?.id).toBe('T2')
    expect(list.tasks[2]?.deps).toEqual(['T2'])
    expect(list.tasks[3]?.deps).toEqual(['T1'])
    expect(list.tasks[1]?.checkpoint?.title).toBe('After Tasks 1-2')
    expect(list.tasks[0]?.phase).toBe('Phase 1: Foundation')
    expect(list.tasks[2]?.phase).toBe('Phase 2: Core')
  })

  test('waiting is normal; blocked means an open question names the task', async () => {
    const list = withBlockers(parseTasks(TODO_TEMPLATE), [
      { file: 'tasks/plan.md', text: 'Upstash or self-hosted Redis for T4?' },
      { file: 'tasks/plan.md', text: 'Which region?' },
      { file: 'SPEC.md', text: 'Should Task 1 have used pnpm?' },
    ])
    expect(list.tasks.map(t => `${t.id}:${t.status}`)).toEqual(['T1:done', 'T2:next', 'T3:waiting', 'T4:blocked'])
    expect(list.tasks[3]!.blockedBy).toBe('tasks/plan.md: Upstash or self-hosted Redis for T4?')
    // Blocking the current task moves "current" on.
    const t2 = withBlockers(parseTasks(TODO_TEMPLATE), [{ file: 'tasks/plan.md', text: 'Is T2 still needed?' }])
    expect(t2.current?.id).toBe('T4')
    const rows = timelineRows(list)
    expect(rows.filter(r => r.kind === 'task').map(r => (r.kind === 'task' ? `${r.glyph} ${r.id} ${r.detail}` : ''))).toEqual([
      '✓ T1 3/3',
      '● T2 1/3',
      '◌ T3 waits on T2',
      '■ T4 question: Upstash or self-hosted Redis for T4?',
    ])
    expect(snapshotOf('2026-10-09', list)).toEqual({ day: '2026-10-09', done: 1, total: 4, doing: 1, blocked: 1 })
  })

  test('plan index: - [ ] Task N lines under phases', async () => {
    const list = parseTasks(PLAN_INDEX)
    expect(list.kind).toBe('tasks')
    expect(list.total).toBe(4)
    expect(list.done).toBe(2)
    expect(list.current?.id).toBe('T3')
    expect(list.checkpoints.length).toBe(2)
    expect(list.tasks[1]?.checkpoint?.title).toBe('Foundation')
  })

  test('free-form checklist falls back to plain boxes', async () => {
    const list = parseTasks(CHECKLIST)
    expect(list.kind).toBe('checklist')
    expect(list.total).toBe(3)
    expect(list.done).toBe(1)
    expect(list.current?.title).toBe('write the parser')
  })

  test('never throws on text with no tasks', async () => {
    expect(parseTasks('').kind).toBe('empty')
    expect(parseTasks('# Notes\n\nnothing here\n```\n- [ ] in a fence\n```').total).toBe(0)
  })
})

describe('parseSpec', () => {
  test('six areas, boundaries and front matter', async () => {
    const spec = parseSpec(SPEC)
    expect(spec.title).toBe('API keys')
    expect(spec.status).toBe('draft')
    expect(spec.areas.map(a => `${a.key}:${a.state}`)).toEqual([
      'objective:present',
      'commands:present',
      'structure:empty',
      'style:missing',
      'testing:present',
      'boundaries:present',
    ])
    expect(spec.boundaries.always).toEqual(['run tests before commits', 'validate inputs'])
    expect(spec.boundaries.ask).toEqual(['database schema changes'])
    expect(spec.boundaries.never).toEqual(['commit secrets', 'log API keys'])
    expect(spec.openQuestions).toEqual(['Should keys expire by default?'])
  })

  test('weak sections are flagged with one reason each (A2)', async () => {
    const hints = (text: string) => Object.fromEntries(parseSpec(text).areas.map(a => [a.key, a.hint]))
    expect(hints(WEAK_SPEC)).toEqual({
      objective: '1 of 2 success criteria have no number or condition: "Delivery is reliable"',
      commands: 'no runnable command line',
      structure: null,
      style: 'no example code block',
      testing: null,
      boundaries: null,
    })
    const good = parseSpec(GOOD_SPEC)
    expect(good.successCriteria).toEqual(['60 requests per minute per key by default', 'Over the limit returns 429 with Retry-After'])
    expect(good.areas.map(a => a.hint)).toEqual([null, null, null, null, null, null])
    // No criteria anywhere; missing and empty areas carry no hint, their state says it.
    expect(hints(SPEC)).toMatchObject({ objective: 'no success criteria', commands: null, structure: null, style: null })
  })

  test('plan doc: tracker line and open questions', async () => {
    const plan = parsePlan(PLAN_INDEX + '\nTasks tracked in Linear project NOTIF.\n')
    expect(plan.trackedIn).toBe('Linear project NOTIF')
    expect(plan.openQuestions[0]).toBe('Upstash or self-hosted Redis?')
  })
})

describe('checkOverwrite', () => {
  test('ticking a box in a full rewrite is allowed', async () => {
    const ticked = TODO_TEMPLATE.replace('- [ ] Migration runs', '- [x] Migration runs')
    expect(checkOverwrite(TODO_TEMPLATE, ticked).isAllowed).toBe(true)
  })

  test('adding a task is allowed', async () => {
    const more = TODO_TEMPLATE + '\n## Task 5: Docs\n- [ ] README\n'
    expect(checkOverwrite(TODO_TEMPLATE, more).isAllowed).toBe(true)
  })

  test('a different plan over unfinished tasks is refused', async () => {
    const v = checkOverwrite(TODO_TEMPLATE, PLAN_INDEX)
    expect(v.isAllowed).toBe(false)
    if (!v.isAllowed) {
      expect(v.open).toBe(3)
      expect(v.lost.map(t => t.id)).toEqual(['T2', 'T3', 'T4'])
    }
  })

  test('a finished plan may be replaced', async () => {
    const done = TODO_TEMPLATE.replace(/- \[ \]/g, '- [x]')
    expect(checkOverwrite(done, PLAN_INDEX).isAllowed).toBe(true)
  })
})

describe('history from git (F5)', () => {
  const current = parseTasks(TODO_T3_DONE)

  test('one snapshot per day from its last commit, stopping at an older plan', async () => {
    const { log, cat } = gitOutput([
      ['2026-10-08', TODO_T3_DONE],
      ['2026-10-03', TODO_T2_DONE],
      ['2026-10-03', TODO_TEMPLATE],
      ['2026-09-29', TODO_NONE_DONE],
      ['2026-09-20', PLAN_INDEX],
      ['2026-09-10', TODO_NONE_DONE],
    ])
    const commits = parseLog(log)
    expect(commits.length).toBe(6)
    expect(snapshotsFromGit(commits, splitBatch(cat), current)).toEqual([
      { day: '2026-09-29', done: 0, total: 4, doing: 0, blocked: 0 },
      { day: '2026-10-03', done: 2, total: 4, doing: 0, blocked: 0 },
      { day: '2026-10-08', done: 3, total: 4, doing: 0, blocked: 0 },
    ])
  })

  test('a commit without the file ends the walk; the mod\'s own snapshots win a shared day', async () => {
    const { log, cat } = gitOutput([
      ['2026-10-08', TODO_T3_DONE],
      ['2026-10-01', null],
      ['2026-09-29', TODO_NONE_DONE],
    ])
    expect(splitBatch(cat)).toEqual([TODO_T3_DONE, null, TODO_NONE_DONE])
    const fromGit = snapshotsFromGit(parseLog(log), splitBatch(cat), current)
    expect(fromGit).toEqual([{ day: '2026-10-08', done: 3, total: 4, doing: 0, blocked: 0 }])
    const stored = [{ day: '2026-10-08', done: 4, total: 4 }]
    expect(mergeHistory(stored, [{ day: '2026-10-02', done: 1, total: 4 }, ...fromGit])).toEqual([
      { day: '2026-10-02', done: 1, total: 4 },
      { day: '2026-10-08', done: 4, total: 4 },
    ])
  })
})

describe('more history sources (0.7.0)', () => {
  test('commit messages: T3, Task 3, task #3; the first mention after the plan began', async () => {
    const at = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000
    const out = [
      `\x1e${at('2026-10-08')}\x1fT3: issue keys\n`,
      `\x1e${at('2026-10-02')}\x1fTask 2 done, refs task #1\n`,
      `\x1e${at('2026-09-25')}\x1fT2 of an older plan\n`,
      `\x1e${at('2026-09-20')}\x1fchore: nothing\n`,
    ].join('')
    const commits = parseMessages(out)
    expect(commits.map(c => c.ids)).toEqual([['T3'], ['T2', 'T1'], ['T2']])
    const list = parseTasks(TODO_T3_DONE)
    const days = doneDaysFromMessages(commits, list, Date.parse('2026-09-30T00:00:00Z'))
    expect(days).toEqual({ 'T3|Issue and revoke keys': '2026-10-08', 'T2|Prisma schema for keys': '2026-10-02', 'T1|Monorepo scaffold': '2026-10-02' })
    expect(snapshotsFromDoneDays(days, list)).toEqual([
      { day: '2026-10-02', done: 2, total: 4 },
      { day: '2026-10-08', done: 3, total: 4 },
    ])
  })

  test('combining: what the mod saw, then files, then messages held between them', async () => {
    const seen = [{ day: '2026-10-09', done: 3, total: 4 }]
    const git = { snaps: [{ day: '2026-10-05', done: 2, total: 4 }, { day: '2026-10-09', done: 1, total: 4 }], doneDays: {} }
    const logs = { snaps: [{ day: '2026-10-03', done: 1, total: 4 }, { day: '2026-10-05', done: 9, total: 9 }], doneDays: {} }
    const messages = { snaps: [{ day: '2026-09-30', done: 1, total: 4 }, { day: '2026-10-04', done: 2, total: 4 }], doneDays: {} }
    const c = combine(seen, [git, logs], messages)
    expect(c.snaps.map(s => `${s.day}:${s.done}/${s.total}`)).toEqual(['2026-09-30:1/4', '2026-10-03:1/4', '2026-10-04:2/4', '2026-10-05:2/4', '2026-10-09:3/4'])
    expect(c.added).toEqual({ seen: 1, files: [1, 1], messages: 2 })
    expect(earliestDays({ a: '2026-10-05' }, { a: '2026-10-02', b: '2026-10-01' })).toEqual({ a: '2026-10-02', b: '2026-10-01' })
  })

  test('session logs: Write and Edit replayed, other files and broken lines skipped', async () => {
    expect(logsDir('/home/.claude', '/Users/me/Projects/agent-skills.demo')).toBe('/home/.claude/projects/-Users-me-Projects-agent-skills-demo')
    const path = '/p/tasks/todo.md'
    const write = JSON.stringify({ timestamp: '2026-10-01T08:00:00Z', toolUseResult: { filePath: path, content: TODO_TEMPLATE } })
    const edit = JSON.stringify({ timestamp: '2026-10-02T08:00:00Z', toolUseResult: { filePath: path, originalFile: TODO_TEMPLATE, oldString: '- [ ] Migration', newString: '- [x] Migration' } })
    expect(textAfter(write, path)?.text).toBe(TODO_TEMPLATE)
    expect(textAfter(edit, path)?.text).toMatch(/- \[x\] Migration/)
    expect(textAfter(edit, '/q/tasks/todo.md')).toBe(null)
    expect(textAfter('{oops "toolUseResult"', path)).toBe(null)
    const h = historyFromLogs([write, `${edit}\nnot json`], path, parseTasks(TODO_T2_DONE))
    expect(h.snaps.map(s => `${s.day}:${s.done}`)).toEqual(['2026-10-01:1', '2026-10-02:1'])
    expect(h.doneDays).toEqual({ 'T1|Monorepo scaffold': '2026-10-01' })
  })
})

describe('timeline dates and steps (F1, H3)', () => {
  test('the day each task was first committed done', async () => {
    const { log, cat } = gitOutput([
      ['2026-10-08', TODO_T3_DONE],
      ['2026-10-03', TODO_T2_DONE],
      ['2026-10-01', TODO_TEMPLATE],
      ['2026-09-29', TODO_NONE_DONE],
    ])
    expect(doneDaysFromGit(parseLog(log), splitBatch(cat), parseTasks(TODO_T3_DONE))).toEqual({
      'T1|Monorepo scaffold': '2026-10-01',
      'T2|Prisma schema for keys': '2026-10-03',
      'T3|Issue and revoke keys': '2026-10-08',
    })
  })

  test('done days, then ≈ days for open tasks at the median pace; × for a failed test run', async () => {
    const list = parseTasks(TODO_T2_DONE)
    const fc = { kind: 'range', optimistic: '2026-10-11', median: '2026-10-13', slow: '2026-10-19', basis: '', added: 0 } as const
    const dates = taskDates(list, { 'T1|Monorepo scaffold': '2026-10-01', 'T2|Prisma schema for keys': '2026-10-03' }, fc, '2026-10-09')
    expect(dates).toEqual({
      T1: { day: '2026-10-01', isEstimate: false },
      T2: { day: '2026-10-03', isEstimate: false },
      T3: { day: '2026-10-11', isEstimate: true },
      T4: { day: '2026-10-13', isEstimate: true },
    })
    expect(taskDates(list, {}, null, '2026-10-09')).toEqual({})
    const rows = timelineRows(list, { dates, failed: 'T3' })
    expect(rows.map(r => [r.kind, r.date, r.kind === 'task' ? `${r.glyph} ${r.id} ${r.detail}` : r.text])).toEqual([
      ['phase', '3 Oct', 'Phase 1: Foundation'],
      ['task', '1 Oct', '✓ T1 3/3'],
      ['task', '3 Oct', '✓ T2 3/3'],
      ['checkpoint', '3 Oct', 'Checkpoint: After Tasks 1-2 (needs you)'],
      ['phase', '≈13 Oct', 'Phase 2: Core'],
      ['task', '≈11 Oct', '× T3 tests failed'],
      ['task', '≈13 Oct', '○ T4 '],
    ])
  })

  test('tool calls as build, test and commit', async () => {
    expect(stepOf('Edit', { file_path: '/p/src/keys.ts' })).toBe('build')
    expect(stepOf('Write', { file_path: '/p/tasks/todo.md' })).toBe(null)
    expect(stepOf('Edit', { file_path: '/p/SPEC-auth.md' })).toBe(null)
    expect(stepOf('Bash', { command: 'pnpm --filter gateway test' })).toBe('test')
    expect(stepOf('Bash', { command: 'npx vitest run keys' })).toBe('test')
    expect(stepOf('Bash', { command: 'cd api && go test ./...' })).toBe('test')
    expect(stepOf('Bash', { command: 'git add -A && git commit -m "T3"' })).toBe('commit')
    expect(stepOf('Bash', { command: 'ls src' })).toBe(null)
    expect(stepOf('Read', { file_path: '/p/src/keys.ts' })).toBe(null)
    expect(spinnerWord('test', 'T4')).toBe('Testing T4')
    expect(spinnerWord('build', null)).toBe('Building')
    expect(spinnerWord(null, 'T4')).toBe('Working on T4')
    expect(spinnerWord(null, null)).toBe(null)
  })
})

describe('digest (G2)', () => {
  test('four lines: progress, forecast, this week, decisions', async () => {
    const snapshots = [
      { day: '2026-09-30', done: 0, total: 4 },
      { day: '2026-10-03', done: 0, total: 4 },
      { day: '2026-10-05', done: 1, total: 5 },
      { day: '2026-10-08', done: 1, total: 4 },
      { day: '2026-10-09', done: 1, total: 4 },
    ]
    const text = digestText({
      spec: parseSpec(SPEC),
      list: parseTasks(TODO_TEMPLATE),
      plan: parsePlan(PLAN_INDEX),
      forecast: { kind: 'not-enough', reason: 'not enough history (1 of 3 tasks done since tracking began)' },
      snapshots,
    })
    expect(text.split('\n')).toEqual([
      'API keys: 1/4 tasks done (25%) · now T2 Prisma schema for keys',
      'ETA: not enough history (1 of 3 tasks done since tracking began).',
      // 3–4 Oct nothing done yet, 5–9 Oct one task.
      'This week ▁▁█████ +1 done (3 Oct–9 Oct)',
      'Needs a decision: Upstash or self-hosted Redis?; approve SPEC.md; Should keys expire by default?',
    ])
    expect(sparkline([1, 1, 1])).toBe('▁▁▁')
    expect(sparkline([0, 2, 4])).toBe('▁▅█')
  })
})

describe('charts (F2)', () => {
  const history = [
    { day: '2026-09-29', done: 0, total: 6, doing: 1, blocked: 2 },
    { day: '2026-10-02', done: 2, total: 6, doing: 1, blocked: 1 },
    { day: '2026-10-06', done: 3, total: 8, doing: 2, blocked: 1 },
    { day: '2026-10-09', done: 5, total: 8, doing: 1, blocked: 0 },
  ]

  test('a quiet day carries the day before', async () => {
    const d = daily(history)
    expect(d.length).toBe(11)
    expect(d[2]).toEqual({ ...history[0], day: '2026-10-01' })
    expect(d[10]).toEqual(history[3])
  })

  test('burn-up: braille lines, axis labels and the numbers under it', async () => {
    const fc = forecast(history, Date.parse('2026-10-09T10:00:00Z'))
    expect(fc.kind).toBe('range')
    const c = burnup(history, fc, 60, 10)!
    const { glyphs, colors } = decodeCells(c.cells, 60)
    expect(glyphs.length).toBe(10)
    expect(glyphs.every(r => [...r].length === 60)).toBe(true)
    expect(glyphs[0]).toMatch(/^ 8 ┤/)
    expect(glyphs[7]).toMatch(/^ 0 ┤/)
    expect(glyphs[8]).toMatch(/^   └─+$/)
    expect(glyphs[9]).toMatch(/29 Sep.*9 Oct/)
    const plot = glyphs.slice(0, 8).join('')
    expect([...plot].some(ch => ch >= '\u2801' && ch <= '\u28ff')).toBe(true)
    const fgs = new Set(colors.flat().map(([fg]) => fg))
    expect(fgs.has(COLOR.done)).toBe(true)
    expect(fgs.has(COLOR.scope)).toBe(true)
    expect(c.legend).toMatch(/^done 5 \(green\) · scope 8 \(\+2\) \(grey\) · forecast ≈ \d+ \w{3}, \d+ \w{3}–\d+ \w{3} \(dotted\)$/)
  })

  test('flow: half-blocks stacked done, in progress, blocked, to do', async () => {
    const c = flow(history, 30, 8)!
    const { glyphs, colors } = decodeCells(c.cells, 30)
    // Last day: 5 done of 8, so the bottom of the last column is done, the top to do.
    const lastCol = colors.slice(0, 6).map(r => r[29]!)
    expect(lastCol[5]).toEqual([COLOR.done, COLOR.done])
    expect(lastCol[0]).toEqual([COLOR.todo, COLOR.todo])
    // First day: nothing done, so the bottom row is in progress.
    expect(colors[5]![4]![1]).toBe(COLOR.doing)
    expect(glyphs[7]).toMatch(/29 Sep.*9 Oct/)
    expect(c.legend).toBe('9 Oct: 5 done · 1 in progress · 0 blocked · 2 to do (bottom to top: green, amber, red, grey)')
  })

  test('SVG for desktop (F4): a tooltip per day, direct labels, a legend, both themes', async () => {
    const fc = forecast(history, Date.parse('2026-10-09T10:00:00Z'))
    const up = burnupSvg(history, fc)!
    expect(up.source.length).toBeLessThan(131072)
    expect(up.source.match(/<title>/g)?.length).toBe(11)
    expect(up.source).toMatch(/<title>1 Oct: 0 done of 6<\/title>/)
    expect(up.source).toMatch(/>done 5<\/text>/)
    expect(up.source).toMatch(/>scope 8<\/text>/)
    expect(up.source).toMatch(/>ETA \d+ \w{3}<\/text>/)
    expect(up.source).toMatch(/prefers-color-scheme:dark/)
    expect(up.alt).toMatch(/^Burn-up: 5 of 8 tasks done by 9 Oct, from 6 in scope on 29 Sep, forecast/)
    const fl = flowSvg(history)!
    expect(fl.source).toMatch(/>in progress 1<\/text>/)
    expect(fl.alt).toBe('Flow on 9 Oct: 5 done, 1 in progress, 0 blocked, 2 to do.')
    expect(burnupSvg(history.slice(0, 1), null)).toBe(null)
  })

  test('no chart from under two days, and base64 as the Raster expects', async () => {
    expect(burnup(history.slice(0, 1), null, 60, 10)).toBe(null)
    expect(flow([], 60, 8)).toBe(null)
    const bytes = Uint8Array.from([0x88, 0x25, 0, 0, 0, 0x88, 0xff, 0, 0, 0, 0, 1, 7])
    expect(toBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)))
  })
})

describe('forecast', () => {
  const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}`
  const now = Date.parse('2026-10-12T10:00:00Z')

  test('under 3 tasks done says not enough history', async () => {
    const h: Snapshot[] = [
      { day: day(1), done: 0, total: 9 },
      { day: day(5), done: 2, total: 9 },
    ]
    const f = forecast(h, now)
    expect(f.kind).toBe('not-enough')
    expect(forecastText(f)).toMatch(/not enough history/)
  })

  test('a range with basis, ordered optimistic ≤ median ≤ slow, and added scope', async () => {
    let h: Snapshot[] = []
    h = record(h, { day: day(1), done: 0, total: 7 })
    h = record(h, { day: day(6), done: 2, total: 8 })
    h = record(h, { day: day(12), done: 4, total: 9 })
    const f = forecast(h, now)
    expect(f.kind).toBe('range')
    if (f.kind === 'range') {
      expect(f.optimistic <= f.median && f.median <= f.slow).toBe(true)
      expect(f.basis).toBe('from 4 tasks in 11 days')
      expect(f.added).toBe(2)
      expect(forecastText(f)).toBe(`ETA ${shortDay(f.median)} (fast ${shortDay(f.optimistic)}, slow ${shortDay(f.slow)}) · from 4 tasks in 11 days · +2 added since tracking began`)
    }
  })

  test('record keeps one snapshot per day', async () => {
    const h = record([{ day: day(1), done: 0, total: 3 }], { day: day(1), done: 1, total: 3 })
    expect(h).toEqual([{ day: day(1), done: 1, total: 3 }])
  })
})

describe('views', () => {
  test('status entry and band', async () => {
    const list = parseTasks(TODO_TEMPLATE)
    expect(statusText(parseSpec(SPEC), list)).toBe('spec ♦ awaiting approval · plan 1/4')
    expect(statusText(parseSpec(SPEC.replace('draft', 'approved')), list)).toBe('spec ✓ approved · plan 1/4')
    expect(statusText(null, null)).toBe(undefined)
    expect(bandText(list)).toBe('● T2 Prisma schema for keys · 2 criteria left · 1/4 done · checkpoint after this task')
    expect(bandText(null)).toBe(undefined)
    expect(bandText(parseTasks(TODO_TEMPLATE.replace(/- \[ \]/g, '- [x]')))).toBe(undefined)
  })

  test('/progress next names the task, its criteria and the checkpoint', async () => {
    const text = nextText(parseTasks(TODO_TEMPLATE), null)
    expect(text).toMatch(/^Next: T2 Prisma schema for keys/)
    expect(text).toMatch(/\[ \] Migration runs on a clean database/)
    expect(text).toMatch(/Checkpoint after this task: After Tasks 1-2/)
    expect(nextText(null, null)).toMatch(/Run \/plan/)
  })

  test('completion toast: checkpoint first, one per edit, none for unticking (B4)', async () => {
    const [t0, t2, cp, t3] = [TODO_TEMPLATE, TODO_T2_DONE, TODO_CP_DONE, TODO_T3_DONE].map(parseTasks)
    expect(completionToast(t0!, t2!)).toBe('♦ Checkpoint reached: After Tasks 1-2 · All tests pass · Review with human before proceeding')
    expect(completionToast(cp!, t3!)).toBe('✓ T3 done Issue and revoke keys · Next: T4 Rate limit per key')
    // Ticking the checkpoint's own boxes finishes no task.
    expect(completionToast(t2!, cp!)).toBe(undefined)
    expect(completionToast(t3!, cp!)).toBe(undefined)
    expect(completionToast(null, t3!)).toBe(undefined)
    // A new plan that reuses T1..Tn is not progress on the old one.
    expect(completionToast(t0!, parseTasks(PLAN_INDEX))).toBe(undefined)
    const all = TODO_T3_DONE.replace(/- \[ \]/g, '- [x]')
    expect(completionToast(t3!, parseTasks(all))).toBe('✓ T4 done Rate limit per key · all tasks done')
  })

  test('block chain follows undone dependencies (C1)', async () => {
    const list = parseTasks(
      '## Task 1: A\n- [x] a\n## Task 2: B\n- [ ] b\n## Task 3: C\n**Dependencies:** Task 2\n- [ ] c\n## Task 4: D\n**Dependencies:** Task 1, Task 3\n- [ ] d\n',
    )
    const t4 = list.tasks.find(t => t.id === 'T4')!
    expect(blockChain(list, t4)).toBe('T4 ← T3 ← T2')
  })

  test('progress brief: the facts the model answers from (C1)', async () => {
    const list = parseTasks(TODO_TEMPLATE)
    const brief = progressBrief({
      spec: parseSpec(SPEC),
      list,
      plan: parsePlan(PLAN_INDEX),
      listFile: 'tasks/todo.md',
      forecast: null,
    })!
    const lines = brief.split('\n').slice(2)
    expect(lines).toEqual([
      'SPEC.md: awaiting approval; Project structure empty, Code style missing; weak: Objective: no success criteria.',
      '- open question (SPEC.md): Should keys expire by default?',
      'tasks/todo.md: 1/4 tasks done.',
      '- current: T2 Prisma schema for keys (Phase 1: Foundation); open: Migration runs on a clean database; Tests pass: pnpm test keys',
      '- checkpoint after T2: After Tasks 1-2 (All tests pass; Review with human before proceeding)',
      '- waiting: T3 Issue and revoke keys, chain T3 ← T2',
      '- not started: T4 Rate limit per key',
      '- open question (tasks/plan.md): Upstash or self-hosted Redis?',
    ])
    expect(progressBrief({ spec: null, list: null, plan: null, listFile: null, forecast: null })).toBe(undefined)
  })

  test('the task a prompt is about (C1)', async () => {
    const list = parseTasks(TODO_TEMPLATE)
    expect(taskInPrompt('why is T3 blocked?', list)).toBe('T3')
    expect(taskInPrompt('what about task 4', list)).toBe('T4')
    expect(taskInPrompt("what's left before the checkpoint?", list)).toBe('T2')
    expect(taskInPrompt('where are we', list)).toBe('T2')
    expect(taskInPrompt('fix the lint errors', list)).toBe(null)
    expect(taskInPrompt('is T9 done', list)).toBe(null)
    expect(taskInPrompt('why is T3 blocked?', null)).toBe(null)
  })

  test('timeline rows: phases, glyphs and a checkpoint that needs you', async () => {
    const done12 = TODO_TEMPLATE.replace('- [ ] Migration', '- [x] Migration').replace('- [ ] Tests pass: `pnpm test keys`', '- [x] Tests pass: `pnpm test keys`')
    const rows = timelineRows(parseTasks(done12))
    const text = rows.map(r => (r.kind === 'task' ? `${r.glyph} ${r.id}` : r.kind === 'phase' ? `# ${r.text}` : `${r.glyph} ${r.text}`))
    expect(text).toEqual([
      '# Phase 1: Foundation',
      '✓ T1',
      '✓ T2',
      '♦ Checkpoint: After Tasks 1-2 (needs you)',
      '# Phase 2: Core',
      '● T3',
      '○ T4',
    ])
  })
})

describe('spec gate (D2)', () => {
  test('source files are code, not specs, plans or docs', async () => {
    expect(isSourceFile('/p', '/p/src/keys.ts')).toBe(true)
    expect(isSourceFile('/p', 'services/gateway/main.py')).toBe(true)
    expect(isSourceFile('/p', '/p/SPEC.md')).toBe(false)
    expect(isSourceFile('/p', '/p/tasks/todo.md')).toBe(false)
    expect(isSourceFile('/p', '/p/specs/auth.md')).toBe(false)
    expect(isSourceFile('/p', '/p/docs/adr/001.json')).toBe(false)
    expect(isSourceFile('/p', '/elsewhere/x.ts')).toBe(false)
  })

  test('warns only while a spec awaits approval', async () => {
    const draft = parseSpec(SPEC)
    const w = gateWarning({ cwd: '/p', path: '/p/src/keys.ts', spec: draft, specFile: 'SPEC.md', hasPlan: false })
    expect(w?.toast).toBe('♦ Spec gate · src/keys.ts changed while SPEC.md awaits approval')
    expect(w?.context).toMatch(/warning only; the edit went through/)
    // Approved in front matter, inferred from a plan, no spec, or not source: nothing.
    expect(gateWarning({ cwd: '/p', path: '/p/src/a.ts', spec: parseSpec(SPEC.replace('status: draft', 'status: approved')), specFile: 'SPEC.md', hasPlan: false })).toBe(null)
    expect(gateWarning({ cwd: '/p', path: '/p/src/a.ts', spec: parseSpec(GOOD_SPEC), specFile: 'SPEC.md', hasPlan: true })).toBe(null)
    expect(gateWarning({ cwd: '/p', path: '/p/src/a.ts', spec: null, specFile: null, hasPlan: false })).toBe(null)
    expect(gateWarning({ cwd: '/p', path: '/p/README.md', spec: draft, specFile: 'SPEC.md', hasPlan: false })).toBe(null)
  })
})
