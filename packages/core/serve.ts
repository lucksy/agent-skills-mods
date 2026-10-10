// The live server's request handling (team-view, T10): `handle(request, io)` →
// `{ status, headers, body }`, with no sockets. It checks the per-run token on
// every request, the Origin on every request that sends one, and the rev on
// every write, then runs the same actions as the /progress verbs (actions.ts).
// The CLI's --serve wires it to node:http, fs.watch and the event stream. Pure.

import { runAction, type ActionInput } from './actions'
import { parsePlan, parseSpec, parseTasks, withBlockers } from './parse'
import { parseTeam, TEAM_FILE } from './team'
import { specFiles } from './view'

/** A request as node:http hands it in: header names in lower case, `url` the path and query. */
export type ServeRequest = { method: string; url: string; headers: Record<string, string | undefined>; body?: string }

/** What to send back. `events` asks the caller to keep the response open as the event stream. */
export type ServeResponse = { status: number; headers: Record<string, string>; body: string; events?: boolean }

/** What the handler reads and writes through: the project's files, who runs the server, and the page. */
export type ServeIo = {
  /** The per-run token every request must carry. */
  token: string
  /** The server's own origin, `http://127.0.0.1:<port>`. */
  origin: string
  /** Today, YYYY-MM-DD: the day actions stamp. */
  today: () => string
  /** A file's text relative to the project, or null when there is none. */
  read: (rel: string) => Promise<string | null>
  /** The file names in a folder relative to the project; empty when it is missing. */
  list: (rel: string) => Promise<string[]>
  write: (rel: string, text: string) => Promise<void>
  /** The git email of whoever runs the server: actions sign with its handle in tasks/team.md. */
  email: () => Promise<string | null>
  /** The dashboard, built from the files whose hash is `rev`. */
  page: (rev: string) => Promise<string>
}

export const TOKEN_HEADER = 'x-agent-skills-token'
export const REV_HEADER = 'x-agent-skills-rev'
export const STALE = 'changed since you loaded it, reload'

/** No CORS headers, ever: only the page this server served may call it. */
const BASE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

const json = (status: number, body: Record<string, unknown>): ServeResponse => ({ status, headers: { ...BASE, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) })
const reply = (status: number, text: string) => json(status, { reply: text })

