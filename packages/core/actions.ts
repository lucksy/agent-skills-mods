// One table of actions (team-view, T1): each write the plugin makes, by name, as
// an argument check and a pure edit. The /progress verbs and the live server's
// POST /action both call it, so the dashboard and the commands can't drift apart.
// Text in, `{ ok, reply, writes }` out; the caller reads, writes and replies. Pure.

import { addHandoff, addQuestion, hasTaskSection, setFrontMatter, setOwner, setReview, stampDoc, stampTodo, tickTask, toggleBox, type TaskState } from './format'
import { parseSpec, parseTasks, type Task, type TaskList } from './parse'
import { approvalStatus, signSpec } from './approvals'
import { shortDay } from './forecast'
import { TEAM_FILE, whoIs, type Team } from './team'

export const ACTION_NAMES = ['start', 'done', 'block', 'unblock', 'tick', 'claim', 'assign', 'unassign', 'review', 'handoff', 'sign'] as const
export type ActionName = (typeof ACTION_NAMES)[number]

/** What an action reads: the files as they are on disk, and who runs it. */
export type ActionInput = {
  /** tasks/todo.md and tasks/plan.md; null when missing. */
  todo: string | null
  plan: string | null
  /** The spec `sign` signs; null when there is none. */
  spec: { file: string; text: string } | null
  /** The task list as the board shows it (blockers included). */
  list: TaskList | null
  today: string
  team: Team | null
  /** Your git email, which tasks/team.md maps to a handle; null when unknown. */
  email: string | null
  /** Task state changes seen since tasks/todo.md was last written (E1). */
  pending: Record<string, Partial<TaskState>>
  /** The `progressFormat` option: whether a ticked box stamps Status lines. */
  keepFormat: boolean
}

/** What an action did: the reply, and the files to write (repo-relative), in order. A refusal writes nothing. */
export type ActionResult = { ok: boolean; reply: string; writes: { file: string; text: string }[] }

type Args = Record<string, unknown>
type Action = {
  /** Whether the action edits tasks/todo.md, so a missing file is refused first. */
  todo: boolean
  /** The args the action takes, or the reply refusing them. */
  check: (args: Args) => Args | string
  edit: (args: Args, input: ActionInput) => ActionResult
}

const refuse = (reply: string): ActionResult => ({ ok: false, reply, writes: [] })
const TODO = 'tasks/todo.md'

const isStr = (v: unknown): v is string => typeof v === 'string'
/** Optional string args: absent, or a string. */
const strings = (args: Args, keys: string[]) => keys.every(k => args[k] === undefined || isStr(args[k]))

/** `4`, `t4` and `T4` all name T4. */
const taskId = (raw: string) => (/^\d+$/.test(raw) ? `T${raw}` : raw.toUpperCase())

/** The task `raw` names, or the reply saying it has no section. */
function findTask(raw: string, input: ActionInput): { id: string; task: Task } | string {
  const id = taskId(raw)
  const task = input.list?.tasks.find(t => t.id === id)
  if (!task || !hasTaskSection(input.todo!, id)) {
    return `No "## Task ${id.slice(1)}:" section in tasks/todo.md.${input.list?.tasks.length ? ` Tasks: ${input.list.tasks.map(t => t.id).join(', ')}.` : ''}`
  }
  return { id, task }
}

/** Who runs the action, as tasks/team.md names them; null without the file or a matching email. */
const sessionHandle = (input: ActionInput) => (input.team ? (whoIs(input.team, input.email)?.handle ?? null) : null)

/** start, done, block and unblock: `/progress start|done|block|unblock T4 ["why"]`. */
function setTask(verb: 'start' | 'done' | 'block' | 'unblock'): Action {
  return {
    todo: true,
    check: args => (isStr(args.id) && strings(args, ['why']) ? args : `Say which task: /progress ${verb} T4${verb === 'block' ? ' "why"' : ''}.`),
    edit: (args, input) => {
      const found = findTask(args.id as string, input)
      if (typeof found === 'string') return refuse(found)
      const { id, task } = found
      const text = input.todo!
      const { today, pending: changes } = input
      const writes: ActionResult['writes'] = []
      let next = text
      let said: string
      if (verb === 'start') {
        const owner = task.owner ? undefined : (sessionHandle(input) ?? undefined)
        next = stampTodo(text, today, { changes: { ...changes, [id]: { status: 'in progress', started: today, ...(owner ? { owner } : {}) } } })
        said = `${id} ${task.title} is in progress (started ${shortDay(task.state?.started ?? today)}).`
      } else if (verb === 'done') {
        next = stampTodo(tickTask(text, id), today, { changes })
        said = `${id} ${task.title} is done: ${task.boxes.filter(b => !b.isDone).length} box(es) ticked.`
      } else if (verb === 'block') {
        const why = (args.why as string | undefined) ?? ''
        if (!why) return refuse('Say why: /progress block T6 "Upstash or self-hosted?"')
        next = stampTodo(text, today, { changes: { ...changes, [id]: { status: 'blocked' } } })
        const added = addQuestion(input.plan, id, why)
        writes.push({ file: 'tasks/plan.md', text: added.text })
        said = `${id} ${task.title} is blocked. Added ${added.q} to tasks/plan.md: "${why}".`
      } else {
        next = stampTodo(text, today, { changes: { ...changes, [id]: { status: 'todo' } } })
        said = `${id} ${task.title} is unblocked. Remove or answer its question in tasks/plan.md so it stays that way.`
      }
      if (next !== text) writes.push({ file: TODO, text: next })
      return { ok: true, reply: said, writes }
    },
  }
}

