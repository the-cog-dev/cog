# Autonomous Session Design

**Date:** 2026-06-05
**Status:** Approved (brainstorm)
**Topic:** Time-boxed autonomous session — orchestrator may auto-spawn agents/teams (and self-schedule) without approval while a user-armed session is active.

---

## Goal

Let an orchestrator **manage its own roster without waiting for manual approval** — spawn agents/teams *and* close/delete idle ones — but only while the user has explicitly armed a **time-boxed autonomous session**. The session governs self-scheduling, team-spawning, and agent-closing under a single switch + timer, auto-reverts to approval-required when it expires, and posts an **urgent inbox message on every auto-spawn and every auto-close** so the user always has an audit trail of what happened while away.

**Motivating use case:** long unattended runs (e.g. the Sims 2 decomp fleet). Today `propose_team` always blocks on approval, so a 30-hour session stalls every time the orchestrator wants more agents — and there's no way for it to tidy up the pile of retired/idle agents (e.g. ~9 idle Opus terminals) that accumulates over a long session. With a session armed, the crew keeps moving, the orchestrator sweeps dead weight, and the user reviews the urgent inbox log when they return.

## Background — what already exists

- **`ProjectAutonomy`** (`src/shared/types.ts`) is a per-project setting, today `{ scheduling: boolean }`, persisted in the `project_settings` table via **`AutonomyStore`** (`src/main/db/autonomy-store.ts`), surfaced as one toggle in **`AutonomySettings.tsx`**.
- **`schedule_prompt`** (MCP) → `POST /schedules` already branches on autonomy: `scheduleBridge.autonomyEnabled()` true → schedule created immediately; false → routed to a `kind:'schedule'` pending proposal in the inbox.
- **`propose_team`** (MCP) → `POST /proposals` has **no bypass today** — it always creates a `kind:'team'` pending proposal, mirrored into the inbox as `high`, surfaced as a desktop modal via `IPC.PROPOSAL_ADDED`, and only spawned when the user approves (desktop modal or mobile inbox → `approveProposal` IPC → per-agent `handleSpawnAgent`).

This feature reuses that pipeline: the same propose→spawn code runs, but main **auto-approves** it while a session is active.

## Chosen approach

**Reuse the proposal pipeline, auto-approve in main** (vs. spawning directly from the hub route, or adding a separate `spawn_team` MCP tool). `propose_team` still creates the proposal *record* (persistent audit trail). Main's existing `onProposalAdded` hook decides auto vs. pending, and the auto path runs the **same spawn code the approve button already runs** (extracted into a shared helper — no duplication). Minimal new surface, full history, identical spawn semantics.

---

## Data model

`src/shared/types.ts`:

```ts
export interface ProjectAutonomy {
  /** Epoch ms when the current autonomous session expires. null/absent = off. */
  sessionExpiresAt: number | null
}
```

- **"Session active"** ⇔ `sessionExpiresAt != null && Date.now() < sessionExpiresAt`.
- The legacy `scheduling: boolean` field is **superseded**. On load, any legacy value maps to "off" (no active session). Off-by-default is the safe migration and the user is the sole operator.
- Stored per-project in `project_settings` under the existing `autonomy` key, JSON-encoded, exactly as today.

`AutonomyStore` gains:

```ts
get(): ProjectAutonomy                       // existing, returns { sessionExpiresAt }
isActive(): boolean                          // sessionExpiresAt != null && Date.now() < it
startSession(durationHours: number): ProjectAutonomy   // sessionExpiresAt = now + h*3600_000
endSession(): ProjectAutonomy                // sessionExpiresAt = null
```

`startSession` clamps `durationHours` to a sane range (min 0.25h, max 72h).

---

## Components & file changes

