import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AsmProject } from '../types'
import { parsePlan, parseSpec, parseTasks, taskKey, type TaskList } from './lib/parse'
import { dayOf, forecast, record, shortDay, snapshotOf, type Snapshot } from './lib/forecast'
import {
  CAT_ARGV,
  catInput,
  doneDaysFromGit,
  logArgv,
  mergeHistory,
  parseLog,
  snapshotsFromGit,
  splitBatch,
  type Backfill,
} from './lib/history'
import { burnup, flow } from './lib/chart'
import { digestText, reportHtml } from './lib/report'
import { burnupSvg, flowSvg } from './lib/svg'
import { spinnerWord, stepOf, type Step } from './lib/steps'
import { checkOverwrite, denyMessage, GUARDED } from './lib/guard'
import {
  bandText,
  bar,
  completionToast,
  taskDates,
  progressBrief,
  taskInPrompt,
  forecastText,
  historyNote,
  nextText,
  specApproval,
  specFileFor,
  specFiles,
  stageOfSkill,
  statusText,
  timelineRows,
  type Stage,
} from './lib/view'

const NAME = 'agent-skills-mods'
const project = atom({ plugin: 'agent-skills-mods', key: 'project' } as const, null as AsmProject | null)
const stage = atom({ plugin: 'agent-skills-mods', key: 'stage' } as const, null as Stage | null)
const allowOverwrite = atom({ plugin: 'agent-skills-mods', key: 'allowOverwrite' } as const, false)
/** What the agent is doing in plan terms, for the spinner (H3). */
const step = atom({ plugin: 'agent-skills-mods', key: 'step' } as const, null as { step: Step; task: string | null } | null)
/** The task whose last test run failed, marked × on the timeline (F1). */
const failed = atom({ plugin: 'agent-skills-mods', key: 'failed' } as const, null as string | null)
/** The spec file picked in the spec pane or by `/spec-view <id>` (A3). */
const specChoice = atom({ plugin: 'agent-skills-mods', key: 'specChoice' } as const, null as string | null)
/** The task the last prompt asked about, highlighted on the board (C1). */
const focus = atom({ plugin: 'agent-skills-mods', key: 'focus' } as const, null as string | null)

const SPEC_PANE = 'asm-spec'
const BOARD_PANE = 'asm-board'
const CHARTS_PANE = 'asm-charts'
/** Where /progress report writes its page (G1), next to the task list it reports on. */
const REPORT_FILE = 'tasks/progress-report.html'
const WATCHED = /(^|[\\/])(SPEC(-[\w.-]+)?\.md|tasks[\\/](plan|todo)\.md)$/
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
type Found = { note: Backfill; snaps: Snapshot[]; doneDays: Record<string, string> }

async function backfill($: $, file: string, list: TaskList, today: string): Promise<Found> {
  const none = (reason: string): Found => ({ note: { source: 'none', reason, since: today }, snaps: [], doneDays: {} })
  try {
    const log = await $.process.run(logArgv(file), { timeoutMs: 20_000 })
    if (log.exitCode !== 0) return none('not a git repository')
    const commits = parseLog(log.stdout)
    if (commits.length === 0) return none(`${file} has no commits`)
    const cat = await $.process.run(CAT_ARGV, { stdin: catInput(commits, file), timeoutMs: 20_000 })
    const texts = cat.exitCode === 0 ? splitBatch(cat.stdout) : []
    const snaps = snapshotsFromGit(commits, texts, list)
    const first = snaps[0]
    if (!first) return none(`no commit of ${file} holds this plan`)
    return { note: { source: 'git', days: snaps.length, since: first.day }, snaps, doneDays: doneDaysFromGit(commits, texts, list) }
  } catch {
    return none('git is not available')
  }
}

/** The build loop in plan terms (H3, F1): what the spinner says, and × for a failed test run. */
async function trackStep($: $, e: { tool: unknown }, result: { isError?: boolean }) {
  try {
    const s = stepOf(String(e.tool), e as never)
    if (!s) return
    const task = (await read($, project))?.list?.current?.id ?? null
    await update($, step, () => ({ step: s, task }))
    if (s === 'test' && task) {
      const isFailed = result.isError === true
      await update($, failed, f => (isFailed ? task : f === task ? null : f))
    }
  } catch {}
}

/** The spec pane's picker (A3): show another spec file. */
async function pick($: $, file: string) {
  await update($, specChoice, () => file)
  await load($)
}

/**
 * Opens a file with the machine's default app (G1): macOS `open`, Linux
 * `xdg-open`, Windows `start`. Only where someone sits at this machine: a
 * terminal, VS Code or the desktop app, never a print run or a phone.
 */
async function openFile($: $, path: string): Promise<boolean> {
  const surfaces = await $.session.surfaces().catch(() => [] as const)
  if (!surfaces.some(s => s === 'terminal' || s === 'vscode' || s === 'desktop')) return false
  for (const argv of [['open', path], ['xdg-open', path], ['cmd', '/c', 'start', '', path]]) {
    try {
      if ((await $.process.run(argv, { timeoutMs: 10_000 })).exitCode === 0) return true
    } catch {}
  }
  return false
}

