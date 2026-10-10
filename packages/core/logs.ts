// History from Claude Code's session logs (F5), read only when the person
// allows it: each session's JSONL records every Write and Edit the agent made
// to the task list, with the file as it was before and the time, so ticks
// that were never committed can be replayed. The format is Claude Code's own
// and may change; a line this does not understand is skipped. Pure.

import { dayOf, snapshotOf, type Snapshot } from './forecast'
import { parseTasks, taskKey, type TaskList } from './parse'

/** The folder Claude Code keeps a project's sessions in: its path with every other character a dash. */
export const logsDir = (configDir: string, cwd: string) => `${configDir}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`

/** Cheap test before parsing: does this session ever write the task list? */
export const mentions = (text: string, file: string) => text.includes('"toolUseResult"') && text.includes(file)

type Result = {
  filePath?: unknown
  content?: unknown
  originalFile?: unknown
  oldString?: unknown
  newString?: unknown
  replaceAll?: unknown
}

/** The task list's text after one logged Write or Edit, or null for a line that is neither. */
export function textAfter(line: string, path: string): { ms: number; text: string } | null {
  if (!line.includes('"toolUseResult"')) return null
  let d: { timestamp?: unknown; toolUseResult?: Result }
  try {
    d = JSON.parse(line)
  } catch {
    return null
  }
  const r = d.toolUseResult
  const ms = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN
  if (!r || r.filePath !== path || !Number.isFinite(ms)) return null
  if (typeof r.content === 'string') return { ms, text: r.content }
  if (typeof r.originalFile === 'string' && typeof r.oldString === 'string' && typeof r.newString === 'string') {
    const text =
      r.replaceAll === true ? r.originalFile.split(r.oldString).join(r.newString) : r.originalFile.replace(r.oldString, () => r.newString as string)
    return { ms, text }
  }
  return null
}

/**
 * The day's last state of the list, from every session's writes, and the
 * first day each task was seen done. States of another plan (most of its
 * tasks missing from the current list) are left out.
 */
export function historyFromLogs(sessions: string[], path: string, current: TaskList): { snaps: Snapshot[]; doneDays: Record<string, string> } {
  const known = new Set(current.tasks.map(taskKey))
  const states = sessions
    .flatMap(text => text.split('\n').map(line => textAfter(line, path)))
    .filter(s => s !== null)
    .sort((a, b) => a.ms - b.ms)
  const byDay = new Map<string, Snapshot>()
  const doneDays: Record<string, string> = {}
  for (const { ms, text } of states) {
    const list = parseTasks(text)
    if (list.total === 0) continue
    if (list.tasks.filter(t => known.has(taskKey(t))).length * 2 < list.tasks.length) continue
    const day = dayOf(ms)
    byDay.set(day, snapshotOf(day, list))
    for (const t of list.tasks) if (t.status === 'done' && !doneDays[taskKey(t)]) doneDays[taskKey(t)] = day
  }
  return { snaps: [...byDay.values()], doneDays }
}
