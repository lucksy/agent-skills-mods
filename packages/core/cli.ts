// The progress summary outside Claude Code (E2): what scripts/agent-skills-progress
// prints for any agent that uses agent-skills (Cursor, Gemini CLI, Codex, a CI
// job). The same parser, history and forecast as the mod; drawn as ANSI text.
// Pure: the script hands it file reads and a command runner.

import { decisions } from './report'
import { buildState, stateJson, type ProjectIo, type State } from './state'
import { forecastText, specApproval, timelineRows } from './view'
import { timeline, type SegTone } from './timeline'

/** What the CLI draws: State v1 (J2). */
export type CliState = State
export type CliIo = ProjectIo

/** Reads the project the way the mod does, with history from git when there is a runner. */
export const gather = (io: CliIo, opts: { specFile?: string } = {}): Promise<CliState> => buildState(io, opts)

// ------------------------------------------------------------------ drawing

export type CliOptions = { color: boolean; width: number }

const ESC = '\u001b['
const SGR = { reset: 0, bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, grey: 90 } as const
type Style = keyof typeof SGR

/** Paints `text` with SGR styles when color is on; plain text otherwise. */
function painter(color: boolean) {
  return (text: string, ...styles: Style[]) => (color && styles.length && text ? `${ESC}${styles.map(s => SGR[s]).join(';')}m${text}${ESC}0m` : text)
}

