# P2b Execution Plan — concurrent per-workspace contexts (N hubs)

Self-contained plan for a fresh (post-compaction) agent to execute cold. Goal:
each open workspace runs its own project context (own hub + DB + stores +
scheduler) concurrently in one process; the active workspace drives the UI; each
team keeps running when you switch away.

## Branch / safety
- All work on branch `feat/telegram-workspaces`. Commit after EVERY stage.
- Verify each stage with `npm run build` (exit 0 = bundles). The project has NO
  tsc gate (esbuild + vitest only); use `npx tsc -b --noEmit 2>&1 | grep <yourfiles>`
  to check YOUR files (ignore pre-existing `string | string[]` express noise +
  missing electron.d.ts methods like `getLinks`/`racGetSessions`).
- DB-backed vitest tests fail on this machine (better-sqlite3 ABI 145 vs node 137)
  — pre-existing, unrelated. Telegram + workspace tests DO run (65 pass).
- The app can only be run-tested by the USER (`npm run dev`, then restart after
  each stage). Ask them to restart + run the stage's Acceptance check.

## Architecture decision: N HubServers (not one routing hub)
Each workspace = a `WorkspaceCtx` = { own HubServer (own port), db, stores,
promptScheduler, bridges }. Reuses the existing `openProject`/`createHubServer`
wiring wholesale — no routes.ts or MCP-header changes. Agents connect to their
context's hub URL at spawn. Module globals (`hub`, `currentDb`, `current*Store`,
`autonomyStore`, `boardStore`, `promptScheduler`) MIRROR THE ACTIVE context so the
~135 existing IPC handlers follow the active workspace unchanged.

## DONE — Stage 1 (commit ee0296f)
In `src/main/index.ts`:
- `interface WorkspaceCtx { workspaceId, projectPath, hub, db, stores{message,
  pinboard,info,inbox,proposals,schedules,autonomy,board,boardAppearance},
  promptScheduler }` (near line ~72).
- `const contexts = new Map<string, WorkspaceCtx>()`, `let activeWorkspaceId`.
- `function setActiveContext(ctx)` — reassigns all the module globals from ctx.
- `openProject` registers its context + calls `setActiveContext`; `closeProject`
  does `contexts.delete(activeWorkspaceId)`.
- Behavior identical (one context today).

## Key files / anchors (line numbers drift — search by name)
- `src/main/index.ts`:
  - `openProject(projectPath)` ~1766 — the 330-line setup to extract.
  - `closeProject()` ~2101 — teardown.
  - `handleSpawnAgent(config)` ~1333 — spawn chokepoint (already sets cwd from
    workspace via `workspaceManager.projectPathFor(config.tabId)`).
  - `setupPreSpawn` ~1191 — "all pre-spawn setup"; writes the MCP config (HUB_URL).
  - `activeWorkspaceProjectPath()` — folder-scoped UI helper (git/files/top-left).
  - TAB_SET_ACTIVE handler ~3071 (currently only `workspaceManager.setActive`).
  - `armAutonomyExpiry()` / `onAutonomyExpired()` ~170 — reads global autonomyStore.
- `src/main/hub/server.ts` — `createHubServer(port, getScheduleBridge, getBoardBridge, getAgentBridge)`.
- `src/main/workspace/workspace-manager.ts` — `projectPathFor(id)`, `getActiveId()`, `setActive(id)`, `list()`.
- DELETE `src/main/hub/project-context.ts` — it's the channels-container shape for
  the rejected routing-hub design; unused and wrong for N-hubs.

## Minefields (the reason this is staged, not one shot)
1. **autonomy ordering**: `armAutonomyExpiry()` reads the GLOBAL `autonomyStore`
   mid-`openProject`. In the factory `autonomyStore` is a local. FIX: arm autonomy
   AFTER `setActiveContext(ctx)` (global is set by then), or pass `ctx.stores.autonomy`.
2. **promptScheduler is referenced in ~5 places**: the scheduleBridge closure,
   TAB_CLOSE (`promptScheduler.deleteByTabId`), the schedule IPC handlers in
   setupIPC, and the scheduler `onChange`. The ctx's own bridge/wiring must use
   the CTX-LOCAL scheduler; external IPC handlers use the active global.
3. **bridges must be per-context**: `createHubServer` gets `() => scheduleBridge`
   (global today). For N hubs, build per-ctx bridges (closing over ctx-local
   promptScheduler/boardStore/db + the GLOBAL `agents` map) and pass THOSE to that
   ctx's createHubServer. Otherwise a non-active hub uses the active context's bridge.
4. **UI-push guards** (Stage 3): every wiring hook that does
   `mainWindow.webContents.send(...)` must guard `if (ctx.workspaceId === activeWorkspaceId)`
   so a background workspace doesn't spam the active UI. Telegram relay stays
   UNGUARDED (all workspaces relay, prefixed by project — see relay-format). Persist
   to ctx store ALWAYS. Enumerate the sites: pinboard onTaskCreated/Updated/Deleted,
   infoChannel onEntryAdded, inbox onMessageAdded/Updated/Deleted, proposals
   onProposalAdded/Resolved, scheduler onChange/onResumed.
