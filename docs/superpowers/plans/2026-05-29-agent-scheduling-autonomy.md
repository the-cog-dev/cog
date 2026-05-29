# Agent Scheduling & Per-Project Autonomy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents create/list/cancel scheduled prompts at any agent in the project via MCP tools, gated by a per-project autonomy toggle (propose-to-inbox by default, fire-directly when enabled).

**Architecture:** Three new MCP tools call new hub HTTP routes. The routes use an injected `scheduleBridge` (main-process object holding the scheduler, agent map, and autonomy store) to decide: autonomy ON → `scheduler.create()` directly; OFF → create a `kind:'schedule'` proposal that reuses the existing `propose_team` → inbox → approve plumbing. Schedules gain a `createdBy` field for panel attribution. The autonomy flag is stored per-project in `.cog/cog.db`.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), Express (hub), better-sqlite3, `@modelcontextprotocol/sdk`, Zod, Vitest.

---

## File Structure

**Create:**
- `src/main/db/autonomy-store.ts` — per-project key/value settings store (reads/writes `autonomy` from `project_settings` table in `cog.db`).
- `src/renderer/components/AutonomySettings.tsx` — the per-project Autonomy section UI.
- `tests/unit/autonomy-store.test.ts`, `tests/unit/schedule-bridge-helpers.test.ts`, `tests/unit/hub-schedule-routes.test.ts`

**Modify:**
- `src/shared/types.ts` — `ScheduledPrompt.createdBy`, `CreateScheduleInput.createdBy`, `TeamProposal.kind`/`payload`, new `SchedulePayload` + `ProjectAutonomy` interfaces.
- `src/main/scheduler/schedules-store.ts` — persist `created_by`.
- `src/main/scheduler/prompt-scheduler.ts` — accept/persist `createdBy`.
- `src/main/scheduler/scheduler-helpers.ts` — `canAgentCancelSchedule()` + `validateAgentScheduleRequest()`.
- `src/main/db/proposals-store.ts` — persist `kind`/`payload`.
- `src/main/hub/proposals-channel.ts` — `createScheduleProposal()`; tag team proposals `kind:'team'`.
- `src/main/db/database.ts` — additive migrations.
- `src/main/hub/routes.ts` — `POST /schedules`, `GET /schedules`, `POST /schedules/:id/cancel`; new `scheduleBridge` param.
- `src/main/hub/server.ts` — thread `scheduleBridge` into `createRoutes`.
- `src/main/index.ts` — build `scheduleBridge`; branch `approveProposal` on `kind`; autonomy IPC handlers; pass `createdBy:'user'` on panel-created schedules.
- `src/mcp-server/index.ts` — `schedule_prompt`, `list_schedules`, `cancel_schedule` tools.
- `src/preload/index.ts`, `src/renderer/electron.d.ts` — `getAutonomy`/`setAutonomy`.
- `src/main/ipc-channels.ts` (or wherever `IPC` consts live) — `AUTONOMY_GET`/`AUTONOMY_SET`.
- `src/renderer/components/SettingsDialog.tsx` — render `<AutonomySettings/>`.
- `src/renderer/components/ScheduleRow.tsx` — creator badge.

**Constants:** `MIN_AGENT_INTERVAL_MINUTES = 5` (in `scheduler-helpers.ts`).

---

## Phase 1 — Data foundations

### Task 1: Schedule `createdBy` attribution

**Files:**
- Modify: `src/shared/types.ts` (`ScheduledPrompt`, `CreateScheduleInput`)
- Modify: `src/main/scheduler/schedules-store.ts`
- Modify: `src/main/scheduler/prompt-scheduler.ts:114-153`
- Modify: `src/main/db/database.ts:36-51` region (additive ALTER)
- Test: `tests/unit/schedules-store.test.ts` (existing)

- [ ] **Step 1: Add the failing test** to `tests/unit/schedules-store.test.ts`:

```ts
it('round-trips createdBy', () => {
  const store = new SchedulesStore(makeDb())  // reuse existing test db helper
  const s: ScheduledPrompt = {
    id: 'sch1', tabId: 'tab-default', agentId: 'a1', name: 'Sitrep',
    promptText: 'post sitrep', intervalMinutes: 40, durationHours: 6,
    startedAt: 1000, expiresAt: 1000 + 6 * 3600_000, nextFireAt: 1000 + 40 * 60_000,
    pausedAt: null, status: 'active', fireHistory: [], createdBy: 'orchestrator'
  }
  store.save(s)
  expect(store.load()[0].createdBy).toBe('orchestrator')
})
```

(If `tests/unit/schedules-store.test.ts` has no `makeDb` helper, copy the in-memory db setup used by the existing tests in that file.)

- [ ] **Step 2: Run it — expect FAIL** (`createdBy` not on type / not persisted)

Run: `npx vitest run tests/unit/schedules-store.test.ts --exclude "**/.claude/worktrees/**"`
Expected: FAIL (type error or `undefined`).

- [ ] **Step 3: Add `createdBy` to the types** in `src/shared/types.ts`:

In `ScheduledPrompt` (after `status: ScheduleStatus`):
```ts
  createdBy: string   // 'user' for panel-created, or the creator agent's name
```
In `CreateScheduleInput` (after `durationHours: number | null`):
```ts
  createdBy?: string  // defaults to 'user' when omitted
```

- [ ] **Step 4: Persist it in the store** (`src/main/scheduler/schedules-store.ts`):

