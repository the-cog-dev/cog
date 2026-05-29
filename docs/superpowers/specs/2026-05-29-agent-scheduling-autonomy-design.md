# Agent Scheduling & Per-Project Autonomy — Design

**Date:** 2026-05-29
**Status:** Approved (brainstorm) — ready for implementation plan
**Scope:** V1 = agent-driven scheduling. Spawn & Reap autonomy are planned fast-follows (B), not in this spec.

---

## Overview

Agents currently have 26 MCP tools (messaging, pinboard, info channel, file ops, `get_agents`, `notify_user`, `propose_team`) but **no access to the prompt scheduler** — scheduling is user-only, driven from the Schedules panel. This feature gives agents the ability to create, list, and cancel **scheduled prompts** aimed at any agent in the project, so an orchestrator can self-direct instead of going idle after each prompt.

**Motivating use case:** an orchestrator kicking off "a 6-hour push for `sonnetworker2`" schedules a recurring prompt — *"post a 2-line progress sitrep to the info channel"* — every 40 minutes for 6 hours. No new reporting machinery is needed; the scheduled prompt drives the existing `post_info` / `send_message` tools.

This is governed by a **per-project autonomy** model: safe by default (agents *propose* schedules, the user approves), with an opt-in per-project toggle that lets trusted projects run autonomously.

## Goals

- Agents can schedule recurring prompts at any agent in the current project.
- **Default is safe:** scheduling requests are *proposed* to the user's inbox and approved before firing (protects tokens; safe for shared/community projects).
- A **per-project toggle** unlocks direct (autonomous) scheduling for trusted projects.
- Agent-created schedules are fully visible and controllable from the existing Schedules panel.

## Non-Goals (this spec)

- **Spawn autonomy** (orchestrator spawns agents/teams without approval) — fast-follow "B".
- **Reap autonomy** (orchestrator kills agents it no longer needs) — fast-follow "B".
- **Event-based wake** ("sleep until workers report") — explicitly dropped; agents already ping on completion, so it's redundant for current workflows.
- Global or per-agent autonomy scope — trust lives **per-project** only.

---

## Architecture

Three layers, each with one job:

1. **MCP tools** (`src/mcp-server/index.ts`) — the agent-facing API: `schedule_prompt`, `list_schedules`, `cancel_schedule`.
2. **Governance decision** (main process) — on `schedule_prompt`, read the current project's `autonomy.scheduling` flag and either call the scheduler directly (on) or create a `schedule`-kind proposal (off).
3. **Existing subsystems, extended** — the prompt scheduler (gains creator attribution), the proposals channel/store (gains a `kind` + `payload`), and the Settings UI (gains a per-project Autonomy section).

### Governance flow

```
agent → schedule_prompt(target_agent, prompt_text, interval_minutes, duration_hours, name?)
            │
            ▼
   project autonomy.scheduling?
       ┌────┴─────┐
      OFF        ON
       │          │
       ▼          ▼
  create        scheduler.create({ ...args, createdBy: <agentName> })
  schedule      → fires on the existing 30s tick
  proposal      → returns schedule_id to the agent
  → proposals channel
  → mirrored to inbox (+ mobile)
  → user approves → scheduler.create(payload)
  → (reject → nothing fires; optional feedback to agent)
```

**One tool, two behaviors**, decided entirely by the per-project flag. The autonomous path is identical to what the Schedules panel does today; the gated path reuses the `propose_team` approval plumbing.

---

## Component 1 — MCP tools

Added to the `agentorch` MCP server (`src/mcp-server/index.ts`), wired to the main process over the existing IPC/HTTP bridge the other tools use.

### `schedule_prompt`
Creates a recurring scheduled prompt aimed at an agent in the project.

| Param | Type | Notes |
|---|---|---|
| `target_agent` | string | Agent name or id in the current project. |
| `prompt_text` | string | The text injected into the target's PTY on each fire. |
| `interval_minutes` | integer | Minutes between fires. **Min floor: 5** (see Guardrails). |
| `duration_hours` | integer | How long the schedule runs before auto-expiring. **Required** (no infinite schedules). |
| `name` | string (optional) | Human label; auto-named `Schedule #N` if omitted. |

**Returns:**
- Autonomy ON → `{ status: 'scheduled', schedule_id, next_fire_at, expires_at }`
- Autonomy OFF → `{ status: 'proposed', proposal_id }` (with a note that user approval is required)

**Errors:** unknown `target_agent`; `interval_minutes` below floor; missing/invalid `duration_hours`; no project open.

### `list_schedules`
Returns active schedules for the current project so an agent can avoid duplicates and find its own jobs. Each entry: `{ schedule_id, name, target_agent, interval_minutes, duration_hours, next_fire_at, expires_at, status, created_by }`.

