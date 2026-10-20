// Whether agent-skills, the workflow this plugin reads, is there: from the
// session's skill listing and Claude Code's installed_plugins.json. Pure: the
// hooks module does the reading.

import { SKILL_STAGE } from './view'

/** agent-skills is installed and on, installed but turned off, not installed, or not known. */
export type AgentSkills = 'present' | 'disabled' | 'missing' | 'unknown'

/** One skill of the session's listing, as the context breakdown gives it. */
export type ListedSkill = { name: string; pluginName?: string }

/** agent-skills' own marketplace and plugin names, from its .claude-plugin/marketplace.json. */
export const AGENT_SKILLS_MARKETPLACE = 'addyosmani/agent-skills'
export const AGENT_SKILLS_PLUGIN = 'agent-skills@addy-agent-skills'

/** What to type, in order, at a Claude Code prompt. */
export const AGENT_SKILLS_INSTALL = [`/plugin marketplace add ${AGENT_SKILLS_MARKETPLACE}`, `/plugin install ${AGENT_SKILLS_PLUGIN}`, '/reload-plugins'] as const

/** The same from a shell. */
export const AGENT_SKILLS_SHELL = `claude plugin marketplace add ${AGENT_SKILLS_MARKETPLACE} && claude plugin install ${AGENT_SKILLS_PLUGIN}`

/**
 * Whether the listing has agent-skills: a skill from the plugin itself, or at
 * least three of its skills by name (copied in as user or project skills).
 * Null when there is no listing.
 */
export function inListing(skills: readonly ListedSkill[] | null | undefined): boolean | null {
  if (!skills) return null
  if (skills.some(s => s.pluginName === 'agent-skills')) return true
  const known = new Set(skills.map(s => s.name.replace(/^agent-skills:/, '')).filter(n => n in SKILL_STAGE))
  return known.size >= 3
}

/** Whether installed_plugins.json lists agent-skills from any marketplace; null when it can't be read. */
export function inInstalled(json: string | null | undefined): boolean | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as { plugins?: Record<string, unknown> }
    if (!parsed || typeof parsed !== 'object' || !parsed.plugins || typeof parsed.plugins !== 'object') return null
    return Object.keys(parsed.plugins).some(k => k.split('@')[0] === 'agent-skills')
  } catch {
    return null
  }
}

/**
 * The verdict from both sources. The listing says what the session can use, so
 * it wins when present; installed but absent from it is turned off. With
 * neither readable it is unknown, and nothing is said.
 */
export function agentSkillsStatus(listing: boolean | null, installed: boolean | null): AgentSkills {
  if (listing === true) return 'present'
  if (listing === false) return installed === true ? 'disabled' : 'missing'
  if (installed === true) return 'present'
  if (installed === false) return 'missing'
  return 'unknown'
}

/** The band's one line for a status that needs the person, or null. */
export function noticeLine(status: AgentSkills): string | null {
  if (status === 'missing') return 'agent-skills isn’t installed. This board shows the spec, plan and tasks its skills write.'
  if (status === 'disabled') return 'agent-skills is installed but turned off, so its skills won’t write the spec, plan and tasks this board shows.'
  return null
}

/** What /progress setup says about agent-skills: a line, and the steps when something is needed. */
export function requirementLines(status: AgentSkills): string[] {
  if (status === 'present') return ['✓ agent-skills is installed']
  if (status === 'unknown') return ['? agent-skills: couldn’t tell from here. If /spec and /plan aren’t available, install it:', ...AGENT_SKILLS_INSTALL.map(c => `    ${c}`)]
  if (status === 'disabled') return ['✗ agent-skills is installed but turned off', '    Turn it on in /plugin, then /reload-plugins']
  return [
    '✗ agent-skills isn’t installed. This plugin reads what its skills write.',
    '    At this prompt:',
    ...AGENT_SKILLS_INSTALL.map(c => `      ${c}`),
    `    Or from a shell: ${AGENT_SKILLS_SHELL}`,
  ]
}

/** The files the board reads, present or not, for /progress setup. */
export type SetupFiles = { spec: boolean; plan: boolean; todo: boolean; format: boolean; team: boolean }

/** The whole /progress setup checklist, ending with the one next step. */
export function setupText(status: AgentSkills, f: SetupFiles): string {
  const mark = (ok: boolean) => (ok ? '✓' : '○')
  const lines = [
    'agent-skills-mods setup',
    '',
    ...requirementLines(status),
    `${mark(f.spec)} SPEC.md${f.spec ? '' : ' (written by /spec)'}`,
    `${mark(f.plan)} tasks/plan.md${f.plan ? '' : ' (written by /plan)'}`,
    `${mark(f.todo)} tasks/todo.md${f.todo ? '' : ' (written by /plan)'}`,
    `${mark(f.format)} progress format${f.format ? '' : ' (/progress format adds status lines and dates)'}`,
    `${mark(f.team)} tasks/team.md${f.team ? '' : ' (optional, for a team: /progress team init)'}`,
    '',
  ]
  const next =
    status === 'missing' || status === 'disabled'
      ? 'Next: install agent-skills with the commands above.'
      : !f.spec
        ? 'Next: run /spec to write the spec.'
        : !f.todo
          ? 'Next: run /plan to break the spec into tasks.'
          : !f.format
            ? 'Next: run /progress format, then /progress to open the board.'
            : 'All set. /progress opens the board.'
  return [...lines, next].join('\n')
}
