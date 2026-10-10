// Plain-text views of the parsed state: the status entry, /progress next, the band line
// and the run timeline rows. Every surface draws these, so they are text only.

import { taskKey, type Spec, type Task, type TaskList, type PlanDoc } from './parse'
import { shortDay, type Forecast } from './forecast'
import type { Backfill } from './history'

export const GLYPH = { done: '✓', next: '●', todo: '○', waiting: '·', blocked: '■', needsYou: '♦', failed: '×' } as const

export type Stage = 'spec' | 'plan' | 'build' | 'test' | 'review' | 'ship'

/** Which agent-skills skill means which stage. */
export const SKILL_STAGE: Record<string, Stage> = {
  'spec-driven-development': 'spec',
  'idea-refine': 'spec',
  'interview-me': 'spec',
  'planning-and-task-breakdown': 'plan',
  'incremental-implementation': 'build',
  'frontend-ui-engineering': 'build',
  'api-and-interface-design': 'build',
  'source-driven-development': 'build',
  'constraint-driven-development': 'build',
  'test-driven-development': 'test',
  'browser-testing-with-devtools': 'test',
  'debugging-and-error-recovery': 'test',
  'code-review-and-quality': 'review',
  'code-simplification': 'review',
  'security-and-hardening': 'review',
  'performance-optimization': 'review',
  'doubt-driven-development': 'review',
  'shipping-and-launch': 'ship',
  'ci-cd-and-automation': 'ship',
  'git-workflow-and-versioning': 'ship',
  'deprecation-and-migration': 'ship',
  'documentation-and-adrs': 'ship',
  'observability-and-instrumentation': 'ship',
}

export function stageOfSkill(skill: string): Stage | null {
  return SKILL_STAGE[skill.replace(/^agent-skills:/, '')] ?? null
}

/** Spec approval: front matter when present, else inferred from a plan existing. */
export function specApproval(spec: Spec | null, hasPlan: boolean): 'approved' | 'awaiting' | 'none' {
  if (!spec) return hasPlan ? 'approved' : 'none'
  if (spec.status) return spec.status === 'approved' ? 'approved' : 'awaiting'
  return hasPlan ? 'approved' : 'awaiting'
}

/** The status line entry: `spec ✓ approved · plan 4/9`, or undefined to clear it. */
export function statusText(spec: Spec | null, list: TaskList | null): string | undefined {
  const approval = specApproval(spec, list !== null)
  const parts: string[] = []
  if (approval === 'approved') parts.push('spec ✓ approved')
  else if (approval === 'awaiting') parts.push('spec ♦ awaiting approval')
  if (list && list.total > 0) parts.push(`plan ${bar(list.done, list.total, 9)} ${list.done}/${list.total}`)
  return parts.length ? parts.join(' · ') : undefined
}

const remaining = (t: Task) => t.boxes.filter(b => !b.isDone).length

/** One line for the band above the prompt; undefined hides it. */
export function bandText(list: TaskList | null): string | undefined {
  const t = list?.current
  if (!list || !t) return undefined
  const left = remaining(t)
  const bits = [`${GLYPH.next} ${t.id} ${t.title}`, ...(t.owner ? [t.owner] : []), `${left} criteri${left === 1 ? 'on' : 'a'} left`, `${list.done}/${list.total} done`]
  if (t.checkpoint) bits.push(`checkpoint after this task`)
  return bits.join(' · ')
}

/** /progress next: the next unblocked task with its criteria, straight from the parser. */
export function nextText(list: TaskList | null, plan: PlanDoc | null): string {
  if (!list) {
    return plan?.trackedIn
      ? `No tasks/todo.md: tasks are tracked in ${plan.trackedIn}.`
      : 'No tasks/todo.md in this project. Run /plan to create one.'
  }
  if (list.total === 0) return 'tasks/todo.md has no tasks yet.'
  const t = list.current
  if (!t) {
    const open = list.tasks.filter(x => x.status === 'blocked' || x.status === 'waiting')
    return open.length
      ? `Nothing can start. ${open.map(b => (b.status === 'blocked' ? `${b.id} blocked by ${b.blockedBy}` : `${b.id} waits on ${b.deps.join(', ')}`)).join('; ')}.`
      : `All ${list.total} tasks are done. Next stage: review.`
  }
  const lines = [`Next: ${t.id} ${t.title}${t.phase ? `  (${t.phase})` : ''}`]
  if (t.deps.length) lines.push(`Depends on: ${t.deps.join(', ')} (done)`)
  for (const b of t.boxes) lines.push(`  ${b.isDone ? '[x]' : '[ ]'} ${b.text}`)
  if (t.checkpoint) {
    lines.push(`Checkpoint after this task: ${t.checkpoint.title}`)
    for (const b of t.checkpoint.items) lines.push(`  ${b.isDone ? '[x]' : '[ ]'} ${b.text}`)
  }
  lines.push(`Progress: ${list.done}/${list.total} tasks done.`)
  return lines.join('\n')
}

