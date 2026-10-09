#!/usr/bin/env -S node --no-warnings --experimental-strip-types
// agent-skills progress for any agent (E2): reads SPEC.md, tasks/plan.md and
// tasks/todo.md with the same parser as the Claude Code plugin and prints the
// stage, a progress bar, the ETA range, the run timeline and what needs you.
//
//   node scripts/agent-skills-progress.mjs [dir] [--brief | --timeline | --json] [--no-color] [--no-git] [--spec <id>] [--width <n>]
//
// No dependencies: Node 22.6 or newer (it runs the plugin's TypeScript through
// Node's type stripping), or Bun.

import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as nodeModule from 'node:module'

// Node notes that it strips types and guesses the module format; neither is news here.
const emitWarning = process.emitWarning.bind(process)
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1]
  const text = String(warning?.message ?? warning)
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON' || /Type Stripping|strip-types|type stripping/i.test(text)) return
  return emitWarning(warning, ...rest)
}

// The plugin's modules import each other without a suffix, as its engine does.
if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    resolve(spec, ctx, next) {
      try {
        return next(spec, ctx)
      } catch (err) {
        if (spec.startsWith('.') && !/\.\w+$/.test(spec)) return next(`${spec}.ts`, ctx)
        throw err
      }
    },
  })
}

const HELP = `agent-skills-progress: the agent-skills workflow at a glance

Usage: agent-skills-progress [dir] [options]

  dir             project folder (default: the current folder)
  --brief         one line: stages and the current task
  --timeline      the run timeline: phases as a tree, a build · test · commit bar per task
  --json          the parsed state as JSON, for other tools
  --spec <id>     show specs/<id>.md or SPEC-<id>.md instead of SPEC.md
  --no-git        skip git history (no ETA until 3 tasks are done today)
  --no-color      plain text (also NO_COLOR=1, or when not a terminal)
  --color         colours even when piped (also FORCE_COLOR=1)
  --width <n>     columns to draw in (default: the terminal's, up to 110)
  -h, --help      this text`

function parseArgs(argv) {
  const o = { dir: '.', mode: 'full', git: true, color: undefined, width: undefined, spec: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') o.mode = 'help'
    else if (a === '--brief') o.mode = 'brief'
    else if (a === '--timeline') o.mode = 'timeline'
    else if (a === '--json') o.mode = 'json'
    else if (a === '--no-git') o.git = false
    else if (a === '--no-color') o.color = false
    else if (a === '--color') o.color = true
    else if (a === '--width') o.width = Number(argv[++i])
    else if (a === '--spec') o.spec = argv[++i]
    else if (a.startsWith('-')) throw new Error(`unknown option ${a} (try --help)`)
    else o.dir = a
  }
  return o
}

/** Runs a command in `cwd`, collecting its output; never rejects. */
function runner(cwd) {
  return (argv, opts = {}) =>
    new Promise(done => {
      let stdout = ''
      let stderr = ''
      let child
      try {
        child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch {
        return done({ exitCode: 127, stdout, stderr: 'spawn failed' })
      }
      child.stdout.setEncoding('utf8').on('data', d => (stdout += d))
      child.stderr.setEncoding('utf8').on('data', d => (stderr += d))
      child.on('error', () => done({ exitCode: 127, stdout, stderr }))
      child.on('close', code => done({ exitCode: code ?? 1, stdout, stderr }))
      child.stdin.on('error', () => {})
      child.stdin.end(opts.stdin ?? '')
    })
}

/** A braille spinner on stderr while git is read, only on a terminal. */
function spinner(text) {
  if (!process.stderr.isTTY) return () => {}
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  let i = 0
  const draw = () => process.stderr.write(`\r\u001b[36m${frames[i++ % frames.length]}\u001b[0m \u001b[2m${text}\u001b[0m`)
  const timer = setInterval(draw, 80)
  draw()
  return () => {
    clearInterval(timer)
    process.stderr.write('\r\u001b[2K')
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.mode === 'help') return console.log(HELP)
  const { gather, renderBrief, renderCli, renderJson, renderTimelineCli } = await import('../hooks/lib/cli.ts')
  const { specCandidates } = await import('../hooks/lib/view.ts')
  const cwd = resolve(o.dir)
  const io = {
    cwd,
    now: Date.now(),
    read: rel => readFile(resolve(cwd, rel), 'utf8').catch(() => null),
    list: rel =>
      readdir(resolve(cwd, rel || '.'), { withFileTypes: true }).then(
        es => es.filter(e => e.isFile()).map(e => e.name),
        () => [],
      ),
    run: o.git ? runner(cwd) : undefined,
  }
  let specFile
  if (o.spec) {
    const names = [...(await io.list('')), ...(await io.list('specs')).map(n => `specs/${n}`)]
    specFile = specCandidates(o.spec).find(f => names.includes(f))
    if (!specFile) throw new Error(`no ${specCandidates(o.spec).join(' or ')} in ${cwd}`)
  }
  const stop = o.mode === 'full' || o.mode === 'timeline' ? spinner('Reading the plan and its git history') : () => {}
  const state = await gather(io, { specFile }).finally(stop)

  const env = process.env
  const color = o.color ?? (env.NO_COLOR ? false : env.FORCE_COLOR ? true : !!process.stdout.isTTY)
  if (o.mode === 'json') return console.log(renderJson(state))
  if (o.mode === 'brief') return console.log(renderBrief(state, { color }))
  const width = o.width || Math.min(110, process.stdout.columns || 80)
  console.log(o.mode === 'timeline' ? renderTimelineCli(state, { color, width }) : renderCli(state, { color, width }))
}

main().catch(err => {
  console.error(`agent-skills-progress: ${err?.message ?? err}`)
  process.exitCode = 2
})