| File | Change |
|------|--------|
| `src/shared/types.ts` | `ProjectAutonomy` → `{ sessionExpiresAt: number \| null }`. |
| `src/main/db/autonomy-store.ts` | Add `isActive()`, `startSession(h)`, `endSession()`; `get()` returns the new shape (with graceful legacy read). |
| `src/main/index.ts` | (1) Repoint `scheduleBridge.autonomyEnabled` → `autonomyStore.isActive()`. (2) Extract `spawnProposalAgents(proposal)` from the current `approveProposal` team-spawn loop; call it from both `approveProposal` and the new auto path. (3) In `onProposalAdded`: if `isActive()` and `kind === 'team'` → auto-approve (spawn + urgent inbox + notify orchestrator + **skip** modal); else existing behavior. (4) IPC: replace `AUTONOMY_SET` with `AUTONOMY_START`(durationHours) and `AUTONOMY_END`; keep `AUTONOMY_GET`. (5) Arm/disarm a one-shot expiry timer; re-arm on startup from stored `sessionExpiresAt`. (6) On expiry: post inbox note + push `AUTONOMY_CHANGED` to renderer. (7) Extract **`teardownAgent(managed)`** from the 4 duplicated kill paths; emit `AGENT_CLOSED_REMOTE(agentId)` inside it. (8) Inject a `closeAgentByName(name)` callback into the hub routes that runs `teardownAgent`. |
| `src/main/hub/routes.ts` | (a) In `POST /proposals`: when `getScheduleBridge()?.autonomyEnabled()` is true, **skip** the `high` inbox mirror (main posts the urgent one instead) and adjust the MCP `next` text to "Autonomous session active — spawning now." Proposal record is still created so `onProposalAdded` fires. (b) Add **`POST /agents/close`**: orchestrator-role gate + session-active gate + self-protection; calls the injected `closeAgentByName`; posts one urgent inbox summary; returns `{ closed, blocked, notFound }`. |
| `src/mcp-server/index.ts` | Add **`close_agents(names, reason?)`** in the orchestrator-only block → `POST /agents/close`. Description spells out: session-only, cannot close self, batch sweep, pair with `get_agents`. |
| `src/shared/types.ts` (the `IPC` constants object) | Add `AUTONOMY_START: 'autonomy:start'`, `AUTONOMY_END: 'autonomy:end'`, `AUTONOMY_CHANGED: 'autonomy:changed'`, `AGENT_CLOSED_REMOTE: 'agent:closed-remote'`; remove `AUTONOMY_SET`. |
| `src/preload/index.ts` + `src/renderer/electron.d.ts` | Expose `startAutonomySession(hours)`, `endAutonomySession()`, keep `getAutonomy()`, add `onAutonomyChanged(cb)` and `onAgentClosedRemote(cb)`. |
| `src/renderer/components/AutonomySettings.tsx` | Rework single toggle → session control: switch + duration dropdown + live countdown + red warning + "End now"; subscribe to `AUTONOMY_CHANGED`. |
| `src/renderer/App.tsx` | Subscribe to `AGENT_CLOSED_REMOTE` → `removeWindow(agentId)` so an orchestrator-closed terminal disappears from the workspace. |
| `tests/unit/autonomy-store.test.ts` | Extend for `isActive`/`startSession`/`endSession`/boundary/rehydrate. |
| `tests/unit/*` | (a) `onProposalAdded` auto-approve branch (active → spawn + urgent inbox + no modal; inactive → pending). (b) `POST /agents/close` route: orchestrator+session required, self → blocked, unknown → notFound, valid → closed + urgent inbox. |

---

## Spawn flow (session active)

1. Orchestrator calls `propose_team` → `POST /proposals` creates the `kind:'team'` proposal record. Because the session is active, the route **skips** the "needs approval" inbox mirror.
2. `onProposalAdded` fires in main. Session active + `kind:'team'` →
   a. `spawnProposalAgents(proposal)` — the loop extracted from `approveProposal`: per agent build `AgentConfig`, `handleSpawnAgent`, emit `AGENT_SPAWNED_REMOTE`. Returns `{ spawned, names }`.
   b. `hub.proposalsChannel.resolve(id, 'approved')`.
   c. **Urgent inbox post:** `inboxChannel.postMessage(orchestratorAgentId, proposedBy, "🤖 Auto-spawned \"<summary>\" — <spawned> agent(s): <names>", 'urgent', ['autospawn:<id>'], tabId)`. Renders on desktop inbox **and** mobile remote inbox.
   d. Notify the orchestrator (`hub.messages.send`) that the team auto-spawned so it proceeds.
   e. **Do not** send `IPC.PROPOSAL_ADDED` (no modal) and do not force-show the window.
