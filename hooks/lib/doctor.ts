// /progress doctor: what is wrong with the task files, the plan and the spec,
// each with how to fix it. The fixable ones (missing Status lines, front
// matter, a Status line the boxes disagree with) `/progress doctor fix` applies. Pure.

import { readFrontMatter, stampDoc, stampTodo, taskStates } from './format'
import { parsePlan, parseSpec, parseTasks } from './parse'

export type Finding = { level: 'error' | 'warn'; file: string; message: string; isFixable: boolean }

const TASK_HEADING = /^#{1,6}\s+(?:\*\*)?Task\s+(\d+)\s*[:.\-–—]/gim

/** Every check, over the files as they are on disk (null where a file is missing). */
export function diagnose(input: { todo: string | null; plan: string | null; specs: { file: string; text: string }[]; today: string; keepFormat: boolean }): Finding[] {
  const out: Finding[] = []
  const add = (level: Finding['level'], file: string, message: string, isFixable = false) => out.push({ level, file, message, isFixable })

  if (input.todo !== null) {
    const file = 'tasks/todo.md'
    const list = parseTasks(input.todo)
    if (list.kind === 'checklist') add('warn', file, 'no "## Task N:" headings: shown as a plain checklist, with no ids, dependencies or checkpoints')
    const counts = new Map<string, number>()
    for (const m of input.todo.matchAll(TASK_HEADING)) counts.set(`T${m[1]}`, (counts.get(`T${m[1]}`) ?? 0) + 1)
    for (const [id, n] of counts) if (n > 1) add('error', file, `${id} is used by ${n} task headings; give each task its own number`)
    const ids = new Set(list.tasks.map(t => t.id))
    for (const t of list.tasks) {
      for (const d of t.deps) {
        if (d === t.id) add('error', file, `${t.id} depends on itself`)
        else if (!ids.has(d)) add('error', file, `${t.id} depends on ${d}, which is not in the list`)
      }
      if (list.kind === 'tasks' && t.boxes.length === 0) add('warn', file, `${t.id} has no checkboxes, so it can never count as done`)
      else if (list.kind === 'tasks' && t.kinds && !t.kinds.includes('verification')) add('warn', file, `${t.id} has no Verification boxes (tests pass, build succeeds)`)
    }
    for (const cycle of cycles(list.tasks)) add('error', file, `dependency loop ${cycle.join(' → ')}: none of these can start`)
    for (const cp of list.checkpoints) if (cp.items.length === 0) add('warn', file, `checkpoint "${cp.title}" has no items to review`)
    if (input.keepFormat && list.kind === 'tasks') {
      const states = taskStates(input.todo)
      const missing = list.tasks.filter(t => !states[t.id]).map(t => t.id)
      if (missing.length) add('warn', file, `no Status line on ${missing.join(', ')}`, true)
      for (const t of list.tasks) {
        const st = states[t.id]
        if (!st || t.boxes.length === 0) continue
        const allTicked = t.boxes.every(b => b.isDone)
        if (st.status === 'done' && !allTicked) add('warn', file, `${t.id} says done but has open boxes`, true)
        if (st.status !== 'done' && allTicked) add('warn', file, `${t.id} has every box ticked but says ${st.status}`, true)
      }
      const fm = readFrontMatter(input.todo).fields
      if (!fm.plan || !fm.created) add('warn', file, 'no plan/created front matter', true)
      if (stampTodo(input.todo, input.today) !== input.todo && !out.some(f => f.file === file && f.isFixable)) add('warn', file, 'Status lines or front matter out of date', true)
    }
  }

  if (input.plan !== null) {
    const file = 'tasks/plan.md'
    const plan = parsePlan(input.plan)
    const unnamed = plan.openQuestions.filter(q => !/^Q\d+\b/.test(q))
    if (unnamed.length) add('warn', file, `${unnamed.length} open question${unnamed.length === 1 ? '' : 's'} without a Q<n> number, e.g. "${unnamed[0]}"`)
    if (input.keepFormat && stampDoc(input.plan, input.today) !== input.plan) add('warn', file, 'no status/created front matter', true)
  }

  for (const spec of input.specs) {
    const s = parseSpec(spec.text)
    for (const a of s.areas) {
      if (a.state === 'missing') add('warn', spec.file, `${a.label} section is missing`)
      else if (a.state === 'empty') add('warn', spec.file, `${a.label} section is empty`)
      else if (a.hint) add('warn', spec.file, `${a.label}: ${a.hint}`)
    }
    if (input.keepFormat && stampDoc(spec.text, input.today) !== spec.text) add('warn', spec.file, 'no status/created front matter', true)
  }
  return out
}

/** Each dependency loop once, as the ids around it: `T3 → T5 → T3`. */
export function cycles(tasks: { id: string; deps: string[] }[]): string[][] {
  const deps = new Map(tasks.map(t => [t.id, t.deps]))
  const found: string[][] = []
  const seen = new Set<string>()
  const walk = (id: string, path: string[]) => {
    const at = path.indexOf(id)
    if (at >= 0) {
      const loop = path.slice(at)
      const key = [...loop].sort().join(',')
      if (!seen.has(key)) seen.add(key), found.push([...loop, id])
      return
    }
    if (path.length > tasks.length) return
    for (const d of deps.get(id) ?? []) if (deps.has(d) && d !== id) walk(d, [...path, id])
  }
  for (const t of tasks) walk(t.id, [])
  return found
}

/** The report: a count, then each file's findings, then how to fix the fixable ones. */
export function doctorText(findings: Finding[]): string {
  if (findings.length === 0) return '✓ No problems found in SPEC.md, tasks/plan.md or tasks/todo.md.'
  const errors = findings.filter(f => f.level === 'error').length
  const warns = findings.length - errors
  const lines = [`${errors ? `× ${errors} error${errors === 1 ? '' : 's'}` : ''}${errors && warns ? ', ' : ''}${warns ? `! ${warns} warning${warns === 1 ? '' : 's'}` : ''}`]
  for (const file of [...new Set(findings.map(f => f.file))]) {
    lines.push('', file)
    for (const f of findings.filter(x => x.file === file)) lines.push(`  ${f.level === 'error' ? '×' : '!'} ${f.message}${f.isFixable ? '  (fixable)' : ''}`)
  }
  if (findings.some(f => f.isFixable)) lines.push('', 'Run `/progress doctor fix` to apply the fixable ones.')
  return lines.join('\n')
}
