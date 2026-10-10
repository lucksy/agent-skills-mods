// Parsers for the files agent-skills writes: SPEC.md, tasks/plan.md and tasks/todo.md.
// Pure functions over text, so the mod, its tests and any other tool can share them.

import { parseStatusLine, readFrontMatter, type TaskState } from './format'

export type Box = { text: string; isDone: boolean }

/**
 * `waiting`: a task it depends on is not done yet, the normal state of a plan
 * under way. `blocked`: an open question names it, so it needs a decision.
 */
export type TaskStatus = 'done' | 'next' | 'todo' | 'waiting' | 'blocked'

export type Task = {
  /** `T3`, or `#5` for an item of a plain checklist. */
  id: string
  title: string
  phase: string | null
  boxes: Box[]
  /** Ids of the tasks this one waits on. */
  deps: string[]
  status: TaskStatus
  /** The open question that blocks it, with the file it is in (withBlockers). */
  blockedBy?: string
  /** Set on the last task before a checkpoint. */
  checkpoint: Checkpoint | null
  /** What its `**Status:**` line says (the progress format, E1), when it has one. */
  state?: TaskState
  /** Which part of the section each box is in, parallel to `boxes`: acceptance criteria or verification. */
  kinds?: ('criteria' | 'verification')[]
  /**
   * How its line in the task index is ticked, when the list has one: `[x]` done,
   * `[~]` under way. The person's own mark, so it wins over the section's open boxes.
   */
  mark?: 'done' | 'doing'
}

export type Checkpoint = { title: string; items: Box[] }

/** A task's identity across edits and plans: its id and its title together. */
export const taskKey = (t: Task) => `${t.id}|${t.title}`

export type TaskList = {
  /** `tasks`: `## Task N:` sections or `- [ ] Task N:` lines. `checklist`: plain boxes. */
  kind: 'tasks' | 'checklist' | 'empty'
  tasks: Task[]
  checkpoints: Checkpoint[]
  done: number
  total: number
  /** The first task marked in progress, else the first that is neither done, waiting nor blocked. */
  current: Task | null
  /** The task list's front matter (the progress format): its plan name and the day it was created. */
  meta?: { plan?: string; created?: string }
}

/** `[ ]` open, `[x]` done, `[~]` under way (counted as open in a section, as under way in the index). */
const BOX = /^\s*[-*+]\s+\[([ xX~])\]\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const TASK_HEADING = /^Task\s+(\d+)\s*[:.\-–—]\s*(.*)$/i
/** An index line: `Task 3: title`, or `T3 · title` as hand-kept indexes write it. */
const TASK_LINE = /^(?:Task\s+|T)(\d+)\s*[:.\-–—·]\s*(.*)$/i
/** What an index line adds after its title: ` — **found; 2 items left**`. */
const LINE_NOTE = /\s+[—–]\s+.*$/
const CHECKPOINT = /^Checkpoint\b\s*[:.\-–—]?\s*(.*)$/i
const PHASE = /^Phase\b/i
const DEPS = /^\s*\*\*Dependencies:?\*\*:?\s*(.*)$/i

