import { describe, expect, test } from 'claude-code/testing'

import { parsePlan, parseSpec, parseTasks, withBlockers } from '../hooks/lib/parse'
import { checkOverwrite } from '../hooks/lib/guard'
import { gateWarning, isSourceFile } from '../hooks/lib/gate'
import { editorArgvs, withStatus } from '../hooks/lib/specedit'
import { burnupPixels, dateRow, drawsPixels, encodePng, flowPixels } from '../hooks/lib/pixels'
import { gather, renderBrief, renderCli, renderJson, type CliIo } from '../hooks/lib/cli'
import { areaSummary, runnableCount } from '../hooks/lib/view'
import { applyEdit, editBetween, parseStatusLine, planName, readFrontMatter, setFrontMatter, stampDoc, stampTodo, statusLine, taskStates } from '../hooks/lib/format'
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
import { burnup, COLOR, daily, flow, revealCells, toBase64 } from '../hooks/lib/chart'
import { meterCells } from '../hooks/ui/meter'
import { bandText, blockChain, taskDates, completionToast, forecastText, progressBrief, taskInPrompt, nextText, statusText, timelineRows, specCandidates, specFiles, specOfPath } from '../hooks/lib/view'
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
    expect(statusText(parseSpec(SPEC), list)).toBe('spec ♦ awaiting approval · plan ██░░░░░░░ 1/4')
    expect(statusText(parseSpec(SPEC.replace('draft', 'approved')), list)).toBe('spec ✓ approved · plan ██░░░░░░░ 1/4')
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
    expect(completionToast(cp!, t3!)).toBe('✓ T3 done · Issue and revoke keys\nNext: T4 Rate limit per key')
    // Ticking the checkpoint's own boxes finishes no task.
    expect(completionToast(t2!, cp!)).toBe(undefined)
    expect(completionToast(t3!, cp!)).toBe(undefined)
    expect(completionToast(null, t3!)).toBe(undefined)
    // A new plan that reuses T1..Tn is not progress on the old one.
    expect(completionToast(t0!, parseTasks(PLAN_INDEX))).toBe(undefined)
    const all = TODO_T3_DONE.replace(/- \[ \]/g, '- [x]')
    expect(completionToast(t3!, parseTasks(all))).toBe('✓ T4 done · Rate limit per key\nAll tasks done')
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

describe('spec pane actions (A1)', () => {
  test('approval goes into front matter, the rest of the file untouched', async () => {
    expect(withStatus('# Spec: X\n\nbody\n', 'approved')).toBe('---\nstatus: approved\n---\n# Spec: X\n\nbody\n')
    expect(withStatus('---\nstatus: draft\nowner: me\n---\n# X\n', 'approved')).toBe('---\nstatus: approved\nowner: me\n---\n# X\n')
    expect(withStatus('---\nowner: me\n---\n# X\n', 'approved')).toBe('---\nowner: me\nstatus: approved\n---\n# X\n')
    expect(withStatus('---\r\nstatus: approved\r\n---\r\n# X\r\n', 'draft')).toBe('---\r\nstatus: draft\r\n---\r\n# X\r\n')
    expect(parseSpec(withStatus(SPEC, 'approved')).status).toBe('approved')
    expect(parseSpec(withStatus(GOOD_SPEC, 'draft')).title).toBe(parseSpec(GOOD_SPEC).title)
  })

  test('a windowed editor first, without --wait; a terminal editor is skipped for the default app', async () => {
    expect(editorArgvs({ visual: 'code --wait', editor: 'vim' }, '/p/SPEC.md')[0]).toEqual(['code', '/p/SPEC.md'])
    expect(editorArgvs({ editor: '/usr/local/bin/zed' }, '/p/SPEC.md')[0]).toEqual(['/usr/local/bin/zed', '/p/SPEC.md'])
    expect(editorArgvs({ editor: 'nvim' }, '/p/SPEC.md')[0]).toEqual(['open', '/p/SPEC.md'])
    expect(editorArgvs({}, '/p/SPEC.md')).toHaveLength(3)
  })
})