### `cancel_schedule`
`cancel_schedule(schedule_id)` — cancels a schedule. An agent may cancel **its own** schedules freely; cancelling a **user-created** schedule or another agent's is rejected (returns an error) to prevent agents tearing down jobs they didn't create. (User retains full control from the panel.)

---

## Component 2 — Per-project autonomy settings

### Storage
Stored in the **project's own `.cog/` database** (`cog.db`), *not* the global app settings file. This is the crux of per-project trust: the setting travels with the project folder and is isolated. A shared/community project's `.cog` has scheduling off (gated); a trusted local project has it on (autonomous).

Shape (extensible for the B fast-follows):
```ts
interface ProjectAutonomy {
  scheduling: boolean   // V1
  // spawn: boolean     // fast-follow B
  // reap: boolean      // fast-follow B
}
```
Default when absent: all `false` (gated).

### UI
A new **"Agent Autonomy"** section in `SettingsDialog`, alongside Notifications / Workspace Themes / Remote View / Stream Deck. Because trust is per-project, the section:
- Headers with the current project name ("Autonomy — *Sims2 decomp*").
- Greys out with a hint when no project is open.
- For V1 shows **one toggle: `Scheduling`** (off by default). `Spawn`/`Reap` rows slot in here for the B fast-follow; no dead "coming soon" toggles shipped now.

**Refactor (cleanup-in-place):** `SettingsDialog.tsx` is ~1,200 lines. Extract the autonomy UI into its own `AutonomySettings.tsx` component the dialog renders, rather than inlining ~80 more lines into an already-oversized file.

---

## Component 3 — Proposals extension (gated path)

Reuse the single proposals system rather than building a parallel "schedule proposals" lane (which would duplicate inbox mirroring, approve/reject UI, and mobile sync).

**Data model** (`proposals-store.ts`, `shared/types.ts`):
- Add `kind: 'team' | 'schedule'` — existing rows migrate to `'team'`.
- Add `payload` (JSON) — carries the schedule args for `'schedule'` kind. `'team'` keeps using its existing `agents` column.

**Approve handler** branches on `kind`:
- `'team'` → spawn agents (today's behavior, untouched).
- `'schedule'` → `scheduler.create(payload)` with `createdBy` = the proposing agent.

Reject is already kind-agnostic (optional feedback routes back to the proposer). Inbox + mobile mirroring already in place, so a proposed schedule appears on the phone and can be approved there.

---

## Component 4 — Schedule attribution

The `ScheduledPrompt` record has no creator field today. Add attribution so agent-made schedules are distinguishable and controllable:

- `shared/types.ts`: `ScheduledPrompt` and `CreateScheduleInput` gain `createdBy: string` (`'user'` or the creator agent's name).
- `schedules-store.ts`: add a `created_by` column; existing rows default to `'user'`.
- `prompt-scheduler.create()`: persists `createdBy` (defaults to `'user'` when called from the panel).
- Schedules panel: render a creator badge — **👤 you** vs **🤖 orchestrator → sonnetworker2**. The target agent is already shown. Existing pause/delete controls operate on agent-made schedules identically.

---

## Data migrations

Both additive, with defaults so existing data is untouched:
- `proposals`: add `kind` (default `'team'`), `payload` (default `NULL`).
- `schedules`: add `created_by` (default `'user'`).

---

## Guardrails (apply in BOTH modes)

Autonomy means "no approval needed," not "no sanity limits":
- **`duration_hours` required** — every agent-created schedule auto-expires; no infinite loops.
- **Minimum interval floor: 5 minutes** — a confused agent can't schedule a 10-second loop and burn tokens overnight. (`schedule_prompt` rejects below the floor; the user's own panel is unaffected.)

The default gated mode (proposals) remains the primary token-safety mechanism; these floors are the backstop for autonomous projects.

---

## Testing

- **Scheduler:** `createdBy` persists and round-trips; panel attribution renders correctly; existing schedule tests stay green.
- **Governance:** with `scheduling` off, `schedule_prompt` creates a `schedule` proposal and fires nothing; with it on, it calls `scheduler.create` directly. Toggle is read per-project.
- **Proposals:** a `schedule`-kind proposal approves into a live schedule; `team` proposals still spawn; reject fires nothing; existing rows read back as `kind: 'team'`.
- **Tool validation:** unknown target, sub-floor interval, missing duration, no-project-open all return clean errors.
- **Migrations:** opening a pre-existing project backfills `kind='team'` / `created_by='user'` without data loss.

---

## Out of scope / fast-follows

- **B — Spawn autonomy:** flip `propose_team`'s gate via an `autonomy.spawn` toggle (most plumbing already exists).
- **B — Reap autonomy:** new `stop_agent` MCP tool gated by `autonomy.reap`, **scoped to agents the orchestrator spawned or shares a team/group with** — never arbitrary peers.
- Both reuse the autonomy framework, settings section, and proposals system built here.