const stripMd = (s: string) => s.replace(/\*\*|__|`/g, '').trim()

/** Task ids named on a Dependencies line: `Task 1, 2`, `T3`, `None`. */
export function parseDeps(text: string): string[] {
  if (/^\s*(none|n\/a|-|—)?\s*\.?\s*$/i.test(text)) return []
  const ids = new Set<string>()
  for (const m of text.matchAll(/\b(?:T(?:ask)?\s*)?(\d+)\b/gi)) ids.add(`T${m[1] ?? ''}`)
  return [...ids]
}

/**
 * Reads a task list. Never throws: text that matches no template comes back as a
 * plain checklist, and text with no boxes at all as `empty`.
 */
export function parseTasks(text: string): TaskList {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const tasks: Task[] = []
  const checkpoints: Checkpoint[] = []
  const loose: Box[] = []
  const fromIndex = new Set<Task>()

  let phase: string | null = null
  // What the lines under the current heading belong to.
  let section: { kind: 'task'; task: Task } | { kind: 'checkpoint'; cp: Checkpoint } | { kind: 'other' } = {
    kind: 'other',
  }
  let inFence = false
  let boxKind: 'criteria' | 'verification' = 'criteria'

  const closeCheckpoint = (cp: Checkpoint) => {
    const last = tasks[tasks.length - 1]
    if (last && last.checkpoint === null) last.checkpoint = cp
    checkpoints.push(cp)
  }

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) continue

    const h = HEADING.exec(line)
    if (h) {
      const title = stripMd(h[2] ?? '')
      const task = TASK_HEADING.exec(title)
      const cp = CHECKPOINT.exec(title)
      if (task) {
        const t: Task = {
          id: `T${task[1] ?? ''}`,
          title: (task[2] ?? '').trim(),
          phase,
          boxes: [],
          deps: [],
          status: 'todo',
          checkpoint: null,
        }
        tasks.push(t)
        section = { kind: 'task', task: t }
        boxKind = 'criteria'
      } else if (cp) {
        const c: Checkpoint = { title: (cp[1] ?? '').trim() || 'Checkpoint', items: [] }
        closeCheckpoint(c)
        section = { kind: 'checkpoint', cp: c }
      } else {
        if (PHASE.test(title)) phase = title
        else if ((h[1] ?? '').length <= 2) phase = null
        section = { kind: 'other' }
      }
      continue
    }

    if (section.kind === 'task') {
      if (/^\s*\*\*Verification:?\*\*/i.test(line)) boxKind = 'verification'
      else if (/^\s*\*\*Acceptance criteria:?\*\*/i.test(line)) boxKind = 'criteria'
      const st = section.task.state ? null : parseStatusLine(line)
      if (st) {
        section.task.state = st
        continue
      }
    }

    const deps = DEPS.exec(line)
    if (deps && section.kind === 'task') {
      section.task.deps = parseDeps(stripMd(deps[1] ?? ''))
      continue
    }

    const box = BOX.exec(line)
    if (!box) continue
    const item: Box = { text: stripMd(box[2] ?? ''), isDone: box[1] === 'x' || box[1] === 'X' }

    if (section.kind === 'task') {
      section.task.boxes.push(item)
      ;(section.task.kinds ??= []).push(boxKind)
    } else if (section.kind === 'checkpoint') {
      section.cp.items.push(item)
    } else {
      // A struck-through line (`~~T1 · title~~ — superseded`) still names its task.
      const line = TASK_LINE.exec(item.text.replace(/^~~/, '').replace(/~~(?=\s|$)/, ''))
      if (line) {
        const t: Task = {
          id: `T${line[1] ?? ''}`,
          title: (line[2] ?? '').replace(LINE_NOTE, '').trim(),
          phase,
          boxes: [item],
          deps: [],
          status: 'todo',
          checkpoint: null,
          mark: item.isDone ? 'done' : box[1] === '~' ? 'doing' : undefined,
        }
        tasks.push(t)
        fromIndex.add(t)
      } else {
        loose.push(item)
      }
    }
  }

  if (tasks.length === 0 && loose.length > 0) {
    loose.forEach((b, i) =>
      tasks.push({
        id: `#${i + 1}`,
        title: b.text,
        phase: null,
        boxes: [b],
        deps: [],
        status: 'todo',
        checkpoint: null,
      }),
    )
    return withMeta(finish(tasks, checkpoints, 'checklist'), text)
  }
  return withMeta(finish(tasks, checkpoints, tasks.length > 0 ? 'tasks' : 'empty', fromIndex), text)
}

function withMeta(list: TaskList, text: string): TaskList {
  const { fields, hasFrontMatter } = readFrontMatter(text)
  if (!hasFrontMatter) return list
  return { ...list, meta: { plan: fields.plan || undefined, created: /^\d{4}-\d{2}-\d{2}$/.test(fields.created ?? '') ? fields.created : undefined } }
}