describe('module specs under specs/ (A3)', () => {
  test('SPEC.md first, root module specs, then specs/<module>.md; READMEs are not specs', async () => {
    expect(specFiles(['SPEC-b.md', 'README.md', 'SPEC.md'], ['payments.md', 'README.md', 'auth.md', 'notes.txt'])).toEqual([
      'SPEC.md',
      'SPEC-b.md',
      'specs/auth.md',
      'specs/payments.md',
    ])
  })

  test('/spec-view arguments and written paths', async () => {
    expect(specCandidates('auth')).toEqual(['specs/auth.md', 'SPEC-auth.md'])
    expect(specCandidates('SPEC-auth.md')).toEqual(['SPEC-auth.md'])
    expect(specCandidates('auth.md')).toEqual(['auth.md', 'specs/auth.md'])
    expect(specCandidates('specs/auth.md')).toEqual(['specs/auth.md'])
    expect(specOfPath('/p/specs/auth.md')).toBe('specs/auth.md')
    expect(specOfPath('/p/SPEC-auth.md')).toBe('SPEC-auth.md')
    expect(specOfPath('/p/specs/README.md')).toBe(null)
    expect(specOfPath('/p/src/auth.md')).toBe(null)
  })
})

describe('pixel charts (F3)', () => {
  const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
  const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer).getUint32(at)
  const history = [
    { day: '2026-10-01', done: 0, total: 4, doing: 1, blocked: 1 },
    { day: '2026-10-05', done: 2, total: 5, doing: 1, blocked: 0 },
  ]

  test('a PNG: signature, IHDR with the size, then IDAT and an IEND with its known CRC', async () => {
    const png = encodePng(3, 2, new Uint8Array(3 * 2 * 4).fill(200))
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(String.fromCharCode(...png.slice(12, 16))).toBe('IHDR')
    expect([u32(png, 16), u32(png, 20)]).toEqual([3, 2])
    expect(String.fromCharCode(...png.slice(37, 41))).toBe('IDAT')
    expect(u32(png, png.length - 4)).toBe(0xae426082)
  })

  test('charts paint at the asked size, small enough to send, with ticks, dates and alt text', async () => {
    const fc = { kind: 'range' as const, optimistic: '2026-10-12', median: '2026-10-15', slow: '2026-10-20', basis: 'x', added: 1 }
    const up = burnupPixels(history, fc, 480, 144)!
    const png = fromB64(up.png)
    expect([u32(png, 16), u32(png, 20)]).toEqual([480, 144])
    expect(png.length).toBeLessThan(480 * 144) // far under the raw 4 bytes a pixel
    expect(up.ticks).toEqual([5, 3, 0])
    expect(up.dates.map(d => d.label)).toEqual(['1 Oct', '5 Oct', '20 Oct'])
    expect(up.alt).toBe('Burn-up: 2 of 5 tasks done by 5 Oct, forecast 15 Oct (12 Oct to 20 Oct).')
    expect(flowPixels(history, 480, 112)!.alt).toBe('Flow on 5 Oct: 2 done, 1 in progress, 0 blocked, 2 to do.')
    expect(burnupPixels(history.slice(0, 1), null, 480, 144)).toBe(null)
  })

  test('date row: centred where each falls, never overlapping', async () => {
    expect(dateRow([{ label: '1 Oct', at: 0 }, { label: '20 Oct', at: 1 }], 20)).toBe('1 Oct         20 Oct')
    expect(dateRow([{ label: '1 Oct', at: 0 }, { label: '2 Oct', at: 0.05 }], 20)).toBe('1 Oct')
  })

  test('kitty and Ghostty draw pictures; tmux and other terminals do not', async () => {
    expect(drawsPixels({ term: 'xterm-kitty' })).toBe(true)
    expect(drawsPixels({ termProgram: 'ghostty' })).toBe(true)
    expect(drawsPixels({ term: 'xterm-256color', kitty: '1' })).toBe(true)
    expect(drawsPixels({ term: 'xterm-ghostty', tmux: '/tmp/tmux-501/default,1,0' })).toBe(false)
    expect(drawsPixels({ term: 'xterm-256color', termProgram: 'Apple_Terminal' })).toBe(false)
  })
})

