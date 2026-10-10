// One module's run timeline (format-v2 T11, F7): `/progress modules dashboard`
// draws that module's plan the way `/progress timeline` draws the active one,
// from its archive if it is done: the task list, its plan, and history.json for
// the days. Its own file, apart from modules.ts, since it builds a State and
// state.ts reads modules: no import cycle. Pure.

import { renderTimelineCli } from './cli'
import { forecast, snapshotOf, type Snapshot } from './forecast'
import type { ModuleRow } from './modules'
import { parsePlan, parseTasks } from './parse'
import { toState } from './state'

/** The files a module's plan needs, relative to the project: its todo.md, plan.md and (archived) history.json. */
export function moduleFiles(rows: ModuleRow[], id: string): string[] {
  const plan = rows.find(r => r.id === id)?.plans.at(-1)
  if (!plan) return []
  return plan.where === 'active' ? ['tasks/todo.md', 'tasks/plan.md'] : [`${plan.dir}/todo.md`, `${plan.dir}/plan.md`, `${plan.dir}/history.json`]
}

/** The module's line, then its latest plan's run timeline; or why there is none. */
export function moduleTimeline(rows: ModuleRow[], id: string, files: Record<string, string | null | undefined>, today: string, o: { color?: boolean; width?: number } = {}): string {
  const r = rows.find(x => x.id === id)
  if (!r) return `No module "${id}". Modules: ${rows.map(x => x.id).join(', ')}.`
  const plan = r.plans.at(-1)
  if (!plan) return `${id} has no plan yet (${r.state}${r.dependsOn.length ? `; needs ${r.dependsOn.join(', ')}` : ''}).`
  const [todoPath, planPath, historyPath] = moduleFiles(rows, id)
  const text = files[todoPath!]
  if (!text) return `${id}: ${todoPath} could not be read.`
  const list = parseTasks(text)
  let snapshots: Snapshot[] = []
  try {
    const h = historyPath ? JSON.parse(files[historyPath] ?? '[]') : []
    if (Array.isArray(h)) snapshots = h.filter(s => s && typeof s.day === 'string')
  } catch {}
  if (!snapshots.length) snapshots = [snapshotOf(today, list)]
  const last = snapshots.at(-1)!.day
  const dates = Object.fromEntries(list.tasks.filter(t => t.state?.done).map(t => [t.id, { day: t.state!.done!, isEstimate: false }]))
  const state = toState({
    cwd: '',
    today: plan.where === 'active' ? today : last,
    specs: [],
    specFile: null,
    list,
    listFile: todoPath!,
    plan: files[planPath!] ? parsePlan(files[planPath!]!) : null,
    forecast: list.total > 0 && list.done === list.total ? { kind: 'done' } : forecast(snapshots, Date.parse(`${last}T12:00:00Z`)),
    snapshots,
    dates,
    history: null,
  })
  const head = `Module ${id} · ${r.state} · ${r.done}/${r.total} · plan ${plan.name} in ${plan.where === 'active' ? 'tasks/todo.md' : plan.dir}`
  return [head, '', renderTimelineCli(state, { color: !!o.color, width: o.width ?? 100 })].join('\n')
}
