import { describe, expect, test } from 'claude-code/testing'

import {
  addAttributes,
  addDriverConfig,
  ATTRIBUTE_LINES,
  driverCommand,
  driverReport,
  driverScript,
  driverStatus,
  driverStatusText,
  mergeByPath,
  mergeKind,
  readDriver,
  removeAttributes,
  removeDriverConfig,
} from '../packages/core/mergedriver'

// team-view T8: the merge driver's pure half. The real `git merge` is in scripts/test.sh.

describe('mergeByPath', () => {
  test('picks the merge by the path git hands in', () => {
    expect(mergeKind('tasks/todo.md')).toBe('todo')
    expect(mergeKind('tasks/backlog.md')).toBe('backlog')
    expect(mergeKind('tasks/plan.md')).toBe('doc')
    expect(mergeKind('SPEC.md')).toBe('doc')
    expect(mergeKind('SPEC-team-view.md')).toBe('doc')
    expect(mergeKind('specs/auth.md')).toBe('doc')
    expect(mergeKind('README.md')).toBe('lines')
    expect(mergeKind('docs/tasks/todo.md')).toBe('lines')
  })

  test('a task list merges by task: boxes ticked on both sides, no markers', () => {
    const base = '## Task 1: A\n**Status:** todo\n- [ ] one\n- [ ] two\n'
    const ours = base.replace('- [ ] one', '- [x] one')
    const theirs = base.replace('- [ ] two', '- [x] two')
    const r = mergeByPath('tasks/todo.md', base, ours, theirs)
    expect(r).toEqual({ text: '## Task 1: A\n**Status:** todo\n- [x] one\n- [x] two\n', conflicts: [], renumbered: [] })
  })

  test('a spec merges approvals by role, its status worked out from the required roles; a plan never is', () => {
    const base = '---\nstatus: draft\n---\n# Spec\n'
    const ours = '---\nstatus: draft\napprovals: pm @a 2026-10-01\n---\n# Spec\n'
    const theirs = '---\nstatus: draft\napprovals: eng @b 2026-10-02\n---\n# Spec\n'
    const spec = mergeByPath('SPEC.md', base, ours, theirs, { required: ['pm', 'eng'] })
    expect(spec.conflicts).toEqual([])
    expect(spec.text).toContain('status: approved')
    expect(spec.text).toContain('approvals: pm @a 2026-10-01, eng @b 2026-10-02')
    expect(mergeByPath('tasks/plan.md', base, ours, theirs, { required: ['pm', 'eng'] }).text).not.toContain('status: approved')
  })

  test('any other file goes to the line merge alone; the report names renumbers and conflicts', () => {
    const r = mergeByPath('README.md', 'a\n', 'b\n', 'c\n')
    expect(r.conflicts).toEqual(['both sides changed the same lines'])
    expect(r.text).toBe('<<<<<<< ours\nb\n=======\nc\n>>>>>>> theirs\n')
    expect(driverReport('tasks/todo.md', { text: '', conflicts: ['T2: deleted in ours, changed in theirs'], renumbered: [['T3', 'T5']] })).toEqual([
      'tasks/todo.md: T3 (theirs) is now T5',
      'tasks/todo.md: T2: deleted in ours, changed in theirs',
    ])
  })
})

describe('.gitattributes', () => {
  test('lines added once, after the rest, and removed again byte for byte', () => {
    for (const before of ['*.png binary\n', '', '# x\r\n']) {
      const after = addAttributes(before)
      expect(after.startsWith(before)).toBe(true)
      expect(addAttributes(after)).toBe(after)
      expect(removeAttributes(after)).toBe(before === '' ? null : before)
    }
    expect(addAttributes(null)).toBe(`${ATTRIBUTE_LINES.join('\n')}\n`)
    expect(addAttributes('*.png binary')).toBe(`*.png binary\n${ATTRIBUTE_LINES.join('\n')}\n`)
  })
})