describe('the progress script for other agents (E2)', () => {
  const NOW = Date.parse('2026-10-09T10:00:00Z')
  const io = (files: Record<string, string>, run?: CliIo['run']): CliIo => ({
    cwd: '/work/keys',
    now: NOW,
    read: async rel => files[rel] ?? null,
    list: async rel => Object.keys(files).filter(f => (rel ? f.startsWith(`${rel}/`) && !f.slice(rel.length + 1).includes('/') : !f.includes('/'))).map(f => f.split('/').pop()!),
    run,
  })
  const git = (copies: [string, string | null][]): CliIo['run'] => {
    const out = gitOutput(copies)
    return async argv => ({ exitCode: 0, stdout: argv[1] === 'log' ? (argv.some(a => a.includes('%B')) ? '' : out.log) : out.cat, stderr: '' })
  }

  test('same parse as the mod: spec, task list, history from git and an ETA range', async () => {
    const s = await gather(
      io({ 'SPEC.md': SPEC, 'tasks/todo.md': TODO_T3_DONE }, git([['2026-10-08', TODO_T3_DONE], ['2026-10-03', TODO_T2_DONE], ['2026-09-29', TODO_NONE_DONE]])),
    )
    expect(s.specFile).toBe('SPEC.md')
    expect([s.list?.done, s.list?.total, s.list?.current?.id]).toEqual([3, 4, 'T4'])
    expect(s.forecast?.kind).toBe('range')
    expect(s.history).toBe('history since 29 Sep: 3 days from git')
    expect(s.dates.T3).toEqual({ day: '2026-10-08', isEstimate: false })
  })

  test('plain text: a framed header, then spec, tasks, next and what needs you under rules', async () => {
    const s = await gather(io({ 'SPEC.md': SPEC, 'tasks/todo.md': TODO_TEMPLATE }))
    const text = renderCli(s, { color: false, width: 72 })
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^╭─ keys ─+╮$/)
    expect(lines[0]!.length).toBe(72)
    expect(lines.every(l => [...l].length <= 72)).toBe(true)
    expect(text).toMatch(/│ agent-skills · API keys +│/)
    expect(text).toMatch(/│ ♦spec ✓plan ●build 1\/4 ○review ○ship +│/)
    expect(text).toMatch(/█+░+  25% 1 of 4 tasks/)
    expect(text).toMatch(/^── Spec · SPEC\.md ─+$/m)
    expect(text).toMatch(/♦ awaiting approval {2}4\/6 core areas/)
    expect(text).toMatch(/^── Tasks · tasks\/todo\.md ─+$/m)
    expect(text).toMatch(/^ {2}Phase 1: Foundation$/m)
    expect(text).toMatch(/^ {4}● T2 Prisma schema for keys · 1\/3$/m)
    expect(text).toMatch(/^── Next · T2 ─+$/m)
    expect(text).toMatch(/^ {4}☐ Migration runs on a clean database$/m)
    expect(text).toMatch(/^ {4}☑ Key table with hashed secret$/m)
    expect(text).toMatch(/^── Needs you · \d+ ─+$/m)
    expect(text).toMatch(/♦ approve SPEC\.md/)
    expect(text).not.toMatch(/\u001b\[/)
  })

  test('colour only when asked: green done, yellow next, magenta needs you', async () => {
    const s = await gather(io({ 'tasks/todo.md': TODO_TEMPLATE }))
    const text = renderCli(s, { color: true, width: 80 })
    expect(text).toContain('\u001b[32m✓\u001b[0m T1')
    expect(text).toContain('\u001b[1;33mT2\u001b[0m')
    // No spec but a plan: the spec gate is behind it, as the mod's status entry says.
    expect(renderBrief(s, { color: false })).toBe('✓spec ✓plan ●build 1/4 ○review ○ship · T2 Prisma schema for keys')
  })

  test('JSON for other tools, and a friendly empty project', async () => {
    const s = await gather(io({ 'specs/limits.md': GOOD_SPEC, 'tasks/todo.md': TODO_TEMPLATE }), { specFile: 'specs/limits.md' })
    const json = JSON.parse(renderJson(s))
    expect(json.spec).toMatchObject({ file: 'specs/limits.md', title: 'Rate limits' })
    expect(json.tasks).toMatchObject({ done: 1, total: 4, current: 'T2' })
    expect(json.tasks.items[1]).toMatchObject({ id: 'T2', status: 'next', open: ['Migration runs on a clean database', 'Tests pass: pnpm test keys'] })
    const empty = renderCli(await gather(io({})), { color: false, width: 60 })
    expect(empty).toMatch(/No SPEC\.md, tasks\/plan\.md or tasks\/todo\.md here\./)
    expect(empty).toMatch(/agent-skills · no plan yet/)
  })
})