/** Columns a string takes, counting each code point as one: every glyph used here is narrow. */
const cols = (s: string) => [...s.replace(/\u001b\[[0-9;]*m/g, '')].length

const fit = (s: string, width: number) => {
  const chars = [...s]
  return chars.length <= width ? s : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`
}

const TONE: Record<string, Style> = { done: 'green', next: 'yellow', waiting: 'grey', blocked: 'red', todo: 'grey', failed: 'red' }

/**
 * The summary: a framed header with the stage strip, progress bar and ETA, then
 * the spec, the run timeline, the next task, and what needs a person, each
 * under a coloured rule. Plain text when color is off.
 */
export function renderCli(s: CliState, o: CliOptions): string {
  const p = painter(o.color)
  const width = Math.max(40, Math.min(110, o.width))
  const inner = width - 4
  const out: string[] = []
  const rule = (label: string, style: Style = 'cyan') => out.push(`${p('──', 'grey')} ${p(label, 'bold', style)} ${p('─'.repeat(Math.max(2, width - cols(label) - 4)), 'grey')}`)
  const line = (text = '') => out.push(`  ${text}`)

  // Header: a rounded frame around the name, the stages and the bar.
  const name = s.spec?.title ?? (s.list ? 'Plan' : 'no plan yet')
  const list = s.list
  const approval = specApproval(s.spec, !!list)
  const stages = stageStrip(s, p)
  const head = [`${p('agent-skills', 'bold', 'cyan')} ${p('·', 'grey')} ${p(fit(name, inner - 15), 'bold')}`, stages]
  if (list && list.total > 0) {
    const pct = Math.round((list.done / list.total) * 100)
    const barWidth = Math.max(10, Math.min(40, inner - 22))
    const filled = Math.round((list.done / list.total) * barWidth)
    head.push(`${p('█'.repeat(filled), 'green')}${p('░'.repeat(barWidth - filled), 'grey')}  ${p(`${pct}%`, 'bold')} ${p(`${list.done} of ${list.total} tasks`, 'grey')}`)
  }
  if (s.forecast) {
    // The date range first, then its basis dimmed under it, so neither is cut.
    const [eta = '', ...basis] = forecastText(s.forecast).split(' · ')
    head.push(s.forecast.kind === 'range' ? p(fit(eta, inner), 'bold') : p(fit(eta, inner), 'grey'))
    if (basis.length) head.push(p(fit(basis.join(' · '), inner), 'grey'))
  }
  const top = ` ${s.cwd.split('/').pop() || s.cwd} `
  out.push(p(`╭─${top}${'─'.repeat(Math.max(0, width - cols(top) - 3))}╮`, 'grey'))
  for (const h of head) out.push(`${p('│', 'grey')} ${h}${' '.repeat(Math.max(0, inner - cols(h)))} ${p('│', 'grey')}`)
  out.push(p(`╰${'─'.repeat(width - 2)}╯`, 'grey'))

  if (!s.spec && !list) {
    line(p('No SPEC.md, tasks/plan.md or tasks/todo.md here.', 'grey'))
    line(`Start with the ${p('spec-driven-development', 'cyan')} skill (/spec), then plan.`)
    return out.join('\n')
  }

  if (s.spec) {
    out.push('')
    rule(`Spec · ${s.specFile ?? 'SPEC.md'}`)
    const tag = approval === 'approved' ? p('✓ approved', 'green', 'bold') : p('♦ awaiting approval', 'magenta', 'bold')
    const present = s.spec.areas.filter(a => a.state === 'present').length
    line(`${tag}  ${p(`${present}/${s.spec.areas.length} core areas`, 'grey')}${s.specFiles.length > 1 ? p(`  · ${s.specFiles.length} specs`, 'grey') : ''}`)
    const glyph = { present: '✓', empty: '○', missing: '×' } as const
    const tone = { present: 'green', empty: 'yellow', missing: 'red' } as const
    const cells = s.spec.areas.map(a => (a.hint ? `${p('!', 'yellow')} ${a.label}` : `${p(glyph[a.state], tone[a.state])} ${a.label}`))
    // Two or three columns, as the width allows.
    const per = width >= 90 ? 3 : 2
    const colW = Math.floor(inner / per)
    for (let i = 0; i < cells.length; i += per) line(cells.slice(i, i + per).map(c => c + ' '.repeat(Math.max(1, colW - cols(c)))).join('').trimEnd())
    for (const a of s.spec.areas.filter(x => x.hint)) line(p(fit(`  ! ${a.label}: ${a.hint}`, inner), 'yellow'))
  }

  if (list && list.total > 0) {
    out.push('')
    rule(`Tasks · ${s.listFile}`)
    const rows = timelineRows(list, { dates: s.dates })
    const dated = rows.some(r => r.date)
    const dateCol = (d: string) => (dated ? p(d.padEnd(8), 'grey') : '')
    for (const r of rows) {
      if (r.kind === 'phase') line(`${dateCol(r.date)}${p(fit(r.text, inner - 8), 'bold')}`)
      else if (r.kind === 'checkpoint') line(`${dateCol(r.date)}  ${r.glyph === '♦' ? p(`${r.glyph} ${fit(r.text, inner - 12)}`, 'magenta') : p(`${r.glyph} ${fit(r.text, inner - 12)}`, 'grey')}`)
      else {
        const title = fit(`${r.title}`, Math.max(10, inner - 16 - cols(r.detail)))
        const body = `${p(r.glyph, TONE[r.status] ?? 'grey')} ${p(r.id, ...(r.status === 'next' ? (['bold', 'yellow'] as Style[]) : []))} ${r.status === 'done' ? p(title, 'grey') : title}`
        line(`${dateCol(r.date)}  ${body}${r.detail ? p(` · ${r.detail}`, 'grey') : ''}`)
      }
    }
    if (list.kind === 'checklist') line(p('Plain checklist: no "## Task N:" headings found.', 'grey'))
  } else if (s.plan?.trackedIn) {
    out.push('')
    rule('Tasks')
    line(`Tasks are tracked in ${p(s.plan.trackedIn, 'cyan')}.`)
  }

  const t = list?.current
  if (t) {
    out.push('')
    rule(`Next · ${t.id}`, 'yellow')
    line(p(fit(t.title, inner), 'bold'))
    for (const b of t.boxes) line(`  ${b.isDone ? p('☑', 'green') : p('☐', 'yellow')} ${b.isDone ? p(fit(b.text, inner - 4), 'grey') : fit(b.text, inner - 4)}`)
    if (t.checkpoint) line(p(`then ♦ ${t.checkpoint.title}`, 'magenta'))
  }

  const needs = decisions({ spec: s.spec, list: s.list, plan: s.plan, forecast: s.forecast, snapshots: s.snapshots, specFile: s.specFile })
  if (needs.length) {
    out.push('')
    rule(`Needs you · ${needs.length}`, 'magenta')
    for (const n of needs.slice(0, 8)) line(`${p('♦', 'magenta')} ${fit(n, inner - 2)}`)
    if (needs.length > 8) line(p(`and ${needs.length - 8} more`, 'grey'))
  }

  out.push('')
  out.push(p(`${'─'.repeat(width)}`, 'grey'))
  const legend = `${p('✓', 'green')} done  ${p('●', 'yellow')} next  ${p('○', 'grey')} to do  ${p('·', 'grey')} waits  ${p('■', 'red')} blocked  ${p('♦', 'magenta')} needs you`
  line(legend)
  if (s.history) line(p(s.history, 'grey'))
  return out.join('\n')
}

/** `✓spec ✓plan ●build 4/9 ○review ○ship`, as the status line script prints it. */
function stageStrip(s: CliState, p: ReturnType<typeof painter>): string {
  const approval = specApproval(s.spec, !!s.list)
  const list = s.list
  const allDone = !!list && list.total > 0 && list.done === list.total
  const st = (glyph: string, label: string, style: Style) => p(`${glyph}${label}`, style)
  return [
    approval === 'approved' ? st('✓', 'spec', 'green') : approval === 'awaiting' ? st('♦', 'spec', 'magenta') : st('○', 'spec', 'grey'),
    list ? st('✓', 'plan', 'green') : st('○', 'plan', 'grey'),
    list && list.total > 0 ? (allDone ? st('✓', 'build', 'green') : st('●', `build ${list.done}/${list.total}`, 'yellow')) : st('○', 'build', 'grey'),
    allDone ? st('●', 'review', 'yellow') : st('○', 'review', 'grey'),
    st('○', 'ship', 'grey'),
  ].join(' ')
}

/** One line for a prompt or a CI log: `✓spec ✓plan ●build 4/9 · T4 Rate limit per key`. */
export function renderBrief(s: CliState, o: Pick<CliOptions, 'color'>): string {
  const p = painter(o.color)
  const t = s.list?.current
  return `${stageStrip(s, p)}${t ? ` ${p('·', 'grey')} ${p(t.id, 'bold')} ${t.title}` : ''}`
}

/** The parsed state as JSON for other tools (J3): State v1, see state.ts. */
export function renderJson(s: CliState): string {
  return JSON.stringify(stateJson(s), null, 2)
}

/** The run timeline (mockup 11) for a terminal: the same rows the plan pane draws, in ANSI colour. */
export function renderTimelineCli(s: CliState, o: CliOptions): string {
  const p = painter(o.color)
  if (!s.list || s.list.total === 0) return renderCli(s, o)
  const tone: Record<SegTone, Style[]> = { text: [], strong: ['bold'], muted: ['grey'], done: ['green'], run: ['yellow'], bad: ['red'], needsYou: ['magenta'], accent: ['cyan'] }
  const t = timeline({
    spec: s.spec,
    list: s.list,
    plan: s.plan,
    forecast: s.forecast,
    dates: s.dates,
    today: s.snapshots[s.snapshots.length - 1]?.day ?? new Date().toISOString().slice(0, 10),
    since: s.snapshots[0]?.day,
    facts: s.commits !== undefined ? { commits: s.commits } : undefined,
  })
  const line = (l: { text: string; tone: SegTone }[]) => `  ${l.map(x => p(x.text, ...tone[x.tone])).join('')}`
  return [...t.header.map(line), '', ...t.rows.map(line), '', ...t.legend.map(line)].join('\n')
}