Add `created_by: string` to `interface Row` (after `status`). Update the `INSERT` column list and `VALUES` (add `created_by` and one more `?`), and add to the `ON CONFLICT ... DO UPDATE SET` block:
```sql
  created_by = excluded.created_by
```
In `save()`, add `s.createdBy` as the final bound argument (matching the new column position). In `rowToSchedule`, add:
```ts
    createdBy: row.created_by ?? 'user',
```

- [ ] **Step 5: Add the migration** in `src/main/db/database.ts` (in the ALTER block near line 78):

```ts
try { db.exec("ALTER TABLE scheduled_prompts ADD COLUMN created_by TEXT") } catch { /* column exists */ }
```
Also add `created_by TEXT` to the `CREATE TABLE IF NOT EXISTS scheduled_prompts (...)` definition so fresh DBs have it.

- [ ] **Step 6: Default `createdBy` in the scheduler** (`src/main/scheduler/prompt-scheduler.ts`, inside `create()` when building the `schedule` object, after `fireHistory: []`):

```ts
      createdBy: input.createdBy && input.createdBy.trim() ? input.createdBy.trim() : 'user',
```

- [ ] **Step 7: Run tests — expect PASS**

Run: `npx vitest run tests/unit/schedules-store.test.ts tests/unit/prompt-scheduler.test.ts --exclude "**/.claude/worktrees/**"`
Expected: PASS (existing scheduler tests still green; new round-trip passes).

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/main/scheduler/schedules-store.ts src/main/scheduler/prompt-scheduler.ts src/main/db/database.ts tests/unit/schedules-store.test.ts
git commit -m "feat(scheduler): add createdBy attribution to scheduled prompts"
```

---

### Task 2: Proposal `kind` + `payload`

**Files:**
- Modify: `src/shared/types.ts` (`TeamProposal`, new `SchedulePayload`)
- Modify: `src/main/db/proposals-store.ts`
- Modify: `src/main/hub/proposals-channel.ts`
- Modify: `src/main/db/database.ts`
- Test: `tests/unit/proposals-store.test.ts` (create if absent)

- [ ] **Step 1: Add types** in `src/shared/types.ts`:

```ts
export interface SchedulePayload {
  targetAgentId: string
  targetAgentName: string
  tabId: string
  promptText: string
  intervalMinutes: number
  durationHours: number      // required for agent-created schedules (no infinite)
  name?: string
}
```
In `TeamProposal`, add after `tabId?: string`:
```ts
  kind: 'team' | 'schedule'
  payload?: SchedulePayload   // present when kind === 'schedule'
```

- [ ] **Step 2: Write the failing store test** in `tests/unit/proposals-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createDatabase } from '../../src/main/db/database'
import { ProposalsStore } from '../../src/main/db/proposals-store'
import type { TeamProposal } from '../../src/shared/types'

function db() { return createDatabase(':memory:') }

describe('ProposalsStore kind/payload', () => {
  it('round-trips a schedule proposal', () => {
    const store = new ProposalsStore(db())
    const p: TeamProposal = {
      id: 'p1', proposedBy: 'orchestrator', summary: 'sitrep loop', agents: [],
      status: 'pending', createdAt: new Date(0).toISOString(), kind: 'schedule',
      payload: { targetAgentId: 'a1', targetAgentName: 'sonnetworker2', tabId: 'tab-default',
                 promptText: 'post sitrep', intervalMinutes: 40, durationHours: 6 }
    }
    store.saveProposal(p)
    const got = store.getProposal('p1')!
    expect(got.kind).toBe('schedule')
    expect(got.payload?.targetAgentName).toBe('sonnetworker2')
  })

  it('defaults legacy rows to kind team', () => {
    const store = new ProposalsStore(db())
    const p: TeamProposal = {
      id: 'p2', proposedBy: 'o', summary: 's', agents: [], status: 'pending',
      createdAt: new Date(0).toISOString(), kind: 'team'
    }
    store.saveProposal(p)
    expect(store.getProposal('p2')!.kind).toBe('team')
  })
})
```

- [ ] **Step 3: Run — expect FAIL**

Run: `npx vitest run tests/unit/proposals-store.test.ts --exclude "**/.claude/worktrees/**"`
Expected: FAIL (columns/fields missing).

- [ ] **Step 4: Migrate the schema** in `src/main/db/database.ts` (ALTER block):

```ts
try { db.exec("ALTER TABLE team_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'team'") } catch { /* exists */ }
try { db.exec("ALTER TABLE team_proposals ADD COLUMN payload TEXT") } catch { /* exists */ }
```
Add `kind TEXT NOT NULL DEFAULT 'team'` and `payload TEXT` to the `CREATE TABLE IF NOT EXISTS team_proposals (...)` body too.

- [ ] **Step 5: Persist in `proposals-store.ts`:**

- `insertStmt`: add `kind, payload` to columns and two more `?` to VALUES.
- All three SELECTs (`loadAllStmt`, `loadPendingStmt`, `getStmt`): add `kind`, `payload` to the column list.
- `saveProposal()`: add final args `proposal.kind`, `proposal.payload ? JSON.stringify(proposal.payload) : null`.
- `interface RawProposal`: add `kind: 'team' | 'schedule'` and `payload: string | null`.
- `rowToProposal()`: add
```ts
    kind: row.kind ?? 'team',
    payload: row.payload ? JSON.parse(row.payload) : undefined,
