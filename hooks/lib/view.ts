// Plain-text views of the parsed state: the status entry, /tasks next, the band line
// and the run timeline rows. Every surface draws these, so they are text only.

import type { Spec, Task, TaskList, PlanDoc } from './parse'
import { shortDay, type Forecast } from './forecast'

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

/** /tasks next: the next unblocked task with its criteria, straight from the parser. */
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
  return `ETA ${shortDay(f.median)} (range ${shortDay(f.optimistic)}–${shortDay(f.slow)}, slow case ${shortDay(f.slow)}) · ${f.basis}${added}`
}

/** A `[████░░░░]` bar, `width` cells wide. */
export function bar(done: number, total: number, width: number): string {
  if (total <= 0 || width <= 0) return ''
  const filled = Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