/** A 64-bit FNV-1a hash of `text` as 16 hex digits: what a rev is made of. Not for secrets. */
export function hashText(text: string): string {
  let hi = 0xcbf29ce4
  let lo = 0x84222325
  for (let i = 0; i < text.length; i++) {
    lo ^= text.charCodeAt(i)
    // Multiply by the FNV prime 0x100000001b3, in 16-bit pieces so nothing overflows.
    const l0 = lo & 0xffff
    const l1 = lo >>> 16
    const h0 = hi & 0xffff
    const h1 = hi >>> 16
    let t0 = l0 * 0x1b3
    let t1 = l1 * 0x1b3 + (t0 >>> 16)
    let t2 = h0 * 0x1b3 + (t1 >>> 16) + (l0 << 8)
    let t3 = h1 * 0x1b3 + (t2 >>> 16) + (l1 << 8)
    t0 &= 0xffff
    t1 &= 0xffff
    t2 &= 0xffff
    t3 &= 0xffff
    lo = ((t1 << 16) | t0) >>> 0
    hi = ((t3 << 16) | t2) >>> 0
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0')
}

/** The files an action can write, and their texts (null when missing), read once. */
type Files = { names: string[]; text: Record<string, string | null> }

async function readFiles(io: ServeIo): Promise<Files> {
  const names = ['tasks/todo.md', 'tasks/plan.md', ...specFiles(await io.list(''), await io.list('specs'))]
  const texts = await Promise.all(names.map(n => io.read(n)))
  return { names, text: Object.fromEntries(names.map((n, i) => [n, texts[i]!])) }
}

const revOf = (f: Files) => hashText(f.names.map(n => `${n}\0${f.text[n] ?? '\u0001'}`).join('\0'))

/**
 * The rev: one hash over tasks/todo.md, tasks/plan.md and every spec, the files
 * an action can write. A write goes ahead only when it still matches what the
 * page loaded, so an edit to any of them since makes the page reload first.
 */
export async function readRev(io: ServeIo): Promise<{ rev: string; files: Files }> {
  const files = await readFiles(io)
  return { rev: revOf(files), files }
}

/** The value of `name` in the query string, decoded; null when absent. */
function query(url: string, name: string): string | null {
  const q = url.split('?')[1] ?? ''
  for (const pair of q.split('&')) {
    const [k, v = ''] = pair.split('=')
    if (k === name) {
      try {
        return decodeURIComponent(v.replace(/\+/g, ' '))
      } catch {
        return null
      }
    }
  }
  return null
}

/** Compares in time that doesn't depend on where the strings first differ. */
function same(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < b.length; i++) diff |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * One request: 401 without the token (the `X-Agent-Skills-Token` header, or
 * `?token=`), 403 when it sends an Origin that isn't the server's own, then
 * `GET /` (the dashboard), `GET /events` (the event stream) or `POST /action`.
 */
export async function handle(req: ServeRequest, io: ServeIo): Promise<ServeResponse> {
  const token = req.headers[TOKEN_HEADER] ?? query(req.url, 'token')
  if (!token || !same(token, io.token)) return reply(401, 'Missing or wrong token: open the URL --serve printed.')
  const origin = req.headers.origin
  if (origin !== undefined && origin !== io.origin) return reply(403, `Only ${io.origin} may call this server.`)

  const path = req.url.split('?')[0]
  if (path === '/' || path === '/events') {
    if (req.method !== 'GET') return reply(405, `${path} takes GET.`)
    if (path === '/events') {
      return { status: 200, headers: { ...BASE, 'content-type': 'text/event-stream', connection: 'keep-alive' }, body: ': connected\n\n', events: true }
    }
    const { rev } = await readRev(io)
    return { status: 200, headers: { ...BASE, 'content-type': 'text/html; charset=utf-8', [REV_HEADER]: rev }, body: await io.page(rev) }
  }
  if (path === '/action') return req.method === 'POST' ? action(req.body ?? '', io) : reply(405, '/action takes POST.')
  return reply(404, `No ${path} here: GET /, GET /events, POST /action.`)
}

/** `POST /action { action, args, rev }`: 409 when the files changed since `rev`, 400 when the action refuses. */
async function action(body: string, io: ServeIo): Promise<ServeResponse> {
  let msg: unknown
  try {
    msg = JSON.parse(body)
  } catch {
    msg = null
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return reply(400, 'Send JSON: { action, args, rev }.')
  const { action: name, args = {}, rev } = msg as { action?: unknown; args?: unknown; rev?: unknown }
  if (typeof rev !== 'string' || !rev) return reply(400, 'Send the rev the page was loaded with.')
  if (!args || typeof args !== 'object' || Array.isArray(args)) return reply(400, 'Send args as an object.')
  const a = args as Record<string, unknown>

  const now = await readRev(io)
  if (now.rev !== rev) return json(409, { reply: STALE, rev: now.rev })

  const { text } = now.files
  const specs = now.files.names.slice(2)
  if (a.spec !== undefined && (typeof a.spec !== 'string' || !specs.includes(a.spec))) {
    return reply(400, `No spec ${String(a.spec)} here.${specs.length ? ` Specs: ${specs.join(', ')}.` : ''}`)
  }
  const specFile = (a.spec as string | undefined) ?? specs[0] ?? null
  const todo = text['tasks/todo.md']!
  const plan = text['tasks/plan.md']!
  const specText = specFile ? text[specFile]! : null
  const teamText = await io.read(TEAM_FILE)
  const team = teamText === null ? null : parseTeam(teamText)
  // The list as the board shows it: open questions block the tasks they name.
  const source = todo ?? plan
  const questions = [
    ...(plan === null ? [] : parsePlan(plan).openQuestions.map(q => ({ file: 'tasks/plan.md', text: q }))),
    ...(specText === null ? [] : parseSpec(specText).openQuestions.map(q => ({ file: specFile!, text: q }))),
  ]
  const input: ActionInput = {
    todo,
    plan,
    spec: specFile && specText !== null ? { file: specFile, text: specText } : null,
    list: source === null ? null : withBlockers(parseTasks(source), questions),
    today: io.today(),
    team,
    email: team ? await io.email() : null,
    // The server keeps no session: nothing is pending, and a ticked box stamps its task's Status line, no other.
    pending: {},
    keepFormat: true,
    scoped: true,
  }
  const r = runAction(typeof name === 'string' ? name : '', a, input)
  if (!r.ok) return reply(400, r.reply)
  for (const w of r.writes) await io.write(w.file, w.text)
  return json(200, { reply: r.reply, rev: (await readRev(io)).rev })
}

// /progress dashboard live (T12): the plugin starts this server as a child of the
// session and reads its address off what it prints; a person runs it by hand.

/** The oldest Node the CLI runs on: it strips the plugin's TypeScript types itself. */
export const MIN_NODE = [22, 6] as const

/**
 * The CLI's --serve on `cwd`: for the plugin's child on a free port and unopened
 * (the plugin opens the address it prints), for a person as they'd type it.
 */
export function serveArgv(script: string, cwd: string, who: 'child' | 'person'): string[] {
  const argv = ['node', '--experimental-strip-types', script, cwd, '--serve']
  return who === 'child' ? [...argv, '--port', '0', '--no-open'] : argv
}

/** `argv` as one shell line, each word single-quoted only when it needs it. */
export function shellLine(argv: readonly string[]): string {
  return argv.map(w => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ')
}

/** The address on --serve's first line (`Serving <dir> at <url>`), once that whole line has come; else null. */
export function servedUrl(stdout: string): string | null {
  return /^Serving .* at (http:\/\/127\.0\.0\.1:\d+\/\S*)\r?\n/m.exec(stdout)?.[1] ?? null
}

/** True when `node --version` (`v20.11.0`) is older than MIN_NODE; an answer it can't read is not. */
export function nodeTooOld(version: string): boolean {
  const m = /^v(\d+)\.(\d+)\./.exec(version.trim())
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])
}