```

- [ ] **Step 6: Channel — tag team + add schedule proposal** in `src/main/hub/proposals-channel.ts`:

In `createProposal()`'s returned object add `kind: 'team' as const,`. Then add a new method:
```ts
  /** Create a pending schedule proposal (no agents; carries a SchedulePayload). */
  createScheduleProposal(
    proposedBy: string,
    summary: string,
    payload: SchedulePayload,
    tabId?: string
  ): TeamProposal {
    if (!summary || typeof summary !== 'string') throw new Error('summary is required')
    if (!payload || typeof payload.promptText !== 'string' || !payload.promptText.trim()) {
      throw new Error('payload.promptText is required')
    }
    const proposal: TeamProposal = {
      id: uuid(), proposedBy, summary, agents: [], status: 'pending',
      createdAt: new Date().toISOString(), tabId: tabId ?? undefined,
      kind: 'schedule', payload
    }
    this.proposals.unshift(proposal)
    this.onProposalAdded?.(proposal)
    return proposal
  }
```
Add `SchedulePayload` to the type import at the top of the file.

- [ ] **Step 7: Run — expect PASS**

Run: `npx vitest run tests/unit/proposals-store.test.ts --exclude "**/.claude/worktrees/**"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/main/db/proposals-store.ts src/main/hub/proposals-channel.ts src/main/db/database.ts tests/unit/proposals-store.test.ts
git commit -m "feat(proposals): add kind/payload to support schedule proposals"
```

---

### Task 3: Per-project autonomy store

**Files:**
- Create: `src/main/db/autonomy-store.ts`
- Modify: `src/shared/types.ts` (`ProjectAutonomy`)
- Modify: `src/main/db/database.ts` (new `project_settings` table)
- Test: `tests/unit/autonomy-store.test.ts`

- [ ] **Step 1: Add the type** in `src/shared/types.ts`:

```ts
export interface ProjectAutonomy {
  scheduling: boolean   // V1; spawn/reap added in the B fast-follow
}
```

- [ ] **Step 2: Add the table** in `src/main/db/database.ts` (inside the main `db.exec` create block):

```sql
    CREATE TABLE IF NOT EXISTS project_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
```

- [ ] **Step 3: Write the failing test** `tests/unit/autonomy-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/main/db/database'
import { AutonomyStore } from '../../src/main/db/autonomy-store'

describe('AutonomyStore', () => {
  it('defaults scheduling to false', () => {
    const s = new AutonomyStore(createDatabase(':memory:'))
    expect(s.get().scheduling).toBe(false)
  })
  it('persists scheduling toggle', () => {
    const db = createDatabase(':memory:')
    new AutonomyStore(db).set({ scheduling: true })
    expect(new AutonomyStore(db).get().scheduling).toBe(true)
  })
})
```

- [ ] **Step 4: Run — expect FAIL** (module missing)

Run: `npx vitest run tests/unit/autonomy-store.test.ts --exclude "**/.claude/worktrees/**"`
Expected: FAIL (cannot find module).

- [ ] **Step 5: Implement `src/main/db/autonomy-store.ts`:**

```ts
import type Database from 'better-sqlite3'
import type { ProjectAutonomy } from '../../shared/types'

const KEY = 'autonomy'
const DEFAULT: ProjectAutonomy = { scheduling: false }

export class AutonomyStore {
  private getStmt: Database.Statement
  private setStmt: Database.Statement

