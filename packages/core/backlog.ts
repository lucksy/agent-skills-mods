// The backlog (ceremonies, C2): tasks/backlog.md holds work that isn't scheduled
// yet, in the task shape with B ids. Items are added with `/progress backlog add`,
// and move between it and tasks/todo.md with `/progress pull B3` and `defer T9`,
// keeping their boxes, size and notes. A deferred task's number is recorded on a
// `**Was:**` line and never given to another task. Text in, texts out; every other
// byte of both files is kept. Pure.

import { parseStatusLine, parseWasLine, type TaskSize } from './format'
import { parseBacklog, parseTasks, type Backlog } from './parse'
import { pointsOf, pointsText } from './size'

export const BACKLOG_FILE = 'tasks/backlog.md'

/** `## B3: title` headings, outside code blocks: each item's number. */
function itemNumbers(text: string): number[] {
  const out: number[] = []
  let inFence = false
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const m = !inFence && /^#{1,6}\s+(?:\*\*)?B(\d+)\s*[:.\-–—]/.exec(line)
    if (m) out.push(Number(m[1]))
  }
  return out
}

/** The id `backlog add` gives the next item: one past the highest B id, or B1. */
export function nextBacklogId(text: string | null): string {
  const n = text === null ? [] : itemNumbers(text)
  return `B${(n.length ? Math.max(...n) : 0) + 1}`
}

/**
 * `/progress backlog add "title" [S|M|L]` (ceremonies T3): the item appended as
 * the next B id, after a blank line. A missing file is created with its front
 * matter (`backlog: <plan>`) and heading.
 */
export function addBacklogItem(text: string | null, title: string, size: TaskSize | null, plan: string): { text: string; id: string } {
  const id = nextBacklogId(text)
  return { id, text: appendItem(text, [`## ${id}: ${title}`, ...(size ? [`**Size:** ${size}`] : [])], plan) }
}

/** The backlog with an item's lines added at its end after a blank line; a missing file made with its front matter. */
function appendItem(text: string | null, item: string[], plan: string): string {
  const eol = text?.includes('\r\n') ? '\r\n' : '\n'
  const block = item.join(eol) + eol
  if (text === null) return ['---', `backlog: ${plan}`, '---', '# Backlog', '', block].join(eol)
  const gap = text === '' ? '' : text.endsWith(`${eol}${eol}`) ? '' : text.endsWith(eol) ? eol : `${eol}${eol}`
  return `${text}${gap}${block}`
}

// ------------------------------------------------------------------ pull and defer (T4)

const TASK_HEAD = /^(#{1,6}\s+(?:\*\*)?)Task\s+(\d+)(\s*[:.\-–—]\s*.*)$/i
const ITEM_HEAD = /^(#{1,6}\s+(?:\*\*)?)B(\d+)(\s*[:.\-–—]\s*.*)$/i

/** Each section a heading pattern starts, outside code blocks: its number, its heading line and where it ends (the next heading). */
function sectionsOf(lines: string[], head: RegExp): { n: number; at: number; end: number }[] {
  const out: { n: number; at: number; end: number }[] = []
  let cur: { n: number; at: number; end: number } | null = null
  let inFence = false
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence || !/^#{1,6}\s/.test(line)) return
    if (cur) cur.end = i
    const m = head.exec(line)
    cur = m ? { n: Number(m[2]), at: i, end: lines.length } : null
    if (cur) out.push(cur)
  })
  return out
}

/** A section's lines without the blank lines that end it. */
function body(lines: string[], s: { at: number; end: number }): string[] {
  const out = lines.slice(s.at, s.end)
  while (out.length > 1 && out[out.length - 1]!.trim() === '') out.pop()
  return out
}

