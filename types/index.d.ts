// State this mod keeps for the session. Plain JSON data; the shapes are the parser's
// (hooks/lib/parse.ts) and the forecast's (hooks/lib/forecast.ts).

export type AsmBox = { text: string; isDone: boolean }
export type AsmCheckpoint = { title: string; items: AsmBox[] }
export type AsmTask = {
  id: string
  title: string
  phase: string | null
  boxes: AsmBox[]
  deps: string[]
  status: 'done' | 'next' | 'todo' | 'blocked'
  checkpoint: AsmCheckpoint | null
}
export type AsmTaskList = {
  kind: 'tasks' | 'checklist' | 'empty'
  tasks: AsmTask[]
  checkpoints: AsmCheckpoint[]
  done: number
  total: number
  current: AsmTask | null
}
export type AsmSpec = {
  title: string | null
  status: 'draft' | 'approved' | null
  areas: { key: string; label: string; state: 'present' | 'empty' | 'missing'; body: string; hint: string | null }[]
  boundaries: { always: string[]; ask: string[]; never: string[] }
  successCriteria: string[]
  openQuestions: string[]
}
export type AsmPlan = { trackedIn: string | null; openQuestions: string[] }
export type AsmForecast =
  | { kind: 'done' }
  | { kind: 'not-enough'; reason: string }
  | { kind: 'range'; optimistic: string; median: string; slow: string; basis: string; added: number }

export type AsmProject = {
  cwd: string
  spec: AsmSpec | null
  list: AsmTaskList | null
  /** The file the task list came from: tasks/todo.md, else tasks/plan.md. */
  listFile: string | null
  plan: AsmPlan | null
  forecast: AsmForecast | null
  /** Where the history behind the forecast starts: rebuilt from git, or from the day the mod first saw the plan. */
  history:
    | { source: 'git'; days: number; since: string }
    | { source: 'none'; reason: string; since: string }
    | null
  /** One per day, oldest first: what the charts draw (F2). */
  snapshots: { day: string; done: number; total: number; doing?: number; blocked?: number }[]
  /** By task id: the day it was done, or the day the forecast expects it (F1). */
  dates: Record<string, { day: string; isEstimate: boolean }>
  /** The spec file shown (A3), and every spec file at the root: SPEC.md first, then SPEC-<id>.md. */
  specFile: string | null
  specFiles: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-skills-mods': {
      project: AsmProject | null
      stage: 'spec' | 'plan' | 'build' | 'test' | 'review' | 'ship' | null
      allowOverwrite: boolean
      focus: string | null
      step: { step: 'build' | 'test' | 'commit'; task: string | null } | null
      failed: string | null
      specChoice: string | null
    }
  }
}