  constructor(db: Database.Database) {
    this.getStmt = db.prepare('SELECT value FROM project_settings WHERE key = ?')
    this.setStmt = db.prepare(
      `INSERT INTO project_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
  }

  get(): ProjectAutonomy {
    const row = this.getStmt.get(KEY) as { value: string } | undefined
    if (!row) return { ...DEFAULT }
    try { return { ...DEFAULT, ...JSON.parse(row.value) } } catch { return { ...DEFAULT } }
  }

  set(value: ProjectAutonomy): void {
    this.setStmt.run(KEY, JSON.stringify(value))
  }
}
```

- [ ] **Step 6: Run — expect PASS**

Run: `npx vitest run tests/unit/autonomy-store.test.ts --exclude "**/.claude/worktrees/**"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/db/autonomy-store.ts src/shared/types.ts src/main/db/database.ts tests/unit/autonomy-store.test.ts
git commit -m "feat(db): per-project autonomy store"
```

---

## Phase 2 — Bridge helpers + autonomy IPC/UI

### Task 4: Schedule-bridge pure helpers

These are the testable pure pieces; the bridge object itself is wired in Task 7/9.

**Files:**
- Modify: `src/main/scheduler/scheduler-helpers.ts`
- Test: `tests/unit/schedule-bridge-helpers.test.ts`

- [ ] **Step 1: Write the failing test** `tests/unit/schedule-bridge-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { canAgentCancelSchedule, validateAgentScheduleRequest, MIN_AGENT_INTERVAL_MINUTES }
  from '../../src/main/scheduler/scheduler-helpers'
import type { ScheduledPrompt } from '../../src/shared/types'

const sched = (createdBy: string): ScheduledPrompt => ({
  id: 's', tabId: 't', agentId: 'a', name: 'n', promptText: 'p', intervalMinutes: 40,
  durationHours: 6, startedAt: 0, expiresAt: 1, nextFireAt: 1, pausedAt: null,
  status: 'active', fireHistory: [], createdBy
})

describe('canAgentCancelSchedule', () => {
  it('allows an agent to cancel its own schedule', () => {
    expect(canAgentCancelSchedule(sched('orchestrator'), 'orchestrator')).toBe(true)
  })
  it('forbids cancelling user or other-agent schedules', () => {
    expect(canAgentCancelSchedule(sched('user'), 'orchestrator')).toBe(false)
    expect(canAgentCancelSchedule(sched('worker9'), 'orchestrator')).toBe(false)
  })
})

describe('validateAgentScheduleRequest', () => {
  it('rejects interval below the floor', () => {
    const r = validateAgentScheduleRequest({ intervalMinutes: 1, durationHours: 6 })
    expect(r.ok).toBe(false)
  })
  it('rejects missing/invalid duration', () => {
    expect(validateAgentScheduleRequest({ intervalMinutes: 40, durationHours: 0 }).ok).toBe(false)
    expect(validateAgentScheduleRequest({ intervalMinutes: 40, durationHours: null as any }).ok).toBe(false)
  })
  it('accepts a valid request at the floor', () => {
    expect(validateAgentScheduleRequest({ intervalMinutes: MIN_AGENT_INTERVAL_MINUTES, durationHours: 6 }).ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run tests/unit/schedule-bridge-helpers.test.ts --exclude "**/.claude/worktrees/**"`
Expected: FAIL (exports missing).

- [ ] **Step 3: Add helpers** to `src/main/scheduler/scheduler-helpers.ts`:

```ts
import type { ScheduledPrompt } from '../../shared/types'

export const MIN_AGENT_INTERVAL_MINUTES = 5

/** Agents may only cancel schedules they themselves created. */
export function canAgentCancelSchedule(schedule: ScheduledPrompt, agentName: string): boolean {
  return schedule.createdBy === agentName && agentName !== 'user'
}

/** Footgun guards for agent-created schedules: required duration + min interval. */
export function validateAgentScheduleRequest(
  input: { intervalMinutes: number; durationHours: number | null }
): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < MIN_AGENT_INTERVAL_MINUTES) {
    return { ok: false, error: `intervalMinutes must be an integer >= ${MIN_AGENT_INTERVAL_MINUTES}` }
  }
  if (!Number.isInteger(input.durationHours as number) || (input.durationHours as number) <= 0) {
    return { ok: false, error: 'durationHours is required and must be a positive integer' }
  }
  return { ok: true }
}
```
(If `scheduler-helpers.ts` already imports types, merge the import rather than duplicating.)

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run tests/unit/schedule-bridge-helpers.test.ts --exclude "**/.claude/worktrees/**"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/scheduler/scheduler-helpers.ts tests/unit/schedule-bridge-helpers.test.ts
git commit -m "feat(scheduler): agent-schedule validation + cancel-ownership helpers"
```

---

### Task 5: Autonomy IPC + preload typings

**Files:**
- Modify: `src/main/ipc-channels.ts` (the file defining the `IPC` const object — confirm path via `grep -rl "SETTINGS_GET" src/main src/shared`)
- Modify: `src/main/index.ts` (handlers + instantiate `AutonomyStore`)
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/electron.d.ts`

- [ ] **Step 1: Add IPC channel constants** to the `IPC` object:

```ts
  AUTONOMY_GET: 'autonomy:get',
  AUTONOMY_SET: 'autonomy:set',
```

- [ ] **Step 2: Instantiate the store + handlers** in `src/main/index.ts`.

Near where `currentSchedulesStore`/`currentProposalsStore` are assigned (around line 1372), add a module-level `let autonomyStore: AutonomyStore | null = null` (top with the other `let` decls) and:
```ts
  autonomyStore = new AutonomyStore(db)
```
Import at top: `import { AutonomyStore } from './db/autonomy-store'` and `import type { ProjectAutonomy } from '../shared/types'`.

Register handlers near the other `ipcMain.handle` calls (e.g. by `SETTINGS_GET` at line ~1979):
```ts
  ipcMain.handle(IPC.AUTONOMY_GET, () => autonomyStore?.get() ?? { scheduling: false })
  ipcMain.handle(IPC.AUTONOMY_SET, (_e, value: ProjectAutonomy) => {
    autonomyStore?.set({ scheduling: !!value?.scheduling })
    return autonomyStore?.get() ?? { scheduling: false }
  })
```

- [ ] **Step 3: Expose in preload** (`src/preload/index.ts`, near `getSettings`):

```ts
  getAutonomy: () => ipcRenderer.invoke(IPC.AUTONOMY_GET),
  setAutonomy: (value: { scheduling: boolean }) => ipcRenderer.invoke(IPC.AUTONOMY_SET, value),
```

- [ ] **Step 4: Type it** in `src/renderer/electron.d.ts` (inside the api interface):

```ts
      getAutonomy: () => Promise<{ scheduling: boolean }>
      setAutonomy: (value: { scheduling: boolean }) => Promise<{ scheduling: boolean }>
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -v "req.params" | grep -iE "autonomy|error TS" | head`
Expected: no new errors mentioning autonomy.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc-channels.ts src/main/index.ts src/preload/index.ts src/renderer/electron.d.ts
git commit -m "feat(ipc): per-project autonomy get/set"
```

---

### Task 6: Autonomy settings UI

**Files:**
- Create: `src/renderer/components/AutonomySettings.tsx`
- Modify: `src/renderer/components/SettingsDialog.tsx`

- [ ] **Step 1: Build the component** `src/renderer/components/AutonomySettings.tsx`:

```tsx
import { useEffect, useState } from 'react'

interface Props { projectName: string | null }

export function AutonomySettings({ projectName }: Props) {
  const [scheduling, setScheduling] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!projectName) return
    window.electron.getAutonomy().then(a => { setScheduling(!!a.scheduling); setLoaded(true) })
  }, [projectName])