/** A box ticked or unticked from the board: `index` counts the task's boxes from 0. */
const tick: Action = {
  todo: true,
  check: args => (isStr(args.id) && Number.isInteger(args.index) ? args : 'Say which box: { id: "T4", index: 0 }.'),
  edit: (args, input) => {
    const id = taskId(args.id as string)
    const index = args.index as number
    const toggled = toggleBox(input.todo!, id, index)
    if (toggled === input.todo) return refuse(`No box ${index + 1} in ${id}.`)
    const next = input.keepFormat ? stampTodo(toggled, input.today, { changes: input.pending }) : toggled
    const after = parseTasks(next).tasks.find(t => t.id === id)
    const box = after?.boxes[index]
    return { ok: true, reply: `${id} ${box?.isDone ? 'ticked' : 'unticked'}: ${box?.text ?? `box ${index + 1}`}.`, writes: [{ file: TODO, text: next }] }
  },
}

/**
 * claim, assign and unassign (format-v2, F2 and F3): the owner on the task's
 * Status line, every other byte kept. Anyone may assign: roles are shown, never enforced.
 */
function owner(verb: 'claim' | 'assign' | 'unassign'): Action {
  return {
    todo: true,
    check: args => (isStr(args.id) && args.id && strings(args, ['who']) ? args : `Say which task: /progress ${verb} T4${verb === 'assign' ? ' @sara' : ''}.`),
    edit: (args, input) => {
      const found = findTask(args.id as string, input)
      if (typeof found === 'string') return refuse(found)
      const { id, task } = found
      const team = input.team
      let owner: string | null = null
      let isYou = false
      if (verb !== 'unassign') {
        const who = verb === 'claim' ? 'me' : (args.who as string | undefined)
        if (!who) return refuse(`Say who: /progress assign ${id} @sara, or /progress claim ${id} for yourself.`)
        if (who === 'me') {
          const email = input.email
          const me = whoIs(team, email)
          if (!me) {
            const why = !team ? 'no tasks/team.md here. /progress team init sets one up;' : !email ? 'git config user.email is not set. Set it,' : `${email} is not in tasks/team.md. Add a row with it,`
            return refuse(`Can't tell who you are: ${why} or name someone: /progress assign ${id} @name.`)
          }
          owner = me.handle
          isYou = true
        } else owner = who.startsWith('@') ? who : `@${who}`
      }
      const was = task.owner
      const writes = [{ file: TODO, text: setOwner(input.todo!, id, owner) }]
      if (!owner) return { ok: true, reply: `${id} ${task.title} has no owner now${was ? ` (was ${was})` : ''}.`, writes }
      const unknown = team && !team.members.some(m => m.handle.toLowerCase() === owner!.toLowerCase()) ? ` ${owner} is not in tasks/team.md (/progress team).` : ''
      return { ok: true, reply: `${id} ${task.title} → ${owner}${isYou ? ' (you)' : ''}${was && was !== owner ? `, was ${was}` : ''}.${unknown}`, writes }
    },
  }
}

/**
 * review (format-v2, F4): the task in review, with its PR and reviewer (`refs`:
 * `#42`, a PR link, `@bob`); owner and dates kept. A done task, or one with
 * nothing ticked yet, is refused with why.
 */
