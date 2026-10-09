// Plain-text views of the parsed state: the status entry, /progress next, the band line
// and the run timeline rows. Every surface draws these, so they are text only.

import type { Spec, Task, TaskList, PlanDoc } from './parse'
import { shortDay, type Forecast } from './forecast'
import type { Backfill } from './history'

export const GLYPH = { done: '✓', next: '●', todo: '○', blocked: '◌', needsYou: '♦' } as const

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
  if (list && list.total > 0) parts.push(`plan ${list.done}/${list.total}`)
  return parts.length ? parts.join(' · ') : undefined
}

const remaining = (t: Task) => t.boxes.filter(b => !b.isDone).length

/** One line for the band above the prompt; undefined hides it. */
export function bandText(list: TaskList | null): string | undefined {
  const t = list?.current
  if (!list || !t) return undefined
  const left = remaining(t)
  const bits = [`${GLYPH.next} ${t.id} ${t.title}`, `${left} criteri${left === 1 ? 'on' : 'a'} left`, `${list.done}/${list.total} done`]
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
    const blocked = list.tasks.filter(x => x.status === 'blocked')
    return blocked.length
      ? `Nothing unblocked. Blocked: ${blocked.map(b => `${b.id} (waits on ${b.deps.join(', ')})`).join('; ')}.`
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
  | { kind: 'phase'; text: string }
  | { kind: 'task'; glyph: string; id: string; title: string; detail: string; status: Task['status'] }
  | { kind: 'checkpoint'; glyph: string; text: string }

/** The run timeline (F1): phases, tasks and checkpoints in plan order. */
export function timelineRows(list: TaskList): TimelineRow[] {
  const rows: TimelineRow[] = []
  let phase: string | null = null
  for (const t of list.tasks) {
    if (t.phase && t.phase !== phase) {
      phase = t.phase
      rows.push({ kind: 'phase', text: t.phase })
    }
    const glyph = t.status === 'done' ? GLYPH.done : t.status === 'next' ? GLYPH.next : t.status === 'blocked' ? GLYPH.blocked : GLYPH.todo
    const left = remaining(t)
    const detail =
      t.status === 'done'
        ? `${t.boxes.length}/${t.boxes.length}`
        : t.status === 'blocked'
          ? `waits on ${t.deps.join(', ')}`
          : t.boxes.length > 1
            ? `${t.boxes.length - left}/${t.boxes.length}`
            : ''
    rows.push({ kind: 'task', glyph, id: t.id, title: t.title, detail, status: t.status })
    if (t.checkpoint) {
      const isDone = t.checkpoint.items.length > 0 && t.checkpoint.items.every(b => b.isDone)
      const isDue = t.status === 'done' && !isDone
      rows.push({
        kind: 'checkpoint',
        glyph: isDone ? GLYPH.done : isDue ? GLYPH.needsYou : GLYPH.todo,
        text: `Checkpoint: ${t.checkpoint.title}${isDue ? ' (needs you)' : ''}`,
      })
    }
  }
  return rows
}

/** The forecast line (G3): a range with its basis, or why there is none. */
export function forecastText(f: Forecast): string {
  if (f.kind === 'done') return 'All tasks done.'
  if (f.kind === 'not-enough') return `ETA: ${f.reason}.`
  const added = f.added > 0 ? ` · +${f.added} added since tracking began` : ''
  return `ETA ${shortDay(f.median)} (fast ${shortDay(f.optimistic)}, slow ${shortDay(f.slow)}) · ${f.basis}${added}`
}

/** Where the forecast's history starts (F5). */
export function historyNote(h: Backfill, file: string | null): string {
  if (h.source === 'git') return `History rebuilt from commits of ${file ?? 'the task list'} back to ${shortDay(h.since)}.`
  return `History tracked from ${shortDay(h.since)}: ${h.reason}.`
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
  const key = (t: Task) => `${t.id}|${t.title}`
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
  const next = after.current ? ` · Next: ${after.current.id} ${after.current.title}` : after.done === after.total ? ' · all tasks done' : ''
  return `${GLYPH.done} ${names} done${title}${next}`
}

/** `T6 ← T5 ← T4`: from a blocked task down its undone dependencies to one that can start. */
export function blockChain(list: TaskList, t: Task): string {
  const byId = new Map(list.tasks.map(x => [x.id, x]))
  const chain = [t.id]
  let cur: Task | undefined = t
  while (cur) {
    const dep: Task | undefined = cur.deps.map(d => byId.get(d)).find(d => d && d.status !== 'done' && !chain.includes(d.id))
    if (!dep) break
    chain.push(dep.id)
    cur = dep.status === 'blocked' ? dep : undefined
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
}

const MAX_ROWS = 12

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
  ]
  const approval = specApproval(spec, list !== null)
  if (spec) {
    const weak = spec.areas.filter(a => a.hint).map(a => `${a.label}: ${a.hint}`)
    const gaps = spec.areas.filter(a => a.state !== 'present').map(a => `${a.label} ${a.state}`)
    out.push(
      `SPEC.md: ${approval === 'approved' ? 'approved' : 'awaiting approval'}${gaps.length ? `; ${gaps.join(', ')}` : ''}${weak.length ? `; weak: ${weak.join('; ')}` : ''}.`,
    )
    for (const q of spec.openQuestions.slice(0, 5)) out.push(`- open question (SPEC.md): ${q}`)
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
        out.push(`- blocked: ${b.id} ${b.title}, chain ${blockChain(list, b)}`)
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
