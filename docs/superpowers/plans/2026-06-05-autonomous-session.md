# Autonomous Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-project, time-boxed "autonomous session" that lets the orchestrator self-schedule, auto-spawn teams, and close idle agents without approval — every spawn/close logged to the inbox as urgent.

**Architecture:** One per-project timestamp (`sessionExpiresAt`) is the single gate. When active: `schedule_prompt` and `propose_team` go through immediately (the latter via auto-approve in main's existing `onProposalAdded`), and a new `close_agents` MCP tool tears down agents. All spawn/teardown reuses existing code paths extracted into shared helpers (`spawnProposalAgents`, `teardownAgent`). A one-shot main-process timer auto-reverts at expiry.

**Tech Stack:** Electron (main/preload/renderer), TypeScript, Express hub, better-sqlite3, @modelcontextprotocol/sdk, React, Vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-06-05-autonomous-session-design.md`

**Conventions for every task:** Work on `main` (project convention — no worktree). Never use `git commit --no-verify` (a hook blocks it). Conventional-commit messages. Unit tests run with `npx vitest run <file>`; full typecheck via `npm run build`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/shared/types.ts` | `ProjectAutonomy` shape + `IPC` channel constants. |
| `src/main/db/autonomy-store.ts` | Session persistence + `isActive`/`startSession`/`endSession` (clock-injectable). |
| `src/main/index.ts` | IPC handlers, expiry timer, `spawnProposalAgents`, `teardownAgent`, auto-approve branch, `agentBridge`. |
| `src/main/hub/routes.ts` | `/proposals` skip-mirror when active; new `POST /agents/close`; `AgentBridge` type. |
| `src/main/hub/server.ts` | Thread `getAgentBridge` into `createRoutes`. |
| `src/mcp-server/index.ts` | New `close_agents` tool; `propose_team` `next` text. |
| `src/preload/index.ts` + `src/renderer/electron.d.ts` | Autonomy + agent-closed bridge methods/types. |
| `src/renderer/components/AutonomySettings.tsx` | Armed-session UI (switch, duration, countdown, End now). |
| `src/renderer/App.tsx` | Prune window on `AGENT_CLOSED_REMOTE`. |
| `tests/unit/autonomy-store.test.ts` | Store unit tests (rewritten). |
| `tests/unit/hub-close-routes.test.ts` | `/agents/close` route tests (new). |

---

## Task 1: Session model + armed-session toggle

Migrates `ProjectAutonomy` to the timestamp shape and wires the manual arm/end toggle end-to-end. This is one cohesive change because the shared type ripples through store → IPC → preload → typings → UI; they must change together to compile. (Server auto-expiry timer is Task 2.)

**Files:**
- Modify: `src/shared/types.ts` (interface ~3-5; IPC constants ~187-188)
- Modify: `src/main/db/autonomy-store.ts` (full)
- Test: `tests/unit/autonomy-store.test.ts` (rewrite)
- Modify: `src/main/index.ts` (scheduleBridge `autonomyEnabled` :1610; IPC handlers :2097-2101)
- Modify: `src/preload/index.ts` (:164-165)
- Modify: `src/renderer/electron.d.ts` (:137-138)
- Modify: `src/renderer/components/AutonomySettings.tsx` (full)

- [ ] **Step 1: Write the failing store tests**

Replace the entire contents of `tests/unit/autonomy-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/main/db/database'
import { AutonomyStore } from '../../src/main/db/autonomy-store'

describe('AutonomyStore', () => {
  it('defaults to no active session', () => {
    const s = new AutonomyStore(createDatabase(':memory:'))
    expect(s.get().sessionExpiresAt).toBeNull()
    expect(s.isActive()).toBe(false)
  })

  it('startSession sets a future expiry and is active inside the window', () => {
    const now = 1_000_000
    const s = new AutonomyStore(createDatabase(':memory:'), () => now)
    const r = s.startSession(6)
    expect(r.sessionExpiresAt).toBe(now + 6 * 3_600_000)
    expect(s.isActive()).toBe(true)
  })

  it('isActive flips to false at and after expiry', () => {
    let now = 0
    const s = new AutonomyStore(createDatabase(':memory:'), () => now)
    s.startSession(1) // expires at 3_600_000
    now = 3_600_000
    expect(s.isActive()).toBe(false)
    now = 3_600_001
    expect(s.isActive()).toBe(false)
  })

  it('clamps duration to [0.25, 72] hours', () => {
    const now = 0
    const s = new AutonomyStore(createDatabase(':memory:'), () => now)
    expect(s.startSession(999).sessionExpiresAt).toBe(72 * 3_600_000)
    expect(s.startSession(0).sessionExpiresAt).toBe(0.25 * 3_600_000)
  })

  it('endSession clears the window', () => {
    const s = new AutonomyStore(createDatabase(':memory:'))
    s.startSession(6)
    s.endSession()
    expect(s.get().sessionExpiresAt).toBeNull()
    expect(s.isActive()).toBe(false)
  })

  it('reads a legacy { scheduling:true } value as off', () => {
    const db = createDatabase(':memory:')
    db.prepare(`INSERT INTO project_settings (key, value) VALUES ('autonomy', ?)`).run(JSON.stringify({ scheduling: true }))
    expect(new AutonomyStore(db).get().sessionExpiresAt).toBeNull()
  })

  it('rehydrates an in-window session from the DB', () => {
    const now = 5_000_000
    const db = createDatabase(':memory:')
    new AutonomyStore(db, () => now).startSession(2)
    expect(new AutonomyStore(db, () => now).isActive()).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/autonomy-store.test.ts`
Expected: FAIL — `isActive`/`startSession`/`endSession` do not exist; `sessionExpiresAt` undefined.

- [ ] **Step 3: Change the `ProjectAutonomy` type**

In `src/shared/types.ts`, replace:

```ts
export interface ProjectAutonomy {
  scheduling: boolean   // V1; spawn/reap added later
}
```

with:

```ts
export interface ProjectAutonomy {
  /** Epoch ms when the current autonomous session expires; null = off. */
  sessionExpiresAt: number | null
}
```

- [ ] **Step 4: Update IPC constants**

In `src/shared/types.ts`, replace these two lines:

```ts
  AUTONOMY_GET: 'autonomy:get',
  AUTONOMY_SET: 'autonomy:set',
```

with:

```ts
  AUTONOMY_GET: 'autonomy:get',
  AUTONOMY_START: 'autonomy:start',
  AUTONOMY_END: 'autonomy:end',
  AUTONOMY_CHANGED: 'autonomy:changed',
```

- [ ] **Step 5: Rewrite `AutonomyStore`**

Replace the entire contents of `src/main/db/autonomy-store.ts`:

```ts
import type Database from 'better-sqlite3'
import type { ProjectAutonomy } from '../../shared/types'

const KEY = 'autonomy'
const MIN_HOURS = 0.25
const MAX_HOURS = 72

export class AutonomyStore {
  private getStmt: Database.Statement
  private setStmt: Database.Statement
  private clock: () => number

  constructor(db: Database.Database, clock: () => number = () => Date.now()) {
    this.getStmt = db.prepare('SELECT value FROM project_settings WHERE key = ?')
    this.setStmt = db.prepare(
      `INSERT INTO project_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    this.clock = clock
  }

  get(): ProjectAutonomy {
    const row = this.getStmt.get(KEY) as { value: string } | undefined
    if (!row) return { sessionExpiresAt: null }
    try {
      const parsed = JSON.parse(row.value)
      const exp = typeof parsed?.sessionExpiresAt === 'number' ? parsed.sessionExpiresAt : null
      return { sessionExpiresAt: exp }
    } catch {
      return { sessionExpiresAt: null }
    }
  }

  isActive(): boolean {
    const { sessionExpiresAt } = this.get()
    return sessionExpiresAt !== null && this.clock() < sessionExpiresAt
  }

  startSession(durationHours: number): ProjectAutonomy {
    const hours = Math.min(MAX_HOURS, Math.max(MIN_HOURS, Number(durationHours) || 0))
    const value: ProjectAutonomy = { sessionExpiresAt: this.clock() + Math.round(hours * 3_600_000) }
    this.setStmt.run(KEY, JSON.stringify(value))
    return value
  }

  endSession(): ProjectAutonomy {
    const value: ProjectAutonomy = { sessionExpiresAt: null }
    this.setStmt.run(KEY, JSON.stringify(value))
    return value
  }
}
```

- [ ] **Step 6: Run the store tests to verify they pass**

Run: `npx vitest run tests/unit/autonomy-store.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Repoint the schedule bridge to the session**

