// "Never overwrite an incomplete plan": the planning skill's rule, checked on every Write.

import { parseTasks, type Task } from './parse'

export const GUARDED = /(^|[\\/])tasks[\\/](plan|todo)\.md$/

export type Verdict = { isAllowed: true } | { isAllowed: false; open: number; lost: Task[] }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * A Write may replace a task file when it keeps every unfinished task (same id and
 * title): ticking boxes, adding tasks and rewording around them all pass. A Write
 * that drops or renames an unfinished task is refused.
 */
export function checkOverwrite(oldText: string, newText: string): Verdict {
  const before = parseTasks(oldText)
  const open = before.tasks.filter(t => t.status !== 'done')
  if (open.length === 0) return { isAllowed: true }

  const after = parseTasks(newText)
  const kept = new Set(after.tasks.map(t => `${before.kind === 'checklist' ? '' : t.id}|${norm(t.title)}`))
  const lost = open.filter(t => !kept.has(`${before.kind === 'checklist' ? '' : t.id}|${norm(t.title)}`))
  return lost.length === 0 ? { isAllowed: true } : { isAllowed: false, open: open.length, lost }
}

export function denyMessage(path: string, v: Extract<Verdict, { isAllowed: false }>): string {
  const names = v.lost
    .slice(0, 5)
    .map(t => `${t.id} ${t.title}`)
    .join('; ')
  const more = v.lost.length > 5 ? ` and ${v.lost.length - 5} more` : ''
  return [
    `agent-skills-mods: refused to overwrite ${path}: it still has ${v.open} unfinished task${v.open === 1 ? '' : 's'}`,
    `and this write would drop ${v.lost.length} of them (${names}${more}).`,
    'Per the planning skill, never overwrite an incomplete plan. Options:',
    'update the file in place with Edit (keep the open tasks),',
    'ask the user whether to finish or discard the old plan, or write the new plan elsewhere.',
    'The user can allow one overwrite with /progress allow-overwrite.',
  ].join(' ')
}
