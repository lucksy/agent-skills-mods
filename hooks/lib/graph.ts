// The dependency graph (Graph tab): tasks as a tree from the ones that wait on
// nothing, each child a task that waits on its parent, and the longest chain
// of unfinished work. A task with two parents is drawn under the first and
// pointed to from the others. Pure.

import type { Task, TaskList } from './parse'
import type { Line, SegTone } from './timeline'

const TONE: Record<Task['status'], SegTone> = { done: 'done', next: 'run', todo: 'muted', waiting: 'muted', blocked: 'needsYou' }
const GLYPH: Record<Task['status'], string> = { done: '✓', next: '◐', todo: '○', waiting: '◌', blocked: '■' }

export function graphLines(list: TaskList): Line[] {
  const byId = new Map(list.tasks.map(t => [t.id, t]))
  const children = new Map<string, Task[]>()
  for (const t of list.tasks) for (const d of t.deps) if (byId.has(d) && d !== t.id) children.set(d, [...(children.get(d) ?? []), t])
  const roots = list.tasks.filter(t => !t.deps.some(d => byId.has(d) && d !== t.id))
  const drawn = new Set<string>()
  const out: Line[] = []
  const node = (t: Task, prefix: string, isLast: boolean, depth: number) => {
    const branch = depth === 0 ? '' : `${prefix}${isLast ? '└─▶ ' : '├─▶ '}`
    if (drawn.has(t.id)) {
      out.push([{ text: branch, tone: 'muted' }, { text: `${t.id}`, tone: 'strong' }, { text: ' (drawn above)', tone: 'muted' }])
      return
    }
    drawn.add(t.id)
    out.push([
      { text: branch, tone: 'muted' },
      { text: GLYPH[t.status], tone: TONE[t.status] },
      { text: ' ', tone: 'text' },
      { text: t.id, tone: 'strong' },
      { text: ` ${t.title}`, tone: t.status === 'done' ? 'muted' : 'text' },
    ])
    const kids = children.get(t.id) ?? []
    const next = depth === 0 ? '' : `${prefix}${isLast ? '    ' : '│   '}`
    kids.forEach((k, i) => node(k, next, i === kids.length - 1, depth + 1))
  }
  roots.forEach((r, i) => {
    if (i > 0) out.push([])
    node(r, '', true, 0)
  })
  // Tasks only reachable through a loop never had a root; list them so nothing goes missing.
  const loose = list.tasks.filter(t => !drawn.has(t.id))
  if (loose.length) out.push([], [{ text: `In a dependency loop: ${loose.map(t => t.id).join(', ')} (see /progress doctor)`, tone: 'bad' }])
  return out
}

/** The longest chain of unfinished tasks through the dependencies: what bounds the finish date. */
export function criticalPath(list: TaskList): string[] {
  const open = new Map(list.tasks.filter(t => t.status !== 'done').map(t => [t.id, t]))
  const memo = new Map<string, string[]>()
  const longest = (id: string, seen: Set<string>): string[] => {
    if (memo.has(id)) return memo.get(id)!
    const t = open.get(id)
    if (!t || seen.has(id)) return []
    seen.add(id)
    let best: string[] = []
    for (const d of t.deps) {
      const p = longest(d, seen)
      if (p.length > best.length) best = p
    }
    seen.delete(id)
    const path = [...best, id]
    memo.set(id, path)
    return path
  }
  let best: string[] = []
  for (const id of open.keys()) {
    const p = longest(id, new Set())
    if (p.length > best.length) best = p
  }
  return best
}
