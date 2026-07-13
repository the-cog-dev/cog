# Agent auto-respawn on restart — plan

Goal: when the app relaunches, bring each workspace's agents back automatically
(fresh CLI processes re-oriented with a reconnect prompt — CLIs lose in-session
memory, so it's re-orientation, not perfect resume). User-configurable.

Branch: `feat/telegram-workspaces` (same as the workspace concurrency work).

## Setting — `agentRespawnMode` (settings.json, default `'active'`)
- `'all'`   — every workspace's roster respawns at boot.
- `'active'` — active workspace's roster respawns at boot; background workspaces
  respawn lazily on first switch to them.
- `'none'`  — never auto-respawn (clean start = today's behavior).

## The roster (per-folder DB)
Each context persists its live agent set to its OWN `.cog/cog.db` so it's
naturally workspace-scoped.
- Table `agent_roster (id TEXT PK, config TEXT json, updated_at TEXT)` in
  `src/main/db/database.ts`.
- `AgentRosterStore` (`src/main/db/agent-roster-store.ts`): save(config) /
  remove(id) / list(): AgentConfig[] / clear().
- `WorkspaceCtx.stores.roster`; factory constructs it.
- Persist on spawn: handleSpawnAgent saves the ORIGINAL config (skills compose
  into the registry copy, not `config`, so re-composition on respawn won't
  double). Save to the agent's OWN ctx (resolveForSpawn(config.tabId)).
- Remove on user-initiated teardown ONLY: teardownAgent removes from roster.
  closeCtxResources (app quit / context close) MUST NOT remove — that's what
  makes them respawn next boot. (closeCtxResources kills PTYs directly, never
  via teardownAgent, so roster is untouched on quit. Good.)

## Respawn
- Pure selector `resolveRespawnTargets(mode, activeId, contextIds, alreadyDone)`
  → ids to respawn now. Unit-tested (ABI blocks DB tests; this stays pure).
- `respawnRosterFor(ctx)`: for each roster config not already live
  (`!agents.has(id)`), call `handleSpawnAgent(config, { reconnect: true })`
  (reuses cwd/skills/metrics/roster-save/ctx-hub routing + buildReconnectPrompt).
  Track respawned ctx ids in a `respawnedRosters` Set to avoid double-spawn.
- Boot: after openProject + restoreBackgroundWorkspaces, respawn per mode
  (`active` → active only; `all` → active + every background context).
- Switch: activateWorkspace → if mode !== 'none' and ctx not respawned yet,
  respawn it (lazy path for `active` mode).

## Stage-4 completeness fix (do while here)
`reconnectAgent` still uses the GLOBAL `hub` for registry.remove/register — make
it use `hubForConfig(config)` so mid-session reconnect targets the agent's own
context hub too.

## Chunks (build + commit each; smoke test the pure bits)
- A: schema + AgentRosterStore + WorkspaceCtx.stores.roster + factory wiring +
  persist on spawn/teardown + reconnectAgent ctx-hub fix. Build green.
- B: setting read + `handleSpawnAgent(config, {reconnect})` + resolveRespawnTargets
  (+ smoke test) + respawnRosterFor + boot & switch wiring. Build green.
- C: Settings UI control (3-way). Build green.

## Verify
`npm run build`; `npx tsc -b --noEmit` (ignore pre-existing getPresets noise);
`npx vitest run src/main/workspace` (pure logic). Live: quit with agents up,
relaunch → active team returns re-oriented; switch → background team returns.