5. **agents Map is global** (all workspaces, keyed by id, each has tabId). Filter by
   tabId where per-workspace views are needed. teardown/kill operate per-agent — fine.
6. **remote view** (`disableRemoteView` in closeProject) — leave tied to active
   context for now; revisit later.

## Stage 2 — extract `createWorkspaceContext` factory (STILL one context, behavior-identical)
1. New `async function createWorkspaceContext(workspaceId: string, projectPath: string): Promise<WorkspaceCtx>`:
   - Move `openProject`'s body into it, but every `hub`/store/scheduler/bridge is a
     LOCAL const (not a global assignment).
   - `const hub = await createHubServer(0, () => scheduleBridgeLocal, () => boardBridgeLocal, () => agentBridgeLocal)`
     — declare the three bridge vars with `let` BEFORE createHubServer, assign the
     ctx-local bridge objects after (they're lazy getters, so late assignment is fine).
   - Register the "user" virtual agent on `hub.registry`.
   - Restore persisted state into hub channels from the ctx stores.
   - Wire the channel hooks against the ctx locals (persistence + UI push + telegram).
     Do NOT add the active-guards yet (one context = always active); leave a
     `// STAGE 3: guard UI push with activeWorkspaceId` comment at each push site.
   - Build + start the ctx-local promptScheduler (uses ctx schedules store).
   - Return `{ workspaceId, projectPath, hub, db, stores{...}, promptScheduler }`.
2. `openProject(projectPath)` becomes:
   - `if (hub) await closeProject()`
   - `projectManager.initProject(projectPath)`
   - `const ctx = await createWorkspaceContext(activeWorkspaceId, projectPath)`
   - `contexts.set(ctx.workspaceId, ctx); setActiveContext(ctx)`
   - `armAutonomyExpiry()` (AFTER setActiveContext — global is set)
   - `setupMessageNudge/TaskNudge/InfoNudge/StaleTaskWatchdog(); loadLinkState()`
     (these are global one-time-ish; keep once. Check they don't double-register.)
   - window title + PROJECT_CHANGED.
3. **Acceptance (user restart):** single project works identically — spawn a team,
   inbox/tasks/git/files, autonomy arm/expire, scheduled prompts. Commit.

## Stage 3 — concurrency: multiple live contexts + switch
1. `TAB_SET_ACTIVE` handler: after `workspaceManager.setActive(id)`:
   - `let ctx = contexts.get(id)`
   - if `!ctx` and workspace folder-bound (`workspaceManager.projectPathFor(id)`):
     `ctx = await createWorkspaceContext(id, wsPath); contexts.set(id, ctx)` — WITHOUT
     closing others.
   - if ctx: `setActiveContext(ctx)`; `mainWindow.webContents.send(PROJECT_CHANGED, {name: basename(ctx.projectPath), path: ctx.projectPath, ...})`; refresh UI (agent list, etc.).
   - if unbound (default tab): setActiveContext to the default ctx.
2. Add the UI-push guards from minefield #4 at every send site (guard by ctx id ===
   activeWorkspaceId). Telegram relay unguarded.
3. Split `closeProject` → `closeWorkspaceContext(id)`: stop that ctx's scheduler,
   close its hub + db, teardown its agents (filter `agents` by tabId===id), delete
   from map. App-quit closes all contexts. TAB_CLOSE handler calls it.
4. Do NOT tear down all on switch.
5. **Acceptance (user restart):** make WS2 folder-bound, switch to it → top-left +
   git + inbox + tasks reflect WS2; switch back → WS1's team still alive and its
   state intact. Commit.

## Stage 4 — route agents to their context's hub
1. In `handleSpawnAgent`/`setupPreSpawn`, resolve `const ctx = contexts.get(config.tabId) ?? contexts.get(activeWorkspaceId)`; write the MCP config's HUB_URL/secret from `ctx.hub.port` / `ctx.hub.secret` (find where HUB_URL is written — likely config-writer or setupPreSpawn env).
2. **Acceptance:** an agent spawned in WS2 posts to WS2's hub → its inbox/tasks land
   in WS2's `.cog/cog.db`, not WS1's. Commit.

## Stage 5 — boot: restore contexts
1. Option A (simpler): lazy — contexts are created on first switch (Stage 3). Good enough for v1.
2. Option B (better): on startup, after the default project opens, eagerly
   `createWorkspaceContext` for every folder-bound workspace in `workspaceManager.list()`
   so their hubs are live and agents can reconnect immediately.
3. Migrate: the existing single project becomes the `tab-default` context.
4. **Acceptance:** restart with N workspaces → N live contexts; per-workspace state
   persists to each folder's own DB. Commit.

## After P2b
- Full isolation done: each workspace = its own folder + team + DB, concurrent, UI
  follows active. Then revisit the user's "superchats" Telegram idea (parked).
