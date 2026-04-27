# Agent Context-Menu Edit + Respawn Design

## Goal

Let the user right-click any agent's title bar and edit the same fields they could pick when spawning it (CLI, model, provider, role, CEO notes, skills, shell, admin, autoMode, cwd, name, advanced). Saving kills the agent and respawns it in the same window slot with the new config — effectively "delete and add a new agent" but without losing the slot it occupied. The existing color popover stays as the fast color-only path; the new edit dialog is the "real edits" path.

This unifies what is today three separate flows (right-click colors, kill+spawn, preset edit) into one coherent right-click menu, and along the way pulls SpawnDialog's form into a reusable `<AgentConfigForm/>` so the form fields stay in sync between Spawn and Edit.

## UX Flow

1. **Right-click agent title bar** → existing popover appears, but with two sections:
   - **Top:** the existing color swatches and theme presets (unchanged)
   - **Bottom:** a thin divider and a new `Edit agent…` button
2. **Click `Edit agent…`** → centered modal opens, pre-filled with the agent's current `AgentConfig`. Same look and feel as `SpawnDialog`, but:
   - Header reads `Edit Agent — <current name>`
   - Submit button reads `Save & Respawn`
   - A small "Cancel" button discards changes (with a confirm if the form is dirty)
3. **Click `Save & Respawn`**:
   - If the agent's current status is `working` → small inline confirm: *"Agent is busy — kill and respawn anyway?"* User confirms or cancels.
   - If status is anything else (`idle`, `waiting`, etc.) → proceed without confirm.
4. **Respawn happens:**
   - Old PTY dies, terminal scrollback wipes, message history under the old name clears
   - New PTY spawns with the new config
   - **Window position and `agent.id` are preserved** — the new agent appears in the exact same x/y/width/height
5. Modal closes; agent is now running with the new config.

The right-click menu is **agents-only**. The Trollbox panel keeps its own custom context menu (`TrollboxThemeMenu`); other panel types keep the plain color picker.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                            Workspace.tsx                           │
│                                                                    │
│   owns: editingAgentId state                                       │
│                                                                    │
│   wires FloatingWindow's onTitleBarContextMenu for agents to       │
│   render <ThemeMenu/> with onEdit={() => setEditingAgentId(id)}    │
│                                                                    │
│   conditionally renders <EditAgentDialog/> when editingAgentId set │
└────────────────┬───────────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────┐    ┌──────────────────────────────────┐
│ <ThemeMenu/> (modified)    │    │ <EditAgentDialog/> (new)         │
│                            │    │                                  │
│  color swatches            │    │  reads current agent config      │
│  ─────────────────         │    │  renders <AgentConfigForm/>      │
│  [ Edit agent… ]  ◄────────┤    │  Save → busy check → IPC respawn │
└────────────────────────────┘    └────────────┬─────────────────────┘
                                               │
                                               ▼
                                  ┌──────────────────────────────────┐
                                  │ <AgentConfigForm/> (new)         │
                                  │   pure controlled form           │
                                  │   used by SpawnDialog + Edit     │
                                  └──────────────────────────────────┘

renderer ───── electronAPI.respawnAgent(id, newConfig) ─────► main

