#!/usr/bin/env -S node --no-warnings --experimental-strip-types
// agent-skills progress for any agent (E2): reads SPEC.md, tasks/plan.md and
// tasks/todo.md with the same parser as the Claude Code plugin and prints the
// stage, a progress bar, the ETA range, the run timeline and what needs you.
//
//   node scripts/agent-skills-progress.mjs [dir] [--brief | --timeline | --json | --branches | --since | --standup-team] [--no-color] [--no-git] [--spec <id>] [--width <n>]
//   node scripts/agent-skills-progress.mjs [dir] --serve [--port 7357] [--no-open]
//   node scripts/agent-skills-progress.mjs --merge <base> <ours> <theirs> <path>   (git's merge driver)
//
// No dependencies: Node 22.6 or newer (it runs the plugin's TypeScript through
// Node's type stripping), or Bun.

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { dirname, join, relative, resolve } from 'node:path'
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
  --branches      the board across branches: each task's furthest state on any
                  local branch or fetched ref, and how long ago this clone fetched
  --since         what changed since you last looked, with who did it; then
                  remembers this look (in the git folder, shared with the plugin)
  --standup-team  the team standup: a line per person with what was done since the
                  last working day (on any branch, or named by their commits), today
                  and blocked, then what nobody owns
  --modules [id]  every module of SPEC.md's capability map, archived plans included; with an id, its run timeline
  --dashboard [out.html]
                  write the dashboard page (default tasks/progress-dashboard.html)
  --serve         the live dashboard on 127.0.0.1, behind a token printed with its URL;
                  it reloads when the plan changes. Ctrl-C stops it
  --port <n>      the port --serve listens on (default 7357; 0 picks a free one)
  --no-open       don't open the page in a browser
  --merge <base> <ours> <theirs> <path>
                  git's merge driver (%O %A %B %P): merges tasks/todo.md by task and a
                  spec's approvals by role, writes <ours>, exits 1 on a conflict.
                  /progress merge-driver install sets it up
  --spec <id>     show specs/<id>.md or SPEC-<id>.md instead of SPEC.md
  --no-git        skip git history (no ETA until 3 tasks are done today)
  --no-color      plain text (also NO_COLOR=1, or when not a terminal)
  --color         colours even when piped (also FORCE_COLOR=1)
  --width <n>     columns to draw in (default: the terminal's, up to 110)
  -h, --help      this text`

function parseArgs(argv) {
  const o = { dir: '.', mode: 'full', git: true, color: undefined, width: undefined, spec: undefined, out: undefined, port: 7357, open: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') o.mode = 'help'
    else if (a === '--brief') o.mode = 'brief'
    else if (a === '--timeline') o.mode = 'timeline'
    else if (a === '--json') o.mode = 'json'
    else if (a === '--branches') o.mode = 'branches'
    else if (a === '--since') o.mode = 'since'
    else if (a === '--standup-team') o.mode = 'standup-team'
    else if (a === '--modules') {
      o.mode = 'modules'
      // A module id, not a folder: no slash, not . or ..
      if (/^[\w][\w.-]*$/.test(argv[i + 1] ?? '')) o.module = argv[++i]
    }
    else if (a === '--dashboard') {
      o.mode = 'dashboard'
      if (/\.html?$/i.test(argv[i + 1] ?? '')) o.out = argv[++i]
    }
    else if (a === '--serve') o.mode = 'serve'
    else if (a === '--port') {
      o.port = Number(argv[++i])
      if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error(`--port takes a number from 0 to 65535`)
    }
    else if (a === '--no-open') o.open = false
    else if (a === '--merge') {
      o.mode = 'merge'
      o.merge = argv.slice(i + 1, i + 5)
      if (o.merge.length < 4) throw new Error('--merge takes <base> <ours> <theirs> <path>, as git passes %O %A %B %P')
      i += 4
    }
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
  if (o.mode === 'merge') return mergeDriver(...o.merge)
  const { gather, renderBrief, renderCli, renderJson, renderTimelineCli } = await import('../packages/core/cli.ts')
  const { specCandidates } = await import('../packages/core/view.ts')
  const cwd = resolve(o.dir)
  // The git folder, absolute; null outside a repository. Never fetches.
  const gitDir = async () => {
    const r = await runner(cwd)(['git', 'rev-parse', '--git-dir'])
    return r.exitCode === 0 && r.stdout.trim() ? resolve(cwd, r.stdout.trim()) : null
  }
  const { SEEN_FILE } = await import('../packages/core/since.ts')
  const io = {
    cwd,
    now: Date.now(),
    read: rel => readFile(resolve(cwd, rel), 'utf8').catch(() => null),
    list: rel =>
      readdir(resolve(cwd, rel || '.'), { withFileTypes: true }).then(
        es => es.filter(e => e.isFile()).map(e => e.name),
        () => [],
      ),
    dirs: rel =>
      readdir(resolve(cwd, rel || '.'), { withFileTypes: true }).then(
        es => es.filter(e => e.isDirectory()).map(e => e.name),
        () => [],
      ),
    run: o.git ? runner(cwd) : undefined,
    // FETCH_HEAD's time: when this clone last fetched (team-view). Never fetches.
    fetchedAt: async () => {
      const dir = await gitDir()
      return dir ? stat(resolve(dir, 'FETCH_HEAD')).then(s => s.mtimeMs, () => null) : null
    },
    // The last look (team-view T9): <git dir>/agent-skills/seen.json, shared with the plugin.
    seen: o.git ? async () => {
      const dir = await gitDir()
      return dir ? readFile(resolve(dir, SEEN_FILE), 'utf8').catch(() => null) : null
    } : undefined,
  }
  let specFile
  if (o.spec) {
    const names = [...(await io.list('')), ...(await io.list('specs')).map(n => `specs/${n}`)]
    specFile = specCandidates(o.spec).find(f => names.includes(f))
    if (!specFile) throw new Error(`no ${specCandidates(o.spec).join(' or ')} in ${cwd}`)
  }
  if (o.mode === 'serve') return serve(io, { specFile, port: o.port, open: o.open, branches: o.git })
  const stop = o.mode === 'full' || o.mode === 'timeline' || o.mode === 'dashboard' ? spinner('Reading the plan and its git history') : () => {}
  // The dashboard's Board has an All branches switch (team-view T5).
  // --since reads the branches too, for new collisions; --json reports since without storing a look.
  const branches = o.git && (o.mode === 'json' || o.mode === 'branches' || o.mode === 'dashboard' || o.mode === 'since' || o.mode === 'standup-team')
  const since = o.git && (o.mode === 'json' || o.mode === 'since')
  const state = await gather(io, { specFile, branches, since }).finally(stop)

  const env = process.env
  const color = o.color ?? (env.NO_COLOR ? false : env.FORCE_COLOR ? true : !!process.stdout.isTTY)
  if (o.mode === 'json') return console.log(renderJson(state))
  if (o.mode === 'branches') {
    const { branchesText } = await import('../packages/core/branches.ts')
    if (!o.git) return console.log('The board across branches reads git; drop --no-git.')
    return console.log(state.branches ? branchesText(state.branches, io.now) : 'Not a git repository: the board across branches reads the other branches from git.')
  }
  if (o.mode === 'since') {
    if (!o.git) return console.log('"Since you last looked" reads git; drop --no-git.')
    const dir = await gitDir()
    if (!dir || !state.since) return console.log('Not a git repository: "since you last looked" keeps its snapshot in the git folder.')
    const { nextSeen, parseSeen, seenOf, seenText, sinceText } = await import('../packages/core/since.ts')
    console.log(sinceText(state.since))
    // This look is remembered: the next one, here or in the plugin, starts from now.
    const path = resolve(dir, SEEN_FILE)
    const prev = parseSeen(await readFile(path, 'utf8').catch(() => null))
    await mkdir(dirname(path), { recursive: true })
    return writeFile(path, seenText(nextSeen(prev, seenOf(state, io.now))))
  }
  if (o.mode === 'standup-team') {
    // ceremonies C3: the same lines /progress standup team copies, from the board and one log since the last working day.
    const { lastWorkingDay, readCommits, standupTeam, standupTeamText } = await import('../packages/core/standup.ts')
    const commits = state.branches && io.run ? await readCommits(io.run, state.branches, lastWorkingDay(state.today)) : []
    return console.log(standupTeamText(standupTeam(state, state.branches, commits, state.today), !!state.list && state.list.total > 0))
  }
  if (o.mode === 'modules') {
    const { modulesText } = await import('../packages/core/modules.ts')
    if (!state.modules) return console.log('No capability map in SPEC.md.')
    if (!o.module) return console.log(modulesText(state.modules, 'SPEC.md'))
    const { moduleFiles, moduleTimeline } = await import('../packages/core/module-timeline.ts')
    const files = Object.fromEntries(await Promise.all(moduleFiles(state.modules, o.module).map(async f => [f, await io.read(f)])))
    const env = process.env
    const color = o.color ?? (env.NO_COLOR ? false : env.FORCE_COLOR ? true : !!process.stdout.isTTY)
    return console.log(moduleTimeline(state.modules, o.module, files, state.today, { color, width: o.width || Math.min(110, process.stdout.columns || 80) }))
  }
  if (o.mode === 'dashboard') {
    const { dashboardHtml } = await import('../packages/core/dashboard/page.ts')
    const html = dashboardHtml(state)
    const out = resolve(cwd, o.out ?? 'tasks/progress-dashboard.html')
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, html)
    const shown = relative(process.cwd(), out)
    return console.log(`Wrote ${shown && !shown.startsWith('..') ? shown : out} (${Math.max(1, Math.round(Buffer.byteLength(html) / 1024))} KB). Open it in a browser; it works offline.`)
  }
  if (o.mode === 'brief') return console.log(renderBrief(state, { color }))
  const width = o.width || Math.min(110, process.stdout.columns || 80)
  console.log(o.mode === 'timeline' ? renderTimelineCli(state, { color, width }) : renderCli(state, { color, width }))
}

/**
 * --merge (team-view T8): git's merge driver. Reads the three files, merges by
 * path (packages/core/mergedriver.ts) with `git merge-file` for the lines it
 * doesn't own, writes the result over <ours>, prints renumbers and conflicts to
 * stderr and exits 1 when markers are left, as git expects.
 */
async function mergeDriver(basePath, oursPath, theirsPath, path) {
  const { driverReport, mergeByPath } = await import('../packages/core/mergedriver.ts')
  const { parseTeam } = await import('../packages/core/team.ts')
  const [base, ours, theirs] = await Promise.all([basePath, oursPath, theirsPath].map(f => readFile(f, 'utf8')))
  // git runs the driver at the top of the work tree, where tasks/team.md names the roles a spec needs.
  const team = await readFile('tasks/team.md', 'utf8').then(parseTeam, () => null)
  let r
  try {
    r = mergeByPath(path, base, ours, theirs, { lineMerge: gitMergeFile, required: team?.approvals })
  } catch (err) {
    // Never leave <ours> alone as if it had won: the plain line merge, markers and all.
    const m = gitMergeFile(base, ours, theirs)
    r = { text: m.text, conflicts: m.clean ? [] : [`the task-aware merge failed (${err?.message ?? err}); merged line by line`], renumbered: [] }
  }
  await writeFile(oursPath, r.text)
  for (const line of driverReport(path, r)) console.error(`agent-skills merge: ${line}`)
  process.exitCode = r.conflicts.length ? 1 : 0
}

/** `git merge-file -p` over temp copies: markers read `<<<<<<< ours` / `>>>>>>> theirs`, as the core's do. */
function gitMergeFile(base, ours, theirs) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-skills-merge-'))
  try {
    const [b, o, t] = ['base', 'ours', 'theirs'].map(n => join(dir, n))
    writeFileSync(b, base)
    writeFileSync(o, ours)
    writeFileSync(t, theirs)
    const r = spawnSync('git', ['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs', o, b, t], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    // 0 clean, 1-127 the number of conflicts; anything else (no git, an error) falls back to whole sides.
    if (r.error || r.status === null || r.status < 0 || r.status > 127) throw new Error(r.error?.message ?? r.stderr ?? 'git merge-file failed')
    return { text: r.stdout, clean: r.status === 0 }
  } catch {
    if (ours === theirs || theirs === base) return { text: ours, clean: true }
    if (ours === base) return { text: theirs, clean: true }
    return { text: `<<<<<<< ours\n${ours}=======\n${theirs}>>>>>>> theirs\n`, clean: false }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * --serve (team-view): the live dashboard. node:http on 127.0.0.1 only, a fresh
 * token per run, and packages/core/serve.ts deciding every response. Writes
 * run one at a time; a change under tasks/, specs/ or to SPEC*.md sends
 * `changed` to every open event stream.
 */
async function serve(io, { specFile, port, open, branches }) {
  const { handle } = await import('../packages/core/serve.ts')
  const { dashboardHtml } = await import('../packages/core/dashboard/page.ts')
  const { gather } = await import('../packages/core/cli.ts')
  const { dayOf } = await import('../packages/core/forecast.ts')
  const cwd = io.cwd
  const git = runner(cwd)
  const sio = {
    token: randomBytes(16).toString('hex'),
    origin: '',
    today: () => dayOf(Date.now()),
    read: io.read,
    list: io.list,
    write: (rel, text) => writeFile(resolve(cwd, rel), text),
    email: () => git(['git', 'config', 'user.email']).then(r => (r.exitCode === 0 ? r.stdout.trim() || null : null)),
    // The dashboard with its write buttons, posting with the rev it was built from (T11),
    // and the Board across branches as --dashboard has it (T5, T6).
    page: async rev => dashboardHtml(await gather({ ...io, now: Date.now() }, { specFile, branches }), { live: { rev } }),
  }

  const streams = new Set()
  let writes = Promise.resolve()
  const server = createServer((req, res) => {
    let body = ''
    let size = 0
    req.setEncoding('utf8')
    req.on('data', d => {
      size += d.length
      if (size > 64 * 1024) {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end('{"reply":"Too large."}')
        req.destroy()
      } else body += d
    })
    req.on('end', async () => {
      if (res.writableEnded) return
      const request = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body }
      // One write at a time, so a rev check and its write can't interleave with another's.
      const respond = () => handle(request, sio)
      const r = await (req.method === 'POST' ? (writes = writes.then(respond, respond)) : respond()).catch(err => ({
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        body: JSON.stringify({ reply: `Server error: ${err?.message ?? err}` }),
      }))
      res.writeHead(r.status, r.headers)
      if (!r.events) return res.end(r.body)
      res.write(r.body)
      streams.add(res)
      req.on('close', () => streams.delete(res))
    })
  })

  // A save often fires several events; one `changed` per burst.
  let timer
  const changed = file => {
    if (!/\.md$/.test(file ?? '')) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      for (const s of streams) s.write(`event: changed\ndata: ${JSON.stringify({ file })}\n\n`)
    }, 100)
  }
  const watchers = []
  const watchDir = (rel, keep) => {
    try {
      watchers.push(watch(resolve(cwd, rel), (_, name) => name && keep(String(name)) && changed(rel ? `${rel}/${name}` : String(name))))
    } catch {}
  }
  watchDir('', name => /^SPEC(-[\w.-]+)?\.md$/.test(name))
  watchDir('tasks', () => true)
  watchDir('specs', () => true)
  // Keeps proxies and the browser from closing an idle stream.
  const ping = setInterval(() => {
    for (const s of streams) s.write(': ping\n\n')
  }, 20_000)

  await new Promise((done, fail) => {
    server.once('error', err => fail(err.code === 'EADDRINUSE' ? new Error(`port ${port} is in use; try --port 0 for a free one`) : err))
    server.listen(port, '127.0.0.1', done)
  })
  sio.origin = `http://127.0.0.1:${server.address().port}`
  const url = `${sio.origin}/?token=${sio.token}`
  console.log(`Serving ${cwd} at ${url}`)
  console.log('Only this machine can reach it, and only with the token. Ctrl-C stops it.')
  if (open) {
    const argv = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url]
    try {
      spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
    } catch {}
  }
  const stop = () => {
    clearInterval(ping)
    for (const w of watchers) w.close()
    for (const s of streams) s.end()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch(err => {
  console.error(`agent-skills-progress: ${err?.message ?? err}`)
  process.exitCode = 2
})
