// The run timeline (F1, mockup 11): the whole plan as one tree, from the spec's
// approval to /review → /ship, with a three-step build · test · commit bar per
// task and an ETA header with its slow case. Drawn as rows of coloured segments
// so the pane and the script (E2) share one layout. Pure.

import { shortDay, type Forecast } from './forecast'
import type { PlanDoc, Spec, Task, TaskList } from './parse'
import { phaseLabel, specApproval, type TaskDate } from './view'

export type SegTone = 'text' | 'strong' | 'muted' | 'done' | 'run' | 'bad' | 'needsYou' | 'accent'
export type Seg = { text: string; tone: SegTone }
export type Line = Seg[]

export type TimelineInput = {
  spec: Spec | null
  list: TaskList
  plan: PlanDoc | null
  forecast: Forecast | null
  dates: Record<string, TaskDate>
  today: string
  /** The first day of the history, when the front matter does not say when the plan began. */
  since?: string
  failed?: string | null
  /** From the project: commits since the plan began, the last test run, the last review. */
  facts?: { commits?: number; tests?: { passed: number; failed: number }; reviewed?: string }
}

const DAY = 86_400_000
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY)
const ago = (n: number) => (n <= 0 ? 'today' : `${n}d ago`)
const DATE_W = 9
const s = (text: string, tone: SegTone = 'text'): Seg => ({ text, tone })
const date = (d: TaskDate | string | undefined | null) => {
  if (!d) return s(' '.repeat(DATE_W))
  const t = typeof d === 'string' ? shortDay(d) : `${d.isEstimate ? '≈' : ''}${shortDay(d.day)}`
  return s(t.padEnd(DATE_W), 'muted')
}
const STEP_WORD = { build: 'building', test: 'testing', commit: 'committing' } as const

/** The three-step bar: what is done of build · test · commit, the step running, what is to come. */
function stepBar(t: Task, isCurrent: boolean, slow: boolean): Seg[] {
  if (t.status === 'done') return [s('▬▬▬', 'done')]
  if (!isCurrent) return [s('▫▫▫', 'muted')]
  const at = t.state?.step === 'commit' ? 2 : t.state?.step === 'test' ? 1 : 0
  const out: Seg[] = []
  if (at > 0) out.push(s('▬'.repeat(at), 'done'))
  out.push(s('▬', slow ? 'bad' : 'run'))
  if (at < 2) out.push(s('▫'.repeat(2 - at), 'muted'))
  return out
}

/** The open question that names a task, short: `Q2, Upstash or self-hosted?`. */
function question(t: Task): string {
  const q = (t.blockedBy ?? '').replace(/^[^:]+\.md: /, '')
  const id = /^\s*(Q\d+)\b\s*(?:\([^)]*\))?\s*[:.\-–—]?\s*(.*)$/.exec(q)
  return id ? `${id[1]}, ${id[2]}` : q
}

/**
 * The timeline: a header (name, size, ETA with its slow case, commits, tests,
 * last review), then the milestones and phases as a tree, then the legend.
 */