describe('motion (bar fill, chart sweep)', () => {
  test('the bar in eighths: whole blocks, one partial cell, then track', async () => {
    expect(meterCells(0, 4)).toEqual({ fill: '', track: '░░░░' })
    expect(meterCells(0.25, 30)).toEqual({ fill: '███████▌', track: '░'.repeat(22) })
    expect(meterCells(1, 4)).toEqual({ fill: '████', track: '' })
    expect(meterCells(2, 4).fill).toBe('████')
  })

  test('a sweep frame clears the plot right of the cut and keeps the axes', async () => {
    const history = [
      { day: '2026-10-01', done: 0, total: 4 },
      { day: '2026-10-09', done: 3, total: 4 },
    ]
    const up = burnup(history, null, 40, 10)!
    expect(revealCells(up.cells, 40, 10, 1)).toBe(up.cells)
    const none = decodeCells(revealCells(up.cells, 40, 10, 0), 40).glyphs
    const full = decodeCells(up.cells, 40).glyphs
    expect(none.slice(0, 8).every(r => r.slice(4).trim() === '')).toBe(true)
    expect(none.slice(0, 8).map(r => r.slice(0, 4))).toEqual(full.slice(0, 8).map(r => r.slice(0, 4)))
    expect(none.slice(8)).toEqual(full.slice(8))
  })
})

