import { describe, expect, test } from 'claude-code/testing'
import { agentSkillsStatus, AGENT_SKILLS_INSTALL, inInstalled, inListing, noticeLine, setupText } from '../packages/core/requires'

const INSTALLED = (keys: string[]) => JSON.stringify({ version: 2, plugins: Object.fromEntries(keys.map(k => [k, [{ scope: 'user' }]])) })

describe('agent-skills requirement', () => {
  test('the listing has agent-skills by its plugin, or by three of its skills copied in', () => {
    expect(inListing([{ name: 'agent-skills:spec-driven-development', pluginName: 'agent-skills' }])).toBe(true)
    expect(inListing([{ name: 'spec-driven-development' }, { name: 'planning-and-task-breakdown' }, { name: 'incremental-implementation' }])).toBe(true)
    expect(inListing([{ name: 'spec-driven-development' }, { name: 'pdf' }])).toBe(false)
    expect(inListing([])).toBe(false)
    expect(inListing(null)).toBeNull()
  })

  test('installed_plugins.json lists agent-skills from any marketplace', () => {
    expect(inInstalled(INSTALLED(['agent-skills@addy-agent-skills', 'agent-skills-mods@agent-skills-mods']))).toBe(true)
    expect(inInstalled(INSTALLED(['agent-skills@my-fork']))).toBe(true)
    expect(inInstalled(INSTALLED(['agent-skills-mods@agent-skills-mods']))).toBe(false)
    expect(inInstalled('not json')).toBeNull()
    expect(inInstalled(null)).toBeNull()
  })

  test('the listing wins; installed but unlisted is turned off; neither source is unknown', () => {
    expect(agentSkillsStatus(true, false)).toBe('present')
    expect(agentSkillsStatus(false, true)).toBe('disabled')
    expect(agentSkillsStatus(false, null)).toBe('missing')
    expect(agentSkillsStatus(null, true)).toBe('present')
    expect(agentSkillsStatus(null, false)).toBe('missing')
    expect(agentSkillsStatus(null, null)).toBe('unknown')
    expect(noticeLine('present')).toBeNull()
    expect(noticeLine('unknown')).toBeNull()
  })

  test('setup lists the install steps, then the one next step', () => {
    const none = { spec: false, plan: false, todo: false, format: false, team: false }
    const missing = setupText('missing', none)
    for (const c of AGENT_SKILLS_INSTALL) expect(missing).toContain(c)
    expect(missing).toMatch(/Next: install agent-skills/)
    expect(setupText('present', none)).toMatch(/Next: run \/spec/)
    expect(setupText('present', { ...none, spec: true })).toMatch(/Next: run \/plan/)
    expect(setupText('present', { ...none, spec: true, plan: true, todo: true })).toMatch(/Next: run \/progress format/)
    expect(setupText('present', { spec: true, plan: true, todo: true, format: true, team: false })).toMatch(/All set/)
  })
})