In `src/main/index.ts:1610`, replace:

```ts
    autonomyEnabled: () => autonomyStore?.get().scheduling ?? false,
```

with:

```ts
    autonomyEnabled: () => autonomyStore?.isActive() ?? false,
```

- [ ] **Step 8: Replace the autonomy IPC handlers**

In `src/main/index.ts`, replace the block at :2097-2101:

```ts
  ipcMain.handle(IPC.AUTONOMY_GET, () => autonomyStore?.get() ?? { scheduling: false })
  ipcMain.handle(IPC.AUTONOMY_SET, (_e, value: ProjectAutonomy) => {
    autonomyStore?.set({ scheduling: !!value?.scheduling })
    return autonomyStore?.get() ?? { scheduling: false }
  })
```

with:

```ts
  ipcMain.handle(IPC.AUTONOMY_GET, () => autonomyStore?.get() ?? { sessionExpiresAt: null })
  ipcMain.handle(IPC.AUTONOMY_START, (_e, durationHours: number) => {
    if (!autonomyStore) return { sessionExpiresAt: null }
    return autonomyStore.startSession(durationHours)
  })
  ipcMain.handle(IPC.AUTONOMY_END, () => {
    if (!autonomyStore) return { sessionExpiresAt: null }
    return autonomyStore.endSession()
  })
```

(The `ProjectAutonomy` import on :41 stays — it is still used by the store. No other change.)

- [ ] **Step 9: Update preload bridge**

In `src/preload/index.ts`, replace the two `// Autonomy` lines at :164-165:

```ts
  getAutonomy: () => ipcRenderer.invoke(IPC.AUTONOMY_GET),
  setAutonomy: (value: { scheduling: boolean }) => ipcRenderer.invoke(IPC.AUTONOMY_SET, value),
```

with:

```ts
  getAutonomy: () => ipcRenderer.invoke(IPC.AUTONOMY_GET),
  startAutonomySession: (hours: number) => ipcRenderer.invoke(IPC.AUTONOMY_START, hours),
  endAutonomySession: () => ipcRenderer.invoke(IPC.AUTONOMY_END),
  onAutonomyChanged: (callback: (a: { sessionExpiresAt: number | null }) => void) => {
    const handler = (_e: unknown, a: { sessionExpiresAt: number | null }) => callback(a)
    ipcRenderer.on(IPC.AUTONOMY_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.AUTONOMY_CHANGED, handler)
  },
```

- [ ] **Step 10: Update renderer typings**

In `src/renderer/electron.d.ts`, replace the two lines at :137-138:

```ts
      getAutonomy: () => Promise<{ scheduling: boolean }>
      setAutonomy: (value: { scheduling: boolean }) => Promise<{ scheduling: boolean }>
```

with:

```ts
      getAutonomy: () => Promise<{ sessionExpiresAt: number | null }>
      startAutonomySession: (hours: number) => Promise<{ sessionExpiresAt: number | null }>
      endAutonomySession: () => Promise<{ sessionExpiresAt: number | null }>
      onAutonomyChanged: (callback: (a: { sessionExpiresAt: number | null }) => void) => () => void
```

- [ ] **Step 11: Rewrite the AutonomySettings UI**