/**
 * Detailed sections win over the one-line index when both name the same task,
 * and the tasks keep the sections' order. A task only the index has goes after
 * the one listed before it there. The index line's mark is kept.
 */
function dedupe(all: Task[], fromIndex: ReadonlySet<Task> = new Set()): Task[] {
  const byId = new Map<string, { task: Task; at: number; isIndex: boolean }>()
  all.forEach((t, i) => {
    const had = byId.get(t.id)
    if (!had) byId.set(t.id, { task: t, at: i, isIndex: fromIndex.has(t) })
    else if (t.boxes.length > had.task.boxes.length) {
      const h = had.task
      byId.set(t.id, { task: { ...t, phase: t.phase ?? h.phase, checkpoint: t.checkpoint ?? h.checkpoint, mark: t.mark ?? h.mark }, at: i, isIndex: fromIndex.has(t) })
    } else if (!had.task.mark && t.mark) byId.set(t.id, { ...had, task: { ...had.task, mark: t.mark } })
  })
  if (fromIndex.size > 0) {
    let prev = -1
    for (const t of all) {
      if (!fromIndex.has(t)) continue
      const e = byId.get(t.id)!
      if (e.isIndex) e.at = prev += 1e-3
      else prev = e.at
    }
  }
  return [...byId.values()].sort((a, b) => a.at - b.at).map(e => e.task)
}

function finish(all: Task[], checkpoints: Checkpoint[], kind: TaskList['kind'], fromIndex?: ReadonlySet<Task>): TaskList {
  const tasks = dedupe(all, fromIndex)
  // Done: every box ticked, or the person said so (its index line, its Status line).
  const isDone = (t: Task) => t.mark === 'done' || t.state?.status === 'done' || (t.boxes.length > 0 && t.boxes.every(b => b.isDone))
  const doneIds = new Set(tasks.filter(isDone).map(t => t.id))
  const known = new Set(tasks.map(t => t.id))

  let current: Task | null = null
  for (const t of tasks) {
    if (doneIds.has(t.id)) t.status = 'done'
    else if (t.blockedBy) t.status = 'blocked'
    else if (t.state?.status === 'blocked') {
      t.status = 'blocked'
      t.blockedBy = t.blockedBy ?? 'its Status line says blocked'
    } else if (t.deps.some(d => known.has(d) && !doneIds.has(d))) t.status = 'waiting'
    else if (current === null) {
      t.status = 'next'
      current = t
    } else t.status = 'todo'
  }
  // A task its Status line says is in progress is the current one, wherever it is.
  const active = tasks.find(t => (t.state?.status === 'in progress' || (!t.state && t.mark === 'doing')) && (t.status === 'todo' || t.status === 'next' || t.status === 'waiting'))
  if (active && active !== current) {
    if (current) current.status = 'todo'
    active.status = 'next'
    current = active
  }
  return { kind, tasks, checkpoints, done: doneIds.size, total: tasks.length, current }
}

