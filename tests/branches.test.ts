import { describe, expect, test } from 'claude-code/testing'

import { branchRows, branchesText, fetchAge, MAX_REFS, parseRefs, pickRefs, readBranches, REFS_ARGV, type Ref } from '../packages/core/branches'
import { collisionLine, collisionOf, collisions } from '../packages/core/collisions'
import { parseTasks } from '../packages/core/parse'
import { buildState, stateJson, type ProjectIo } from '../packages/core/state'

// team-view T3 (V1): the board across branches, from git objects already here.

const NOW = Date.parse('2026-10-11T12:00:00Z')
const DAY = 86_400_000
const sec = (ms: number) => Math.floor(ms / 1000)

const todo = (states: (string | null)[]) =>
  states.map((s, i) => `## Task ${i + 1}: Task ${i + 1}\n${s === null ? '' : `**Status:** ${s}\n`}- [ ] box\n`).join('\n')

const HERE = todo(['done · started 2026-10-01 · done 2026-10-02', 'in progress · @amila · started 2026-10-10', null, null])
const FEAT = todo(['done · started 2026-10-01 · done 2026-10-02', 'done · @amila · started 2026-10-10 · done 2026-10-11', 'in review · @bob · started 2026-10-09', null])
const OLD = todo(['in progress', null, null, 'blocked · @sara'])

describe('which refs count as the team (Q2)', () => {
  const refsOut = [
    `refs/heads/main\t${'a'.repeat(40)}\t${sec(NOW)}`,
    `refs/heads/feat/keys\t${'b'.repeat(40)}\t${sec(NOW - DAY)}`,
    `refs/heads/ancient\t${'c'.repeat(40)}\t${sec(NOW - 90 * DAY)}`,
    `refs/remotes/origin/HEAD\t${'a'.repeat(40)}\t${sec(NOW)}`,
    `refs/remotes/origin/feat/keys\t${'b'.repeat(40)}\t${sec(NOW - DAY)}`,
    `refs/remotes/origin/feat/rate-limit\t${'d'.repeat(40)}\t${sec(NOW - 2 * DAY)}`,
    `refs/remotes/origin/stale\t${'e'.repeat(40)}\t${sec(NOW - 31 * DAY)}`,
    'not a ref line',
  ].join('\n')

  test('parses for-each-ref lines into short names', () => {
    const refs = parseRefs(refsOut)
    expect(refs.map(r => r.name)).toEqual(['main', 'feat/keys', 'ancient', 'origin/HEAD', 'origin/feat/keys', 'origin/feat/rate-limit', 'origin/stale'])
    expect(refs[4]!.remote).toBe(true)
    expect(refs[1]!.ms).toBe(sec(NOW - DAY) * 1000)
  })

  test('local branches, then remotes from the last 30 days; the current commit, remote HEAD and repeats skipped', () => {
    const picked = pickRefs(parseRefs(refsOut), 'a'.repeat(40), NOW)
    expect(picked.map(r => r.name)).toEqual(['feat/keys', 'ancient', 'origin/feat/rate-limit'])
  })

  test('at most 25 refs', () => {
    const many: Ref[] = Array.from({ length: 40 }, (_, i) => ({ ref: `refs/heads/b${i}`, name: `b${i}`, sha: `${i}`.padStart(40, 'f'), ms: NOW, remote: false }))
    expect(pickRefs(many, null, NOW)).toHaveLength(MAX_REFS)
  })

  test('only for-each-ref: nothing that fetches', () => {
    expect(REFS_ARGV.slice(0, 2)).toEqual(['git', 'for-each-ref'])
  })
})