Replace the entire contents of `src/renderer/components/AutonomySettings.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'

interface Props { projectName: string | null }

const DURATIONS = [
  { label: '2h', hours: 2 },
  { label: '6h', hours: 6 },
  { label: '12h', hours: 12 },
  { label: '24h', hours: 24 },
]

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMin = Math.ceil(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function AutonomySettings({ projectName }: Props) {
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [durationHours, setDurationHours] = useState(6)
  const [now, setNow] = useState(() => Date.now())
  const tick = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!projectName) return
    window.electronAPI.getAutonomy().then(a => { setExpiresAt(a.sessionExpiresAt); setLoaded(true) })
    const off = window.electronAPI.onAutonomyChanged(a => setExpiresAt(a.sessionExpiresAt))
    return () => off()
  }, [projectName])

  const active = expiresAt !== null && now < expiresAt

  useEffect(() => {
    if (!active) {
      if (tick.current) { clearInterval(tick.current); tick.current = null }
      return
    }
    tick.current = setInterval(() => setNow(Date.now()), 1000)
    return () => { if (tick.current) clearInterval(tick.current) }
  }, [active])

  const start = async () => {
    const a = await window.electronAPI.startAutonomySession(durationHours)
    setExpiresAt(a.sessionExpiresAt); setNow(Date.now())
  }
  const end = async () => {
    const a = await window.electronAPI.endAutonomySession()
    setExpiresAt(a.sessionExpiresAt)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid #333', paddingTop: '16px' }}>
      <div style={{ fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Agent Autonomy{projectName ? ` — ${projectName}` : ''}
      </div>
      {!projectName ? (
        <p style={{ fontSize: '12px', color: '#888', margin: 0 }}>Open a project to configure autonomy.</p>
      ) : (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px',
          backgroundColor: active ? '#2a1f1f' : '#252525',
          border: active ? '1px solid #b04a4a' : '1px solid #333',
          borderRadius: '4px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: '13px', color: '#e0e0e0', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: active ? '#e8a33d' : '#888' }}>⚠</span> Autonomous session
            </div>
            <div
              onClick={loaded ? (active ? end : start) : undefined}
              style={{
                width: 40, height: 22, borderRadius: 11,
                backgroundColor: active ? '#4caf50' : '#444',
                position: 'relative', cursor: loaded ? 'pointer' : 'not-allowed',
                transition: 'background-color 0.2s', flexShrink: 0, opacity: loaded ? 1 : 0.5
              }}
            >
              <div style={{
                width: 18, height: 18, borderRadius: '50%', backgroundColor: '#fff',
                position: 'absolute', top: 2, left: active ? 20 : 2, transition: 'left 0.2s'
              }} />
            </div>
          </div>

          {active ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: '12px', color: '#e8a33d' }}>{formatRemaining(expiresAt! - now)} left</div>
              <button
                onClick={end}
                style={{ fontSize: '11px', color: '#e0e0e0', background: '#3a2a2a', border: '1px solid #b04a4a', borderRadius: 4, padding: '3px 8px', cursor: 'pointer' }}
              >End now</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: '12px', color: '#888' }}>Duration</span>
              <select
                value={durationHours}
                onChange={e => setDurationHours(Number(e.target.value))}
                style={{ fontSize: '12px', background: '#1c1c1c', color: '#e0e0e0', border: '1px solid #444', borderRadius: 4, padding: '3px 6px' }}
              >
                {DURATIONS.map(d => <option key={d.hours} value={d.hours}>{d.label}</option>)}
              </select>
            </div>
          )}

          <div style={{ fontSize: '11px', color: '#888', lineHeight: 1.4 }}>
            While active, agents self-schedule prompts, spawn agents/teams, and close idle agents <strong>without approval</strong>. Every spawn/close posts to your inbox as urgent.
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 12: Typecheck the whole app**

Run: `npm run build`
Expected: build succeeds with no TypeScript errors. (This confirms every `scheduling` reference is gone and the new API typechecks.)

- [ ] **Step 13: Commit**

```bash
git add src/shared/types.ts src/main/db/autonomy-store.ts tests/unit/autonomy-store.test.ts src/main/index.ts src/preload/index.ts src/renderer/electron.d.ts src/renderer/components/AutonomySettings.tsx
git commit -m "feat(autonomy): time-boxed session model + armable toggle UI"
```

---

## Task 2: Server-side auto-expiry timer

Adds the one-shot timer that flips the session off at expiry, pushes state to the renderer, and posts an inbox note. Re-arms on project load so a session survives a restart. Pure main-process wiring (no unit harness for `index.ts`); verified by build + manual smoke.

**Files:**
- Modify: `src/main/index.ts` (new module-level timer + functions; START/END handlers; re-arm on load)

- [ ] **Step 1: Add the timer state + functions**

In `src/main/index.ts`, immediately after the `getVisibleAgents` function (ends at :149), add:

```ts
let autonomyExpiryTimer: ReturnType<typeof setTimeout> | null = null

// Re-arm the one-shot autonomy expiry timer from the stored session and push
// current state to the renderer. Safe to call repeatedly (start/end/load).
function armAutonomyExpiry(): void {
  if (autonomyExpiryTimer) { clearTimeout(autonomyExpiryTimer); autonomyExpiryTimer = null }
  const exp = autonomyStore?.get().sessionExpiresAt ?? null
  mainWindow?.webContents.send(IPC.AUTONOMY_CHANGED, { sessionExpiresAt: exp })
  if (exp === null) return
  const delay = exp - Date.now()
  if (delay <= 0) { onAutonomyExpired(); return }
  autonomyExpiryTimer = setTimeout(onAutonomyExpired, delay)
}

