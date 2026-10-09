// /progress archive: a finished or abandoned plan moved out of the way, so the
// next /plan starts clean and the old one stays readable. Pure.

import { planName } from './format'

/** `tasks/archive/2026-10-10-api-keys`, numbered when that folder is taken. */
export function archiveDir(today: string, todoText: string | null, planText: string | null, taken: string[]): string {
  const name = (todoText && planName(todoText)) || (planText && planName(planText)) || 'plan'
  const base = `${today}-${name}`
  let dir = base
  for (let n = 2; taken.includes(dir); n++) dir = `${base}-${n}`
  return `tasks/archive/${dir}`
}

/** The index a plan's archive folder starts with: what it was, how far it got, where its files are. */
export function archiveReadme(input: { dir: string; today: string; name: string; done: number; total: number; files: string[]; open: string[] }): string {
  const lines = [
    `# Archived plan: ${input.name}`,
    '',
    `Archived ${input.today} with ${input.done} of ${input.total} tasks done.`,
    '',
    ...input.files.map(f => `- [${f}](${f})`),
  ]
  if (input.open.length) lines.push('', '## Left open', '', ...input.open.map(t => `- ${t}`))
  return `${lines.join('\n')}\n`
}
