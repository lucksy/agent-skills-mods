// Health (K1): on track, or at risk with every reason a person should act on.
// There is no "off track" until a plan has a target date to miss. Pure.

import type { State } from './state'
import { specApproval } from './view'

export type Health = { status: 'on track' | 'at risk'; reasons: string[] }

export function health(s: State): Health {
  const list = s.list
  if (!list || list.total === 0) return { status: 'on track', reasons: [] }
  const reasons = [...s.alerts]
  for (const t of list.tasks) if (t.status === 'blocked' && t.blockedBy) reasons.push(`${t.id} is blocked: ${t.blockedBy.replace(/^[^:]+\.md: /, '')}`)
  const underWay = list.done > 0 || list.tasks.some(t => t.state?.status === 'in progress')
  if (underWay && specApproval(s.spec, true) === 'awaiting') reasons.push(`Building while ${s.specFile ?? 'SPEC.md'} awaits approval`)
  for (const t of list.tasks) {
    const cp = t.checkpoint
    if (cp && t.status === 'done' && cp.items.some(b => !b.isDone)) reasons.push(`Checkpoint after ${t.id} is not signed off: ${cp.title}`)
  }
  return { status: reasons.length ? 'at risk' : 'on track', reasons }
}
