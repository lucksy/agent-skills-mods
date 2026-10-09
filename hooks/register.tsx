import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AsmProject } from '../types'
import { parsePlan, parseSpec, parseTasks, type TaskList } from './lib/parse'
import { dayOf, forecast, record, shortDay, snapshotOf, type Snapshot } from './lib/forecast'
import {
  CAT_ARGV,
  catInput,
  logArgv,
  mergeHistory,
  parseLog,
  snapshotsFromGit,
  splitBatch,
  type Backfill,
} from './lib/history'
import { burnup, flow } from './lib/chart'
import { checkOverwrite, denyMessage, GUARDED } from './lib/guard'
import {
  bandText,
  bar,
  completionToast,
  progressBrief,
  taskInPrompt,
  forecastText,
  historyNote,
  nextText,
  specApproval,
  stageOfSkill,
  statusText,
  timelineRows,
  type Stage,
} from './lib/view'

const NAME = 'agent-skills-mods'
const project = atom({ plugin: 'agent-skills-mods', key: 'project' } as const, null as AsmProject | null)
const stage = atom({ plugin: 'agent-skills-mods', key: 'stage' } as const, null as Stage | null)
const allowOverwrite = atom({ plugin: 'agent-skills-mods', key: 'allowOverwrite' } as const, false)
/** The task the last prompt asked about, highlighted on the board (C1). */
const focus = atom({ plugin: 'agent-skills-mods', key: 'focus' } as const, null as string | null)

const SPEC_PANE = 'asm-spec'
const BOARD_PANE = 'asm-board'
const CHARTS_PANE = 'asm-charts'
const WATCHED = /(^|[\\/])(SPEC\.md|tasks[\\/](plan|todo)\.md)$/
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

type $ = EngineInterface

async function readText($: $, path: string): Promise<string | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/**
 * Rebuilds the snapshots a project had before the mod saw it (F5): two git
 * calls, once per project. Without git the history starts today, and says so.
 */
async function backfill($: $, file: string, list: TaskList, today: string): Promise<{ note: Backfill; snaps: Snapshot[] }> {
  const none = (reason: string) => ({ note: { source: 'none', reason, since: today } as const, snaps: [] })
  try {
    const log = await $.process.run(logArgv(file), { timeoutMs: 20_000 })
    if (log.exitCode !== 0) return none('not a git repository')
    const commits = parseLog(log.stdout)
    if (commits.length === 0) return none(`${file} has no commits`)
    const cat = await $.process.run(CAT_ARGV, { stdin: catInput(commits, file), timeoutMs: 20_000 })
    const snaps = cat.exitCode === 0 ? snapshotsFromGit(commits, splitBatch(cat.stdout), list) : []
    const first = snaps[0]
    if (!first) return none(`no commit of ${file} holds this plan`)
    return { note: { source: 'git', days: snaps.length, since: first.day }, snaps }
  } catch {
    return none('git is not available')
  }
}

/** Projects whose backfill is running, so a second load does not start another. */
const backfilling = new Set<string>()

/** Re-reads the three files, records today's snapshot and updates the status entry. */
async function load($: $): Promise<AsmProject> {
  const cwd = await $.session.cwd()
  const [specText, todoText, planText] = await Promise.all([
    readText($, `${cwd}/SPEC.md`),
    readText($, `${cwd}/tasks/todo.md`),
    readText($, `${cwd}/tasks/plan.md`),
  ])
  const spec = specText === null ? null : parseSpec(specText)
  const plan = planText === null ? null : parsePlan(planText)
  // The task list lives in todo.md; a plan.md alone still carries the phase index.
  const listSource = todoText ?? planText
  const list = listSource === null ? null : parseTasks(listSource)

  const listFile = todoText !== null ? 'tasks/todo.md' : planText !== null ? 'tasks/plan.md' : null
  let fc: AsmProject['forecast'] = null
  let backfilled: Backfill | null = null
  let snapshots: Snapshot[] = []
  if (list && list.total > 0) {
    const now = await $.clock.now()
    const key = `history:${cwd}`
    const noteKey = `backfill:${cwd}`
    let history = ((await $.store.get(key)) as Snapshot[] | undefined) ?? []
    let note = ((await $.store.get(noteKey)) as Backfill | undefined) ?? null
    if (!note && listFile && !backfilling.has(cwd)) {
      backfilling.add(cwd)
      try {
        const found = await backfill($, listFile, list, dayOf(now))
        note = found.note
        history = mergeHistory(((await $.store.get(key)) as Snapshot[] | undefined) ?? [], found.snaps)
        await $.store.set(noteKey, note)
        $.ui.toast(
          note.source === 'git'
            ? `Progress history rebuilt from git: ${note.days} day${note.days === 1 ? '' : 's'} since ${shortDay(note.since)}`
            : `No git history for ${listFile} (${note.reason}): tracking progress from today`,
        )
      } finally {
        backfilling.delete(cwd)
      }
    }
    const next = record(history, snapshotOf(dayOf(now), list))
    await $.store.set(key, next)
    fc = forecast(next, now)
    backfilled = note
    snapshots = next
  }

  const value: AsmProject = { cwd, spec, list, listFile, plan, forecast: fc, history: backfilled, snapshots }
  await update($, project, () => value)
  $.ui.status(statusText(spec, list))
  return value
}