3. Session **off/expired** → unchanged current behavior (pending proposal, `high` inbox mirror, desktop modal, manual approve).

**Schedules under a session:** `schedule_prompt` already auto-creates immediately when `autonomyEnabled()` (now `isActive()`) — so no `kind:'schedule'` proposal is ever created during a session, and `onProposalAdded`'s auto path only ever handles `kind:'team'`. The urgent-inbox alert is intentionally scoped to **spawns only** (not schedule creation) to avoid noise.

---

## Agent cleanup — close/delete capability (session-gated)

While a session is armed the orchestrator can also **fully close/delete agent terminals** from the workspace (kill the PTY, unregister from the hub, remove the floating window). This is the symmetric counterpart to auto-spawn: spawn the crew you need, retire the dead weight.

**New MCP tool** (`src/mcp-server/index.ts`), in the ORCHESTRATOR-ONLY block:

```
close_agents(names: string[], reason?: string)
```

- ORCHESTRATOR ONLY, and only effective while an **autonomous session is active**. Outside a session it returns a clear error telling the orchestrator to ask the user instead (no proposal path — closing is a session-only power in v1).
- **Self-protection:** the calling agent cannot close itself (any except itself — co-orchestrators *are* closable). A self target is reported as `blocked`, not an error.
- Batch by design so a single call can sweep several idle agents. Targets are agent names or ids; the orchestrator typically pairs this with `get_agents` to find idle/retired ones.
- → `POST /agents/close` on the hub.

**Hub route** (`src/main/hub/routes.ts`) — `POST /agents/close`, body `{ requestedBy, targets: string[], reason? }`:
1. `requestedBy` must be registered and `isOrchestratorRole` (mirror of the `propose_team` gate) → else 403.
2. Session must be active (`getScheduleBridge()?.autonomyEnabled()` → now `isActive()`) → else 403 `autonomous session required`.
3. For each target: resolve via registry; `== requestedBy` → `blocked`; unresolved → `notFound`; else call the injected close callback.
4. Post one **urgent** inbox message summarizing the sweep: `🗑️ Auto-closed N agent(s): <names>` (+ any blocked/notFound), tag `autoclose`.
5. Respond `{ closed: string[], blocked: string[], notFound: string[] }`.