describe('the rows (furthest state per task)', () => {
  const ref = (name: string, sha: string, remote = false): Ref => ({ ref: `refs/heads/${name}`, name, sha, ms: NOW, remote })

  test('each task shows its furthest state, the ref it is on and its owner; a ref without the file is skipped', () => {
    const b = branchRows(
      { name: 'main', list: parseTasks(HERE) },
      [
        { ref: ref('origin/feat/keys', '1', true), text: FEAT },
        { ref: ref('old', '2'), text: OLD },
        { ref: ref('docs', '3'), text: null },
      ],
      NOW - 2 * DAY,
    )
    expect(b.rows.map(r => [r.id, r.state, r.ref, r.owner])).toEqual([
      ['T1', 'done', 'main', null],
      ['T2', 'done', 'origin/feat/keys', '@amila'],
      ['T3', 'in review', 'origin/feat/keys', '@bob'],
      ['T4', 'blocked', 'old', '@sara'],
    ])
    expect(b.rows[2]!.on.map(o => `${o.ref}:${o.state}`)).toEqual(['main:todo', 'origin/feat/keys:in review', 'old:todo'])
    expect(b.refs.map(r => [r.name, r.hasFile])).toEqual([['origin/feat/keys', true], ['old', true], ['docs', false]])
  })

  test('todo everywhere names no ref', () => {
    const b = branchRows({ name: 'main', list: parseTasks(todo([null])) }, [{ ref: ref('x', '1'), text: todo([null]) }], null)
    expect(b.rows[0]).toMatchObject({ state: 'todo', ref: null })
  })

  test('the printed board: fetch age on remote rows, refs without the file listed', () => {
    const b = branchRows({ name: 'main', list: parseTasks(HERE) }, [{ ref: ref('origin/feat/keys', '1', true), text: FEAT }, { ref: ref('docs', '3'), text: null }], NOW - 2 * DAY)
    const text = branchesText(b, NOW)
    expect(text.split('\n')).toEqual([
      'Board across branches · main + 1 ref · fetched 2d ago',
      '✓ T1 Task 1 · done on main',
      '✓ T2 Task 2 · done on origin/feat/keys @amila (fetched 2d ago)',
      '◐ T3 Task 3 · in review on origin/feat/keys @bob (fetched 2d ago)',
      '○ T4 Task 4 · todo',
      'No tasks/todo.md on: docs.',
    ])
  })

  test('never fetched, and fetch ages in minutes and hours', () => {
    expect(fetchAge(null, NOW)).toBe('never fetched')
    expect(fetchAge(NOW - 5 * 60_000, NOW)).toBe('fetched 5m ago')
    expect(fetchAge(NOW - 3 * 3_600_000, NOW)).toBe('fetched 3h ago')
    expect(branchesText(branchRows({ name: 'main', list: null }, [], null), NOW)).toBe('Board across branches · main + 0 refs · never fetched\nNo tasks in tasks/todo.md on any branch.')
  })
})

/** A git that answers for-each-ref, rev-parse and cat-file from fake output, recording each call. */
function fakeGit(copies: Record<string, string | null>, opts: { truncate?: boolean } = {}) {
  const calls: string[][] = []
  const shas = Object.keys(copies)
  const run = async (argv: string[], o?: { stdin?: string }) => {
    calls.push(argv)
    const ok = (stdout: string, isStdoutTruncated = false) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated })
    if (argv[1] === 'for-each-ref') return ok(shas.map((s, i) => `refs/heads/b${i}\t${s}\t${sec(NOW)}`).join('\n') + '\n')
    if (argv[1] === 'rev-parse') return ok(`${'0'.repeat(40)}\nmain\n`)
    if (argv[1] === 'cat-file') {
      const lines = (o?.stdin ?? '').split('\n').filter(Boolean)
      const out = lines.map(l => {
        const text = copies[l.split(':')[0]!]
        return text === null || text === undefined ? `${l} missing\n` : `@@asm blob\n${text}\n`
      })
      return ok(out.join(''), !!opts.truncate)
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected', isStdoutTruncated: false }
  }
  return { run, calls }
}