/** `T6`, `Task 6`, `task #6` named in a question. */
const TASK_REF = /\b(?:T(\d+)|[Tt]ask\s*#?(\d+))\b/g

/**
 * The list with every open task an open question names marked blocked, and
 * the current task moved past them. A question that names no task blocks
 * nothing; it still waits for a decision.
 */
export function withBlockers(list: TaskList, questions: { file: string; text: string }[]): TaskList {
  const by = new Map<string, string>()
  for (const q of questions) for (const m of q.text.matchAll(TASK_REF)) by.set(`T${m[1] ?? m[2]}`, `${q.file}: ${q.text}`)
  if (![...by.keys()].some(id => list.tasks.some(t => t.id === id))) return list
  const tasks = list.tasks.map(t => ({ ...t, blockedBy: by.get(t.id) }))
  return { ...finish(tasks, list.checkpoints, list.kind), meta: list.meta }
}

/** Tasks still to do, as the write guard counts them. */
export function openCount(list: TaskList): number {
  return list.total - list.done
}

// ---------------------------------------------------------------- SPEC.md

export type AreaState = 'present' | 'empty' | 'missing'

export type SpecArea = {
  key: string
  label: string
  state: AreaState
  body: string
  /** Why a present area looks weak (A2), or null. A hint only: it never blocks approval. */
  hint: string | null
}

export type Spec = {
  title: string | null
  /** From front matter `status:`; `null` when the file does not say. */
  status: 'draft' | 'approved' | null
  /** From front matter (the progress format): the day it was written and the day it was approved. */
  created?: string
  approvedOn?: string
  areas: SpecArea[]
  boundaries: { always: string[]; ask: string[]; never: string[] }
  /** From `## Success Criteria`, or a "Success criteria" list inside Objective. */
  successCriteria: string[]
  openQuestions: string[]
}

/** The six core areas the spec skill requires, in its order. */
export const CORE_AREAS: ReadonlyArray<{ key: string; label: string; match: RegExp }> = [
  { key: 'objective', label: 'Objective', match: /^objective/i },
  { key: 'commands', label: 'Commands', match: /^commands?\b/i },
  { key: 'structure', label: 'Project structure', match: /^(project\s+)?structure/i },
  { key: 'style', label: 'Code style', match: /^code\s+style|^style/i },
  { key: 'testing', label: 'Testing', match: /^testing/i },
  { key: 'boundaries', label: 'Boundaries', match: /^boundaries/i },
]

export function parseSpec(text: string): Spec {
  let body = text.replace(/\r\n?/g, '\n')
  let status: Spec['status'] = null
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body)
  if (fm) {
    const s = /^status:\s*["']?(\w+)/im.exec(fm[1] ?? '')?.[1]?.toLowerCase()
    if (s === 'approved' || s === 'draft') status = s
    body = body.slice(fm[0].length)
  }

  const title = /^#\s+(.*)$/m.exec(body)?.[1]?.replace(/^Spec:\s*/i, '').trim() ?? null

  // Split into level-2 sections.
  const sections: { heading: string; body: string }[] = []
  let cur: { heading: string; lines: string[] } | null = null
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const h = !inFence && /^##\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      if (cur) sections.push({ heading: cur.heading, body: cur.lines.join('\n').trim() })
      cur = { heading: stripMd(h[1] ?? ''), lines: [] }
    } else if (cur) cur.lines.push(line)
  }
  if (cur) sections.push({ heading: cur.heading, body: cur.lines.join('\n').trim() })

  const areas: SpecArea[] = CORE_AREAS.map(a => {
    const s = sections.find(x => a.match.test(x.heading))
    const state: AreaState = !s ? 'missing' : isPlaceholder(s.body) ? 'empty' : 'present'
    return { key: a.key, label: a.label, state, body: s?.body ?? '', hint: null }
  })

  const objective = areas.find(a => a.key === 'objective')?.body ?? ''
  const scSection = sections.find(s => /^success criteria/i.test(s.heading))
  const successCriteria = criteriaItems(
    scSection ? scSection.body : (/success criteria[^\n]*\n([\s\S]*)/i.exec(objective)?.[1] ?? ''),
    !scSection,
  )
  for (const a of areas) if (a.state === 'present') a.hint = weakness(a, successCriteria)

  const boundaries = { always: [] as string[], ask: [] as string[], never: [] as string[] }
  const bText = areas.find(a => a.key === 'boundaries')?.body ?? ''
  let bucket: keyof typeof boundaries | null = null
  for (const raw of bText.split('\n')) {
    const line = stripMd(raw.replace(/^\s*[-*+]\s+/, ''))
    const head = /^(always(?: do)?|ask first|never(?: do)?)\s*:?\s*(.*)$/i.exec(line)
    if (head) {
      const k = (head[1] ?? '').toLowerCase()
      bucket = k.startsWith('always') ? 'always' : k.startsWith('ask') ? 'ask' : 'never'
      for (const item of (head[2] ?? '').split(/[,;]\s*/)) if (item.trim()) boundaries[bucket].push(item.trim())
    } else if (bucket && /^\s+[-*+]\s+/.test(raw) && line) {
      boundaries[bucket].push(line)
    }
  }

  const oq = sections.find(s => /^open questions/i.test(s.heading))?.body ?? ''
  const openQuestions = oq
    .split('\n')
    .map(l => /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(l)?.[1])
    .filter((l): l is string => !!l && !isPlaceholder(l))
    .map(stripMd)

  const dates = readFrontMatter(text).fields
  const day = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)
  return { title, status, areas, boundaries, successCriteria, openQuestions, created: day(dates.created), approvedOn: day(dates.approved) }
}