describe('.git/config', () => {
  const CONFIG = '[core]\n\tbare = false\n[branch "main"]\n\tremote = origin\n'
  test('the section added after the rest and removed whole, the rest kept', () => {
    const after = addDriverConfig(CONFIG, '/opt/p/scripts/agent-skills-progress.mjs')
    expect(after).toBe(`${CONFIG}[merge "agent-skills"]\n    name = agent-skills task-aware merge\n    driver = node /opt/p/scripts/agent-skills-progress.mjs --merge %O %A %B %P\n`)
    expect(removeDriverConfig(after)).toBe(CONFIG)
    // Installed again with a new path: one section, the new path.
    const moved = addDriverConfig(after, '/new/scripts/agent-skills-progress.mjs')
    expect(moved.match(/\[merge "agent-skills"\]/g)).toHaveLength(1)
    expect(driverStatus(null, moved).script).toBe('/new/scripts/agent-skills-progress.mjs')
    // In the middle of the file, the sections after it stay.
    const middle = `[core]\n\tbare = false\n[merge "agent-skills"]\n\tdriver = x\n[user]\n\tname = a\n`
    expect(removeDriverConfig(middle)).toBe('[core]\n\tbare = false\n[user]\n\tname = a\n')
  })

  test('paths with spaces, quotes, ; or # are quoted for the shell and for git, and read back', () => {
    for (const path of ['/a b/x.mjs', "/it's/x.mjs", '/a;b#c/x.mjs', '/q"uote\\/x.mjs']) {
      const config = addDriverConfig('', path)
      expect(driverStatus(null, config).script).toBe(path)
      expect(readDriver(config)).toBe(driverCommand(path))
    }
    expect(driverCommand('/a b/x.mjs')).toBe("node '/a b/x.mjs' --merge %O %A %B %P")
    expect(driverScript('cat %A')).toBe(null)
  })
})

// ceremonies T4: the backlog merges item by item, and a deferred number is never given out again.
describe('the backlog in the merge (ceremonies T4)', () => {
  const BASE = '# Backlog\n\n## B1: Docs\n- [ ] x\n'

  test('backlog add on both sides: both items, distinct B ids, no markers', () => {
    const ours = `${BASE}\n## B2: Quotas\n**Size:** L\n`
    const theirs = `${BASE}\n## B2: Audit export\n`
    const r = mergeByPath('tasks/backlog.md', BASE, ours, theirs)
    expect(r).toEqual({ text: `${BASE}\n## B2: Quotas\n**Size:** L\n\n## B3: Audit export\n`, conflicts: [], renumbered: [['B2', 'B3']] })
    expect(driverReport('tasks/backlog.md', r)).toEqual(['tasks/backlog.md: B2 (theirs) is now B3'])
  })

  test('an item\'s Dependencies name tasks, so a renumbered item leaves them alone', () => {
    const ours = `${BASE}\n## B2: Quotas\n**Dependencies:** T2\n`
    const theirs = `${BASE}\n## B2: Audit export\n**Dependencies:** T2\n`
    expect(mergeByPath('tasks/backlog.md', BASE, ours, theirs).text).toContain('## B3: Audit export\n**Dependencies:** T2\n')
  })

  test('a task number taken on both sides skips the numbers the backlog records as old ones', () => {
    const base = '## Task 1: A\n- [ ] a\n'
    const ours = `${base}\n## Task 2: B\n- [ ] b\n`
    const theirs = `${base}\n## Task 2: C\n- [ ] c\n`
    expect(mergeByPath('tasks/todo.md', base, ours, theirs).renumbered).toEqual([['T2', 'T3']])
    expect(mergeByPath('tasks/todo.md', base, ours, theirs, { reserved: [3, 4] }).renumbered).toEqual([['T2', 'T5']])
  })

  test('install adds the backlog line; status names an install from before it', () => {
    expect(ATTRIBUTE_LINES).toContain('tasks/backlog.md merge=agent-skills')
    const old = ATTRIBUTE_LINES.slice(0, 4).join('\n') + '\n'
    const config = addDriverConfig(null, '/x/agent-skills-progress.mjs')
    expect(driverStatusText(driverStatus(old, config), true)).toBe(
      'Installed before the driver merged the backlog: .gitattributes has no tasks/backlog.md line, so git merges tasks/backlog.md line by line.\n/progress merge-driver install puts it right (it asks first).',
    )
    expect(addAttributes(old)).toBe(`${old}tasks/backlog.md merge=agent-skills\n`)
  })
})