describe('reading the refs through git', () => {
  test('one for-each-ref, one rev-parse and one cat-file; the cache skips refs already read', async () => {
    const a = 'a'.repeat(40)
    const c = 'c'.repeat(40)
    const git = fakeGit({ [a]: FEAT, [c]: null })
    const cache = new Map<string, string | null>()
    const b = await readBranches(git.run, { file: 'tasks/todo.md', now: NOW, here: parseTasks(HERE), fetchedAt: null, cache })
    expect(git.calls.map(c => c[1])).toEqual(['for-each-ref', 'rev-parse', 'cat-file'])
    expect(git.calls[2]).toEqual(['git', 'cat-file', '--batch=@@asm %(objecttype)'])
    expect(b!.here).toBe('main')
    expect(b!.rows.find(r => r.id === 'T3')).toMatchObject({ state: 'in review', ref: 'b0', owner: '@bob' })
    expect(b!.refs.map(r => r.hasFile)).toEqual([true, false])
    // Read again: nothing new to read.
    git.calls.length = 0
    await readBranches(git.run, { file: 'tasks/todo.md', now: NOW, here: parseTasks(HERE), fetchedAt: null, cache })
    expect(git.calls.map(c => c[1])).toEqual(['for-each-ref', 'rev-parse'])
    // No command that fetches, pulls or checks out.
    expect(git.calls.every(c => ['for-each-ref', 'rev-parse', 'cat-file', 'log'].includes(c[1]!))).toBe(true)
  })

  test('a cut read drops its partial last copy', async () => {
    const git = fakeGit({ ['a'.repeat(40)]: FEAT, ['b'.repeat(40)]: OLD }, { truncate: true })
    const b = await readBranches(git.run, { file: 'tasks/todo.md', now: NOW, here: null, fetchedAt: null })
    expect(b!.refs.map(r => r.name)).toEqual(['b0'])
  })

  test('outside a git repository there is no board', async () => {
    const run = async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' })
    expect(await readBranches(run, { file: 'tasks/todo.md', now: NOW, here: null, fetchedAt: null })).toBeNull()
  })
})

describe('--json', () => {
  const io = (run?: ProjectIo['run']): ProjectIo => ({
    cwd: '/p',
    now: NOW,
    read: async rel => (rel === 'tasks/todo.md' ? HERE : null),
    list: async () => [],
    run,
    fetchedAt: async () => NOW - DAY,
  })

  test('branches is in State v1 when asked for, and null otherwise', async () => {
    const git = fakeGit({ ['a'.repeat(40)]: FEAT })
    const withBranches = stateJson(await buildState(io(git.run), { branches: true }))
    expect(withBranches.schema).toBe(1)
    expect(withBranches.branches?.fetchedAt).toBe(NOW - DAY)
    expect(withBranches.branches?.rows.find(r => r.id === 'T2')).toMatchObject({ state: 'done', ref: 'b0' })
    expect(stateJson(await buildState(io(git.run))).branches).toBeNull()
    expect(stateJson(await buildState(io(), { branches: true })).branches).toBeNull()
  })
})

// team-view T4 (V1): collisions, from the branch rows and the current list.