export type TimelineRow =
  | { kind: 'phase'; text: string; date: string }
  | { kind: 'task'; glyph: string; id: string; title: string; detail: string; status: Task['status'] | 'failed'; date: string }
  | { kind: 'checkpoint'; glyph: string; text: string; date: string }

/** A task's day: when it was done, or `≈` when the forecast expects it. */
export type TaskDate = { day: string; isEstimate: boolean }

const DAY_MS = 86_400_000

/**
 * The date column (F1): the day each done task was first seen done, and for
 * the open ones, in plan order, the day the median pace reaches them.
 */
export function taskDates(list: TaskList, doneDays: Record<string, string>, fc: Forecast | null, today: string): Record<string, TaskDate> {
  const dates: Record<string, TaskDate> = {}
  for (const t of list.tasks) {
    const day = doneDays[taskKey(t)]
    if (t.status === 'done' && day) dates[t.id] = { day, isEstimate: false }
  }
  if (fc?.kind !== 'range') return dates
  const open = list.tasks.filter(t => t.status !== 'done')
  const days = Math.max(1, Math.round((Date.parse(`${fc.median}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS))
  open.forEach((t, i) => {
    const at = Date.parse(`${today}T00:00:00Z`) + Math.ceil(((i + 1) * days) / open.length) * DAY_MS
    dates[t.id] = { day: new Date(at).toISOString().slice(0, 10), isEstimate: true }
  })
  return dates
}

const dateText = (d: TaskDate | undefined) => (d ? `${d.isEstimate ? '≈' : ''}${shortDay(d.day)}` : '')

/**
 * The run timeline (F1): phases, tasks and checkpoints in plan order. A task
 * whose last test run failed is marked ×; a phase is dated by its last task.
 */
export function timelineRows(list: TaskList, opts: { dates?: Record<string, TaskDate>; failed?: string | null } = {}): TimelineRow[] {
  const dates = opts.dates ?? {}
  const rows: TimelineRow[] = []
  let phase = null as Extract<TimelineRow, { kind: 'phase' }> | null
  for (const t of list.tasks) {
    if (t.phase && t.phase !== phase?.text) {
      phase = { kind: 'phase', text: t.phase, date: '' }
      rows.push(phase)
    }
    const date = dateText(dates[t.id])
    if (phase && date) phase.date = date
    const isFailed = t.status !== 'done' && opts.failed === t.id
    const glyph = isFailed
      ? GLYPH.failed
      : t.status === 'done'
        ? GLYPH.done
        : t.status === 'next'
          ? GLYPH.next
          : t.status === 'blocked'
            ? GLYPH.blocked
            : t.status === 'waiting'
              ? GLYPH.waiting
              : GLYPH.todo
    const left = remaining(t)
    const progress = t.boxes.length > 1 ? `${t.boxes.length - left}/${t.boxes.length}` : ''
    const detail = isFailed
      ? ['tests failed', progress].filter(Boolean).join(' · ')
      : t.status !== 'done' && t.state?.status === 'in review'
        ? ['in review', t.pr && `PR ${t.pr}`, t.reviewer].filter(Boolean).join(' · ')
      : t.status === 'done'
        ? `${t.boxes.length}/${t.boxes.length}`
        : t.status === 'blocked'
          ? `question: ${t.blockedBy?.replace(/^[^:]+: /, '') ?? ''}`
          : t.status === 'waiting'
            ? `waits on ${t.deps.join(', ')}`
            : progress
    rows.push({ kind: 'task', glyph, id: t.id, title: t.title, detail: [t.owner, detail].filter(Boolean).join(' · '), status: isFailed ? 'failed' : t.status, date })
    if (t.checkpoint) {
      const isDone = t.checkpoint.items.length > 0 && t.checkpoint.items.every(b => b.isDone)
      const isDue = t.status === 'done' && !isDone
      rows.push({
        kind: 'checkpoint',
        glyph: isDone ? GLYPH.done : isDue ? GLYPH.needsYou : GLYPH.todo,
        text: `Checkpoint: ${t.checkpoint.title}${isDue ? ' (needs you)' : ''}`,
        date,
      })
    }
  }
  return rows
}

/**
 * Spec files (A3): SPEC.md first, then module specs at the root (`SPEC-<id>.md`),
 * then those of a capability map under `specs/` (`specs/<module>.md`).
 */
export const SPEC_FILE = /^SPEC(-[\w.-]+)?\.md$/
const MODULE_SPEC = /^[\w.-]+\.md$/
const NOT_A_SPEC = /^(readme|index|_index|template)\.md$/i
export function specFiles(names: string[], specsDir: string[] = []): string[] {
  const root = names.filter(n => SPEC_FILE.test(n)).sort((a, b) => (a === 'SPEC.md' ? -1 : b === 'SPEC.md' ? 1 : a.localeCompare(b)))
  const modules = specsDir.filter(n => MODULE_SPEC.test(n) && !NOT_A_SPEC.test(n)).sort((a, b) => a.localeCompare(b))
  return [...root, ...modules.map(n => `specs/${n}`)]
}

/**
 * The files `/spec-view <arg>` may mean, best first: a file name as given,
 * else `specs/<arg>.md` and `SPEC-<arg>.md`.
 */
export function specCandidates(arg: string): string[] {
  const a = arg.trim().replace(/^\.\//, '')
  if (/\.md$/i.test(a)) return a.includes('/') || SPEC_FILE.test(a) ? [a] : [a, `specs/${a}`]
  return [`specs/${a}.md`, `SPEC-${a}.md`]
}

/** `/spec-view auth` → SPEC-auth.md, as the error names it when nothing matches. */
export const specFileFor = (arg: string) => specCandidates(arg).at(-1)!

/** A path the agent wrote that is a spec: the file as the pane names it, or null. */
export function specOfPath(path: string): string | null {
  const p = path.replace(/\\/g, '/')
  const root = /(?:^|\/)(SPEC(-[\w.-]+)?\.md)$/.exec(p)
  if (root) return root[1]!
  const mod = /(?:^|\/)specs\/([\w.-]+\.md)$/.exec(p)
  return mod && !NOT_A_SPEC.test(mod[1]!) ? `specs/${mod[1]}` : null
}

/** The forecast line (G3): a range with its basis, or why there is none. */
export function forecastText(f: Forecast): string {
  if (f.kind === 'done') return 'All tasks done.'
  if (f.kind === 'not-enough') return `ETA: ${f.reason}.`
  const added = f.added > 0 ? ` · +${f.added} added since tracking began` : ''
  return `ETA ${shortDay(f.median)} (fast ${shortDay(f.optimistic)}, slow ${shortDay(f.slow)}) · ${f.basis}${added}`
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`

/** Where the forecast's history comes from (F5): each source's days, or why there are none. */
export function historyNote(h: Backfill, file: string | null): string {
  const parts = [
    h.days.git ? `${days(h.days.git)} from commits of ${file ?? 'the task list'}` : '',
    h.days.messages ? `${days(h.days.messages)} from commit messages` : '',
    h.days.logs ? `${days(h.days.logs)} from session logs` : '',
  ].filter(Boolean)
  if (parts.length === 0) return `History tracked from ${shortDay(h.since)}${h.gitNote ? `: ${h.gitNote}` : ''}.`
  return `History since ${shortDay(h.since)}: ${parts.join(', ')}.`
}

/** `/progress history`: each source, what it gave, and how to change the session-log answer. */
export function historyText(h: Backfill | null, file: string | null): string {
  if (!h) return 'No task list here, so there is no history.'
  const logs = {
    ask: 'not read yet: the band above the prompt asks. /progress history logs on reads them.',
    yes: `on, ${days(h.days.logs)} added. /progress history logs off stops using them.`,
    no: 'off. /progress history logs on reads them.',
    empty: `no session of this project writes ${file ?? 'the task list'}.`,
    unasked: 'not read, since git gave enough. /progress history logs on reads them too.',
  }[h.logs]
  return [
    historyNote(h, file),
    `- commits of ${file ?? 'the task list'}: ${h.gitNote ?? days(h.days.git)}`,
    `- commit messages naming tasks (T3, Task 3): ${days(h.days.messages)}`,
    `- Claude Code session logs: ${logs}`,
    `- seen by this plugin: ${days(h.days.seen)}`,
  ].join('\n')
}

/** A `[████░░░░]` bar, `width` cells wide. */
export function bar(done: number, total: number, width: number): string {
  if (total <= 0 || width <= 0) return ''
  const filled = Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/**
 * The toast for one edit of the task list (B4), or undefined. A checkpoint just
 * reached wins over the task that reached it, so there is at most one per edit, and
 * unticking never raises one. Tasks match by id and title, so a new plan that
 * reuses ids doesn't read as progress.
 */
export function completionToast(before: TaskList | null, after: TaskList | null): string | undefined {
  if (!before || !after) return undefined
  const key = taskKey
  const wasDone = new Set(before.tasks.filter(t => t.status === 'done').map(key))
  const known = new Set(before.tasks.map(key))
  const finished = after.tasks.filter(t => t.status === 'done' && known.has(key(t)) && !wasDone.has(key(t)))
  if (finished.length === 0) return undefined

  const cp = finished.map(t => t.checkpoint).find(c => c && !(c.items.length > 0 && c.items.every(b => b.isDone)))
  if (cp) {
    const open = cp.items.filter(b => !b.isDone).map(b => b.text)
    return `${GLYPH.needsYou} Checkpoint reached: ${cp.title}${open.length ? ` · ${open.join(' · ')}` : ''}`
  }
  const names = finished.map(t => t.id).join(', ')
  const title = finished.length === 1 ? ` ${finished[0]?.title ?? ''}` : ''
  const next = after.current ? `\nNext: ${after.current.id} ${after.current.title}` : after.done === after.total ? '\nAll tasks done' : ''
  return `${GLYPH.done} ${names} done${title ? ` ·${title}` : ''}${next}`
}

/** `T6 ← T5 ← T4`: from a waiting task down its undone dependencies to one that can start. */
export function blockChain(list: TaskList, t: Task): string {
  const byId = new Map(list.tasks.map(x => [x.id, x]))
  const chain = [t.id]
  let cur: Task | undefined = t
  while (cur) {
    const dep: Task | undefined = cur.deps.map(d => byId.get(d)).find(d => d && d.status !== 'done' && !chain.includes(d.id))
    if (!dep) break
    chain.push(dep.id)
    cur = dep.status === 'waiting' ? dep : undefined
  }
  return chain.join(' ← ')
}

export type BriefInput = {
  spec: Spec | null
  list: TaskList | null
  plan: PlanDoc | null
  /** The file the task list came from. */
  listFile: string | null
  forecast: Forecast | null
  /** The spec file shown: SPEC.md, or a module spec such as SPEC-auth.md (A3). */
  specFile?: string | null
}

const MAX_ROWS = 12

/** How Claude lays out an answer about progress (mockup 10): one short card per topic, its source named. */
export const ANSWER_CARDS = [
  'Lay the answer out as cards inside one ```text block: one card per topic (a checkpoint, a blocked task, the next task), each opening with a header line that names its source file on the right, then the task line with its glyph (◐ current, ○ to do, · waiting, ■ blocked, ✓ done), its open boxes as "☐ ..." lines, and what follows. Then one plain sentence after the block saying what the user can do. For example:',
  '```text',
  'Checkpoint 1 · 1 task left                         from tasks/todo.md',
  '◐ T4 Rate limit per key',
  '  ☐ 429 with Retry-After after 60 req/min',
  '  ☐ pnpm --filter gateway test',
  'then checkpoint: tests pass · build clean · review with you',
  '',
  'T6 blocked                     from tasks/plan.md → Open questions',
  'T6 ← T5 ← T4 (dependency chain)',
  'and Q2 is still open: "Upstash Redis or self-hosted for the sliding window?"',
  '```',
  "Answer Q2 and I'll update plan.md and unblock T6.",
].join('\n')

/**
 * The system-prompt section (C1): the parsed state the model answers progress
 * questions from, so counts come from the parser and not from a guess.
 * Undefined when there is nothing agent-skills shaped in the project.
 */
export function progressBrief(p: BriefInput): string | undefined {
  const { spec, list, plan, listFile } = p
  if (!spec && !list) return undefined
  const out = [
    'agent-skills progress, parsed from the project files by the agent-skills-mods plugin and current as of this request.',
    'When the user asks about progress ("what\'s left?", "where are we?", "what\'s next?", "why is T6 blocked?"), answer from these facts: cite task ids, name the source file, and keep it to a few short lines rather than pasting the markdown. Read the file itself only for detail not listed here.',
    ANSWER_CARDS,
  ]
  const approval = specApproval(spec, list !== null)
  if (spec) {
    const weak = spec.areas.filter(a => a.hint).map(a => `${a.label}: ${a.hint}`)
    const gaps = spec.areas.filter(a => a.state !== 'present').map(a => `${a.label} ${a.state}`)
    out.push(
      `${p.specFile ?? 'SPEC.md'}: ${approval === 'approved' ? 'approved' : 'awaiting approval'}${gaps.length ? `; ${gaps.join(', ')}` : ''}${weak.length ? `; weak: ${weak.join('; ')}` : ''}.`,
    )
    for (const q of spec.openQuestions.slice(0, 5)) out.push(`- open question (${p.specFile ?? 'SPEC.md'}): ${q}`)
  }
  if (list && listFile) {
    if (list.total === 0) out.push(`${listFile}: no tasks yet.`)
    else {
      out.push(`${listFile}: ${list.done}/${list.total} tasks done${list.kind === 'checklist' ? ' (plain checklist, no task headings)' : ''}.`)
      const t = list.current
      if (t) {
        const open = t.boxes.filter(b => !b.isDone).map(b => b.text)
        out.push(`- current: ${t.id} ${t.title}${t.phase ? ` (${t.phase})` : ''}${open.length ? `; open: ${open.join('; ')}` : ''}`)
        if (t.checkpoint) out.push(`- checkpoint after ${t.id}: ${t.checkpoint.title} (${t.checkpoint.items.map(b => b.text).join('; ')})`)
      } else if (list.done === list.total) out.push('- all tasks done; next stage is review.')
      for (const b of list.tasks.filter(x => x.status === 'blocked').slice(0, MAX_ROWS)) {
        const chain = blockChain(list, b)
        out.push(`- blocked: ${b.id} ${b.title}, by open question (${b.blockedBy})${chain.includes('←') ? `; dependency chain ${chain}` : ''}`)
      }
      for (const b of list.tasks.filter(x => x.status === 'waiting').slice(0, MAX_ROWS)) {
        out.push(`- waiting: ${b.id} ${b.title}, chain ${blockChain(list, b)}`)
      }
      const todo = list.tasks.filter(x => x.status === 'todo')
      if (todo.length) {
        const shown = todo.slice(0, MAX_ROWS).map(x => `${x.id} ${x.title}`)
        out.push(`- not started: ${shown.join('; ')}${todo.length > MAX_ROWS ? `; and ${todo.length - MAX_ROWS} more` : ''}`)
      }
      const due = list.tasks.find(x => x.status === 'done' && x.checkpoint && !x.checkpoint.items.every(b => b.isDone))
      if (due?.checkpoint) out.push(`- checkpoint waiting on the user: ${due.checkpoint.title}`)
    }
  }
  for (const q of plan?.openQuestions.slice(0, 5) ?? []) out.push(`- open question (tasks/plan.md): ${q}`)
  if (plan?.trackedIn) out.push(`- tasks are tracked in ${plan.trackedIn}`)
  if (p.forecast) out.push(`- ${forecastText(p.forecast)}`)
  return out.join('\n')
}

/** The task a prompt is about (C1): one it names (`T6`, `task 6`), else the current one for a progress question. */
export function taskInPrompt(text: string, list: TaskList | null): string | null {
  if (!list || list.total === 0) return null
  const known = new Set(list.tasks.map(t => t.id))
  for (const m of text.matchAll(/\b(?:T|task\s*#?\s*)(\d+)\b/gi)) {
    const id = `T${m[1] ?? ''}`
    if (known.has(id)) return id
  }
  const isProgress = /\b(what'?s|what is) (left|next|remaining|blocked)\b|\bwhere are we\b|\bhow far\b|\bprogress\b|\bstatus\b/i.test(text)
  return isProgress ? (list.current?.id ?? null) : null
}

// ------------------------------------------------------------------ the task board (B1, mockups 7 and 9)

/** A colour name the board uses, mapped to the surface's theme by the pane. */
export type Tone = 'done' | 'now' | 'muted' | 'blocked' | 'accent' | 'needsYou' | 'text'

export type BoardRow =
  | { kind: 'phase'; label: string; summary: string | null }
  | { kind: 'task'; id: string; title: string; glyph: string; tone: Tone; right: string; rightTone: Tone; isCurrent: boolean; under: { text: string; tone: Tone }[] }
  | { kind: 'checkpoint'; label: string; glyph: string; tone: Tone; right: string; rightTone: Tone }

/** `Phase 1: Foundation` → `Phase 1 · Foundation`, as the board writes a phase. */
export const phaseLabel = (p: string) => p.replace(/^(Phase\s+\d+)\s*[:.\-–—]\s*/i, '$1 · ')

/** A short criterion for the line under the current task: `✓ ApiKey model`. */
const shortBox = (b: { text: string; isDone: boolean }) => `${b.isDone ? '✓' : '☐'} ${b.text.replace(/^Tests pass:.*/i, 'tests').replace(/^Build succeeds:.*/i, 'build').replace(/`/g, '')}`

/**
 * The board: phases with their tasks and checkpoints, a status column on the
 * right (✓, now, 2/5, waits T3, blocked, after T4), the current task's boxes
 * under it, and why a blocked task is blocked. Phases neither under way nor
 * next fold to one line (`Phase 3 · console 0/2`).
 */
export function boardRows(list: TaskList, opts: { failed?: string | null } = {}): BoardRow[] {
  const phases: { name: string | null; tasks: Task[] }[] = []
  for (const t of list.tasks) {
    const last = phases[phases.length - 1]
    if (last && last.name === t.phase) last.tasks.push(t)
    else phases.push({ name: t.phase, tasks: [t] })
  }
  const currentPhase = phases.findIndex(p => p.tasks.some(t => t.id === list.current?.id))
  const firstOpen = phases.findIndex(p => p.tasks.some(t => t.status !== 'done'))
  const focus = currentPhase >= 0 ? currentPhase : firstOpen
  const rows: BoardRow[] = []
  let checkpointNo = 0
  phases.forEach((p, i) => {
    const done = p.tasks.filter(t => t.status === 'done').length
    const isOpen = i === focus || i === focus + 1 || p.tasks.some(t => t.status === 'blocked')
    const fold = p.name !== null && !isOpen
    if (p.name !== null) rows.push({ kind: 'phase', label: phaseLabel(p.name), summary: fold ? `${done}/${p.tasks.length}` : null })
    for (const t of p.tasks) {
      if (fold) {
        if (t.checkpoint) checkpointNo++
        continue
      }
      const isFailed = t.status !== 'done' && opts.failed === t.id
      const ticked = t.boxes.filter(b => b.isDone).length
      const isCurrent = t.id === list.current?.id
      const waitOn = t.deps.find(d => list.tasks.some(x => x.id === d && x.status !== 'done'))
      const inReview = t.status !== 'done' && t.state?.status === 'in review'
      const [glyph, tone, right, rightTone]: [string, Tone, string, Tone] = isFailed
        ? ['×', 'blocked', 'tests failed', 'blocked']
        : t.status === 'done'
          ? ['●', 'done', '✓', 'done']
          : inReview
            ? ['◐', 'now', ['review', t.pr, t.reviewer].filter(Boolean).join(' '), 'now']
            : isCurrent
            ? ['◐', 'now', ticked > 0 ? `${ticked}/${t.boxes.length}` : 'now', 'now']
            : t.status === 'blocked'
              ? ['■', 'blocked', 'blocked', 'blocked']
              : t.status === 'waiting'
                ? ['○', 'muted', waitOn ? `waits ${waitOn}` : 'waits', 'muted']
                : ['○', 'muted', '', 'muted']
      const under: { text: string; tone: Tone }[] = []
      if (isCurrent && t.boxes.length > 0) {
        const doneBoxes = t.boxes.filter(b => b.isDone).map(shortBox)
        const open = t.boxes.filter(b => !b.isDone).map(shortBox)
        if (doneBoxes.length) under.push({ text: doneBoxes.join(' · '), tone: 'muted' })
        if (open.length) under.push({ text: open.join(' · '), tone: 'muted' })
      }
      if (t.status === 'blocked' && t.blockedBy) {
        const m = /^(?:tasks\/)?([\w./-]+\.md): (.*)$/.exec(t.blockedBy)
        under.push({ text: m ? `open question in ${m[1]}: ${m[2]}` : t.blockedBy, tone: 'muted' })
      }
      rows.push({ kind: 'task', id: t.id, title: t.owner ? `${t.title} · ${t.owner}` : t.title, glyph, tone, right, rightTone, isCurrent, under })
      if (t.checkpoint) {
        checkpointNo++
        const items = t.checkpoint.items
        const isDone = items.length > 0 && items.every(b => b.isDone)
        const isDue = t.status === 'done' && !isDone
        rows.push({
          kind: 'checkpoint',
          label: `Checkpoint ${checkpointNo}`,
          glyph: isDone ? '✓' : isDue ? '♦' : '◆',
          tone: isDone ? 'done' : isDue ? 'needsYou' : 'accent',
          right: isDone ? '✓' : isDue ? 'review with you' : `after ${t.id}`,
          rightTone: isDone ? 'done' : isDue ? 'needsYou' : 'muted',
        })
      }
    }
  })
  return rows
}

/** `Phase 1 of 3`: where the work is, for the board's header. */
export function phaseOf(list: TaskList): string | null {
  const names = [...new Set(list.tasks.map(t => t.phase).filter((p): p is string => !!p))]
  if (names.length === 0) return null
  const at = list.current?.phase ?? list.tasks.find(t => t.status !== 'done')?.phase ?? names[names.length - 1]
  return `Phase ${Math.max(1, names.indexOf(at ?? '') + 1)} of ${names.length}`
}

/** The band's counts (B2): open acceptance criteria and open verifications, apart. */
export function openCounts(t: Task): string {
  const open = t.boxes.map((b, i) => ({ b, kind: t.kinds?.[i] ?? 'criteria' })).filter(x => !x.b.isDone)
  const c = open.filter(x => x.kind === 'criteria').length
  const v = open.filter(x => x.kind === 'verification').length
  const parts = [`${c} criteri${c === 1 ? 'on' : 'a'}`]
  if (v) parts.push(`${v} verification${v === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

// ------------------------------------------------------------------ the spec pane (A1, A2, mockup 8)

const RUN_LINE = /^\s*(?:[-*+]\s+)?(?:\$\s+)?`?(?:pnpm|npm|npx|yarn|bun|deno|node|make|cargo|go|python3?|pip|uv|pytest|poetry|docker|git|bash|sh|\.\/)\b/
const TEST_TOOLS = /\b(vitest|jest|mocha|ava|pytest|unittest|playwright|cypress|rspec|minitest|phpunit|go test|cargo test|node:test|bun test|deno test|junit|xunit)\b/i

/** Commands a Commands section lets you run: lines in code blocks and lines that start with a tool. */
export function runnableCount(body: string): number {
  let n = 0
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence ? line.trim() !== '' : RUN_LINE.test(line)) n++
  }
  return n
}

/**
 * What the spec pane writes on the right of an area (mockup 8): `4 success
 * criteria`, `4 runnable`, `vitest · 80%`; a weak area's short reason (`no
 * example`) with `isWeak`; `missing` or `empty`; or nothing.
 */
export function areaSummary(a: { key: string; state: string; body: string; hint: string | null }, criteria: string[]): { text: string; isWeak: boolean } {
  if (a.state !== 'present') return { text: a.state, isWeak: true }
  if (a.hint) {
    const short =
      a.key === 'style'
        ? 'no example'
        : a.key === 'commands'
          ? 'nothing runnable'
          : /^no success criteria/.test(a.hint)
            ? 'no success criteria'
            : ((n: string) => `${n} vague criteri${n === '1' ? 'on' : 'a'}`)(/^(\d+) of/.exec(a.hint)?.[1] ?? 'some')
    return { text: short, isWeak: true }
  }
  if (a.key === 'objective') return { text: `${criteria.length} success criteri${criteria.length === 1 ? 'on' : 'a'}`, isWeak: false }
  if (a.key === 'commands') {
    const n = runnableCount(a.body)
    return { text: n ? `${n} runnable` : '', isWeak: false }
  }
  if (a.key === 'testing') {
    const tool = TEST_TOOLS.exec(a.body)?.[1]?.toLowerCase()
    const cover = /(\d{1,3})\s*%/.exec(a.body)?.[1]
    return { text: [tool, cover ? `${cover}%` : null].filter(Boolean).join(' · '), isWeak: false }
  }
  return { text: '', isWeak: false }
}

// ------------------------------------------------------------------ one task in detail (/progress task T4)

const DAY_OF = (d: string) => Date.parse(`${d}T00:00:00Z`)

/**
 * Everything about one task: state, boxes by kind, what it waits on and what
 * waits on it, the checkpoint after it, days spent, the expected date, and the
 * commits that name it.
 */
export function taskDetail(list: TaskList, id: string, opts: { today: string; dates: Record<string, TaskDate>; commits: { hash: string; day: string; subject: string }[] }): string | null {
  const t = list.tasks.find(x => x.id === id)
  if (!t) return null
  const st = t.state
  const glyph = { done: GLYPH.done, next: '◐', todo: GLYPH.todo, waiting: GLYPH.waiting, blocked: GLYPH.blocked }[t.status]
  const word = t.status !== 'done' && st?.status === 'in review' ? 'in review' : { done: 'done', next: 'current', todo: 'to do', waiting: 'waiting', blocked: 'blocked' }[t.status]
  const lines = [`${glyph} ${t.id} ${t.title}${t.phase ? `  ·  ${phaseLabel(t.phase)}` : ''}`]
  const facts = [word]
  if (t.owner) facts.push(t.owner)
  if (t.pr) facts.push(`PR ${t.pr}`)
  if (t.reviewer) facts.push(`reviewer ${t.reviewer}`)
  if (st?.step && t.status !== 'done') facts.push(`step ${st.step}`)
  if (st?.started) {
    const end = st.done ?? opts.today
    const n = Math.max(0, Math.round((DAY_OF(end) - DAY_OF(st.started)) / 86_400_000))
    facts.push(`started ${shortDay(st.started)}`, t.status === 'done' ? `took ${n}d` : `${n}d so far`)
  }
  const d = opts.dates[t.id]
  if (d) facts.push(d.isEstimate ? `expected ≈${shortDay(d.day)}` : `done ${shortDay(d.day)}`)
  lines.push(facts.join(' · '))
  const groups: [string, number[]][] = [
    ['Acceptance criteria', t.boxes.map((_, i) => i).filter(i => (t.kinds?.[i] ?? 'criteria') === 'criteria')],
    ['Verification', t.boxes.map((_, i) => i).filter(i => t.kinds?.[i] === 'verification')],
  ]
  for (const [label, idx] of groups) {
    if (!idx.length) continue
    lines.push('', `${label} ${idx.filter(i => t.boxes[i]!.isDone).length}/${idx.length}`)
    for (const i of idx) lines.push(`  ${t.boxes[i]!.isDone ? '☑' : '☐'} ${t.boxes[i]!.text}`)
  }
  const byId = new Map(list.tasks.map(x => [x.id, x]))
  if (t.deps.length) lines.push('', `Waits on: ${t.deps.map(x => `${x} ${byId.get(x)?.status === 'done' ? '✓' : (byId.get(x)?.status ?? '?')}`).join(', ')}`)
  const after = list.tasks.filter(x => x.deps.includes(t.id)).map(x => x.id)
  if (after.length) lines.push(`${after.length === 1 ? 'Waits on it' : 'Wait on it'}: ${after.join(', ')}`)
  if (t.blockedBy) lines.push(`Blocked by: ${t.blockedBy}`)
  if (t.checkpoint) lines.push(`Then checkpoint: ${t.checkpoint.title} (${t.checkpoint.items.map(b => b.text).join(' · ')})`)
  if (opts.commits.length) {
    lines.push('', `Commits naming ${t.id}`)
    for (const c of opts.commits.slice(0, 8)) lines.push(`  ${c.hash} ${shortDay(c.day)}  ${c.subject}`)
    if (opts.commits.length > 8) lines.push(`  and ${opts.commits.length - 8} more`)
  }
  return lines.join('\n')
}

/** Commits from `git log --format=%h %as %s` whose subject names the task (`T4`, `Task 4`). */
export function commitsNaming(out: string, id: string): { hash: string; day: string; subject: string }[] {
  const n = id.slice(1)
  const re = new RegExp(`\\b(?:T${n}|[Tt]ask\\s*#?${n})\\b`)
  return out
    .split('\n')
    .map(l => /^([0-9a-f]{4,40}) (\d{4}-\d{2}-\d{2}) (.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m && re.test(m[3]!))
    .map(m => ({ hash: m[1]!, day: m[2]!, subject: m[3]! }))
}

// ------------------------------------------------------------------ alerts on the band

/**
 * What the band warns about, one line each: the current task running more
 * than twice the usual days per task, and scope grown more than 20% since the
 * plan began.
 */
export function alerts(input: { list: TaskList | null; snapshots: { day: string; total: number }[]; today: string }): string[] {
  const { list, snapshots, today } = input
  if (!list || list.total === 0) return []
  const out: string[] = []
  const began = list.meta?.created ?? snapshots[0]?.day
  const days = (a: string, b: string) => Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000))
  const t = list.current
  if (t?.state?.started && began && list.done >= 2) {
    const pace = Math.max(1, days(began, today) / list.done)
    const running = days(t.state.started, today)
    if (running > pace * 2) out.push(`${t.id} has run ${running}d, over twice the usual ${Math.round(pace)}d a task`)
  }
  const first = snapshots[0]?.total
  if (first && list.total > first && (list.total - first) / first > 0.2) {
    out.push(`scope grew from ${first} to ${list.total} tasks (+${Math.round(((list.total - first) / first) * 100)}%) since ${shortDay(snapshots[0]!.day)}`)
  }
  return out
}