┌────────────────────────────────────────────────────────────────────┐
│                          src/main/index.ts                         │
│                                                                    │
│  IPC.AGENT_RESPAWN handler                                         │
│   ├─ validate (name collision, cwd exists)                         │
│   ├─ manualKills.add(id) ; killPty(managed)                        │
│   ├─ hub.registry.remove(oldName) ; hub.messages.clearAgent(old)   │
│   └─ spawnFromConfig({ ...newConfig, id })  ◄── shared with        │
│                                                  reconnectAgent()   │
└────────────────────────────────────────────────────────────────────┘
```

## New / Modified Units

### New

1. **`src/renderer/components/AgentConfigForm.tsx`** — pure controlled form extracted from `SpawnDialog`. Props:
   ```ts
   interface AgentConfigFormProps {
     value: Omit<AgentConfig, 'id'>
     onChange: (next: Omit<AgentConfig, 'id'>) => void
     selectedSkills: Array<{ id: string; name: string }>
     onSelectedSkillsChange: (next: Array<{ id: string; name: string }>) => void
     showAdvanced: boolean
     onShowAdvancedChange: (next: boolean) => void
     errors?: Partial<Record<keyof AgentConfig, string>>  // inline field errors
   }
   ```
   Renders all current SpawnDialog fields. Knows nothing about spawn vs edit — just renders inputs. Exports the `CLI_MODELS` / `CLI_PRESETS` / `OPENCLAUDE_PROVIDERS` / `ROLE_PRESETS` constants that previously lived in SpawnDialog.

2. **`src/renderer/components/EditAgentDialog.tsx`** — modal wrapper. Receives `agent: AgentConfig` and `onClose`. Internally:
   - Initializes form state from the agent's current config
   - Subscribes to the agents store; auto-closes with a toast if the agent is removed externally
   - On Save:
     - If form clean → no-op, just close
     - If status === `working` → show busy confirm
     - Otherwise → call `electronAPI.respawnAgent(agent.id, formValue)`. If returns `{ ok: false, error }` → set inline field errors and stay open. Else close.
   - On Cancel: confirm if form is dirty.
   - Header: `Edit Agent — <name>`. Button: `Save & Respawn`.

### Modified

3. **`src/renderer/components/SpawnDialog.tsx`** — slimmed down. Keeps the `<New Agent>` header, the `Spawn` button, and the `onSpawn` submit handler. The form body becomes `<AgentConfigForm/>`. The `CLI_MODELS` constant (currently exported from this file) moves to `AgentConfigForm.tsx` to keep the single source of truth.

4. **`ThemeMenu` function** (currently inline in `src/renderer/components/FloatingWindow.tsx` around line 337; may be extracted to its own file as a tidy during this change) — accepts a new optional `onEdit?: () => void` prop. When set, renders a divider + `Edit agent…` button below the swatches.

5. **`src/renderer/components/FloatingWindow.tsx`** — when rendering `ThemeMenu` for an agent, pass `onEdit` that bubbles up via a new `onEditAgent?: (agentId: string) => void` prop on FloatingWindow itself.

6. **`src/renderer/components/Workspace.tsx`** — owns `editingAgentId` state. Passes `onEditAgent={(id) => setEditingAgentId(id)}` to FloatingWindow for agent windows. Conditionally renders `<EditAgentDialog/>`.

7. **`src/main/index.ts`** — extract a private `spawnFromConfig(config: AgentConfig)` helper from the existing spawn path so both `reconnectAgent()` and the new respawn handler use it. Add `IPC.AGENT_RESPAWN` handler.

8. **`src/shared/ipc.ts`** — add `AGENT_RESPAWN: 'agent:respawn'` constant.

9. **`src/preload/index.ts`** + **`src/shared/types.ts`** (electronAPI) — expose `respawnAgent(agentId, newConfig)`.

## IPC Contract: `agent:respawn`

**Request:** `{ agentId: string, newConfig: Omit<AgentConfig, 'id'> }`

**Response:** `{ ok: true } | { ok: false, error: 'NAME_TAKEN' | 'CWD_MISSING' | 'AGENT_NOT_FOUND' | 'INTERNAL', message?: string }`

**Main-process handler steps:**
1. Look up `managed = agents.get(agentId)`. If not found → return `{ ok: false, error: 'AGENT_NOT_FOUND' }`.
2. Validate:
   - If `newConfig.name !== managed.config.name` AND another agent in the registry already has `newConfig.name` → return `{ ok: false, error: 'NAME_TAKEN' }`.
   - If `newConfig.cwd` does not exist on disk (or is not a directory) → return `{ ok: false, error: 'CWD_MISSING' }`.
3. `manualKills.add(agentId)` — suppresses the auto-reconnect side effect that fires on PTY exit.
4. `killPty(managed)` — old terminal dies.
5. `hub.registry.remove(managed.config.name)` and `hub.messages.clearAgent(managed.config.name)` — wipe history under the old name.
6. `agents.delete(agentId)` and `hasReceivedInitialPrompt.delete(agentId)`.
7. Call `spawnFromConfig({ ...newConfig, id: agentId })` — the same factored spawn helper used by `reconnectAgent`.
8. Return `{ ok: true }`.

**Why agent id is preserved:** the workshop window manager keys position state by `agent.id`, not by name. Re-spawning with the same id keeps the window in place. The name change is a registry-key change only.

**Why a separate function instead of just calling `reconnectAgent`:** `reconnectAgent` is built for crash recovery. It deliberately preserves messages and assumes the name didn't change. Our path needs explicit history wipe and rename support, plus pre-flight validation.

## Edge Cases

- **Name collision** — validated before kill. Renderer surfaces error inline under the Name field, dialog stays open, agent untouched.
- **CWD missing** — same pattern. Inline error under CWD field.
- **Save while busy** — renderer reads agent status from store. `working` → inline busy confirm. Cancel keeps dialog open.
- **Agent crashes during respawn gap** — `manualKills.add` happens before the kill, so the auto-reconnect path can't fire. Even if PTY exit and our new spawn race, the new spawn wins because we delete the old `agents` map entry first.
- **User edits while agent auto-reconnects from a real crash** — we read managed config off the registry at handler entry. If a reconnect fired between dialog-open and Save, we'd respawn with the user's edits on top of whatever the auto-reconnect produced (correct).
- **Dialog open, agent killed externally** — `EditAgentDialog` watches the agent's presence in the renderer store. Agent disappears → dialog auto-closes with a small toast: *"Agent was removed."*
- **Dirty form + cancel** — confirm "Discard changes?" Clean form closes silently.
- **Skills picker** — reuses existing `<SkillBrowser/>` modal-on-modal, same as SpawnDialog.
- **Theme color is NOT in this dialog** — theme stays in the popover swatches (already hot-applied via `setAgentTheme`, no respawn needed). Putting theme in the dialog would force a respawn for a color change, which is worse UX than what we have today.

## Out of Scope

- **Editing terminal-only agents** — `cli === 'terminal'` is a special case (no auto-reconnect, no model/provider). For v1, the right-click menu still shows the color popover but the `Edit agent…` button is hidden for terminal agents. They can be deleted and re-spawned the old way.
- **Editing presets via right-click** — presets get edited in PresetDialog as today. PresetDialog refactoring to share `<AgentConfigForm/>` is a follow-up, not blocking.
- **Diff view / "reset to original"** — nice-to-have, deferred.
- **Bulk edit (right-click multiple agents)** — not in v1.

## Testing

**Unit / component:**
- `<AgentConfigForm/>` renders identical fields when given a fresh-empty value vs. a populated value (snapshot)
- `<EditAgentDialog/>` pre-fills correctly given an `AgentConfig`
- Busy confirm appears only when status is `working`
- Inline error under Name field appears when respawn returns `NAME_TAKEN`

**Main-process:**
- `respawn` handler rejects with `NAME_TAKEN` when target name belongs to another agent
- `respawn` handler rejects with `CWD_MISSING` when cwd doesn't exist
- `respawn` handler preserves agent id and clears messages under old name
- `manualKills` flag is set before kill so auto-reconnect doesn't fire

**E2E (manual smoke):**
- Right-click agent → `Edit agent…` → change model from sonnet → opus → Save → new PTY launches with `--model opus`, window stays in same x/y/width
- Rename agent → registry shows new name, old name freed for re-use, message panel clears
- Save while agent is processing → busy confirm appears; cancel leaves agent untouched
- Save with name that's already taken → inline error, dialog stays open, agent untouched
- Cancel with dirty form → confirm; cancel keeps editing; discard closes without changes