const review: Action = {
  todo: true,
  check: args =>
    isStr(args.id) && args.id && (args.refs === undefined || (Array.isArray(args.refs) && args.refs.every(isStr)))
      ? args
      : 'Say which task: /progress review T4 #42 @bob (PR and reviewer optional).',
  edit: (args, input) => {
    const found = findTask(args.id as string, input)
    if (typeof found === 'string') return refuse(found)
    const { id, task } = found
    let pr: string | undefined
    let reviewer: string | undefined
    for (const w of (args.refs as string[] | undefined) ?? []) {
      if (/^#\d+$/.test(w) || /^https?:\/\//i.test(w)) pr = w
      else if (/^@[\w.-]+$/.test(w)) reviewer = w
      else return refuse(`Not a PR or a reviewer: "${w}". Use /progress review ${id} #42 @bob (both optional).`)
    }
    if (task.status === 'done') return refuse(`${id} ${task.title} is done: a review comes before its last box is ticked.`)
    if (!task.boxes.some(b => b.isDone) && task.state?.status !== 'in progress' && task.state?.status !== 'in review') {
      return refuse(`${id} ${task.title} has no box ticked yet: build it first, or /progress start ${id}.`)
    }
    const next = setReview(input.todo!, id, { pr, reviewer })
    const after = parseTasks(next).tasks.find(t => t.id === id)
    const bits = [after?.pr && `PR ${after.pr}`, after?.reviewer && `reviewer ${after.reviewer}`].filter(Boolean)
    return { ok: true, reply: `${id} ${task.title} is in review${bits.length ? `: ${bits.join(', ')}` : ''}.`, writes: [{ file: TODO, text: next }] }
  },
}

/**
 * handoff (format-v2, F6): the task's new owner `to`, and a dated `note` under it
 * from the old owner (else you), which the next person's agent reads.
 */
const handoff: Action = {
  todo: true,
  check: args => (isStr(args.id) && args.id && strings(args, ['to', 'note']) ? args : 'Say which task: /progress handoff T4 @bob "migration done, tests left".'),
  edit: (args, input) => {
    const found = findTask(args.id as string, input)
    if (typeof found === 'string') return refuse(found)
    const { id, task } = found
    const to = args.to as string | undefined
    const note = ((args.note as string | undefined) ?? '').trim()
    if (!to) return refuse(`Say who takes it: /progress handoff ${id} @bob "${note || 'note'}".`)
    if (!note) return refuse(`Say what the next person needs to know: /progress handoff ${id} ${to} "migration done, tests left".`)
    const from = task.owner ?? sessionHandle(input)
    return {
      ok: true,
      reply: `${id} ${task.title} → ${to}${from ? `, from ${from}` : ''}. Note: "${note}".`,
      writes: [{ file: TODO, text: addHandoff(input.todo!, id, { day: input.today, from, to, note }) }],
    }
  },
}

/**
 * sign (A1, format-v2 F5): approve the spec; with `approvals:` in tasks/team.md,
 * sign it for your roles instead, and it is approved once every role has signed.
 */
const sign: Action = {
  todo: false,
  check: args => args,
  edit: (_args, input) => {
    if (!input.spec) return refuse('No spec here to sign.')
    const { file, text } = input.spec
    const { team, today } = input
    if (!team?.approvals.length) {
      return { ok: true, reply: `✓ ${file} approved · planning can start`, writes: [{ file, text: stampDoc(setFrontMatter(text, { status: 'approved', approved: today }), today) }] }
    }
    const me = whoIs(team, input.email)
    if (!me) return refuse(`Can't sign: ${input.email ? `${input.email} is not in ${TEAM_FILE}` : 'git config user.email is not set'}.`)
    const r = signSpec(stampDoc(text, today), me, team.approvals, today)
    if (!r.signed.length) {
      const sigs = parseSpec(text).approvals
      const open = team.approvals.filter(role => !sigs.some(s => s.role === role))
      return refuse(open.length ? `${me.handle} (${me.roles.join(', ') || 'no role'}) holds no role ${file} still waits on: ${open.join(', ')}.` : `${file} has every signature it needs.`)
    }
    const waiting = approvalStatus(parseSpec(r.text).approvals, team).waiting
    return {
      ok: true,
      reply: r.complete
        ? `✓ ${file} approved: every role has signed (${team.approvals.join(', ')})`
        : `✓ ${me.handle} signed ${file} for ${r.signed.join(', ')} · waiting on ${waiting.map(w => `${w.who.join(' or ') || w.role} (${w.role})`).join(', ')}`,
      writes: [{ file, text: r.text }],
    }
  },
}

export const ACTIONS: Record<ActionName, Action> = {
  start: setTask('start'),
  done: setTask('done'),
  block: setTask('block'),
  unblock: setTask('unblock'),
  tick,
  claim: owner('claim'),
  assign: owner('assign'),
  unassign: owner('unassign'),
  review,
  handoff,
  sign,
}

export const isActionName = (name: string): name is ActionName => (ACTION_NAMES as readonly string[]).includes(name)

/** Runs action `name` on `input`: a missing tasks/todo.md, bad args or the edit's own check refuse it. */
export function runAction(name: string, args: Args, input: ActionInput): ActionResult {
  if (!isActionName(name)) return refuse(`No action "${name}". Actions: ${ACTION_NAMES.join(', ')}.`)
  const action = ACTIONS[name]
  if (action.todo && input.todo === null) return refuse('No tasks/todo.md here.')
  const checked = action.check(args ?? {})
  if (typeof checked === 'string') return refuse(checked)
  return action.edit(checked, input)
}
