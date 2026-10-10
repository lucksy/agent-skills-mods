// Every module at a glance (format-v2, F7). A capability map in SPEC.md lists
// the modules; each may have a spec (SPEC-<id>.md or specs/<id>.md) and plans,
// the active tasks/todo.md or archived ones under tasks/archive/. A plan names
// its module with `module:` in its front matter (a list is fine); without it,
// a plan counts for every module whose id its name contains (`core-dashboard`
// counts for core and for dashboard). Pure.

import { readFrontMatter } from './format'
import { shortDay } from './forecast'
import { parseTasks, type Spec } from './parse'

export type MapRow = { id: string; responsibility: string; dependsOn: string[] }

export type PlanRef = { where: 'active' | 'archive'; dir: string; name: string; done: number; total: number; started?: string; finished?: string }

export type ModuleState = 'not started' | 'speccing' | 'ready to plan' | 'planned' | 'building' | 'done'

export type ModuleRow = MapRow & {
  spec: { file: string; status: 'approved' | 'draft' | null; approvedOn?: string } | null
  plans: PlanRef[]
  done: number
  total: number
  state: ModuleState
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim())
const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l)
const isRule = (l: string) => /^\s*\|[\s:|-]+\|\s*$/.test(l)

/** The first table under a heading naming a capability map, read by its column names; null when there is none. */
export function parseCapabilityMap(text: string): MapRow[] | null {
  const lines = readFrontMatter(text).body.replace(/\r\n?/g, '\n').split('\n')
  const heading = lines.findIndex(l => /^#{1,6}\s.*capability map/i.test(l))
  if (heading < 0) return null
  const head = lines.findIndex((l, i) => i > heading && isRow(l) && isRule(lines[i + 1] ?? ''))
  if (head < 0) return null
  const names = cells(lines[head]!).map(c => c.toLowerCase())
  const col = (re: RegExp) => names.findIndex(n => re.test(n))
  const [idCol, respCol, depCol] = [col(/module|^id$/), col(/responsib|what/), col(/depend/)]
  if (idCol < 0) return null
  const rows: MapRow[] = []
  for (let i = head + 2; i < lines.length && isRow(lines[i]!); i++) {
    const c = cells(lines[i]!)
    const id = (c[idCol] ?? '').replace(/`/g, '').trim()
    if (!id) continue
    const deps = (depCol < 0 ? '' : (c[depCol] ?? '')).replace(/`/g, '')
    rows.push({
      id,
      responsibility: respCol < 0 ? '' : (c[respCol] ?? ''),
      dependsOn: deps
        .split(/[,;]/)
        .map(d => d.trim())
        .filter(d => d && !/^[—–-]+$/.test(d) && !/^none$/i.test(d)),
    })
  }
  return rows.length ? rows : null
}

/** A plan file read for its name, its modules, its counts and its dates. */
function planOf(p: { where: 'active' | 'archive'; dir: string; text: string }): PlanRef & { modules: string[] | null } {
  const { fields } = readFrontMatter(p.text)
  const list = parseTasks(p.text)
  const name = fields.plan ?? p.dir.split('/').pop()!.replace(/^\d{4}-\d{2}-\d{2}-/, '')
  // A plan starts when it was planned (its created date), else with its first task.
  const starts = fields.created ? [fields.created] : list.tasks.map(t => t.state?.started).filter((d): d is string => !!d).sort()
  const ends = list.tasks.map(t => t.state?.done).filter((d): d is string => !!d).sort()
  const finished = list.total > 0 && list.done === list.total ? ends.at(-1) : undefined
  return {
    where: p.where,
    dir: p.dir,
    name,
    done: list.done,
    total: list.total,
    ...(starts[0] ? { started: starts[0] } : {}),
    ...(finished ? { finished } : {}),
    modules: fields.module ? fields.module.split(',').map(m => m.trim()).filter(Boolean) : null,
  }
}

/** Each module with its spec, its plans and where it stands. */
export function moduleRows(map: MapRow[], specs: { file: string; spec: Spec }[], plans: { where: 'active' | 'archive'; dir: string; text: string }[]): ModuleRow[] {
  const read = plans.map(planOf)
  return map.map(m => {
    const s = specs.find(x => x.file === `SPEC-${m.id}.md` || x.file === `specs/${m.id}.md`)
    const mine = read
      .filter(p => (p.modules ? p.modules.includes(m.id) : new RegExp(`(^|-)${m.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-|$)`).test(p.name)))
      .map(({ modules: _, ...p }) => p)
    const done = mine.reduce((n, p) => n + p.done, 0)
    const total = mine.reduce((n, p) => n + p.total, 0)
    const state: ModuleState =
      total > 0 && done === total
        ? 'done'
        : done > 0
          ? 'building'
          : total > 0
            ? 'planned'
            : s
              ? s.spec.status === 'approved'
                ? 'ready to plan'
                : 'speccing'
              : 'not started'
    return {
      ...m,
      spec: s ? { file: s.file, status: s.spec.status, ...(s.spec.approvedOn ? { approvedOn: s.spec.approvedOn } : {}) } : null,
      plans: mine,
      done,
      total,
      state,
    }
  })
}

const GLYPH: Record<ModuleState, string> = { done: '✓', building: '●', planned: '◐', 'ready to plan': '◇', speccing: '♦', 'not started': '○' }

/** `/progress modules`: a line per module, in map order. */
export function modulesText(rows: ModuleRow[], file: string): string {
  const w = Math.max(...rows.map(r => r.id.length)) + 3
  const lines = [`Modules · ${file} · ${rows.length} modules · ${rows.filter(r => r.state === 'done').length} done`]
  for (const r of rows) {
    const bits: string[] = [r.state]
    if (r.state === 'not started') {
      if (r.dependsOn.length) bits.push(`needs ${r.dependsOn.join(', ')}`)
    } else {
      if (r.total) bits.push(`${r.done}/${r.total}`)
      bits.push(r.spec ? `spec ${r.spec.status === 'approved' ? `approved${r.spec.approvedOn ? ` ${shortDay(r.spec.approvedOn)}` : ''}` : 'draft'}` : 'no spec file')
      const last = r.plans.at(-1)
      const finished = r.plans.map(p => p.finished).filter((d): d is string => !!d).sort().at(-1)
      if (r.state === 'done' && finished) bits.push(`finished ${shortDay(finished)}${last?.where === 'archive' ? ` (${last.dir})` : ''}`)
      else if (last?.started) bits.push(`started ${shortDay(last.started)}`)
    }
    lines.push(`  ${GLYPH[r.state]} ${r.id.padEnd(w)}${bits.join(' · ')}`)
  }
  lines.push('/progress modules <id> shows one module\'s run timeline.')
  return lines.join('\n')
}