function onAutonomyExpired(): void {
  autonomyExpiryTimer = null
  if (!autonomyStore) return
  autonomyStore.endSession()
  mainWindow?.webContents.send(IPC.AUTONOMY_CHANGED, { sessionExpiresAt: null })
  try {
    const orch = getVisibleAgents().find(a => (a.role || '').toLowerCase() === 'orchestrator')
    hub?.inboxChannel.postMessage(
      orch?.id ?? 'system', orch?.name ?? 'system',
      'Autonomous session ended — approvals required again.', 'normal', ['autonomy'], orch?.tabId
    )
  } catch { /* inbox may be unavailable */ }
}
```

- [ ] **Step 2: Arm the timer from the START/END handlers**

In `src/main/index.ts`, update the two handlers added in Task 1 (AUTONOMY_START / AUTONOMY_END) to arm after mutating:

```ts
  ipcMain.handle(IPC.AUTONOMY_START, (_e, durationHours: number) => {
    if (!autonomyStore) return { sessionExpiresAt: null }
    const v = autonomyStore.startSession(durationHours)
    armAutonomyExpiry()
    return v
  })
  ipcMain.handle(IPC.AUTONOMY_END, () => {
    if (!autonomyStore) return { sessionExpiresAt: null }
    const v = autonomyStore.endSession()
    armAutonomyExpiry()
    return v
  })
```

- [ ] **Step 3: Re-arm on project load**

In `src/main/index.ts`, find `autonomyStore = new AutonomyStore(db)` (:1426) and add the re-arm call on the next line:

```ts
  autonomyStore = new AutonomyStore(db)
  armAutonomyExpiry()
```

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Manual smoke test**

Run: `npm run dev`. Open a project. In Settings → Agent Autonomy, set Duration `2h` and flip the switch ON. Verify the countdown shows "1h 59m left" and ticks. Click **End now** → reverts to the duration dropdown. Re-arm, then quit and relaunch the app, reopen the project → the countdown is still running (re-armed from disk). Set a very short window by editing nothing (trust the unit-tested clamp) — to verify expiry without waiting, temporarily start a session, then in DevTools console confirm `await window.electronAPI.getAutonomy()` returns a future `sessionExpiresAt`.

Expected: toggle arms/ends, countdown ticks, survives restart.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(autonomy): auto-expiry timer, change events, re-arm on load"
```

---

## Task 3: Auto-approve teams while a session is active

Extracts the team-spawn loop into a shared helper, makes `onProposalAdded` auto-approve `team` proposals during a session (urgent inbox + orchestrator notify + no modal), and stops the `/proposals` route from mirroring a "needs approval" message when the session is active.

**Files:**
- Modify: `src/main/index.ts` (new `spawnProposalAgents`; `approveProposal` :498-540; `onProposalAdded` :1544-1552)
- Modify: `src/main/hub/routes.ts` (`/proposals` mirror :368-383 + response :384)
- Modify: `src/mcp-server/index.ts` (`propose_team` `next` :682-685)
- Test: `tests/unit/hub-schedule-routes.test.ts` is unaffected; route behavior covered manually here (the auto-approve lives in `index.ts`, which has no unit harness).

- [ ] **Step 1: Add the `spawnProposalAgents` helper**

In `src/main/index.ts`, immediately after the `handleSpawnAgent` function (starts at :1112 — add after its closing brace), add. This is the exact loop from the current `approveProposal`, returning a summary:

```ts
// Spawn every agent in a team proposal (shared by manual approve + autonomous
// auto-approve). Returns how many spawned and their final unique names.
function spawnProposalAgents(proposal: TeamProposal): { spawned: number; total: number; names: string[] } {
  const ordered = [...proposal.agents].sort((a, b) => roleRank(a.role) - roleRank(b.role))
  const tabId = proposal.tabId || 'tab-default'
  const cwd = projectManager.currentProject?.path || process.cwd()
  let spawned = 0
  const names: string[] = []
  for (const a of ordered) {
    const config: AgentConfig = {
      id: uuidv4(),
      name: uniqueAgentName(a.name),
      cli: a.cli,
      cwd,
      role: a.role,
      ceoNotes: a.ceoNotes,
      shell: a.shell || (process.platform === 'win32' ? 'powershell' : 'bash'),
      admin: false,
      autoMode: a.autoMode,
      model: a.model,
      providerUrl: a.providerUrl,
      skills: a.skills,
      tabId,
      theme: a.theme
    }
    try {
      handleSpawnAgent(config)
      mainWindow?.webContents.send(IPC.AGENT_SPAWNED_REMOTE, {
        agentId: config.id, name: config.name, cli: config.cli, tabId: config.tabId
      })
      spawned++
      names.push(config.name)
    } catch (err: any) {
      console.error(`[proposal-spawn] spawn failed for ${a.name}:`, err?.message)
    }
  }
  return { spawned, total: ordered.length, names }
}
```

(`TeamProposal` is already imported on :41; `uuidv4`, `roleRank`, `uniqueAgentName`, `handleSpawnAgent`, `projectManager`, `mainWindow` are all in module scope.)

- [ ] **Step 2: Use the helper in `approveProposal`**

In `src/main/index.ts`, replace the team-spawn block at :498-540 (from `const ordered = [...proposal.agents]...` through the `return { success: true, spawned }`) with:

```ts
      const { spawned, total, names } = spawnProposalAgents(proposal)
      hub.proposalsChannel.resolve(proposalId, 'approved')
      try {
        const summary = spawned === total
          ? `User approved your team from 3DS. Spawned: ${names.join(', ')}.`
          : `User approved part of your team from 3DS. Spawned ${spawned}/${total}.`
        hub.messages.send('user', proposal.proposedBy, summary)
      } catch { /* orchestrator may not be reachable */ }
      return { success: true, spawned }
```

- [ ] **Step 3: Auto-approve in `onProposalAdded`**

In `src/main/index.ts`, replace the `onProposalAdded` assignment at :1544-1552:

```ts
  hub.proposalsChannel.onProposalAdded = (proposal) => {
    proposalsStore.saveProposal(proposal)
    mainWindow?.webContents.send(IPC.PROPOSAL_ADDED, proposal)
    // Show the main window so the user notices the modal
    if (mainWindow && !mainWindow.isFocused()) {
      mainWindow.show()
      mainWindow.flashFrame(true)
    }
  }
```

with:

```ts
  hub.proposalsChannel.onProposalAdded = (proposal) => {
    proposalsStore.saveProposal(proposal)
    // Autonomous session: auto-approve team proposals instead of prompting.
    if (proposal.kind === 'team' && autonomyStore?.isActive()) {
      const { spawned, total, names } = spawnProposalAgents(proposal)
      hub.proposalsChannel.resolve(proposal.id, 'approved')
      try {
        const orch = hub.registry.get(proposal.proposedBy)
        const summary = `🤖 Auto-spawned "${proposal.summary}" — ${spawned}/${total} agent(s): ${names.join(', ')}`
        hub.inboxChannel.postMessage(
          orch?.id ?? proposal.proposedBy, proposal.proposedBy, summary, 'urgent',
          [`autospawn:${proposal.id}`], proposal.tabId
        )
        hub.messages.send('user', proposal.proposedBy,
          `Autonomous session active — your team auto-spawned (${spawned}/${total}). Proceed.`)
      } catch { /* orchestrator may be unreachable */ }
      return
    }
    mainWindow?.webContents.send(IPC.PROPOSAL_ADDED, proposal)
    // Show the main window so the user notices the modal
    if (mainWindow && !mainWindow.isFocused()) {
      mainWindow.show()
      mainWindow.flashFrame(true)
    }
  }
```

- [ ] **Step 4: Skip the inbox mirror + flag the response in `/proposals`**

In `src/main/hub/routes.ts`, change the mirror guard at :368 from `if (inboxChannel) {` to:

```ts
      if (inboxChannel && !getScheduleBridge?.()?.autonomyEnabled()) {
```

Then change the response at :384 from `res.json(proposal)` to:

```ts
      res.json({ ...proposal, autoSpawning: getScheduleBridge?.()?.autonomyEnabled() === true })
```

- [ ] **Step 5: Tailor the `propose_team` tool result**

In `src/mcp-server/index.ts`, replace the `return toolResult({ ...result, next: ... })` in the `propose_team` handler (:682-685):

```ts
      return toolResult({
        ...result,
        next: 'Awaiting user approval in the confirmation modal. Continue other work; you will be notified when they decide.'
      })
```

with:

```ts
      const next = result.autoSpawning
        ? 'Autonomous session active — your team is spawning now. Continue working; you will get a confirmation message.'
        : 'Awaiting user approval in the confirmation modal. Continue other work; you will be notified when they decide.'
      return toolResult({ ...result, next })
```

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 7: Manual smoke test**

Run: `npm run dev`. Open a project, spawn an orchestrator agent (role `orchestrator`). With the session **OFF**, have it call `propose_team` → confirm the approval modal still appears (unchanged path). Then arm the session, call `propose_team` again → confirm the team spawns immediately with **no modal**, and an **urgent** inbox message `🤖 Auto-spawned …` appears (desktop inbox + mobile remote inbox).

Expected: off = modal; on = auto-spawn + urgent inbox.

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts src/main/hub/routes.ts src/mcp-server/index.ts
git commit -m "feat(autonomy): auto-approve team proposals during an active session"
```

---

## Task 4: `teardownAgent` helper + window prune on remote close

Consolidates the four duplicated kill paths into one `teardownAgent` helper, and adds an `AGENT_CLOSED_REMOTE` push so a non-window-initiated close removes the floating terminal in the renderer.

**Files:**
- Modify: `src/shared/types.ts` (IPC constant)
- Modify: `src/main/index.ts` (new `teardownAgent`; refactor KILL_AGENT :1805-1825, `killAgentByName` :2851-2868, close-tab loop :2632-2645, `killAllAgents` :2874-2888)
- Modify: `src/preload/index.ts` + `src/renderer/electron.d.ts` (`onAgentClosedRemote`)
- Modify: `src/renderer/App.tsx` (listener → `removeWindow`)

- [ ] **Step 1: Add the IPC constant**

In `src/shared/types.ts`, in the `IPC` object, add after `AGENT_SPAWNED_REMOTE` (search for it; it sits near the other agent channels):

```ts
  AGENT_CLOSED_REMOTE: 'agent:closed-remote',
```

- [ ] **Step 2: Add the `teardownAgent` helper**

In `src/main/index.ts`, after the `spawnProposalAgents` function added in Task 3, add. This is the exact body of the current `KILL_AGENT` handler plus the new `AGENT_CLOSED_REMOTE` push:

```ts
// Single source of truth for fully tearing down a live agent: kill the PTY,
// unregister from the hub, clear nudge state, drop config, and tell the
// renderer to remove the window. Used by every kill path.
function teardownAgent(managed: ManagedPty): void {
  const { id, name } = managed.config
  manualKills.add(id) // Prevent auto-reconnect
  killPty(managed)
  hub.registry.remove(name)
  hub.messages.clearAgent(name)
  pendingNudges.delete(name)
  lastNudgeDelivery.delete(name)
  const fallbackTimer = nudgeFallbackTimers.get(name)
  if (fallbackTimer) {
    clearTimeout(fallbackTimer)
    nudgeFallbackTimers.delete(name)
  }
  if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)
  initialPrompts.delete(id)
  hasReceivedInitialPrompt.delete(id)
  agents.delete(id)
  mainWindow?.webContents.send(IPC.AGENT_CLOSED_REMOTE, { agentId: id })
  mainWindow?.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
}
```

- [ ] **Step 3: Refactor the `KILL_AGENT` handler**

In `src/main/index.ts`, replace the handler body at :1805-1825:

```ts
  ipcMain.handle(IPC.KILL_AGENT, (_event, agentId: string) => {
    const managed = agents.get(agentId)
    if (managed) {
      manualKills.add(agentId) // Prevent auto-reconnect
      killPty(managed)
      hub.registry.remove(managed.config.name)
      hub.messages.clearAgent(managed.config.name)
      pendingNudges.delete(managed.config.name)
      lastNudgeDelivery.delete(managed.config.name)
      const fallbackTimer = nudgeFallbackTimers.get(managed.config.name)
      if (fallbackTimer) {
        clearTimeout(fallbackTimer)
        nudgeFallbackTimers.delete(managed.config.name)
      }
      if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)
      initialPrompts.delete(agentId)
      hasReceivedInitialPrompt.delete(agentId)
      agents.delete(agentId)
      mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
    }
  })