**Main wiring** (`src/main/index.ts`):
- Extract the duplicated teardown sequence (currently copy-pasted across `KILL_AGENT`, `killAgentByName`, the close-tab loop, and `killAllAgents`) into one **`teardownAgent(managed)`** helper: `manualKills.add` → `killPty` → `registry.remove` → `messages.clearAgent` → nudge/timer cleanup → `cleanupConfig` (or Pi dir cleanup) → map deletes → `agents.delete` → **send `AGENT_CLOSED_REMOTE(agentId)`** → `send AGENT_STATE_UPDATE(getVisibleAgents())`. All existing kill paths switch to it (DRY).
- **`AGENT_CLOSED_REMOTE`** is a new main→renderer push mirroring `AGENT_SPAWNED_REMOTE`; the renderer listens and calls `removeWindow(agentId)` so the panel actually disappears (today only the agent list refreshes via `AGENT_STATE_UPDATE`, which doesn't prune windows). Idempotent — `removeWindow` on an already-gone id is a no-op.
- Inject a `closeAgentByName(name) → { ok: boolean }` callback into the hub routes (alongside `scheduleBridge`) that resolves the managed agent and runs `teardownAgent`.

**Renderer** (`src/renderer`): add an `AGENT_CLOSED_REMOTE` listener → `removeWindow(agentId)`; expose nothing new in preload (close is orchestrator-driven via MCP, not a renderer action).

## UI — `AutonomySettings.tsx`

```
┌─ Agent Autonomy — <project> ─────────────────┐
│ ⚠ Autonomous session                  ◉ ON   │
│   Duration  [ 6h ▾ ]   ·   4h 12m left       │
│                                              │
│   While active, agents self-schedule,        │
│   spawn teams, AND close idle agents — no     │
│   approval. Each spawn/close → 📥 urgent.     │
│                                    [ End now ]│
└──────────────────────────────────────────────┘
```

- **Duration dropdown:** presets `2h / 6h / 12h / 24h` plus a "Custom…" numeric hours field. Selecting a duration and flipping the switch on calls `startAutonomySession(hours)`.
- **Countdown:** a client-side `setInterval` re-renders "Xh Ym left" from `sessionExpiresAt`; no polling of main.
- **Red/warning styling** on the whole panel while armed so its state is unmistakable.
- **"End now"** calls `endAutonomySession()` → instant revert.
- Subscribes to `AUTONOMY_CHANGED` so the UI flips off live when main's expiry timer fires.
- Disabled with a hint when no project is open (matches current behavior).

## Safety & edge cases

- **Auto-expiry:** main arms a one-shot `setTimeout` at `sessionExpiresAt`. On fire → `endSession()`, post inbox note `Autonomous session ended — approvals required again`, push `AUTONOMY_CHANGED`. Disarmed/re-armed on `startSession`/`endSession`.
- **Restart safety:** session is just a timestamp. On app start, if `sessionExpiresAt` is still in the future, re-arm the expiry timer for the remaining time; if already past, treat as off.
- **Manual override wins:** "End now" and expiry both funnel through `endSession()`.
- **Feature is off by default and fail-safe:** session off/expired → the entire current approval flow is untouched. No behavioral change when unarmed.
- **Duration clamp:** `startSession` enforces min 0.25h / max 72h so an absurd value can't create a practically-infinite window.
- **No hard agent cap** (per decision): the time-box is the blast-radius control, and every spawn/close is logged urgent so the user can intervene (End now) on return.
- **Close is session-only and self-safe:** `close_agents` is rejected entirely when no session is active, and the calling agent can never close itself (a self target is reported `blocked`, not executed).

## Out of scope (v1)

- Mobile start/extend of the session (desktop-only control for v1; mobile still **sees** urgent auto-spawn/auto-close alerts via the existing remote inbox).
- A per-session concurrent-agent cap.
- Urgent alerts for schedule auto-creation (spawns/closes only).
- A propose-to-close flow when the session is off — closing is session-only in v1; with no session armed the orchestrator must ask the user.

## Testing

- **`AutonomyStore`:** `isActive()` true inside window / false at and after `sessionExpiresAt`; `startSession` sets a future timestamp and clamps; `endSession` clears; legacy `{ scheduling:true }` reads as off; rehydrate-from-store keeps an in-window session active.
- **Auto-approve branch:** with a stubbed active store + fake proposal, `onProposalAdded` spawns each agent, resolves the proposal `approved`, posts exactly one `urgent` inbox message, and does **not** emit `PROPOSAL_ADDED`; with an inactive store it falls through to the pending path.
- **Proposals route:** `POST /proposals` skips the `high` inbox mirror when the bridge reports active, still creates the proposal.
- **Close route:** `POST /agents/close` → 403 when requester isn't an orchestrator; 403 when no session is active; a self target comes back in `blocked` (PTY untouched); an unknown name comes back in `notFound`; valid targets come back in `closed`, invoke `closeAgentByName`, and post exactly one `urgent` inbox summary.
- **`teardownAgent`:** one call fully removes the agent (registry, maps, PTY) and emits `AGENT_CLOSED_REMOTE`; the existing kill paths still behave after the refactor.
- Follow the existing `tests/unit/autonomy-store.test.ts` and hub-route test patterns.
