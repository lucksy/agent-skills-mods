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