```

with:

```ts
  ipcMain.handle(IPC.KILL_AGENT, (_event, agentId: string) => {
    const managed = agents.get(agentId)
    if (managed) teardownAgent(managed)
  })
```

- [ ] **Step 4: Refactor `killAgentByName`**

In `src/main/index.ts`, replace the `killAgentByName` body at :2851-2868:

```ts
      killAgentByName: async (name: string) => {
        const managed = Array.from(agents.values()).find(m => m.config.name === name)
        if (managed) {
          manualKills.add(managed.config.id)
          killPty(managed)
          hub.registry.remove(name)
          hub.messages.clearAgent(name)
          pendingNudges.delete(name)
          lastNudgeDelivery.delete(name)
          const t = nudgeFallbackTimers.get(name)
          if (t) { clearTimeout(t); nudgeFallbackTimers.delete(name) }
          if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)
          initialPrompts.delete(managed.config.id)
          hasReceivedInitialPrompt.delete(managed.config.id)
          agents.delete(managed.config.id)
          mainWindow?.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
        }
      },
```

with:

```ts
      killAgentByName: async (name: string) => {
        const managed = Array.from(agents.values()).find(m => m.config.name === name)
        if (managed) teardownAgent(managed)
      },
```

- [ ] **Step 5: Refactor the close-tab loop**

In `src/main/index.ts`, the close-tab handler loops agents for a tab (:2632-2645). Replace the inner teardown block:

```ts
    for (const [agentId, managed] of agents) {
      if (managed.config.tabId === tabId) {
        manualKills.add(agentId)
        killPty(managed)
        hub.registry.remove(managed.config.name)
        hub.messages.clearAgent(managed.config.name)
        pendingNudges.delete(managed.config.name)
```

so that the matching branch calls the helper instead. Replace the whole `for` body for the matched agent with `teardownAgent(managed)`. Concretely, change the loop to:

```ts
    for (const [, managed] of agents) {
      if (managed.config.tabId === tabId) teardownAgent(managed)
    }
```

(Verify by reading :2632-2650 first; remove any now-duplicated per-field cleanup lines that followed, and any trailing single `AGENT_STATE_UPDATE` send for this loop — `teardownAgent` already sends it per agent.)

- [ ] **Step 6: Refactor `killAllAgents`**

In `src/main/index.ts`, replace the `killAllAgents` body at :2874-2888:

```ts
      killAllAgents: async () => {
        const ids = [...agents.keys()]
        for (const id of ids) {
          const managed = agents.get(id)
          if (managed) {
            manualKills.add(id)
            killPty(managed)
            hub.registry.remove(managed.config.name)
            hub.messages.clearAgent(managed.config.name)
            pendingNudges.delete(managed.config.name)
            if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)
          }
          agents.delete(id)
        }
        mainWindow?.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
      },
```

with:

```ts
      killAllAgents: async () => {
        for (const managed of [...agents.values()]) teardownAgent(managed)
      },
```

- [ ] **Step 7: Expose the renderer bridge**

In `src/preload/index.ts`, add right after the `onAgentSpawnedRemote` block (ends :39):

```ts
  onAgentClosedRemote: (callback: (info: { agentId: string }) => void) => {
    const handler = (_event: unknown, info: { agentId: string }) => callback(info)
    ipcRenderer.on(IPC.AGENT_CLOSED_REMOTE, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_CLOSED_REMOTE, handler)
  },
```

In `src/renderer/electron.d.ts`, add after `onAgentSpawnedRemote` (:47):

```ts
      onAgentClosedRemote: (callback: (info: { agentId: string }) => void) => () => void
```

- [ ] **Step 8: Prune the window in the renderer**

In `src/renderer/App.tsx`, immediately after the existing `onAgentSpawnedRemote` effect (ends :293), add:

```tsx
  // Remove the floating window when an agent is closed outside its own card
  // (orchestrator close_agents, streamdeck, etc.).
  useEffect(() => {
    const off = window.electronAPI.onAgentClosedRemote(({ agentId }) => removeWindow(agentId))
    return () => off()
  }, [removeWindow])
```

- [ ] **Step 9: Typecheck**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 10: Manual smoke test**

Run: `npm run dev`. Spawn 2 agents. Close one via its window's close button → it disappears (KILL_AGENT path still works). If a Stream Deck is connected, trigger a kill-by-name → the window now disappears too (previously it lingered). Confirm no agent is left in the agent list after either.

Expected: all kill paths remove both the process and the window.

- [ ] **Step 11: Commit**

```bash
git add src/shared/types.ts src/main/index.ts src/preload/index.ts src/renderer/electron.d.ts src/renderer/App.tsx
git commit -m "refactor(agents): single teardownAgent helper + prune window on remote close"
```

---

## Task 5: `close_agents` — bridge, route, MCP tool

Wires the session-gated, orchestrator-only batch close from MCP → hub route → `teardownAgent`, with self-protection and an urgent inbox summary.

**Files:**
- Modify: `src/main/hub/routes.ts` (`AgentBridge` type; `createRoutes` param; new `POST /agents/close`)
- Modify: `src/main/hub/server.ts` (`getAgentBridge` param)
- Modify: `src/main/index.ts` (`agentBridge` wiring + `createHubServer` call)
- Modify: `src/mcp-server/index.ts` (new `close_agents` tool)
- Test: `tests/unit/hub-close-routes.test.ts` (new)

- [ ] **Step 1: Write the failing route tests**

Create `tests/unit/hub-close-routes.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRoutes, type AgentBridge } from '../../src/main/hub/routes'

function makeApp(opts: {
  requester: any
  session: boolean
  agentBridge?: AgentBridge
  inbox?: any
}) {
  const registry = { get: (name: string) => (name === 'MainGuy' ? opts.requester : null) }
  const app = express()
  app.use(express.json())
  app.use(createRoutes(
    registry as any,            // registry
    {} as any,                  // messages
    { accessor: null },         // outputRef
    {} as any,                  // pinboard
    {} as any,                  // infoChannel
    { store: null },            // messageStoreRef
    { path: null },             // projectPathRef
    undefined,                  // groupManager
    (opts.inbox ?? { postMessage: vi.fn() }) as any, // inboxChannel
    undefined,                  // proposalsChannel
    () => ({ autonomyEnabled: () => opts.session } as any), // getScheduleBridge
    undefined,                  // getBoardBridge
    () => opts.agentBridge      // getAgentBridge
  ))
  return app
}

