// Sample files in the shapes agent-skills writes (planning and spec skill templates).

export const TODO_TEMPLATE = `# Tasks: API keys

## Phase 1: Foundation

## Task 1: Monorepo scaffold

**Description:** pnpm workspaces and lint.

**Acceptance criteria:**
- [x] Workspace builds
- [x] Lint passes

**Verification:**
- [x] Tests pass: \`pnpm test\`

**Dependencies:** None

## Task 2: Prisma schema for keys

**Acceptance criteria:**
- [x] Key table with hashed secret
- [ ] Migration runs on a clean database

**Verification:**
- [ ] Tests pass: \`pnpm test keys\`

**Dependencies:** Task 1

## Checkpoint: After Tasks 1-2
- [ ] All tests pass
- [ ] Review with human before proceeding

## Phase 2: Core

## Task 3: Issue and revoke keys

**Acceptance criteria:**
- [ ] POST /keys returns the secret once

**Dependencies:** Task 2

## Task 4: Rate limit per key

**Acceptance criteria:**
- [ ] 60 requests per minute by default

**Dependencies:** 1
`

export const PLAN_INDEX = `# Implementation Plan: Notifications

## Overview
Email and in-app notifications.

## Task List

### Phase 1: Foundation
- [x] Task 1: Notification model
- [x] Task 2: Queue worker

### Checkpoint: Foundation
- [x] Tests pass, builds clean

### Phase 2: Core Features
- [ ] Task 3: Email channel
- [ ] Task 4: In-app channel

### Checkpoint: Core Features
- [ ] End-to-end flow works

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Spam | High | Rate limits |

## Open Questions
- Upstash or self-hosted Redis?
`

export const CHECKLIST = `# TODO
- [x] set up repo
- [ ] write the parser
- [ ] ship it
`

/** Every A2 rule trips once: vague criterion, prose-only commands, style without a snippet. */
export const WEAK_SPEC = `# Spec: Webhooks

## Objective
Customers get events pushed to their own URL.

## Commands
Run the dev server and the tests.

## Project Structure
services/gateway/src/webhooks

## Code Style
camelCase, small functions.

## Testing Strategy
Vitest.

## Boundaries
- Always: sign payloads

## Success Criteria
- Delivery is reliable
- Failed deliveries retry 5 times with backoff
`

/** Objective carries its own criteria list; every rule passes. */
export const GOOD_SPEC = `# Spec: Rate limits

## Objective
Stop one key from starving the others.

Success criteria:
- 60 requests per minute per key by default
- Over the limit returns 429 with Retry-After

## Commands
- \`pnpm --filter gateway test\`

## Code Style
\`\`\`ts
export const limitFor = (key: ApiKey) => key.plan.rpm ?? DEFAULT_RPM
\`\`\`
`

const tick = (text: string, ...boxes: string[]) => boxes.reduce((t, b) => t.replace(`- [ ] ${b}`, `- [x] ${b}`), text)
/** T2 finished: the checkpoint after it is reached. */
export const TODO_T2_DONE = tick(TODO_TEMPLATE, 'Migration', 'Tests pass: `pnpm test keys`')
/** Checkpoint ticked too. */
export const TODO_CP_DONE = tick(TODO_T2_DONE, 'All tests pass', 'Review with human')
/** And T3 finished. */
export const TODO_T3_DONE = tick(TODO_CP_DONE, 'POST /keys')

export const SPEC = `---
status: draft
---
# Spec: API keys

## Objective
Developers create and revoke API keys from the console.

## Tech Stack
NestJS, Prisma, Postgres.

## Commands
\`\`\`
pnpm dev:gateway
pnpm test
\`\`\`

## Project Structure
[Where code lives]

## Testing Strategy
Vitest unit tests; one e2e per endpoint.

## Boundaries
- Always: run tests before commits, validate inputs
- Ask first: database schema changes
- Never: commit secrets, log API keys

## Open Questions
- Should keys expire by default?
`

/** No box ticked: the plan as it was first committed. */
export const TODO_NONE_DONE = TODO_TEMPLATE.replace(/- \[x\]/g, '- [ ]')

/** The two git calls' output for copies of a file, newest first: `[day, text]`, text null where the file is missing. */
export function gitOutput(copies: [string, string | null][]) {
  const hash = (i: number) => `${i}`.padStart(40, 'a')
  const log = copies.map(([day], i) => `${hash(i)} ${Date.parse(`${day}T12:00:00Z`) / 1000}`).join('\n') + '\n'
  const cat = copies
    .map(([, text], i) => (text === null ? `${hash(i)}:./tasks/todo.md missing\n` : `@@asm blob\n${text}\n`))
    .join('')
  return { log, cat }
}

/** A Raster's packed cells as rows of glyphs and the matching rows of [fg, bg]. */
export function decodeCells(cells: string, columns: number) {
  const bin = atob(cells)
  const view = new DataView(Uint8Array.from(bin, c => c.charCodeAt(0)).buffer)
  const glyphs: string[] = []
  const colors: [number, number][][] = []
  for (let i = 0; i < bin.length / 12; i++) {
    const [g, fg, bg] = [0, 4, 8].map(o => view.getUint32(i * 12 + o, true))
    const r = Math.floor(i / columns)
    glyphs[r] = (glyphs[r] ?? '') + String.fromCodePoint(g!)
    ;(colors[r] ??= []).push([fg!, bg!])
  }
  return { glyphs, colors }
}
