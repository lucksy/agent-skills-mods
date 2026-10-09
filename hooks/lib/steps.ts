// The build loop in plan terms (H3, F1): which step of incremental
// implementation a tool call is, read from the call alone.

export type Step = 'build' | 'test' | 'commit'

const TEST = /(^|[\s;&|(])((npx|pnpm|yarn|bunx?|npm)\s+(run\s+)?(\S+\s+)*test\b|vitest|jest|pytest|mocha|playwright\s+test|go\s+test|cargo\s+test|rspec|phpunit|make\s+test)/
const COMMIT = /(^|[\s;&|(])git\s+(-\S+\s+)*commit\b/
/** Files that hold the plan itself: editing them is bookkeeping, not building. */
const PLAN_FILES = /(^|[\\/])(SPEC(-[\w.-]+)?\.md|tasks[\\/][^\\/]+\.md)$/
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** The step a tool call is, or null for one that is none of build, test and commit. */
export function stepOf(tool: string, input: { command?: unknown; file_path?: unknown; notebook_path?: unknown }): Step | null {
  if (tool === 'Bash' && typeof input.command === 'string') {
    if (COMMIT.test(input.command)) return 'commit'
    if (TEST.test(input.command)) return 'test'
    return null
  }
  const path = input.file_path ?? input.notebook_path
  if (EDIT_TOOLS.has(tool) && typeof path === 'string') return PLAN_FILES.test(path) ? null : 'build'
  return null
}

const VERB: Record<Step, string> = { build: 'Building', test: 'Testing', commit: 'Committing' }

/**
 * The spinner's word: `Building T4` once the turn took a step, `Working on T4`
 * before it has, the verb alone with no plan, and null with neither.
 */
export function spinnerWord(step: Step | null, task: string | null): string | null {
  if (step) return task ? `${VERB[step]} ${task}` : VERB[step]
  return task ? `Working on ${task}` : null
}