const ORCH = { id: 'o1', name: 'MainGuy', role: 'orchestrator', tabId: 'tab-default' }

describe('POST /agents/close', () => {
  it('403 when requester is not an orchestrator', async () => {
    const app = makeApp({ requester: { ...ORCH, role: 'worker' }, session: true, agentBridge: { close: vi.fn(() => ({ ok: true })) } })
    const res = await request(app).post('/agents/close').send({ requestedBy: 'MainGuy', targets: ['W1'] })
    expect(res.status).toBe(403)
  })

  it('403 when no autonomous session is active', async () => {
    const close = vi.fn(() => ({ ok: true }))
    const app = makeApp({ requester: ORCH, session: false, agentBridge: { close } })
    const res = await request(app).post('/agents/close').send({ requestedBy: 'MainGuy', targets: ['W1'] })
    expect(res.status).toBe(403)
    expect(close).not.toHaveBeenCalled()
  })

  it('blocks self, closes others, posts one urgent inbox summary', async () => {
    const close = vi.fn((n: string) => ({ ok: n !== 'Ghost' }))
    const inbox = { postMessage: vi.fn() }
    const app = makeApp({ requester: ORCH, session: true, agentBridge: { close }, inbox })
    const res = await request(app).post('/agents/close')
      .send({ requestedBy: 'MainGuy', targets: ['MainGuy', 'Worker', 'Ghost'] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ closed: ['Worker'], blocked: ['MainGuy'], notFound: ['Ghost'] })
    expect(close).toHaveBeenCalledWith('Worker')
    expect(close).not.toHaveBeenCalledWith('MainGuy')
    expect(inbox.postMessage).toHaveBeenCalledTimes(1)
    expect(inbox.postMessage.mock.calls[0][3]).toBe('urgent')
  })

  it('400 when targets is empty', async () => {
    const app = makeApp({ requester: ORCH, session: true, agentBridge: { close: vi.fn() } })
    const res = await request(app).post('/agents/close').send({ requestedBy: 'MainGuy', targets: [] })
    expect(res.status).toBe(400)
  })

  it('400 when requestedBy is missing', async () => {
    const app = makeApp({ requester: ORCH, session: true, agentBridge: { close: vi.fn() } })
    const res = await request(app).post('/agents/close').send({ targets: ['W1'] })
    expect(res.status).toBe(400)
  })

  it('503 when no agent bridge is wired', async () => {
    const app = makeApp({ requester: ORCH, session: true, agentBridge: undefined })
    const res = await request(app).post('/agents/close').send({ requestedBy: 'MainGuy', targets: ['W1'] })
    expect(res.status).toBe(503)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/hub-close-routes.test.ts`
Expected: FAIL — `AgentBridge` is not exported and `createRoutes` has no 13th param / no `/agents/close` route.

- [ ] **Step 3: Add the `AgentBridge` type + `createRoutes` param**

In `src/main/hub/routes.ts`, after the `BoardBridge` interface (ends :44) add:

```ts
/**
 * Injected by index.ts so the hub can tear down a live agent (which lives in
 * the main process). Used by the session-gated close_agents route.
 */
export interface AgentBridge {
  /** Tear down a live agent by name or id. ok=false when no such agent. */
  close: (nameOrId: string) => { ok: boolean }
}
```

Then extend the `createRoutes` signature — change the last param line (:58) from:

```ts
  getBoardBridge?: () => BoardBridge | undefined
): Router {
```

to:

```ts
  getBoardBridge?: () => BoardBridge | undefined,
  getAgentBridge?: () => AgentBridge | undefined
): Router {
```

- [ ] **Step 4: Add the `POST /agents/close` route**

In `src/main/hub/routes.ts`, immediately after the `router.get('/proposals/:id', ...)` handler (ends :402) add:

```ts
  // Session-gated, orchestrator-only batch close. Tears agents down via the
  // injected agent bridge; the calling agent can never close itself.
  router.post('/agents/close', (req: Request, res: Response) => {
    const { requestedBy, targets, reason } = req.body ?? {}
    if (typeof requestedBy !== 'string' || !requestedBy.trim()) { res.status(400).json({ error: 'requestedBy required' }); return }
    if (!Array.isArray(targets) || targets.length === 0) { res.status(400).json({ error: 'targets must be a non-empty array' }); return }
    const requester = registry.get(requestedBy)
    if (!requester) { res.status(404).json({ error: `Agent '${requestedBy}' not registered` }); return }
    if (!isOrchestratorRole(requester.role)) {
      res.status(403).json({ error: `close_agents is restricted to agents with role 'orchestrator' (yours: '${requester.role}')` })
      return
    }
    if (!getScheduleBridge?.()?.autonomyEnabled()) {
      res.status(403).json({ error: 'close_agents requires an active autonomous session. Ask the user to arm one.' })
      return
    }
    const bridge = getAgentBridge?.()
    if (!bridge) { res.status(503).json({ error: 'Agent control unavailable' }); return }

    const closed: string[] = []
    const blocked: string[] = []
    const notFound: string[] = []
    for (const t of targets) {
      if (typeof t !== 'string' || !t.trim()) continue
      if (t.trim().toLowerCase() === requestedBy.trim().toLowerCase()) { blocked.push(t); continue }
      const r = bridge.close(t)
      if (r.ok) closed.push(t); else notFound.push(t)
    }

    if (inboxChannel && closed.length > 0) {
      try {
        const text = `🗑️ Auto-closed ${closed.length} agent(s): ${closed.join(', ')}${reason ? ` — ${reason}` : ''}`
        inboxChannel.postMessage(requester.id, requestedBy, text, 'urgent', ['autoclose'], requester.tabId)
      } catch (err: any) {
        console.error('[hub:close] failed to post close summary:', err?.message)
      }
    }
    res.json({ closed, blocked, notFound })
  })
```

- [ ] **Step 5: Thread `getAgentBridge` through `createHubServer`**

In `src/main/hub/server.ts`, update the import (:10):

```ts
import { createRoutes, type OutputAccessor, type ScheduleBridge, type BoardBridge, type AgentBridge } from './routes'
```

Update the signature (:32-36):

```ts
export function createHubServer(
  preferredPort = 0,
  getScheduleBridge?: () => ScheduleBridge | undefined,
  getBoardBridge?: () => BoardBridge | undefined,
  getAgentBridge?: () => AgentBridge | undefined
): Promise<HubServer> {
```

Update the `createRoutes` call (:63) to append the new getter:

```ts
    app.use(createRoutes(registry, messages, outputRef, pinboard, infoChannel, messageStoreRef, projectPathRef, groupManager, inboxChannel, proposalsChannel, getScheduleBridge, getBoardBridge, getAgentBridge))
```

- [ ] **Step 6: Wire the `agentBridge` in main**

In `src/main/index.ts`, add the type to the routes import (:13):

```ts
import type { ScheduleBridge, BoardBridge, AgentBridge } from './hub/routes'
```

Add a module-level holder next to the other bridge holders (near :68):

```ts
let agentBridge: AgentBridge | null = null
```

Update the `createHubServer` call (:1430) to pass the getter:

```ts
  hub = await createHubServer(0, () => scheduleBridge ?? undefined, () => boardBridge ?? undefined, () => agentBridge ?? undefined)
```

Wire the bridge right after the `boardBridge = { ... }` block (ends :1655):

```ts
  // Wire the agent bridge so the close_agents route can tear down live agents.
  agentBridge = {
    close: (nameOrId) => {
      const managed = [...agents.values()].find(
        m => m.config.id === nameOrId || m.config.name.toLowerCase() === nameOrId.toLowerCase()
      )
      if (!managed) return { ok: false }
      teardownAgent(managed)
      return { ok: true }
    }
  }
```

- [ ] **Step 7: Run the route tests to verify they pass**

Run: `npx vitest run tests/unit/hub-close-routes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Add the `close_agents` MCP tool**

In `src/mcp-server/index.ts`, in the ORCHESTRATOR-ONLY block (after the `propose_team` tool, before `schedule_prompt` at :692), add:

```ts
server.tool(
  'close_agents',
  'ORCHESTRATOR ONLY, and only while an autonomous session is armed. Fully closes/deletes agent terminals from the workspace (kills the process, removes the window). Use to clean up retired/idle agents — pair with get_agents to find them. You cannot close yourself. Outside an autonomous session this is rejected; ask the user instead.',
  {
    names: z.array(z.string()).describe('Agent names (or ids) to close. Batch several to sweep idle agents in one call.'),
    reason: z.string().optional().describe('Optional short reason, included in the urgent inbox note to the user.')
  },
  async ({ names, reason }) => {
    try {
      const result = await hubFetch('/agents/close', {
        method: 'POST',
        body: JSON.stringify({ requestedBy: AGENT_NAME, targets: names, reason })
      })
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to close agents: ${err.message}`)
    }
  }
)
```

- [ ] **Step 9: Typecheck**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 10: Manual smoke test**

Run: `npm run dev`. Spawn an orchestrator + 2 worker agents. With the session **OFF**, have the orchestrator call `close_agents(["Worker-1"])` → it returns a 403-style error telling it to ask the user; nothing closes. Arm the session, call `close_agents(["Worker-1","MainGuy"])` → Worker-1's terminal disappears, `MainGuy` is reported `blocked`, and an **urgent** inbox note `🗑️ Auto-closed 1 agent(s): Worker-1` appears.

Expected: off = rejected; on = closes others, blocks self, urgent inbox logged.

- [ ] **Step 11: Commit**

```bash
git add src/main/hub/routes.ts src/main/hub/server.ts src/main/index.ts src/mcp-server/index.ts tests/unit/hub-close-routes.test.ts
git commit -m "feat(autonomy): session-gated close_agents cleanup sweep"
```

---

## Final verification

- [ ] Run the full unit suite: `npx vitest run` — expect all green (including the two autonomy files).
- [ ] Full build/typecheck: `npm run build` — expect success.
- [ ] End-to-end smoke: arm a 2h session → orchestrator `propose_team` auto-spawns (urgent inbox) → `close_agents` sweeps an idle worker (urgent inbox, window gone) → **End now** reverts → with session off, both `propose_team` and `close_agents` fall back to approval/rejection. Confirm urgent items also show on the mobile remote inbox.

---

## Self-Review

**Spec coverage:** session data model (T1) ✓; `isActive`/`startSession`/`endSession` + clamp + legacy read (T1) ✓; repoint `scheduleBridge.autonomyEnabled` (T1) ✓; IPC start/end/get/changed (T1/T2) ✓; expiry timer + re-arm + inbox note (T2) ✓; `spawnProposalAgents` extraction + auto-approve + skip-mirror + tool `next` (T3) ✓; `teardownAgent` + `AGENT_CLOSED_REMOTE` + renderer prune (T4) ✓; `AgentBridge` + `/agents/close` + `close_agents` + self-protection + session gate + urgent inbox (T5) ✓; UI (T1) ✓; tests for store + close route ✓.

**Known untested-by-unit (verified by build + manual):** `onProposalAdded` auto-approve branch and the expiry timer live in `src/main/index.ts`, which has no unit harness in this repo; each has explicit manual smoke steps. The `/proposals` skip-mirror is exercised via the close-route harness pattern and manual test.

**Type consistency:** `ProjectAutonomy = { sessionExpiresAt: number | null }` used identically across store, IPC, preload, typings, UI. `AgentBridge.close(nameOrId) → { ok }` matches the route call and the index wiring. Response shape `{ closed, blocked, notFound }` matches the test assertions. `spawnProposalAgents → { spawned, total, names }` matches both call sites.