export function timeline(input: TimelineInput): { header: Line[]; rows: Line[]; legend: Line[] } {
  const { spec, list, forecast: fc, dates, today } = input
  const range = fc?.kind === 'range' ? fc : null
  const phases: { name: string | null; tasks: Task[] }[] = []
  for (const t of list.tasks) {
    const last = phases[phases.length - 1]
    if (last && last.name === t.phase) last.tasks.push(t)
    else phases.push({ name: t.phase, tasks: [t] })
  }
  const named = phases.filter(p => p.name !== null).length
  const checkpoints = list.tasks.filter(t => t.checkpoint).length
  const approval = specApproval(spec, true)
  const name = list.meta?.plan ?? (spec?.title ? spec.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'plan')
  const began = list.meta?.created ?? input.plan?.created ?? input.since ?? today
  const sinceStart = Math.max(0, days(began, today))
  // How long a task takes at this pace, for "slow": over twice that and still running.
  const pace = list.done > 0 ? Math.max(1, sinceStart / list.done) : null

  const header: Line[] = []
  const head: Seg[] = [s(name, 'strong'), s(`  ${list.total} tasks${named ? ` · ${named} phases` : ''}`, 'muted')]
  if (spec) head.push(s(' · spec ', 'muted'), approval === 'approved' ? s('✓ approved', 'done') : s('♦ awaiting approval', 'needsYou'))
  header.push(head)
  if (fc?.kind === 'done') header.push([s(`${sinceStart}d in · `, 'muted'), s('all tasks done → /review', 'strong')])
  else if (range) {
    const left = Math.max(0, days(today, range.median))
    header.push([
      s(`${sinceStart}d in · `, 'muted'),
      s(`about ${left} day${left === 1 ? '' : 's'} to go → ${checkpoints ? `checkpoint ${checkpoints}` : 'last task'} ≈ ${shortDay(range.median)}`, 'strong'),
      s(`  (slow case ${shortDay(range.slow)})`, 'muted'),
    ])
  } else header.push([s(`${sinceStart}d in · `, 'muted'), s(fc?.kind === 'not-enough' ? `no ETA yet: ${fc.reason}` : 'no ETA yet', 'muted')])
  const facts = input.facts
  if (facts && (facts.commits !== undefined || facts.tests || facts.reviewed)) {
    const line: Seg[] = []
    if (facts.commits !== undefined) line.push(s('Commits: ', 'muted'), s(String(facts.commits), 'strong'))
    if (facts.tests) {
      if (line.length) line.push(s(', ', 'muted'))
      line.push(facts.tests.failed > 0 ? s(`tests ${facts.tests.failed} failing`, 'bad') : s(`tests ${facts.tests.passed} passing`, 'muted'))
    }
    if (facts.reviewed) line.push(s(`${line.length ? ' · ' : ''}last /review ${ago(days(facts.reviewed, today))}`, 'muted'))
    header.push(line)
  }

  const rows: Line[] = []
  const pipe = (): Line => [date(null), s('│', 'muted')]
  rows.push([date(spec?.approvedOn ?? null), approval === 'approved' ? s('✓', 'done') : s('♦', 'needsYou'), s(approval === 'approved' ? ' spec approved' : ' spec awaiting approval', approval === 'approved' ? 'text' : 'needsYou')])
  rows.push(pipe())
  rows.push([date(input.plan?.approvedOn ?? list.meta?.created ?? null), s('✓', 'done'), s(' plan  ', 'text'), s(`${list.total} tasks · ${checkpoints} checkpoint${checkpoints === 1 ? '' : 's'}`, 'muted')])
  rows.push(pipe())

  const titleW = Math.min(28, Math.max(...list.tasks.map(t => t.title.length)))
  let cpNo = 0
  phases.forEach((p, pi) => {
    const done = p.tasks.filter(t => t.status === 'done').length
    const isCurrent = p.tasks.some(t => t.id === list.current?.id)
    const lastDate = (() => {
      const last = p.tasks[p.tasks.length - 1]
      return last ? dates[last.id] : undefined
    })()
    const pg = done === p.tasks.length ? s('✓', 'done') : isCurrent ? s('●', 'run') : s('○', 'muted')
    if (p.name !== null) {
      rows.push([date(lastDate), s('├─ ', 'muted'), pg, s(` ${phaseLabel(p.name)}`, 'strong'), s(`  ${done} of ${p.tasks.length}${done === p.tasks.length || isCurrent ? ' done' : ''}`, 'muted')])
    }
    p.tasks.forEach((t, ti) => {
      const isLast = ti === p.tasks.length - 1
      const branch = p.name !== null ? s(`│  ${isLast ? '└─' : '├─'} `, 'muted') : s(isLast ? '└─ ' : '├─ ', 'muted')
      const isCur = t.id === list.current?.id
      const isFailed = t.status !== 'done' && input.failed === t.id
      const started = t.state?.started
      const runDays = started ? Math.max(0, days(started, today)) : 0
      const slow = isCur && pace !== null && started !== undefined && runDays > pace * 2
      const glyph: Seg = isFailed
        ? s('×', 'bad')
        : t.status === 'done'
          ? s('✓', 'done')
          : t.status === 'blocked'
            ? s('♦', 'needsYou')
            : isCur
              ? s('●', slow ? 'bad' : 'run')
              : t.status === 'waiting'
                ? s('◌', 'muted')
                : s('○', 'muted')
      const row: Seg[] = [date(null), branch, glyph, s(' '), s(t.id, 'strong'), s(` ${t.title.length > titleW ? `${t.title.slice(0, titleW - 1)}…` : t.title.padEnd(titleW)}  `)]
      const d = dates[t.id]
      if (t.status === 'blocked') row.push(s(`needs you: ${question(t)}`, 'needsYou'))
      else if (t.status === 'done') row.push(...stepBar(t, false, false), s(` done${d && !d.isEstimate ? ` ${shortDay(d.day)}` : ''}`, 'done'))
      else if (isCur) {
        row.push(...stepBar(t, true, slow), s(' '))
        row.push(
          isFailed
            ? s('tests failed', 'bad')
            : s(`${STEP_WORD[t.state?.step ?? 'build']} · ${runDays === 0 ? 'today' : `${runDays}d`}`, slow ? 'bad' : 'run'),
        )
        if (d?.isEstimate) row.push(s(`  done ≈${shortDay(d.day)}`, 'muted'))
      } else {
        const dep = t.deps.find(x => list.tasks.some(o => o.id === x && o.status !== 'done'))
        if (dep) row.push(s(`after ${dep}  `, 'muted'))
        row.push(...stepBar(t, false, false))
        const prev = dep ? dates[dep] : undefined
        if (prev) row.push(s(` starts ≈${shortDay(prev.day)}`, 'muted'))
        else if (d?.isEstimate) row.push(s(` ≈${shortDay(d.day)}`, 'muted'))
      }
      rows.push(row)
      if (t.checkpoint) {
        cpNo++
        const items = t.checkpoint.items
        const isDone = items.length > 0 && items.every(b => b.isDone)
        const isDue = t.status === 'done' && !isDone
        const what = items.map(b => b.text.replace(/^All tests pass$/i, 'tests').replace(/^Application builds.*$/i, 'build').replace(/^Review with human.*$/i, 'review with you')).join(' · ')
        rows.push([
          date(dates[t.id] ?? null),
          s('├─ ', 'muted'),
          isDone ? s('✓', 'done') : isDue ? s('♦', 'needsYou') : s('○', 'muted'),
          s(` checkpoint ${cpNo}`, isDue ? 'needsYou' : isDone ? 'text' : 'muted'),
          s(`   ${isDue ? `needs you: ${what}` : what}`, isDue ? 'needsYou' : 'muted'),
        ])
      }
    })
    if (pi < phases.length - 1) rows.push(pipe())
  })
  rows.push(pipe())
  const allDone = list.total > 0 && list.done === list.total
  rows.push([date(null), allDone ? s('●', 'run') : s('○', 'muted'), s(' /review → /ship', allDone ? 'strong' : 'muted')])

  const legend: Line[] = [
    [s('▬▬▬', 'muted'), s(' build · test · commit', 'muted')],
    [
      s('■', 'done'),
      s(' done  ', 'done'),
      s('■', 'run'),
      s(' running  ', 'run'),
      s('■', 'bad'),
      s(' slow  ', 'bad'),
      s('×', 'bad'),
      s(' failed  ', 'bad'),
      s('♦', 'needsYou'),
      s(' needs you  ', 'needsYou'),
      s('▫', 'muted'),
      s(' to come  ', 'muted'),
      s('◌', 'muted'),
      s(' waits on another task', 'muted'),
    ],
  ]
  return { header, rows, legend }
}

/** A line's plain text, for tests and for surfaces that draw no colour. */
export const plain = (line: Line) => line.map(x => x.text).join('')
