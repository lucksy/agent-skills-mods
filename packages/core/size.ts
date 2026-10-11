// Task size (ceremonies, C1): what a `**Size:**` line weighs. S is ½ point, M 1
// and L 2; a task without a size counts as 1, the same as M, so a plan with no
// Size lines weighs exactly its task count and every forecast stays as it was. Pure.

import type { TaskSize } from './format'
import type { Task, TaskList } from './parse'

export const SIZES: readonly TaskSize[] = ['S', 'M', 'L']

export const WEIGHT: Record<TaskSize, number> = { S: 0.5, M: 1, L: 2 }

/** A task's points: its size's weight, or 1 without one. */
export const weightOf = (t: { size?: TaskSize }) => (t.size ? WEIGHT[t.size] : 1)

/** The points of some tasks together. */
export const pointsOf = (tasks: readonly Pick<Task, 'size'>[]) => tasks.reduce((n, t) => n + weightOf(t), 0)

/** Each sized task's size by id: what an older copy of the list, written before the sizes were, is weighed by (T2). */
export const sizesOf = (list: TaskList): Map<string, TaskSize> => new Map(list.tasks.flatMap(t => (t.size ? [[t.id, t.size] as const] : [])))

/**
 * A list's points done and in total; with no sizes, its done and total counts.
 * `sizes` weighs a task without a Size line of its own (an older copy, by today's sizes).
 */
export function listPoints(list: TaskList, sizes?: ReadonlyMap<string, TaskSize>): { done: number; total: number } {
  const sized = sizes ? list.tasks.map(t => ({ ...t, size: t.size ?? sizes.get(t.id) })) : list.tasks
  return { done: pointsOf(sized.filter(t => t.status === 'done')), total: pointsOf(sized) }
}

/** `1 point`, `½ point`, `2½ points`: a number of points in words. */
export function pointsText(n: number): string {
  const whole = Math.floor(n)
  const half = n - whole >= 0.5
  const num = `${whole || !half ? whole : ''}${half ? '½' : ''}`
  return `${num} point${n === 1 || n === 0.5 ? '' : 's'}`
}
