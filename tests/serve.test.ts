import { describe, expect, test } from 'claude-code/testing'

import { ACTION_NAMES } from '../packages/core/actions'
import { stampTodo } from '../packages/core/format'
import { parsePlan, parseSpec, parseTasks } from '../packages/core/parse'
import { handle, hashText, nodeTooOld, readRev, serveArgv, servedUrl, shellLine, type ServeIo, type ServeRequest } from '../packages/core/serve'
import { SPEC, TODO_T2_DONE, TODO_TEMPLATE } from './fixtures'

// team-view T10: the live server's request handling, with no sockets. The token
// on every request, the Origin on every request that sends one, the rev on
// every write; then the same actions the /progress verbs run.

const TOKEN = 'a'.repeat(32)
const ORIGIN = 'http://127.0.0.1:7357'
const TEAM = `---
approvals: product, eng
---
| Handle | Role | Email |
|---|---|---|
| @amila | lead, eng | amila@example.com |
| @pm | product | pm@example.com |
`
const PLAN = '# Plan\n\n## Open Questions\n\n- Q1 (T3): argon2 or bcrypt?\n'

/** A project in memory: its files, and every write the handler makes. */
function project(files: Record<string, string> = {}, email: string | null = 'amila@example.com') {
  const disk: Record<string, string> = { 'tasks/todo.md': TODO_TEMPLATE, 'tasks/plan.md': PLAN, 'SPEC.md': SPEC, 'tasks/team.md': TEAM, ...files }
  const writes: string[] = []
  const io: ServeIo = {
    token: TOKEN,
    origin: ORIGIN,
    today: () => '2026-10-11',
    read: async rel => disk[rel] ?? null,
    list: async rel => Object.keys(disk).filter(f => (rel ? f.startsWith(`${rel}/`) && !f.slice(rel.length + 1).includes('/') : !f.includes('/'))).map(f => f.split('/').pop()!),
    write: async (rel, text) => {
      writes.push(rel)
      disk[rel] = text
    },
    email: async () => email,
    page: async rev => `<!doctype html><html><body data-rev="${rev}">dashboard</body></html>`,
  }
  return { io, disk, writes }
}