/** The lines with a section taken out; the last one taken leaves the file ending as it did. */
function cut(lines: string[], s: { at: number; end: number }): string[] {
  if (s.end < lines.length) return [...lines.slice(0, s.at), ...lines.slice(s.end)]
  const rest = lines.slice(0, s.at)
  while (rest.length && rest[rest.length - 1]!.trim() === '') rest.pop()
  return lines[lines.length - 1] === '' ? [...rest, ''] : rest
}

const split = (text: string) => ({ eol: text.includes('\r\n') ? '\r\n' : '\n', lines: text.replace(/\r\n?/g, '\n').split('\n') })

/** The task number a new or pulled task takes: one past the highest in tasks/todo.md and every `Was:` in the backlog. */
export function nextTaskNumber(todo: string, backlog: string | null): number {
  const used = [
    ...parseTasks(todo).tasks.flatMap(t => (/^T\d+$/.test(t.id) ? [Number(t.id.slice(1))] : [])),
    ...(backlog === null ? [] : parseBacklog(backlog).items.flatMap(i => (i.was ? [Number(i.was.id.slice(1))] : []))),
  ]
  return (used.length ? Math.max(...used) : 0) + 1
}

/** What a move did: both files' new texts and where the task or item went, or why it didn't. */
export type Move = { ok: true; todo: string; backlog: string; from: string; to: string; title: string; wasKept: boolean } | { ok: false; reason: string }

/**
 * `/progress pull B3` (C2): the item out of tasks/backlog.md and into tasks/todo.md
 * after its last task, as `**Status:** todo`. It takes its `Was:` number when that
 * is still free, else the next free one. Refused when it depends on a task
 * tasks/todo.md doesn't have.
 */
export function pullItem(todo: string, backlog: string, rawId: string): Move {
  const id = rawId.toUpperCase().replace(/^(\d+)$/, 'B$1')
  const items = parseBacklog(backlog).items
  const item = items.find(i => i.id === id)
  if (!item) return { ok: false, reason: `No ${id} in ${BACKLOG_FILE}.${items.length ? ` Items: ${items.map(i => i.id).join(', ')}.` : ''}` }
  const list = parseTasks(todo)
  const ids = new Set(list.tasks.map(t => t.id))
  const missing = item.deps.filter(d => !ids.has(d))
  if (missing.length) {
    const named = missing.length === 1 ? `${missing[0]}, which is` : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}, which are`
    return { ok: false, reason: `${id} depends on ${named} not in tasks/todo.md. Pull or add ${missing.length === 1 ? 'it' : 'them'} first, or change ${id}'s Dependencies line.` }
  }
  const wasKept = !!item.was && !ids.has(item.was.id)
  const to = wasKept ? item.was!.id : `T${nextTaskNumber(todo, backlog)}`

  const b = split(backlog)
  const sec = sectionsOf(b.lines, ITEM_HEAD).find(s => `B${s.n}` === id)!
  const [head, ...rest] = body(b.lines, sec)
  // The heading as a task's; its Was line goes (the number is the task's now) and a fresh Status line comes in.
  let status = false
  const kept = rest.filter(l => {
    if (parseWasLine(l)) return false
    if (!status && parseStatusLine(l)) return (status = true), false
    return true
  })
  const task = [head!.replace(ITEM_HEAD, (_, a, _n, c) => `${a}Task ${to.slice(1)}${c}`), '**Status:** todo', ...kept]

  const t = split(todo)
  const last = sectionsOf(t.lines, TASK_HEAD).at(-1)
  const at = last ? last.end : t.lines.length
  const before = t.lines.slice(0, at)
  const after = t.lines.slice(at)
  const lead = before.length && before[before.length - 1]!.trim() !== '' ? [''] : []
  const tail = after.length && after[0]!.trim() !== '' ? [''] : after.length ? [] : ['']
  return {
    ok: true,
    todo: [...before, ...lead, ...task, ...tail, ...after].join(t.eol),
    backlog: cut(b.lines, sec).join(b.eol),
    from: id,
    to,
    title: item.title,
    wasKept,
  }
}