describe('progress format (E1)', () => {
  const TODAY = '2026-10-09'

  test('Status lines read and write the same way', async () => {
    expect(parseStatusLine('**Status:** in progress · started 2026-10-08 · step test')).toEqual({ status: 'in progress', started: '2026-10-08', step: 'test' })
    expect(parseStatusLine('**Status:** done · started 2026-10-01 · done 2026-10-02')).toEqual({ status: 'done', started: '2026-10-01', done: '2026-10-02' })
    expect(parseStatusLine('**Status**: Blocked')).toEqual({ status: 'blocked' })
    expect(parseStatusLine('**Description:** x')).toBe(null)
    expect(statusLine({ status: 'in progress', started: '2026-10-08', step: 'build' })).toBe('**Status:** in progress · started 2026-10-08 · step build')
    expect(statusLine({ status: 'done', started: '2026-10-01', done: '2026-10-02', step: 'commit' })).toBe('**Status:** done · started 2026-10-01 · done 2026-10-02')
  })

  test('front matter: set, add, remove; every other byte kept', async () => {
    expect(setFrontMatter('# X\n', { status: 'draft' })).toBe('---\nstatus: draft\n---\n# X\n')
    expect(setFrontMatter('---\nstatus: draft\nowner: me\n---\n# X\n', { status: 'approved', approved: TODAY })).toBe('---\nstatus: approved\nowner: me\napproved: 2026-10-09\n---\n# X\n')
    expect(setFrontMatter('---\nstatus: approved\napproved: 2026-10-01\n---\n# X\n', { status: 'draft', approved: null })).toBe('---\nstatus: draft\n---\n# X\n')
    expect(readFrontMatter('---\nplan: api-keys # short\ncreated: 2026-09-29\n---\nbody').fields).toEqual({ plan: 'api-keys', created: '2026-09-29' })
  })

  test('a task list gets front matter and one Status line per task, from its boxes', async () => {
    const out = stampTodo(TODO_TEMPLATE, TODAY, { plan: planName(TODO_TEMPLATE) })
    expect(out.startsWith('---\nplan: api-keys\ncreated: 2026-10-09\n---\n# Tasks: API keys')).toBe(true)
    expect(taskStates(out)).toEqual({
      T1: { status: 'done', done: TODAY },
      T2: { status: 'in progress', started: TODAY },
      T3: { status: 'todo' },
      T4: { status: 'todo' },
    })
    expect(out).toMatch(/## Task 2: Prisma schema for keys\n\*\*Status:\*\* in progress · started 2026-10-09\n/)
    // Idempotent, and a later day changes nothing already dated.
    expect(stampTodo(out, '2026-10-12')).toBe(out)
  })

  test('changes the plugin saw merge in; ticking the last box makes a task done', async () => {
    const base = stampTodo(TODO_TEMPLATE, '2026-10-01')
    const building = stampTodo(base, TODAY, { changes: { T3: { status: 'in progress', started: TODAY, step: 'build' } } })
    expect(taskStates(building).T3).toEqual({ status: 'in progress', started: TODAY, step: 'build' })
    const ticked = building.replace('- [ ] Migration runs', '- [x] Migration runs').replace('- [ ] Tests pass: `pnpm test keys`', '- [x] Tests pass: `pnpm test keys`')
    expect(taskStates(stampTodo(ticked, TODAY)).T2).toEqual({ status: 'done', started: '2026-10-01', done: TODAY })
    // A done Status line with open boxes goes back to in progress: the boxes are the truth.
    const claimed = base.replace('**Status:** todo', '**Status:** done · done 2026-10-05')
    expect(taskStates(stampTodo(claimed, TODAY)).T3?.status).toBe('in progress')
  })

  test('specs and plans: draft and created when missing, an approval date once approved', async () => {
    expect(readFrontMatter(stampDoc('# Spec: X\n', TODAY)).fields).toEqual({ status: 'draft', created: TODAY })
    expect(readFrontMatter(stampDoc('---\nstatus: approved\ncreated: 2026-09-28\n---\n# X', TODAY)).fields).toEqual({ status: 'approved', created: '2026-09-28', approved: TODAY })
    const done = '---\nstatus: approved\ncreated: 2026-09-28\napproved: 2026-09-29\n---\n# X'
    expect(stampDoc(done, TODAY)).toBe(done)
  })

  test('an Edit grows to carry the Status line it moved, and stays unique', async () => {
    const before = stampTodo(TODO_TEMPLATE, '2026-10-01')
    const after = applyEdit(before, '- [ ] POST /keys returns the secret once', '- [x] POST /keys returns the secret once')!
    const stamped = stampTodo(after, TODAY)
    const edit = editBetween(before, stamped)!
    expect(edit.old_string).toContain('**Status:** todo')
    expect(edit.new_string).toContain('**Status:** done · done 2026-10-09')
    expect(applyEdit(before, edit.old_string, edit.new_string)).toBe(stamped)
    expect(applyEdit('a a', 'a', 'b')).toBe(null)
    expect(editBetween('same', 'same')).toBe(null)
  })

  test('the parser reads the format: state, the task in progress as current, box kinds, dates', async () => {
    const text = stampTodo(TODO_TEMPLATE, '2026-10-01', { plan: 'api-keys' }).replace(/(## Task 4: Rate limit per key\n)\*\*Status:\*\* todo/, '$1**Status:** in progress · started 2026-10-08 · step test')
      .replace('**Status:** in progress · started 2026-10-01', '**Status:** todo')
    const list = parseTasks(text)
    expect(list.meta).toEqual({ plan: 'api-keys', created: '2026-10-01' })
    expect(list.current?.id).toBe('T4')
    expect(list.tasks.find(t => t.id === 'T2')?.status).toBe('todo')
    expect(list.tasks.find(t => t.id === 'T1')?.state).toEqual({ status: 'done', done: '2026-10-01' })
    expect(list.tasks.find(t => t.id === 'T2')?.kinds).toEqual(['criteria', 'criteria', 'verification'])
    const spec = parseSpec('---\nstatus: approved\ncreated: 2026-09-28\napproved: 2026-09-29\n---\n# Spec: X\n')
    expect([spec.status, spec.created, spec.approvedOn]).toEqual(['approved', '2026-09-28', '2026-09-29'])
    expect(parsePlan('---\nstatus: approved\napproved: 2026-09-29\n---\n# Plan').approvedOn).toBe('2026-09-29')
  })
})

describe('spec pane summaries (mockup 8)', () => {
  test('runnable lines, test tool and coverage, short weak reasons', async () => {
    expect(runnableCount('```\npnpm dev\npnpm test\n\n```\n- `pnpm lint`\nRun it')).toBe(3)
    const area = (key: string, body: string, hint: string | null = null) => ({ key, state: 'present', body, hint })
    expect(areaSummary(area('testing', 'Vitest unit tests, 80% coverage'), [])).toEqual({ text: 'vitest · 80%', isWeak: false })
    expect(areaSummary(area('commands', '```\na\nb\nc\nd\n```'), [])).toEqual({ text: '4 runnable', isWeak: false })
    expect(areaSummary(area('objective', 'x'), ['a', 'b', 'c', 'd'])).toEqual({ text: '4 success criteria', isWeak: false })
    expect(areaSummary(area('style', 'x', 'no example code block'), [])).toEqual({ text: 'no example', isWeak: true })
    expect(areaSummary({ key: 'structure', state: 'missing', body: '', hint: null }, [])).toEqual({ text: 'missing', isWeak: true })
  })
})
