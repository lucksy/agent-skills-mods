// The backlog (ceremonies, C2): tasks/backlog.md holds work that isn't scheduled
// yet, in the task shape with B ids. Items are added with `/progress backlog add`.
// Text in, text out; every other byte of the file is kept. Pure.

import type { TaskSize } from './format'
import type { Backlog } from './parse'
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
  const eol = text?.includes('\r\n') ? '\r\n' : '\n'
  const item = [`## ${id}: ${title}`, ...(size ? [`**Size:** ${size}`] : [])].join(eol) + eol
  if (text === null) return { id, text: ['---', `backlog: ${plan}`, '---', '# Backlog', '', item].join(eol) }
  const gap = text === '' ? '' : text.endsWith(`${eol}${eol}`) ? '' : text.endsWith(eol) ? eol : `${eol}${eol}`
  return { id, text: `${text}${gap}${item}` }
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