/**
 * `/progress defer T9` (C2): a task not yet started out of tasks/todo.md and
 * into tasks/backlog.md as the next B id, with `**Was:** T9 · deferred <today> @by`.
 * Its Status line goes; its boxes, size, handoffs and notes stay. Refused for a
 * task started, in review or done, or one another task depends on.
 */
export function deferTask(todo: string, backlog: string | null, rawId: string, by: string | null, today: string, plan: string): Move {
  const id = /^\d+$/.test(rawId) ? `T${rawId}` : rawId.toUpperCase()
  const list = parseTasks(todo)
  const task = list.tasks.find(x => x.id === id)
  const t = split(todo)
  const sec = sectionsOf(t.lines, TASK_HEAD).find(s => `T${s.n}` === id)
  if (!task || !sec) return { ok: false, reason: `No "## Task ${id.slice(1)}:" section in tasks/todo.md.${list.tasks.length ? ` Tasks: ${list.tasks.map(x => x.id).join(', ')}.` : ''}` }
  const name = `${id} ${task.title}`
  const word = task.status === 'done' ? 'done' : task.state?.status === 'in review' ? 'in review' : task.state?.status === 'in progress' || task.boxes.some(b => b.isDone) ? 'started' : null
  if (word) return { ok: false, reason: `${name} is ${word}: only a task not yet started goes back to the backlog.` }
  const dependents = list.tasks.filter(x => x.deps.includes(id)).map(x => x.id)
  if (dependents.length) {
    const who = dependents.length === 1 ? `${dependents[0]} depends` : `${dependents.slice(0, -1).join(', ')} and ${dependents.at(-1)} depend`
    return { ok: false, reason: `${name} can't be deferred: ${who} on it. Defer ${dependents.length === 1 ? 'it' : 'them'} first, or change ${dependents.length === 1 ? 'its' : 'their'} Dependencies line${dependents.length === 1 ? '' : 's'}.` }
  }
  const to = nextBacklogId(backlog)
  const [head, ...rest] = body(t.lines, sec)
  let status = false
  const kept = rest.filter(l => (!status && parseStatusLine(l) ? ((status = true), false) : true))
  const was = `**Was:** ${id} · deferred ${today}${by ? ` ${by}` : ''}`
  const item = [head!.replace(TASK_HEAD, (_, a, _n, c) => `${a}${to}${c}`), was, ...kept]
  // An index line naming the task (`- [ ] Task 9: …`) would bring it back: it goes too.
  const index = new RegExp(`^\\s*[-*+]\\s+\\[[ xX~]\\]\\s+~*(?:Task\\s+|T)${id.slice(1)}\\s*[:.\\-–—·]`, 'i')
  const out = cut(t.lines, sec).filter(l => !index.test(l))
  return { ok: true, todo: out.join(t.eol), backlog: appendItem(backlog, item, plan), from: id, to, title: task.title, wasKept: true }
}

/** `/progress backlog`: each item with its size, and the points they add up to. */
export function backlogText(b: Backlog | null): string {
  if (!b) return `No ${BACKLOG_FILE} here. /progress backlog add "title" [S|M|L] starts one.`
  if (!b.items.length) return `${BACKLOG_FILE} has no items. /progress backlog add "title" [S|M|L] adds one.`
  const n = b.items.length
  const w = Math.max(...b.items.map(i => i.id.length))
  const tw = Math.max(...b.items.map(i => i.title.length))
  const lines = [`Backlog · ${BACKLOG_FILE} · ${n} item${n === 1 ? '' : 's'}, ${pointsText(pointsOf(b.items))}`]
  for (const i of b.items) {
    const tail = [i.size ?? 'no size', ...(i.was ? [`was ${i.was.id}`] : [])].join(' · ')
    lines.push(`  ${i.id.padEnd(w)}  ${i.title.padEnd(tw)}  ${tail}`)
  }
  return lines.join('\n')
}