/** `build T4` while building or testing, the stage alone otherwise. */
async function stageLabel($: $): Promise<string | null> {
  const s = await read($, stage)
  if (!s) return null
  const t = (await read($, project))?.list?.current
  return s === 'build' || s === 'test' ? `${s}${t ? ` ${t.id}` : ''}` : s
}

const reply = (text: string) => ({ text })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: 'agent-skills task board. Args: next | charts | allow-overwrite | refresh',
      argumentHint: '[next|charts|allow-overwrite|refresh]',
    })
    await $.command.register({
      name: 'spec-view',
      description: 'Open SPEC.md as a pane with its six core areas',
    })
    await load($).catch(() => undefined)
    return next(e)
  })

  // ----------------------------------------------------------- commands (A3, B1, C2, D1)

  on('command.run', { command: 'spec-view' }, async $ => {
    const p = await load($)
    await $.ui.open({ id: SPEC_PANE, title: 'Spec' })
    return reply(p.spec ? 'Spec pane opened.' : `No SPEC.md in ${p.cwd}. Run /spec to write one.`)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const p = await load($)
    if (arg === 'next') return reply(nextText(p.list, p.plan))
    if (arg === 'allow-overwrite') {
      await update($, allowOverwrite, () => true)
      return reply('The next turn may overwrite tasks/plan.md or tasks/todo.md even with unfinished tasks.')
    }
    if (arg === 'refresh') return reply(statusText(p.spec, p.list) ?? 'No SPEC.md or tasks files here.')
    if (arg === 'charts') {
      await $.ui.open({ id: CHARTS_PANE, title: 'Charts' })
      const days = new Set(p.snapshots.map(s => s.day)).size
      return reply(days >= 2 ? `Charts opened: ${days} days of history.` : 'Charts opened. They draw once there are two days of history.')
    }
    if (arg !== '') return reply(`Unknown argument "${arg}". Use: /progress [next|charts|allow-overwrite|refresh]`)
    await $.ui.open({ id: BOARD_PANE, title: 'Plan' })
    return reply(p.list ? `Board opened: ${p.list.done}/${p.list.total} tasks done.` : nextText(null, p.plan))
  })

  // ----------------------------------------------------------- write guard (D1)

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (!GUARDED.test(e.file_path)) return next(e)
    const old = await readText($, e.file_path)
    if (old === null) return next(e)
    const verdict = checkOverwrite(old, e.content)
    if (verdict.isAllowed) return next(e)
    if (await read($, allowOverwrite)) {
      await update($, allowOverwrite, () => false)
      return next(e)
    }
    return { deny: denyMessage(e.file_path, verdict) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${NAME}: the plan guard failed, so the write was stopped.` }))

  // ----------------------------------------------------------- refresh after edits (A1, B1)

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : null
    if (!path || !EDIT_TOOLS.has(String(e.tool)) || !WATCHED.test(path) || result.isError) return result
    const before = (await read($, project))?.list ?? null
    const after = (await load($)).list
    const toast = GUARDED.test(path) ? completionToast(before, after) : undefined
    if (toast) $.ui.toast(toast)
    if (/SPEC\.md$/.test(path)) void $.ui.open({ id: SPEC_PANE, title: 'Spec' })
    else if (/todo\.md$/.test(path)) void $.ui.open({ id: BOARD_PANE, title: 'Plan' })
    return result
   })
    // A refresh that fails must never change the tool's own result.
    .catch(($, e, next) => next(e))

  // Edits made outside the session show after the next turn. The overwrite allowance
  // lasts the person's whole turn, so a subagent finishing inside it leaves it alone.
  on('turn.complete', async ($, e, next) => {
    await load($).catch(() => undefined)
    if (e.agentId === undefined) await update($, allowOverwrite, () => false)
    return next(e)
  })

  // ----------------------------------------------------------- answers about progress (C1)

  // Fresh numbers for the turn (edits made outside the session included), and the
  // board focused on the task the prompt asks about.
  on('prompt.submit', async ($, e, next) => {
    const p = await load($)
    const id = taskInPrompt(e.text, p.list)
    await update($, focus, () => id)
    if (id) void $.ui.open({ id: BOARD_PANE, title: 'Plan' })
    return next(e)
  }).catch(($, e, next) => next(e))

  // The parsed state as the last system-prompt section, after the cache boundary.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const p = await read($, project)
    const text = p ? progressBrief(p) : undefined
    return text ? { ...result, sections: [...result.sections, { id: `${NAME}:progress`, text, scope: 'session' as const }] } : result
  }).catch(($, e, next) => next(e))

  // ----------------------------------------------------------- stage in the footer (H2)

  on('skill.prompt', async ($, e, next) => {
    const s = stageOfSkill(e.skill)
    if (s) await update($, stage, () => s)
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const label = await stageLabel($)
    return label ? next({ ...e, props: { ...e.props, tail: `· ${label}` } }) : next(e)
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const s = await read($, stage)
    return s ? next({ ...e, props: { ...e.props, modes: [...e.props.modes, s] } }) : next(e)
  })

  // ----------------------------------------------------------- current task band (B2)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const line = bandText((await read($, project))?.list ?? null)
    if (!line) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text dimColor wrap="truncate-end">
        {line}
      </Text>
    )
  })

  // ----------------------------------------------------------- spec pane (A1, A3)

  on('ui.render', { component: 'Pane', requestId: SPEC_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const p = await read($, project)
    const spec = p?.spec
    if (!spec) {
      return (
        <Box flexDirection="column">
          <Text>No SPEC.md yet.</Text>
          <Text dimColor>It would be at {p?.cwd ?? '.'}/SPEC.md. Run /spec to write one.</Text>
        </Box>
      )
    }
    const approval = specApproval(spec, !!p?.list)
    const width = e.props.bodyColumns
    const colWidth = Math.max(12, Math.floor((width - 2) / 3))
    const glyph = { present: '✓', empty: '○', missing: '×' } as const
    const tone = { present: 'success', empty: 'warning', missing: 'error' } as const
    const column = (head: string, items: string[]) => (
      <Box flexDirection="column" width={colWidth}>
        <Text bold>{head}</Text>
        {items.length === 0 ? <Text dimColor>none</Text> : items.map(i => <Text wrap="wrap">· {i}</Text>)}
      </Box>
    )
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">
            {spec.title ?? 'SPEC.md'}
          </Text>
          <Text color={approval === 'approved' ? 'success' : 'permission'}>
            {approval === 'approved' ? '✓ approved' : '♦ awaiting approval'}
            <Text dimColor>{spec.status ? ' (front matter)' : approval === 'approved' ? ' (a plan exists)' : ''}</Text>
          </Text>
        </Box>
        <Box flexDirection="column">
          {spec.areas.map(a => (
            <Text wrap="truncate-end">
              {a.hint ? <Text color="warning">!</Text> : <Text color={tone[a.state]}>{glyph[a.state]}</Text>}{' '}
              {a.label.padEnd(18)}
              {a.hint ? (
                <Text color="warning">{a.hint}</Text>
              ) : (
                <Text dimColor>{a.state !== 'present' ? a.state : areaDetail(a, spec.successCriteria)}</Text>
              )}
            </Text>
          ))}
        </Box>
        <Box flexDirection="row" gap={1}>
          {column('Always', spec.boundaries.always)}
          {column('Ask first', spec.boundaries.ask)}
          {column('Never', spec.boundaries.never)}
        </Box>
        {spec.openQuestions.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Open questions</Text>
            {spec.openQuestions.map(q => (
              <Text wrap="wrap">♦ {q}</Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })

  // ----------------------------------------------------------- task board + run timeline (B1, F1, G3)

  on('ui.render', { component: 'Pane', requestId: BOARD_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const p = await read($, project)
    const list = p?.list
    if (!list || list.total === 0) {
      return <Text dimColor>{nextText(list ?? null, p?.plan ?? null)}</Text>
    }
    const width = e.props.bodyColumns
    const focused = await read($, focus)
    const tone = { done: 'success', next: 'warning', blocked: 'error', todo: 'subtle' } as const
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>
            <Text bold>
              {list.done}/{list.total} done
            </Text>{' '}
            <Text color="success">{bar(list.done, list.total, Math.max(4, Math.min(30, width - 16)))}</Text>
          </Text>
          {p?.forecast && (
            <Text dimColor wrap="wrap">
              {forecastText(p.forecast)}
            </Text>
          )}
          {p?.history && <Text dimColor>{historyNote(p.history, p.listFile)}</Text>}
          {list.kind === 'checklist' && <Text dimColor>Plain checklist: no "## Task N:" headings found.</Text>}
          {p?.plan?.trackedIn && <Text dimColor>Tasks tracked in {p.plan.trackedIn}</Text>}
        </Box>
        <Box flexDirection="column">
          {timelineRows(list).map(row =>
            row.kind === 'phase' ? (
              <Text bold>{row.text}</Text>
            ) : row.kind === 'checkpoint' ? (
              <Text color={row.glyph === '♦' ? 'permission' : undefined} dimColor={row.glyph !== '♦'} wrap="truncate-end">
                {'  '}
                {row.glyph} {row.text}
              </Text>
            ) : (
              <Text wrap="truncate-end" inverse={row.id === focused}>
                {row.id === focused ? '› ' : '  '}
                <Text color={tone[row.status]}>{row.glyph}</Text> <Text bold={row.status === 'next'}>{row.id}</Text>{' '}
                <Text dimColor={row.status === 'done'}>{row.title}</Text>
                {row.detail ? <Text dimColor> · {row.detail}</Text> : ''}
              </Text>
            ),
          )}
        </Box>
        <Text dimColor>✓ done ● next ○ to do ◌ waits on a dependency ♦ needs you</Text>
      </Box>
    )
  })

  // ----------------------------------------------------------- charts (F2)

  on('ui.render', { component: 'Pane', requestId: CHARTS_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const p = await read($, project)
    const snaps = p?.snapshots ?? []
    const columns = Math.max(24, Math.min(120, e.props.bodyColumns))
    const up = burnup(snaps, p?.forecast ?? null, columns, 10)
    const fl = flow(snaps, columns, 8)
    if (!up || !fl) {
      const since = snaps[0] ? ` Tracking since ${shortDay(snaps[0].day)}.` : ''
      return <Text dimColor wrap="wrap">{`Charts need two days of history.${since}`}</Text>
    }
    // Rasters are terminal cells; other surfaces get the numbers until their SVG charts (F4).
    const raster = (key: string, c: { columns: number; rows: number; cells: string }) => {
      if (e.surface !== 'terminal') return null
      const { Raster } = $.ui.resolve(e)
      return <Raster key={key} columns={c.columns} rows={c.rows} cells={c.cells} />
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>
            <Text bold>Burn-up</Text> <Text dimColor>scope vs done{p?.forecast?.kind === 'range' ? ', dotted = forecast' : ''}</Text>
          </Text>
          {raster('burnup', up)}
          <Text dimColor wrap="wrap">{up.legend}</Text>
        </Box>
        <Box flexDirection="column">
          <Text>
            <Text bold>Flow</Text> <Text dimColor>tasks by state, per day</Text>
          </Text>
          {raster('flow', fl)}
          <Text dimColor wrap="wrap">{fl.legend}</Text>
        </Box>
      </Box>
    )
  })
}

function areaDetail(a: { key: string; body: string }, criteria: string[]): string {
  if (a.key === 'objective') return `${criteria.length} success criteri${criteria.length === 1 ? 'on' : 'a'}`
  return firstLine(a.body)
}

function firstLine(body: string): string {
  const line = body.split('\n').find(l => l.trim() && !/^\s*(```|~~~)/.test(l)) ?? ''
  return line.replace(/^\s*[-*+]\s+/, '').replace(/\*\*|`/g, '').trim()
}