const isPlaceholder = (s: string) => s.replace(/\[[^\]]*\]|[-*\s]|<!--[\s\S]*?-->/g, '') === ''

/** List items of a criteria block; prose lines too when the block is its own section. */
function criteriaItems(text: string, listOnly: boolean): string[] {
  const items: string[] = []
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line) || (listOnly && items.length > 0 && !line.trim())) break
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line)?.[1]
    const item = li ?? (listOnly ? undefined : line.trim())
    if (item && !isPlaceholder(item)) items.push(stripMd(item))
  }
  return items
}

/** A number, a comparison, or words that make a criterion checkable. */
const TESTABLE =
  /\d|[<>≤≥=]|\b(when|if|within|under|over|below|above|less|more|least|most|after|before|returns?|responds?|rejects?|fails?|passes|shows?|every|each|only|never|no|all|without)\b/i

/** A runnable command: in a code block, in backticks, or a line that starts with a common tool. */
const RUNNABLE =
  /```[\s\S]*?\S[\s\S]*?```|~~~[\s\S]*?\S[\s\S]*?~~~|`[^`\n]+`|^\s*(?:[-*+]\s+)?(?:\$\s+)?(?:pnpm|npm|npx|yarn|bun|deno|node|make|cargo|go|python3?|pip|uv|pytest|poetry|docker|git|bash|sh|\.\/)\s/m

/** The weak-section rules (A2): one short reason, or null. */
function weakness(a: SpecArea, criteria: string[]): string | null {
  if (a.key === 'objective') {
    if (criteria.length === 0) return 'no success criteria'
    const vague = criteria.filter(c => !TESTABLE.test(c))
    if (vague.length === 0) return null
    return `${vague.length} of ${criteria.length} success criteria have no number or condition: "${vague[0]}"`
  }
  if (a.key === 'commands' && !RUNNABLE.test(a.body)) return 'no runnable command line'
  if (a.key === 'style' && !/^\s*(```|~~~)/m.test(a.body)) return 'no example code block'
  return null
}

// ---------------------------------------------------------------- tasks/plan.md

export type PlanDoc = {
  trackedIn: string | null
  openQuestions: string[]
  /** Front matter (the progress format): approval and dates. */
  status?: 'draft' | 'approved'
  created?: string
  approvedOn?: string
}

export function parsePlan(text: string): PlanDoc {
  const trackedIn = /tasks (?:are )?tracked in ([^\n.]+)/i.exec(text)?.[1]?.trim() ?? null
  const oq = /^##\s+Open Questions\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im.exec(text)?.[1] ?? ''
  const openQuestions = oq
    .split('\n')
    .map(l => /^\s*[-*+]\s+(.*)$/.exec(l)?.[1])
    .filter((l): l is string => !!l && !/^\[.*\]$/.test(l.trim()))
    .map(stripMd)
  const fm = readFrontMatter(text).fields
  const day = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)
  const status = fm.status === 'approved' || fm.status === 'draft' ? fm.status : undefined
  return { trackedIn, openQuestions, status, created: day(fm.created), approvedOn: day(fm.approved) }
}