  const toggle = async () => {
    const next = !scheduling
    setScheduling(next)
    await window.electron.setAutonomy({ scheduling: next })
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 14, color: '#e0e0e0', margin: '0 0 4px' }}>
        Agent Autonomy{projectName ? ` — ${projectName}` : ''}
      </h3>
      {!projectName ? (
        <p style={{ fontSize: 12, color: '#888' }}>Open a project to configure autonomy.</p>
      ) : (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ccc' }}>
          <input type="checkbox" checked={scheduling} disabled={!loaded} onChange={toggle} />
          Scheduling — let agents create scheduled prompts directly (off = they propose to your inbox)
        </label>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Render it** in `src/renderer/components/SettingsDialog.tsx`. Import at top:
```tsx
import { AutonomySettings } from './AutonomySettings'
```
Add a section near the other sections (e.g. after the Notifications section block, ~line 393). Pass the current project name — `SettingsDialog` already receives or can read it; if it has a `projectName`/`currentProject` prop use that, otherwise call `window.electron.getCurrentProject?.()` once in local state and pass `.name`:
```tsx
        {/* Agent Autonomy section */}
        <AutonomySettings projectName={projectName ?? null} />
```
(Confirm how `SettingsDialog` knows the project — `grep -n "project" src/renderer/components/SettingsDialog.tsx`. Use the existing source of truth; do not add a second one.)

- [ ] **Step 3: Verify build**

Run: `npm run build 2>&1 | tail -5`
Expected: `✓ built` with no TS errors.

- [ ] **Step 4: Manual check** (note in commit, no automated UI test): `npm run dev`, open Settings → "Agent Autonomy — <project>" shows; toggling persists across dialog reopen.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/AutonomySettings.tsx src/renderer/components/SettingsDialog.tsx
git commit -m "feat(settings): per-project Agent Autonomy section"
```

---

## Phase 3 — Hub routes + MCP tools

### Task 7: Hub schedule routes + bridge wiring

**Files:**
- Modify: `src/main/hub/routes.ts` (new routes + `scheduleBridge` param)
- Modify: `src/main/hub/server.ts` (thread param through `createRoutes`; expose setter)
- Modify: `src/main/index.ts` (construct the bridge, inject it)
- Test: `tests/unit/hub-schedule-routes.test.ts`

The bridge interface (define in `routes.ts` and export):
```ts
export interface ScheduleBridge {
  autonomyEnabled: () => boolean
  resolveTarget: (agentNameOrId: string) => { agentId: string; tabId: string; name: string } | null
  create: (p: { agentId: string; tabId: string; name?: string; promptText: string;
                intervalMinutes: number; durationHours: number; createdBy: string }) =>
    { id: string; nextFireAt: number; expiresAt: number | null }
  list: () => Array<{ id: string; name: string; agentId: string; agentName: string;
                      intervalMinutes: number; durationHours: number | null; nextFireAt: number;
                      expiresAt: number | null; status: string; createdBy: string }>
  cancel: (id: string, byAgentName: string) => { ok: boolean; error?: string }
}
```

- [ ] **Step 1: Write the failing route test** `tests/unit/hub-schedule-routes.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRoutes, type ScheduleBridge } from '../../src/main/hub/routes'
// NOTE: createRoutes has many positional params. Build the app the same way
// tests/integration/hub-server.test.ts does, passing a fake proposalsChannel
// and the new scheduleBridge as the trailing arg. Reuse that file's harness.

function appWith(bridge: ScheduleBridge, proposalsChannel: any) {
  const app = express()
  app.use(express.json())
  // ...mirror the arg order used in hub-server.test.ts, ending with proposalsChannel, bridge
  return app
}

describe('POST /schedules', () => {
  it('fires directly when autonomy is enabled', async () => {
    const bridge: ScheduleBridge = {
      autonomyEnabled: () => true,
      resolveTarget: () => ({ agentId: 'a1', tabId: 'tab-default', name: 'sonnetworker2' }),
      create: vi.fn(() => ({ id: 'sch1', nextFireAt: 123, expiresAt: 456 })),
      list: () => [], cancel: () => ({ ok: true })
    }
    const proposalsChannel = { createScheduleProposal: vi.fn() }
    const res = await request(appWith(bridge, proposalsChannel))
      .post('/schedules')
      .send({ proposedBy: 'orchestrator', targetAgent: 'sonnetworker2', promptText: 'sitrep',
              intervalMinutes: 40, durationHours: 6 })
    expect(res.body.status).toBe('scheduled')
    expect(bridge.create).toHaveBeenCalled()
    expect(proposalsChannel.createScheduleProposal).not.toHaveBeenCalled()
  })

  it('proposes when autonomy is disabled', async () => {
    const bridge: ScheduleBridge = {
      autonomyEnabled: () => false,
      resolveTarget: () => ({ agentId: 'a1', tabId: 'tab-default', name: 'sonnetworker2' }),
      create: vi.fn(), list: () => [], cancel: () => ({ ok: true })
    }
    const proposalsChannel = { createScheduleProposal: vi.fn(() => ({ id: 'p1' })) }
    const res = await request(appWith(bridge, proposalsChannel))
      .post('/schedules')
      .send({ proposedBy: 'orchestrator', targetAgent: 'sonnetworker2', promptText: 'sitrep',
              intervalMinutes: 40, durationHours: 6 })
    expect(res.body.status).toBe('proposed')
    expect(proposalsChannel.createScheduleProposal).toHaveBeenCalled()
    expect(bridge.create).not.toHaveBeenCalled()
  })

  it('rejects sub-floor interval', async () => {
    const bridge: ScheduleBridge = {
      autonomyEnabled: () => true, resolveTarget: () => ({ agentId: 'a1', tabId: 't', name: 'x' }),
      create: vi.fn(), list: () => [], cancel: () => ({ ok: true })
    }
    const res = await request(appWith(bridge, { createScheduleProposal: vi.fn() }))
      .post('/schedules').send({ proposedBy: 'o', targetAgent: 'x', promptText: 'p', intervalMinutes: 1, durationHours: 6 })
    expect(res.status).toBe(400)
  })
})
```

(Fill in `appWith` by copying the exact `createRoutes(...)` argument list from `tests/integration/hub-server.test.ts`, appending the `scheduleBridge` as the new trailing param.)

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run tests/unit/hub-schedule-routes.test.ts --exclude "**/.claude/worktrees/**"`
Expected: FAIL (routes/param missing).

- [ ] **Step 3: Add the param + routes** in `src/main/hub/routes.ts`.

Add `scheduleBridge?: ScheduleBridge` as the final parameter of `createRoutes(...)`. Import the validation helpers:
```ts
import { validateAgentScheduleRequest } from '../scheduler/scheduler-helpers'
```
Register (place near the proposals routes):
```ts
  router.post('/schedules', (req: Request, res: Response) => {
    if (!scheduleBridge) { res.status(503).json({ error: 'Scheduler unavailable' }); return }
    const { proposedBy, targetAgent, promptText, intervalMinutes, durationHours, name } = req.body ?? {}
    if (typeof proposedBy !== 'string' || !proposedBy.trim()) { res.status(400).json({ error: 'proposedBy required' }); return }
    if (typeof targetAgent !== 'string' || !targetAgent.trim()) { res.status(400).json({ error: 'targetAgent required' }); return }
    if (typeof promptText !== 'string' || !promptText.trim()) { res.status(400).json({ error: 'promptText required' }); return }
    const v = validateAgentScheduleRequest({ intervalMinutes, durationHours })
    if (!v.ok) { res.status(400).json({ error: v.error }); return }
    const target = scheduleBridge.resolveTarget(targetAgent)
    if (!target) { res.status(404).json({ error: `Agent not found: ${targetAgent}` }); return }

    if (scheduleBridge.autonomyEnabled()) {
      const created = scheduleBridge.create({
        agentId: target.agentId, tabId: target.tabId, name,
        promptText: promptText.trim(), intervalMinutes, durationHours, createdBy: proposedBy
      })
      res.json({ status: 'scheduled', scheduleId: created.id, nextFireAt: created.nextFireAt, expiresAt: created.expiresAt })
      return
    }
    if (!proposalsChannel) { res.status(503).json({ error: 'Proposals unavailable' }); return }
    const proposal = proposalsChannel.createScheduleProposal(
      proposedBy,
      `Schedule "${(name || 'prompt')}" for ${target.name} every ${intervalMinutes}m for ${durationHours}h`,
      { targetAgentId: target.agentId, targetAgentName: target.name, tabId: target.tabId,
        promptText: promptText.trim(), intervalMinutes, durationHours, name },
      target.tabId
    )
    res.json({ status: 'proposed', proposalId: proposal.id })
  })

  router.get('/schedules', (_req: Request, res: Response) => {
    if (!scheduleBridge) { res.json([]); return }
    res.json(scheduleBridge.list())
  })

  router.post('/schedules/:id/cancel', (req: Request, res: Response) => {
    if (!scheduleBridge) { res.status(503).json({ error: 'Scheduler unavailable' }); return }
    const byAgent = (req.body && req.body.requestedBy) || ''
    const result = scheduleBridge.cancel(req.params.id, byAgent)
    if (!result.ok) { res.status(403).json({ error: result.error || 'Not allowed' }); return }
    res.json({ ok: true })
  })
```

- [ ] **Step 4: Thread it through `server.ts`** — add an optional `scheduleBridge` slot the hub can hold, and pass it to `createRoutes(...)` as the trailing arg. Since the bridge depends on main-process state created after the hub, expose a setter on the `HubServer` (e.g. `setScheduleBridge(b)`) that stores it in a closure variable the route closures read via `() => currentBridge`. Simplest: have `createHubServer` accept `getScheduleBridge?: () => ScheduleBridge | undefined` and pass `createRoutes(..., proposalsChannel, scheduleBridgeProxy)` where the proxy delegates to the getter. Add `getScheduleBridge` to the `createHubServer` options.

- [ ] **Step 5: Build the bridge in `index.ts`** and supply it to the hub. Where the hub is created, pass a getter returning:
```ts
  const scheduleBridge: ScheduleBridge = {
    autonomyEnabled: () => autonomyStore?.get().scheduling ?? false,
    resolveTarget: (key) => {
      for (const m of agents.values()) {
        if (m.config.id === key || m.config.name.toLowerCase() === key.toLowerCase()) {
          return { agentId: m.config.id, tabId: m.config.tabId || 'tab-default', name: m.config.name }
        }
      }
      return null
    },
    create: (p) => {
      if (!promptScheduler) throw new Error('Scheduler unavailable')
      const s = promptScheduler.create({
        tabId: p.tabId, agentId: p.agentId, name: p.name, promptText: p.promptText,
        intervalMinutes: p.intervalMinutes, durationHours: p.durationHours, createdBy: p.createdBy
      })
      return { id: s.id, nextFireAt: s.nextFireAt, expiresAt: s.expiresAt }
    },
    list: () => (promptScheduler?.list() ?? []).map(s => ({
      id: s.id, name: s.name, agentId: s.agentId,
      agentName: [...agents.values()].find(m => m.config.id === s.agentId)?.config.name ?? s.agentId,
      intervalMinutes: s.intervalMinutes, durationHours: s.durationHours, nextFireAt: s.nextFireAt,
      expiresAt: s.expiresAt, status: s.status, createdBy: s.createdBy
    })),
    cancel: (id, byAgentName) => {
      const s = promptScheduler?.get(id)
      if (!s) return { ok: false, error: 'Schedule not found' }
      if (!canAgentCancelSchedule(s, byAgentName)) return { ok: false, error: 'Agents may only cancel schedules they created' }
      promptScheduler!.delete(id)   // confirm method name in prompt-scheduler.ts (delete/remove/stop)
      return { ok: true }
    }
  }
```
Import `canAgentCancelSchedule` and the `ScheduleBridge` type. Confirm the scheduler's single-delete method name (`grep -nE "delete\(|remove\(|stop\(" src/main/scheduler/prompt-scheduler.ts`) and use it.

- [ ] **Step 6: Run route tests + full suite — expect PASS**

Run: `npx vitest run tests/unit/hub-schedule-routes.test.ts tests/integration/hub-server.test.ts --exclude "**/.claude/worktrees/**"`
Expected: PASS (existing hub tests unaffected by the new trailing optional param).

- [ ] **Step 7: Commit**

```bash
git add src/main/hub/routes.ts src/main/hub/server.ts src/main/index.ts tests/unit/hub-schedule-routes.test.ts
git commit -m "feat(hub): schedule routes with autonomy/propose bridge"
```

---

### Task 8: MCP tools

**Files:**
- Modify: `src/mcp-server/index.ts` (add three `server.tool(...)` blocks near `propose_team`)

- [ ] **Step 1: Add `schedule_prompt`** (place after the `propose_team` tool):

```ts
server.tool(
  'schedule_prompt',
  'Schedule a recurring prompt to be injected into an agent in this workspace (yourself or another agent). Use for self-directed check-ins or to drive a worker (e.g. "post a sitrep every 40 minutes for 6 hours"). If the project has Scheduling autonomy enabled, the schedule starts immediately; otherwise it is PROPOSED for the user to approve in their inbox. Minimum interval is 5 minutes; duration_hours is required (no infinite schedules).',
  {
    target_agent: z.string().describe('Name (or id) of the agent the prompt fires at. Use your own name to self-schedule.'),
    prompt_text: z.string().describe('The text injected into the target agent on each fire.'),
    interval_minutes: z.number().int().describe('Minutes between fires. Minimum 5.'),
    duration_hours: z.number().int().describe('How many hours the schedule runs before auto-expiring. Required.'),
    name: z.string().optional().describe('Optional human-readable label.')
  },
  async ({ target_agent, prompt_text, interval_minutes, duration_hours, name }) => {
    try {
      const result = await hubFetch('/schedules', {
        method: 'POST',
        body: JSON.stringify({
          proposedBy: AGENT_NAME, targetAgent: target_agent, promptText: prompt_text,
          intervalMinutes: interval_minutes, durationHours: duration_hours, name
        })
      })
      if (result.status === 'proposed') {
        return toolResult({ ...result, next: 'Awaiting user approval in their inbox. Continue other work; you will be notified when they decide.' })
      }
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to schedule prompt: ${err.message}`)
    }
  }
)
```

- [ ] **Step 2: Add `list_schedules`:**

```ts
server.tool(
  'list_schedules',
  'List active scheduled prompts in this workspace, including who created each one. Use to avoid creating duplicate schedules and to find the ids of schedules you created (so you can cancel them).',
  {},
  async () => {
    try { return toolResult(await hubFetch('/schedules')) }
    catch (err: any) { return toolError(`Failed to list schedules: ${err.message}`) }
  }
)
```

- [ ] **Step 3: Add `cancel_schedule`:**

```ts
server.tool(
  'cancel_schedule',
  'Cancel a scheduled prompt by id. You may only cancel schedules YOU created (not the user\'s or another agent\'s). Get ids from list_schedules().',
  { schedule_id: z.string().describe('The id of the schedule to cancel.') },
  async ({ schedule_id }) => {
    try {
      const result = await hubFetch(`/schedules/${encodeURIComponent(schedule_id)}/cancel`, {
        method: 'POST', body: JSON.stringify({ requestedBy: AGENT_NAME })
      })
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to cancel schedule: ${err.message}`)
    }
  }
)
```

- [ ] **Step 4: Build the MCP server**

Run: `npm run build:mcp 2>&1 | tail -5`
Expected: build succeeds, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/index.ts
git commit -m "feat(mcp): schedule_prompt, list_schedules, cancel_schedule tools"
```

---

## Phase 4 — Approve branching + panel attribution

### Task 9: Branch `approveProposal` on kind

**Files:**
- Modify: `src/main/index.ts` (`approveProposal` at ~line 450)

- [ ] **Step 1: Branch before the team-spawn logic.** At the top of `approveProposal`, after fetching `const proposal = hub.proposalsChannel.get(proposalId)` and the not-found guard, add:

```ts
    if (proposal.kind === 'schedule') {
      if (!proposal.payload) {
        return { success: false, error: 'Schedule proposal missing payload' }
      }
      try {
        scheduleBridge.create({
          agentId: proposal.payload.targetAgentId,
          tabId: proposal.payload.tabId,
          name: proposal.payload.name,
          promptText: proposal.payload.promptText,
          intervalMinutes: proposal.payload.intervalMinutes,
          durationHours: proposal.payload.durationHours,
          createdBy: proposal.proposedBy
        })
      } catch (err: any) {
        return { success: false, error: err?.message || 'Failed to create schedule' }
      }
      hub.proposalsChannel.resolve(proposalId, 'approved')
      return { success: true }
    }
```
This sits before the existing agent-spawn path, which now only runs for `kind === 'team'`. (`scheduleBridge` is the same object built in Task 7 — hoist it so both the hub getter and `approveProposal` reference it.)

- [ ] **Step 2: Build to verify**

Run: `npm run build 2>&1 | tail -5`
Expected: `✓ built`, no TS errors.

- [ ] **Step 3: Manual integration check** (note in commit): with autonomy OFF, an agent calling `schedule_prompt` creates an inbox proposal; approving it makes the schedule appear in the Schedules panel and fire on the tick. With autonomy ON, it appears immediately.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(proposals): approve schedule proposals into live schedules"
```

---

### Task 10: Schedule-row creator badge

**Files:**
- Modify: `src/renderer/components/ScheduleRow.tsx`

- [ ] **Step 1: Render the creator** in `ScheduleRow.tsx`. The row receives a `ScheduledPrompt` (confirm the prop name via `grep -n "createdBy\|ScheduledPrompt\|props" src/renderer/components/ScheduleRow.tsx`). Add a small badge next to the schedule name:

```tsx
{schedule.createdBy && schedule.createdBy !== 'user'
  ? <span title={`Created by ${schedule.createdBy}`} style={{ fontSize: 11, color: '#9aa', marginLeft: 6 }}>
      🤖 {schedule.createdBy}
    </span>
  : <span title="Created by you" style={{ fontSize: 11, color: '#9aa', marginLeft: 6 }}>👤 you</span>}
```
(Match the existing element/prop names in the file; `schedule` is illustrative — use the real prop.)

- [ ] **Step 2: Build**

Run: `npm run build 2>&1 | tail -5`
Expected: `✓ built`.

- [ ] **Step 3: Manual check:** a schedule created by an agent shows 🤖 + agent name; a user-created one shows 👤 you. User pause/delete still works on both.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/ScheduleRow.tsx
git commit -m "feat(ui): show schedule creator (you vs agent) in Schedules panel"
```

---

## Final verification

- [ ] **Full test suite** (excluding the stale-worktree path):

Run: `npx vitest run --exclude "**/.claude/worktrees/**" 2>&1 | tail -15`
Expected: no NEW failures vs. baseline (the 7 pre-existing `remote-server.test.ts` fixture failures remain; everything else green).

- [ ] **Full build:**

Run: `npm run build 2>&1 | tail -5`
Expected: `✓ built`.

- [ ] **Manual end-to-end** (`npm run dev`):
  1. Settings → Agent Autonomy shows current project; Scheduling OFF by default.
  2. With OFF: an orchestrator `schedule_prompt(target=worker, …)` → proposal in inbox (+ mobile) → approve → schedule appears (🤖 badge) and fires.
  3. With ON: same call fires immediately, returns `scheduled`.
  4. `list_schedules` shows it; `cancel_schedule` on its own succeeds; cancelling a 👤-you schedule returns the not-allowed error.
  5. Below-floor interval / missing duration → clean tool error.
  6. Existing `propose_team` flow still spawns agents (kind:'team' untouched).

---

## Self-Review notes (author)

- **Spec coverage:** three tools (Task 8) ✓; propose/execute fork (Task 7) ✓; per-project storage in `.cog` (Task 3) ✓; Settings section, extracted component (Task 6) ✓; proposals `kind`+`payload` reuse (Task 2) ✓; approve branch (Task 9) ✓; attribution (Tasks 1 + 10) ✓; guardrails duration-required + 5-min floor (Task 4, enforced in Task 7 route) ✓; cancel-own-only (Task 4 + Task 7) ✓; migrations additive with defaults (Tasks 1–3) ✓.
- **Type consistency:** `createdBy: string` used identically across `ScheduledPrompt`, `CreateScheduleInput`, store, bridge, UI; `SchedulePayload` fields identical in type, proposal, route, approve. `ScheduleBridge` method names consistent between routes.ts definition and index.ts implementation.
- **Confirm-before-coding callouts (not placeholders — verifications):** exact `IPC` consts file path; `SettingsDialog`'s existing project source; `ScheduleRow` prop name; scheduler single-delete method name; `createRoutes` arg order for the test harness. Each step says how to confirm.
