// Parsers for the files agent-skills writes: SPEC.md, tasks/plan.md and tasks/todo.md.
// Pure functions over text, so the mod, its tests and any other tool can share them.

export type Box = { text: string; isDone: boolean }

export type TaskStatus = 'done' | 'next' | 'todo' | 'blocked'

export type Task = {
  /** `T3`, or `#5` for an item of a plain checklist. */
  id: string
  title: string
  phase: string | null
  boxes: Box[]
  /** Ids of the tasks this one waits on. */
  deps: string[]
  status: TaskStatus
  /** Set on the last task before a checkpoint. */
  checkpoint: Checkpoint | null
}

export type Checkpoint = { title: string; items: Box[] }

export type TaskList = {
  /** `tasks`: `## Task N:` sections or `- [ ] Task N:` lines. `checklist`: plain boxes. */
  kind: 'tasks' | 'checklist' | 'empty'
  tasks: Task[]
  checkpoints: Checkpoint[]
  done: number
  total: number
  /** The first task that is neither done nor blocked. */
  current: Task | null
}

const BOX = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const TASK_HEADING = /^Task\s+(\d+)\s*[:.\-–—]\s*(.*)$/i
const TASK_LINE = /^Task\s+(\d+)\s*[:.\-–—]\s*(.*)$/i
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

  let phase: string | null = null
  // What the lines under the current heading belong to.
  let section: { kind: 'task'; task: Task } | { kind: 'checkpoint'; cp: Checkpoint } | { kind: 'other' } = {
    kind: 'other',
  }
  let inFence = false

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

    const deps = DEPS.exec(line)
    if (deps && section.kind === 'task') {
      section.task.deps = parseDeps(stripMd(deps[1] ?? ''))
      continue
    }

    const box = BOX.exec(line)
    if (!box) continue
    const item: Box = { text: stripMd(box[2] ?? ''), isDone: box[1] !== ' ' }

    if (section.kind === 'task') {
      section.task.boxes.push(item)
    } else if (section.kind === 'checkpoint') {
      section.cp.items.push(item)
    } else {
      const line = TASK_LINE.exec(item.text)
      if (line) {
        tasks.push({
          id: `T${line[1] ?? ''}`,
          title: (line[2] ?? '').trim(),
          phase,
          boxes: [item],
          deps: [],
          status: 'todo',
          checkpoint: null,
        })
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
    return finish(tasks, checkpoints, 'checklist')
  }
  return finish(tasks, checkpoints, tasks.length > 0 ? 'tasks' : 'empty')
}

/** Detailed sections win over the one-line index when both name the same task. */
function dedupe(tasks: Task[]): Task[] {
  const byId = new Map<string, Task>()
  for (const t of tasks) {
    const had = byId.get(t.id)
    if (!had || t.boxes.length > had.boxes.length) {
      byId.set(t.id, had ? { ...t, phase: t.phase ?? had.phase, checkpoint: t.checkpoint ?? had.checkpoint } : t)
    }
  }
  return [...byId.values()]
}

function finish(all: Task[], checkpoints: Checkpoint[], kind: TaskList['kind']): TaskList {
  const tasks = dedupe(all)
  const isDone = (t: Task) => t.boxes.length > 0 && t.boxes.every(b => b.isDone)
  const doneIds = new Set(tasks.filter(isDone).map(t => t.id))
  const known = new Set(tasks.map(t => t.id))

  let current: Task | null = null
  for (const t of tasks) {
    if (doneIds.has(t.id)) t.status = 'done'
    else if (t.deps.some(d => known.has(d) && !doneIds.has(d))) t.status = 'blocked'
    else if (current === null) {
      t.status = 'next'
      current = t
    } else t.status = 'todo'
  }
  return { kind, tasks, checkpoints, done: doneIds.size, total: tasks.length, current }
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

  return { title, status, areas, boundaries, successCriteria, openQuestions }
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

export type PlanDoc = { trackedIn: string | null; openQuestions: string[] }

export function parsePlan(text: string): PlanDoc {
  const trackedIn = /tasks (?:are )?tracked in ([^\n.]+)/i.exec(text)?.[1]?.trim() ?? null
  const oq = /^##\s+Open Questions\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im.exec(text)?.[1] ?? ''
  const openQuestions = oq
    .split('\n')
    .map(l => /^\s*[-*+]\s+(.*)$/.exec(l)?.[1])
    .filter((l): l is string => !!l && !/^\[.*\]$/.test(l.trim()))
    .map(stripMd)
  return { trackedIn, openQuestions }
}
