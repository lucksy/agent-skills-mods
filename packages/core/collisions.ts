// Collision alerts (team-view V1): a task under way on two branches at once, or
// with two different owners. Read from the board across branches (branches.ts),
// with the current task as the working tree has it now, so starting a task that
// someone else already has shows in the same prompt. Pure.

import { stateWord, type BranchBoard, type RefState } from './branches'
import type { Task } from './parse'
import type { TaskStatusWord } from './format'

/** A ref's side of a collision, with how long ago the task started there. */
export type CollisionRef = RefState & {
  /** `today`, `2d`: since its Status line's start day, else the ref's newest commit; null when neither is known. */
  age: string | null
}

/** One task that collides, and every branch involved (this one first). */
export type Collision = {
  id: string
  title: string
  /** Under way on two branches, two different owners, or both. */
  why: ('under way' | 'owners')[]
  on: CollisionRef[]
}

const UNDER_WAY = new Set<TaskStatusWord>(['in progress', 'in review'])

/** The branch a ref stands for: `origin/feat/x` is the same branch as `feat/x`. */
export const branchOf = (r: Pick<RefState, 'ref' | 'remote'>) => (r.remote ? r.ref.replace(/^[^/]+\//, '') : r.ref)

/** Days since the task started on this ref, or since the ref's newest commit. */
function ageOf(r: RefState, now: number): string | null {
  const since = r.started ? Date.parse(`${r.started}T00:00:00Z`) : r.at
  if (since === null || Number.isNaN(since)) return null
  const days = Math.floor((now - since) / 86_400_000)
  return days <= 0 ? 'today' : `${days}d`
}

/**
 * Whether these refs' copies of one task collide: under way (in progress or in
 * review) on two branches, or two different owners where it is not done. Done
 * on one branch while under way on another is not a collision. A branch read
 * twice (local and remote-tracking) counts once, its first copy kept.
 */
function clash(on: RefState[]): { why: Collision['why']; on: RefState[] } | null {
  const seen = new Set<string>()
  const refs = on.filter(r => !seen.has(branchOf(r)) && seen.add(branchOf(r)))
  const under = refs.filter(r => UNDER_WAY.has(r.state))
  const owned = refs.filter(r => r.state !== 'done' && r.owner)
  const why: Collision['why'] = []
  if (under.length >= 2) why.push('under way')
  if (new Set(owned.map(r => r.owner)).size >= 2) why.push('owners')
  if (why.length === 0) return null
  const involved = new Set([...(why.includes('under way') ? under : []), ...(why.includes('owners') ? owned : [])])
  return { why, on: refs.filter(r => involved.has(r)) }
}

const withAge = (on: RefState[], now: number): CollisionRef[] => on.map(r => ({ ...r, age: ageOf(r, now) }))

/** Every collision on the board, in its row order. */
export function collisions(board: BranchBoard, now: number): Collision[] {
  return board.rows.flatMap(row => {
    const c = clash(row.on)
    return c ? [{ id: row.id, title: row.title, why: c.why, on: withAge(c.on, now) }] : []
  })
}

/**
 * The collision of one task as the working tree has it now, against the other
 * branches on a board read earlier: this branch's copies on the board are
 * replaced by `task`. Null when there is no board or no collision.
 */
export function collisionOf(task: Task, board: BranchBoard | null, now: number): Collision | null {
  if (!board) return null
  const name = board.here ?? 'HEAD'
  const here: RefState = { ref: name, remote: false, state: stateWord(task), owner: task.owner ?? null, started: task.state?.started ?? null, at: null }
  const others = (board.rows.find(r => r.id === task.id)?.on ?? []).filter(r => branchOf(r) !== name)
  const c = clash([here, ...others])
  return c ? { id: task.id, title: task.title, why: c.why, on: withAge(c.on, now) } : null
}

/**
 * The band's line for a collision, from this branch's side: the first other
 * branch involved. `T4 is also in progress on feat/rate-limit by @bob (2d)`.
 */
export function collisionLine(c: Collision, here: string | null): string {
  const other = c.on.find(r => branchOf(r) !== (here ?? 'HEAD')) ?? c.on[0]!
  const age = other.age ? ` (${other.age})` : ''
  const more = c.on.filter(r => branchOf(r) !== (here ?? 'HEAD')).length - 1
  const rest = more > 0 ? ` and ${more} more` : ''
  if (UNDER_WAY.has(other.state)) return `${c.id} is also ${other.state} on ${other.ref}${other.owner ? ` by ${other.owner}` : ''}${age}${rest}`
  return `${c.id} is also assigned to ${other.owner} on ${other.ref}${age}${rest}`
}