const get = (url: string, headers: Record<string, string> = {}): ServeRequest => ({ method: 'GET', url, headers })
const post = (body: unknown, headers: Record<string, string> = { 'x-agent-skills-token': TOKEN, origin: ORIGIN }): ServeRequest => ({
  method: 'POST',
  url: '/action',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

/** POSTs `action` with the project's current rev. */
async function run(p: ReturnType<typeof project>, action: string, args: Record<string, unknown> = {}) {
  const { rev } = await readRev(p.io)
  const r = await handle(post({ action, args, rev }), p.io)
  return { status: r.status, json: JSON.parse(r.body) as { reply: string; rev?: string } }
}

describe('the token and the Origin', () => {
  test('a missing or wrong token gets 401 and reads nothing it would show', async () => {
    const p = project()
    for (const req of [get('/'), get('/?token=nope'), get('/events'), get('/', { 'x-agent-skills-token': 'b'.repeat(32) }), post({ action: 'start', args: { id: 'T3' }, rev: 'x' }, { origin: ORIGIN })]) {
      const r = await handle(req, p.io)
      expect(r.status).toBe(401)
      expect(r.body).not.toContain('dashboard')
    }
    expect(p.writes).toEqual([])
  })

  test('the token works as a header or as ?token= on the page URL', async () => {
    const p = project()
    expect((await handle(get(`/?token=${TOKEN}`), p.io)).status).toBe(200)
    expect((await handle(get('/', { 'x-agent-skills-token': TOKEN }), p.io)).status).toBe(200)
    expect((await handle(get(`/?view=board&token=${TOKEN}`), p.io)).status).toBe(200)
  })

  test('a foreign Origin gets 403, even with the token, and writes nothing', async () => {
    const p = project()
    const { rev } = await readRev(p.io)
    for (const origin of ['http://evil.example', 'http://localhost:7357', 'null', 'http://127.0.0.1:7358']) {
      expect((await handle(post({ action: 'start', args: { id: 'T3' }, rev }, { 'x-agent-skills-token': TOKEN, origin }), p.io)).status).toBe(403)
      expect((await handle(get(`/?token=${TOKEN}`, { origin }), p.io)).status).toBe(403)
    }
    expect(p.writes).toEqual([])
  })

  test('no response carries CORS headers; none can be cached or leak the token as a referrer', async () => {
    const p = project()
    const { rev } = await readRev(p.io)
    const all = [
      await handle(get('/'), p.io),
      await handle(get(`/?token=${TOKEN}`), p.io),
      await handle(get(`/events?token=${TOKEN}`), p.io),
      await handle(get(`/nope?token=${TOKEN}`), p.io),
      await handle(post({ action: 'start', args: { id: 'T3' }, rev }), p.io),
      await handle(post({ action: 'start', args: { id: 'T3' }, rev }, { 'x-agent-skills-token': TOKEN, origin: 'http://evil.example' }), p.io),
      await handle({ method: 'OPTIONS', url: '/action', headers: { origin: 'http://evil.example' } }, p.io),
    ]
    for (const r of all) {
      expect(Object.keys(r.headers).filter(h => h.toLowerCase().startsWith('access-control-'))).toEqual([])
      expect(r.headers['cache-control']).toBe('no-store')
      expect(r.headers['referrer-policy']).toBe('no-referrer')
    }
  })
})

describe('GET', () => {
  test('/ serves the dashboard with the rev it was built from', async () => {
    const p = project()
    const r = await handle(get(`/?token=${TOKEN}`), p.io)
    const { rev } = await readRev(p.io)
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(r.headers['x-agent-skills-rev']).toBe(rev)
    expect(r.body).toContain(`data-rev="${rev}"`)
  })

  test('/events opens an event stream; other paths are 404 and other methods 405', async () => {
    const p = project()
    const e = await handle(get(`/events?token=${TOKEN}`), p.io)
    expect(e.status).toBe(200)
    expect(e.events).toBe(true)
    expect(e.headers['content-type']).toBe('text/event-stream')
    expect((await handle(get(`/nope?token=${TOKEN}`), p.io)).status).toBe(404)
    expect((await handle(get(`/action?token=${TOKEN}`), p.io)).status).toBe(405)
    expect((await handle({ method: 'DELETE', url: `/?token=${TOKEN}`, headers: {} }, p.io)).status).toBe(405)
  })
})

describe('the rev', () => {
  test('is a hash of tasks/todo.md, tasks/plan.md and the specs; any edit to one changes it', async () => {
    const p = project()
    const a = (await readRev(p.io)).rev
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect((await readRev(p.io)).rev).toBe(a)
    for (const file of ['tasks/todo.md', 'tasks/plan.md', 'SPEC.md']) {
      const q = project({ [file]: `${p.disk[file]}\n` })
      expect((await readRev(q.io)).rev).not.toBe(a)
    }
    expect(hashText('a')).not.toBe(hashText('b'))
    expect(hashText('')).toMatch(/^[0-9a-f]{16}$/)
  })

  test('a stale rev gets 409 and writes nothing', async () => {
    const p = project()
    const { rev } = await readRev(p.io)
    p.disk['tasks/todo.md'] += '\n'
    const r = await handle(post({ action: 'start', args: { id: 'T3' }, rev }), p.io)
    expect(r.status).toBe(409)
    expect(JSON.parse(r.body).reply).toBe('changed since you loaded it, reload')
    expect(p.writes).toEqual([])
  })
})

describe('bad requests', () => {
  test('a body that is not an action, a missing rev, an unknown action and bad args get 400 and write nothing', async () => {
    const p = project()
    const { rev } = await readRev(p.io)
    const cases: [unknown, string][] = [
      ['{not json', 'Send JSON: { action, args, rev }.'],
      [[1, 2], 'Send JSON: { action, args, rev }.'],
      [{ action: 'start', args: { id: 'T3' } }, 'Send the rev the page was loaded with.'],
      [{ action: 'start', args: 'T3', rev }, 'Send args as an object.'],
      [{ action: 'rename', args: {}, rev }, 'No action "rename". Actions: start, done, block, unblock, tick, claim, assign, unassign, review, handoff, sign, signoff, answer, size, backlog-add, pull, defer.'],
      [{ action: 'start', args: { id: 4 }, rev }, 'Say which task: /progress start T4.'],
      [{ action: 'start', args: { id: 'T9' }, rev }, 'No "## Task 9:" section in tasks/todo.md. Tasks: T1, T2, T3, T4.'],
      [{ action: 'tick', args: { id: 'T3', index: 7 }, rev }, 'No box 8 in T3.'],
      [{ action: 'block', args: { id: 'T3' }, rev }, 'Say why: /progress block T6 "Upstash or self-hosted?"'],
      [{ action: 'sign', args: { spec: '../etc/passwd' }, rev }, 'No spec ../etc/passwd here. Specs: SPEC.md.'],
    ]
    for (const [body, reply] of cases) {
      const r = await handle(post(body), p.io)
      expect([r.status, JSON.parse(r.body).reply]).toEqual([400, reply])
    }
    expect(p.writes).toEqual([])
  })

  test('without tasks/todo.md, a task action is refused', async () => {
    const p = project()
    delete p.disk['tasks/todo.md']
    const r = await run(p, 'done', { id: 'T2' })
    expect([r.status, r.json.reply]).toEqual([400, 'No tasks/todo.md here.'])
  })
})

describe('each action, through POST /action', () => {
  test('the 17 actions are the table\'s', () => {
    expect(ACTION_NAMES.length).toBe(17)
  })

  test('pull and defer write both files; a page loaded before either changed gets a 409 and writes neither (ceremonies T4)', async () => {
    const p = project({ 'tasks/backlog.md': '# Backlog\n\n## B1: Quotas\n- [ ] per tenant\n' })
    const r = await run(p, 'defer', { id: 'T4' })
    expect([r.status, r.json.reply]).toEqual([200, 'T4 Rate limit per key is deferred: it is B2 in tasks/backlog.md now, and /progress pull B2 brings it back as T4.'])
    expect(p.writes).toEqual(['tasks/todo.md', 'tasks/backlog.md'])
    expect(p.disk['tasks/backlog.md']).toContain('## B2: Rate limit per key\n**Was:** T4 · deferred 2026-10-11 @amila\n')
    const rev = (await readRev(p.io)).rev
    for (const file of ['tasks/backlog.md', 'tasks/todo.md']) {
      const q = project({ 'tasks/backlog.md': p.disk['tasks/backlog.md']!, 'tasks/todo.md': p.disk['tasks/todo.md']! })
      expect((await readRev(q.io)).rev).toBe(rev)
      q.disk[file] += '\n'
      const stale = await handle(post({ action: 'pull', args: { id: 'B2' }, rev }), q.io)
      expect(stale.status).toBe(409)
      expect(q.writes).toEqual([])
    }
    const back = await run(p, 'pull', { id: 'B2' })
    expect([back.status, back.json.reply]).toEqual([200, 'B2 Rate limit per key is T4 in tasks/todo.md now, its old number, after the last task.'])
    expect(p.disk['tasks/backlog.md']).toBe('# Backlog\n\n## B1: Quotas\n- [ ] per tenant\n')
  })

  test('backlog-add appends to tasks/backlog.md, which is part of the rev (ceremonies T3)', async () => {
    const p = project({ 'tasks/backlog.md': '# Backlog\n\n## B1: Docs\n' })
    const before = (await readRev(p.io)).rev
    const r = await run(p, 'backlog-add', { title: 'Quotas', size: 'L' })
    expect([r.status, r.json.reply]).toEqual([200, 'Added B2 Quotas (L) to tasks/backlog.md.'])
    expect(p.disk['tasks/backlog.md']).toBe('# Backlog\n\n## B1: Docs\n\n## B2: Quotas\n**Size:** L\n')
    expect(p.writes).toEqual(['tasks/backlog.md'])
    // A page loaded before the backlog changed is stale.
    const stale = await handle(post({ action: 'backlog-add', args: { title: 'Again' }, rev: before }), p.io)
    expect(stale.status).toBe(409)
  })

  test('size writes the task\'s Size line and nothing else (ceremonies T1)', async () => {
    const p = project()
    const r = await run(p, 'size', { id: 'T3', size: 'L' })
    expect([r.status, r.json.reply]).toEqual([200, 'T3 Issue and revoke keys is size L (2 points).'])
    expect(p.disk['tasks/todo.md']).toBe(TODO_TEMPLATE.replace('## Task 3: Issue and revoke keys\n', '## Task 3: Issue and revoke keys\n**Size:** L\n'))
    expect((await run(p, 'size', { id: 'T3', size: 'XL' })).status).toBe(400)
  })

  test('start, done, block and unblock stamp the task; block adds its question to tasks/plan.md', async () => {
    const p = project()
    let r = await run(p, 'start', { id: 'T3' })
    expect([r.status, r.json.reply]).toEqual([200, 'T3 Issue and revoke keys is in progress (started 11 Oct).'])
    expect(r.json.rev).toBe((await readRev(p.io)).rev)
    expect(parseTasks(p.disk['tasks/todo.md']!).tasks.find(t => t.id === 'T3')?.state).toMatchObject({ status: 'in progress', started: '2026-10-11', owner: '@amila' })

    r = await run(p, 'block', { id: 'T3', why: 'Which hash?' })
    expect(r.status).toBe(200)
    expect(p.disk['tasks/plan.md']).toContain('Q2 (T3): Which hash?')
    expect(parseTasks(p.disk['tasks/todo.md']!).tasks.find(t => t.id === 'T3')?.state?.status).toBe('blocked')

    r = await run(p, 'unblock', { id: 'T3' })
    expect(r.status).toBe(200)
    expect(parseTasks(p.disk['tasks/todo.md']!).tasks.find(t => t.id === 'T3')?.state?.status).toBe('todo')

    r = await run(p, 'done', { id: 'T2' })
    expect([r.status, r.json.reply]).toEqual([200, 'T2 Prisma schema for keys is done: 2 box(es) ticked.'])
    expect(parseTasks(p.disk['tasks/todo.md']!).tasks.find(t => t.id === 'T2')?.status).toBe('done')
    expect(p.writes).toEqual(['tasks/todo.md', 'tasks/plan.md', 'tasks/todo.md', 'tasks/todo.md', 'tasks/todo.md'])
  })

  test('tick toggles one box', async () => {
    const p = project()
    const r = await run(p, 'tick', { id: 'T3', index: 0 })
    expect([r.status, r.json.reply]).toEqual([200, 'T3 ticked: POST /keys returns the secret once.'])
    expect(parseTasks(p.disk['tasks/todo.md']!).tasks.find(t => t.id === 'T3')?.boxes[0]?.isDone).toBe(true)
  })

  test('claim, assign and unassign set the owner; claim names the server\'s git user', async () => {
    const p = project()
    let r = await run(p, 'claim', { id: 'T4' })
    expect([r.status, r.json.reply]).toEqual([200, 'T4 Rate limit per key → @amila (you).'])
    r = await run(p, 'assign', { id: 'T4', who: '@pm' })
    expect([r.status, r.json.reply]).toEqual([200, 'T4 Rate limit per key → @pm, was @amila.'])
    r = await run(p, 'unassign', { id: 'T4' })
    expect([r.status, r.json.reply]).toEqual([200, 'T4 Rate limit per key has no owner now (was @pm).'])
    const nobody = project({}, null)
    r = await run(nobody, 'claim', { id: 'T4' })
    expect(r.status).toBe(400)
    expect(nobody.writes).toEqual([])
  })

  test('review and handoff', async () => {
    const p = project()
    let r = await run(p, 'review', { id: 'T2', refs: ['#42', '@pm'] })
    expect([r.status, r.json.reply]).toEqual([200, 'T2 Prisma schema for keys is in review: PR #42, reviewer @pm.'])
    r = await run(p, 'handoff', { id: 'T2', to: '@pm', note: 'migration left' })
    expect([r.status, r.json.reply]).toEqual([200, 'T2 Prisma schema for keys → @pm, from @amila. Note: "migration left".'])
    expect(p.disk['tasks/todo.md']).toContain('migration left')
  })

  test('sign signs the spec for your roles, or a spec named in args', async () => {
    const p = project({ 'specs/auth.md': SPEC.replace('API keys', 'Auth') })
    let r = await run(p, 'sign', {})
    expect([r.status, r.json.reply]).toEqual([200, '✓ @amila signed SPEC.md for eng · waiting on @pm (product)'])
    expect(parseSpec(p.disk['SPEC.md']!).approvals?.map(a => a.role)).toEqual(['eng'])
    r = await run(p, 'sign', { spec: 'specs/auth.md' })
    expect(r.status).toBe(200)
    expect(p.writes).toEqual(['SPEC.md', 'specs/auth.md'])
  })

  test('signoff and answer write the sign-off and the answer with your name and the date', async () => {
    const p = project({ 'tasks/todo.md': TODO_T2_DONE })
    let r = await run(p, 'signoff')
    expect(r.status).toBe(200)
    expect(p.disk['tasks/todo.md']).toContain('**Signed off:** @amila 2026-10-11')
    r = await run(p, 'answer', { q: 'Q1', text: 'argon2id' })
    expect([r.status, r.json.reply]).toEqual([200, 'Q1 answered: "argon2id" · @amila 2026-10-11.'])
    expect(parsePlan(p.disk['tasks/plan.md']!).answered.map(a => a.answer.text)).toEqual(['argon2id'])
  })

  test('each action writes only its own file, keeping every other byte', async () => {
    // A list already in the format, so ticking a box stamps nothing new.
    const p = project({ 'tasks/todo.md': stampTodo(TODO_TEMPLATE, '2026-10-11', { changes: {} }) })
    const before = { ...p.disk }
    await run(p, 'tick', { id: 'T2', index: 1 })
    expect(p.disk['tasks/plan.md']).toBe(before['tasks/plan.md'])
    expect(p.disk['SPEC.md']).toBe(before['SPEC.md'])
    expect(p.disk['tasks/team.md']).toBe(before['tasks/team.md'])
    const changed = p.disk['tasks/todo.md']!.split('\n').filter((l, i) => l !== before['tasks/todo.md']!.split('\n')[i])
    expect(changed).toEqual(['- [x] Migration runs on a clean database'])
    expect(p.writes).toEqual(['tasks/todo.md'])
  })
})

describe('the live page\'s writes (T11)', () => {
  test('on a list not yet in the format, a write changes only its task: no Status line on another, no created: field', async () => {
    const p = project()
    const before = p.disk['tasks/todo.md']!
    for (const [action, args] of [['start', { id: 'T3' }], ['tick', { id: 'T2', index: 1 }], ['claim', { id: 'T4' }]] as const) {
      expect((await run(p, action, args)).status).toBe(200)
    }
    const after = p.disk['tasks/todo.md']!
    expect(after.startsWith('# Tasks: API keys\n')).toBe(true)
    expect(after).not.toContain('created:')
    const states = parseTasks(after).tasks.map(t => [t.id, t.state?.status ?? null])
    expect(states).toEqual([['T1', null], ['T2', 'in progress'], ['T3', 'in progress'], ['T4', 'todo']])
    // Three Status lines added, one box ticked, nothing else.
    expect(after.split('\n').length).toBe(before.split('\n').length + 3)
  })

  test('a bad handle from a text field gets 400 saying what is wrong with it', async () => {
    const p = project()
    const r = await run(p, 'handoff', { id: 'T2', to: 'bob smith', note: 'x' })
    expect([r.status, r.json.reply]).toEqual([400, '"bob smith" is not a handle. Handles are one word, like @sara.'])
    expect(p.writes).toEqual([])
  })
})


// team-view T12: /progress dashboard live starts the CLI's --serve as the session's child.
test('serveArgv runs --serve on a free port and unopened for the plugin, and as a person types it otherwise', () => {
  expect(serveArgv('/plug/scripts/agent-skills-progress.mjs', '/p', 'child')).toEqual([
    'node', '--experimental-strip-types', '/plug/scripts/agent-skills-progress.mjs', '/p', '--serve', '--port', '0', '--no-open',
  ])
  expect(serveArgv('/plug/scripts/agent-skills-progress.mjs', '/p', 'person')).toEqual(['node', '--experimental-strip-types', '/plug/scripts/agent-skills-progress.mjs', '/p', '--serve'])
})

test('shellLine quotes only the words that need it', () => {
  expect(shellLine(['node', '/a/b.mjs', '/p', '--serve'])).toBe('node /a/b.mjs /p --serve')
  expect(shellLine(['node', "/My Files/it's.mjs", '--serve'])).toBe(`node '/My Files/it'\\''s.mjs' --serve`)
})

test('servedUrl reads the address off --serve\'s first line, once the whole line has come', () => {
  expect(servedUrl('')).toBeNull()
  expect(servedUrl('Serving /p at http://127.0.0.1:5012')).toBeNull()
  expect(servedUrl('Serving /my p at http://127.0.0.1:50123/?token=ab12\nOnly this machine can reach it')).toBe('http://127.0.0.1:50123/?token=ab12')
  expect(servedUrl('Serving /p at http://example.com/?token=x\n')).toBeNull()
})

test('nodeTooOld: older than 22.6 is too old; an answer it can\'t read is left to the start to judge', () => {
  expect(nodeTooOld('v20.11.0\n')).toBe(true)
  expect(nodeTooOld('v22.5.9')).toBe(true)
  expect(nodeTooOld('v22.6.0')).toBe(false)
  expect(nodeTooOld('v24.1.0')).toBe(false)
  expect(nodeTooOld('bun 1.2')).toBe(false)
})