/** Projects whose backfill is running, so a second load does not start another. */
const backfilling = new Set<string>()

/** Re-reads the three files, records today's snapshot and updates the status entry. */
async function load($: $): Promise<AsmProject> {
  const cwd = await $.session.cwd()
  const names = await $.fs.list(cwd).then(
    entries => entries.filter(f => f.kind === 'file').map(f => f.name),
    () => [] as string[],
  )
  const files = specFiles(names)
  const choice = await read($, specChoice)
  const specFile = choice && files.includes(choice) ? choice : (files[0] ?? null)
  const [specText, todoText, planText] = await Promise.all([
    specFile ? readText($, `${cwd}/${specFile}`) : null,
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
  let dates: AsmProject['dates'] = {}
  if (list && list.total > 0) {
    const now = await $.clock.now()
    const key = `history:${cwd}`
    const noteKey = `backfill:${cwd}`
    let history = ((await $.store.get(key)) as Snapshot[] | undefined) ?? []
    let note = ((await $.store.get(noteKey)) as Backfill | undefined) ?? null
    const daysKey = `doneDays:${cwd}`
    let doneDays = ((await $.store.get(daysKey)) as Record<string, string> | undefined) ?? {}
    if (!note && listFile && !backfilling.has(cwd)) {
      backfilling.add(cwd)
      try {
        const found = await backfill($, listFile, list, dayOf(now))
        note = found.note
        history = mergeHistory(((await $.store.get(key)) as Snapshot[] | undefined) ?? [], found.snaps)
        doneDays = { ...found.doneDays, ...doneDays }
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
    // A task first seen done today is dated today; the dates stay when it is unticked.
    const today = dayOf(now)
    const fresh = list.tasks.filter(t => t.status === 'done' && !doneDays[taskKey(t)])
    if (fresh.length > 0 || note?.source === 'git') {
      for (const t of fresh) doneDays = { ...doneDays, [taskKey(t)]: today }
      await $.store.set(daysKey, doneDays)
    }
    dates = taskDates(list, doneDays, fc, today)
    snapshots = next
  }

  const value: AsmProject = { cwd, spec, list, listFile, plan, forecast: fc, history: backfilled, snapshots, dates, specFile, specFiles: files }
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

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: 'agent-skills task board. Args: next | charts | digest | report | allow-overwrite | refresh',
      argumentHint: '[next|charts|digest|report|allow-overwrite|refresh]',
    })
    await $.command.register({
      name: 'spec-view',
      description: 'Open SPEC.md, or a module spec SPEC-<id>.md, as a pane with its six core areas',
      argumentHint: '[module id]',
    })
    await load($).catch(() => undefined)
    return next(e)
  })

  // ----------------------------------------------------------- commands (A3, B1, C2, D1)

  on('command.run', { command: 'spec-view' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg) {
      const file = specFileFor(arg)
      const p = await load($)
      if (!p.specFiles.includes(file)) {
        const here = p.specFiles.length ? ` Specs here: ${p.specFiles.join(', ')}.` : ''
        return reply(`No ${file} in ${p.cwd}.${here}`)
      }
      await update($, specChoice, () => file)
    }
    const p = await load($)
    await $.ui.open({ id: SPEC_PANE, title: 'Spec' })
    if (!p.spec) return reply(`No SPEC.md in ${p.cwd}. Run /spec to write one.`)
    const others = p.specFiles.length > 1 ? ` (${p.specFiles.length} specs; pick another in the pane or with /spec-view <id>)` : ''
    return reply(`Spec pane opened: ${p.specFile}${others}.`)
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
    if (arg === 'digest') {
      const text = digestText(p)
      const copied = await $.ui.copy({ text }).catch(() => ({ isCopied: false as const, reason: 'refused' as const }))
      return reply(`${text}\n\n${copied.isCopied ? 'Copied to the clipboard.' : `Not copied (${copied.reason}); select the lines above.`}`)
    }
    if (arg === 'report') {
      if (!p.list || p.list.total === 0) return reply('No task list yet, so there is nothing to report.')
      const path = `${p.cwd}/${REPORT_FILE}`
      const html = reportHtml({
        ...p,
        today: dayOf(await $.clock.now()),
        charts: { burnup: burnupSvg(p.snapshots, p.forecast), flow: flowSvg(p.snapshots) },
      })
      await $.fs.write(path, html)
      const size = `${Math.round(html.length / 1024)} KB`
      return reply(
        (await openFile($, path))
          ? `Wrote ${REPORT_FILE} (${size}) and opened it in your browser. It is one self-contained page, so it also opens offline or as an email attachment.`
          : `Wrote ${REPORT_FILE} (${size}): one self-contained page that opens offline. Open ${path} in a browser or attach it to an email.`,
      )
    }
    if (arg !== '') return reply(`Unknown argument "${arg}". Use: /progress [next|charts|digest|report|allow-overwrite|refresh]`)
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

  // ----------------------------------------------------------- after each tool call: refresh (A1, B1) and step (H3, F1)

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    await trackStep($, e, result)
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : null
    if (!path || !EDIT_TOOLS.has(String(e.tool)) || !WATCHED.test(path) || result.isError) return result
    // A refresh that fails must never change the tool's own result.
    try {
      const before = (await read($, project))?.list ?? null
      const after = (await load($)).list
      const toast = GUARDED.test(path) ? completionToast(before, after) : undefined
      if (toast) $.ui.toast(toast)
      const spec = /(?:^|[\\/])(SPEC(-[\w.-]+)?\.md)$/.exec(path)
      if (spec) {
        await update($, specChoice, () => spec[1]!)
        await load($)
        void $.ui.open({ id: SPEC_PANE, title: 'Spec' })
      }
      if (/todo\.md$/.test(path)) void $.ui.open({ id: BOARD_PANE, title: 'Plan' })
    } catch {}
    return result
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (options.planSpinner !== true || e.props.message !== null) return next(e)
    const s = await read($, step)
    return s ? next({ ...e, props: { ...e.props, word: spinnerWord(s.step, s.task) } }) : next(e)
  })

  // Edits made outside the session show after the next turn. The overwrite allowance
  // lasts the person's whole turn, so a subagent finishing inside it leaves it alone.
  on('turn.complete', async ($, e, next) => {
    await load($).catch(() => undefined)
    if (e.agentId === undefined) {
      await update($, allowOverwrite, () => false)
      await update($, step, () => null)
    }
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
    // The mobile app draws no Select yet; there /spec-view <id> picks.
    const picker = (() => {
      if (!p || p.specFiles.length < 2) return null
      if (e.surface === 'mobile') return <Text dimColor>Specs: {p.specFiles.join(', ')}</Text>
      const { Select } = $.ui.resolve(e)
      return (
        <Select
          key="spec-file"
          label="Spec"
          options={p.specFiles.map(f => ({ value: f, label: f }))}
          value={p.specFile ?? undefined}
          onSelect={(file: string) => void pick($, file)}
        />
      )
    })()
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
        {picker}
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">
            {spec.title ?? p?.specFile ?? 'SPEC.md'}
            {spec.title && p?.specFile && p.specFile !== 'SPEC.md' ? <Text dimColor> ({p.specFile})</Text> : ''}
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
    const failedTask = await read($, failed)
    const rows = timelineRows(list, { dates: p?.dates ?? {}, failed: failedTask })
    const dated = rows.some(r => r.date)
    const date = (d: string) => (dated ? <Text dimColor>{d.padEnd(8)}</Text> : '')
    const tone = { done: 'success', next: 'warning', blocked: 'error', todo: 'subtle', failed: 'error' } as const
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
          {rows.map(row =>
            row.kind === 'phase' ? (
              <Text wrap="truncate-end">
                {date(row.date)}
                <Text bold>{row.text}</Text>
              </Text>
            ) : row.kind === 'checkpoint' ? (
              <Text color={row.glyph === '♦' ? 'permission' : undefined} dimColor={row.glyph !== '♦'} wrap="truncate-end">
                {date(row.date)}
                {'  '}
                {row.glyph} {row.text}
              </Text>
            ) : (
              <Text wrap="truncate-end" inverse={row.id === focused}>
                {date(row.date)}
                {row.id === focused ? '› ' : '  '}
                <Text color={tone[row.status]}>{row.glyph}</Text> <Text bold={row.status === 'next'}>{row.id}</Text>{' '}
                <Text dimColor={row.status === 'done'}>{row.title}</Text>
                {row.detail ? <Text dimColor> · {row.detail}</Text> : ''}
              </Text>
            ),
          )}
        </Box>
        <Text dimColor>✓ done ● next ○ to do ◌ waits on a dependency ♦ needs you × tests failed{dated ? ' · ≈ expected' : ''}</Text>
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
    // Terminal cells there (F2); interactive SVG on desktop, VS Code and mobile (F4).
    const chart = (key: 'burnup' | 'flow', c: { columns: number; rows: number; cells: string }) => {
      if (e.surface === 'terminal') {
        const { Raster } = $.ui.resolve(e)
        return <Raster key={key} columns={c.columns} rows={c.rows} cells={c.cells} />
      }
      const svg = key === 'burnup' ? burnupSvg(snaps, p?.forecast ?? null) : flowSvg(snaps)
      if (!svg) return null
      const { Svg } = $.ui.resolve(e)
      return <Svg source={svg.source} alt={svg.alt} isInteractive />
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>
            <Text bold>Burn-up</Text> <Text dimColor>scope vs done{p?.forecast?.kind === 'range' ? ', dotted = forecast' : ''}</Text>
          </Text>
          {chart('burnup', up)}
          <Text dimColor wrap="wrap">{up.legend}</Text>
        </Box>
        <Box flexDirection="column">
          <Text>
            <Text bold>Flow</Text> <Text dimColor>tasks by state, per day</Text>
          </Text>
          {chart('flow', fl)}
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