describe('collisions', () => {
  const ref = (name: string, sha: string, remote = false, ms = NOW - DAY): Ref => ({ ref: `refs/${remote ? 'remotes' : 'heads'}/${name}`, name, sha, ms, remote })
  const board = (here: string, theirs: { name: string; text: string; remote?: boolean; ms?: number }[]) =>
    branchRows({ name: 'main', list: parseTasks(here) }, theirs.map((t, i) => ({ ref: ref(t.name, `${i}`, t.remote, t.ms), text: t.text })), null)

  test('in progress on two branches is a collision, with each ref, owner and age', () => {
    const b = board(todo([null, 'in progress · @amila · started 2026-10-11']), [{ name: 'feat/rate-limit', text: todo([null, 'in progress · @bob · started 2026-10-09']) }])
    const found = collisions(b, NOW)
    expect(found.map(c => [c.id, c.why])).toEqual([['T2', ['under way', 'owners']]])
    expect(found[0]!.on.map(o => [o.ref, o.state, o.owner, o.age])).toEqual([
      ['main', 'in progress', '@amila', 'today'],
      ['feat/rate-limit', 'in progress', '@bob', '2d'],
    ])
    expect(collisionLine(found[0]!, 'main')).toBe('T2 is also in progress on feat/rate-limit by @bob (2d)')
  })

  test('in review on one branch and in progress on another, by the same owner, is a collision', () => {
    const b = board(todo(['in progress · @bob · started 2026-10-10']), [{ name: 'feat/x', text: todo(['in review · @bob · started 2026-10-08']) }])
    expect(collisions(b, NOW).map(c => [c.id, c.why])).toEqual([['T1', ['under way']]])
  })

  test('a branch cut while the task was under way carries the same claim: same owner, same start day, not a collision', () => {
    const b = board(todo(['in review · @amila · started 2026-10-10']), [{ name: 'feat/t2', text: todo(['in progress · @amila · started 2026-10-10']) }])
    expect(collisions(b, NOW)).toEqual([])
    const t = parseTasks(todo(['in progress · @amila · started 2026-10-10'])).tasks[0]!
    expect(collisionOf(t, b, NOW)).toBeNull()
  })

  test('an owner written in another case is the same person', () => {
    const b = board(todo(['in progress · @Amila · started 2026-10-10']), [{ name: 'feat/x', text: todo(['todo · @amila']) }])
    expect(collisions(b, NOW)).toEqual([])
  })

  test('two different owners is a collision, even when only one branch has started it', () => {
    const b = board(todo(['in progress · @amila · started 2026-10-10']), [{ name: 'feat/x', text: todo(['todo · @sara']) }])
    const [c] = collisions(b, NOW)
    expect(c?.why).toEqual(['owners'])
    // No Status date there: the age is the ref's newest commit.
    expect(collisionLine(c!, 'main')).toBe('T1 is also assigned to @sara on feat/x (1d)')
  })

  test('done on one branch while in progress on another is not a collision', () => {
    const b = board(todo(['in progress · @amila · started 2026-10-10']), [{ name: 'feat/x', text: todo(['done · @bob · started 2026-10-01 · done 2026-10-02']) }])
    expect(collisions(b, NOW)).toEqual([])
  })

  test('one branch and its own remote-tracking copy are one branch, not two', () => {
    const b = board(todo(['in progress · @amila · started 2026-10-10']), [{ name: 'origin/main', remote: true, text: todo(['in progress · @amila · started 2026-10-10']) }])
    expect(collisions(b, NOW)).toEqual([])
    const c = board(todo([null]), [
      { name: 'feat/x', text: todo(['in progress · @bob · started 2026-10-10']) },
      { name: 'origin/feat/x', remote: true, text: todo(['in progress · @bob · started 2026-10-09']) },
    ])
    expect(collisions(c, NOW)).toEqual([])
  })

  test('the current task as the working tree has it now, against the board read earlier', () => {
    // The board was read while T2 was still todo here; then T2 was started.
    const b = board(todo([null, null]), [{ name: 'feat/rate-limit', text: todo([null, 'in progress · @bob · started 2026-10-09']) }])
    expect(collisions(b, NOW)).toEqual([])
    const now = parseTasks(todo([null, 'in progress · @amila · started 2026-10-11']))
    const c = collisionOf(now.tasks[1]!, b, NOW)
    expect(c && collisionLine(c, b.here)).toBe('T2 is also in progress on feat/rate-limit by @bob (2d)')
    expect(collisionOf(now.tasks[0]!, b, NOW)).toBeNull()
    expect(collisionOf(now.tasks[1]!, null, NOW)).toBeNull()
  })

  test('--json lists collisions with the task, ref, owner and age', async () => {
    const io: ProjectIo = {
      cwd: '/p',
      now: NOW,
      read: async rel => (rel === 'tasks/todo.md' ? todo([null, 'in progress · @amila · started 2026-10-11']) : null),
      list: async () => [],
      run: fakeGit({ ['a'.repeat(40)]: todo([null, 'in review · @bob · started 2026-10-09']) }).run,
    }
    const json = stateJson(await buildState(io, { branches: true }))
    expect(json.collisions?.map(c => [c.id, c.on.map(o => [o.ref, o.owner, o.age])])).toEqual([
      ['T2', [['main', '@amila', 'today'], ['b0', '@bob', '2d']]],
    ])
    expect(stateJson(await buildState(io)).collisions).toBeNull()
  })
})
