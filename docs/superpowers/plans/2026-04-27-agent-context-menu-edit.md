# Agent Context-Menu Edit + Respawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Edit agent…" entry to the agent title-bar right-click menu that opens a dialog mirroring SpawnDialog. Saving kills the old PTY and respawns the agent in the same window slot with the new config — including renames — and wipes message history.

**Architecture:** Renderer-only UI plus one new main-process IPC. Extract `<AgentConfigForm/>` from `SpawnDialog` (pure refactor); add `<EditAgentDialog/>` wrapper; thread an `onEditAgent` callback up through `FloatingWindow` → `Workspace` → `App`; add a new `agent:respawn` IPC handler that validates name + cwd, kills the old PTY, clears messages under the old name, and re-uses a factored `spawnFromConfig` helper to relaunch with the same `agent.id` (so workshop window position is preserved).

**Tech Stack:** React 18, TypeScript, Electron renderer + main, Vitest (pure-function unit tests only — no DOM env in this repo).

**Spec:** `docs/superpowers/specs/2026-04-27-agent-context-menu-edit-design.md`

---

## File Structure

**New files:**
- `src/renderer/components/AgentConfigForm.tsx` — pure controlled form (extracted from SpawnDialog)
- `src/renderer/components/EditAgentDialog.tsx` — modal wrapper around AgentConfigForm for editing
- `src/main/respawn-validation.ts` — pure validation helpers (testable)
- `src/main/respawn-validation.test.ts` — unit tests for validation

**Modified files:**
- `src/shared/types.ts` — add `IPC.AGENT_RESPAWN`, add `RespawnResult` type
- `src/preload/index.ts` — add `respawnAgent` binding
- `src/renderer/electron.d.ts` — add `respawnAgent` to ElectronAPI type
- `src/main/index.ts` — factor `spawnFromConfig` helper, add `agent:respawn` IPC handler
- `src/renderer/components/SpawnDialog.tsx` — slim down, use AgentConfigForm
- `src/renderer/components/PresetDialog.tsx` — update `CLI_MODELS` import to AgentConfigForm
- `src/renderer/components/FloatingWindow.tsx` — `ThemeMenu` accepts `onEdit?`, FloatingWindow accepts `onEditAgent?` prop and passes through
- `src/renderer/components/Workspace.tsx` — pass `onEditAgent` to FloatingWindow for non-terminal agent windows
- `src/renderer/App.tsx` — own `editingAgentId` state, render `<EditAgentDialog/>` when set

---

## Task 1: Add the `agent:respawn` IPC channel + types

**Files:**
- Modify: `src/shared/types.ts:93-180` (add to IPC enum + add new type)
- Modify: `src/preload/index.ts:5` (add binding)
- Modify: `src/renderer/electron.d.ts` (add binding type)

- [ ] **Step 1: Add the IPC constant + result type**

In `src/shared/types.ts`, find the `IPC` const (starts around line 93) and add `AGENT_RESPAWN: 'agent:respawn'` alongside `KILL_AGENT`. Then near the bottom of the file, add the result type:

```ts
export type RespawnResult =
  | { ok: true }
  | { ok: false; error: 'AGENT_NOT_FOUND' | 'NAME_TAKEN' | 'CWD_MISSING' | 'INTERNAL'; message?: string }
```

- [ ] **Step 2: Add the preload binding**

In `src/preload/index.ts`, alongside `killAgent` (line 6), add:

```ts
respawnAgent: (agentId: string, newConfig: unknown) => ipcRenderer.invoke(IPC.AGENT_RESPAWN, agentId, newConfig),
```

- [ ] **Step 3: Add the ElectronAPI type**

In `src/renderer/electron.d.ts`, add the import for `RespawnResult` to the existing type imports at the top, then add inside the `electronAPI` interface (alongside `killAgent`):

```ts
respawnAgent: (agentId: string, newConfig: Omit<AgentConfig, 'id'>) => Promise<RespawnResult>
```

- [ ] **Step 4: Confirm typecheck**

Run: `npm run build` (or whichever script runs `tsc`).
Expected: PASS. Renderer can now reference `window.electronAPI.respawnAgent` with full types, but no handler exists yet — calling it would reject in main.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/preload/index.ts src/renderer/electron.d.ts
git commit -m "feat: add agent:respawn IPC channel + types"
```

---

## Task 2: Pure validation helper for respawn requests (TDD)

**Files:**
- Create: `src/main/respawn-validation.ts`
- Test: `src/main/respawn-validation.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/respawn-validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateRespawnRequest } from './respawn-validation'
import type { AgentConfig } from '../shared/types'

const baseConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: 'agent-1',
  name: 'worker',
  cli: 'claude',
  cwd: 'C:/projects/foo',
  role: 'worker',
  ceoNotes: '',
  shell: 'powershell',
  admin: false,
  autoMode: false,
  ...overrides,
})

describe('validateRespawnRequest', () => {
  it('accepts when name is unchanged and cwd exists', () => {
    const current = baseConfig()
    const next = { ...current, model: 'opus' }
    const result = validateRespawnRequest({
      currentConfig: current,
      newConfig: next,
      otherAgentNames: ['orchestrator'],
      cwdExists: () => true,
    })
    expect(result).toEqual({ ok: true })
  })

  it('accepts when name changes to a free name', () => {
    const current = baseConfig({ name: 'worker' })
    const next = { ...current, name: 'researcher' }
    const result = validateRespawnRequest({
      currentConfig: current,
      newConfig: next,
      otherAgentNames: ['orchestrator'],
      cwdExists: () => true,
    })
    expect(result).toEqual({ ok: true })
  })

  it('rejects when new name belongs to another live agent', () => {
    const current = baseConfig({ name: 'worker' })
    const next = { ...current, name: 'orchestrator' }
    const result = validateRespawnRequest({
      currentConfig: current,
      newConfig: next,
      otherAgentNames: ['orchestrator'],
      cwdExists: () => true,
    })
    expect(result).toEqual({ ok: false, error: 'NAME_TAKEN' })
  })

  it('does NOT reject when keeping the same name (it would appear in otherAgentNames if naive)', () => {
    const current = baseConfig({ name: 'worker' })
    const next = { ...current }
    const result = validateRespawnRequest({
      currentConfig: current,
      newConfig: next,
      otherAgentNames: ['worker', 'orchestrator'],  // includes self
      cwdExists: () => true,
    })
    expect(result).toEqual({ ok: true })
  })

  it('rejects when cwd does not exist', () => {
    const current = baseConfig()
    const next = { ...current, cwd: 'C:/missing' }
    const result = validateRespawnRequest({
      currentConfig: current,
      newConfig: next,
      otherAgentNames: [],
      cwdExists: () => false,
    })
    expect(result).toEqual({ ok: false, error: 'CWD_MISSING' })
  })

  it('rejects empty name', () => {
    const current = baseConfig()
    const next = { ...current, name: '   ' }
    const result = validateRespawnRequest({
      currentConfig: current,
      newConfig: next,
      otherAgentNames: [],
      cwdExists: () => true,
    })
    expect(result).toEqual({ ok: false, error: 'INTERNAL', message: 'Name cannot be empty' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/respawn-validation.test.ts`
Expected: FAIL — `validateRespawnRequest` is not defined.

- [ ] **Step 3: Write the minimal implementation**

Create `src/main/respawn-validation.ts`:

```ts
import type { AgentConfig, RespawnResult } from '../shared/types'

export interface ValidateRespawnInput {
  currentConfig: AgentConfig
  newConfig: Omit<AgentConfig, 'id'>
  /** Names of all live agents — may include the current agent's own name */
  otherAgentNames: string[]
  /** Sync check that cwd exists on disk */
  cwdExists: (path: string) => boolean
}

export function validateRespawnRequest(input: ValidateRespawnInput): RespawnResult {
  const { currentConfig, newConfig, otherAgentNames, cwdExists } = input
  const trimmedName = newConfig.name.trim()

  if (!trimmedName) {
    return { ok: false, error: 'INTERNAL', message: 'Name cannot be empty' }
  }

  if (trimmedName !== currentConfig.name) {
    if (otherAgentNames.includes(trimmedName)) {
      return { ok: false, error: 'NAME_TAKEN' }
    }
  }

  if (!cwdExists(newConfig.cwd)) {
    return { ok: false, error: 'CWD_MISSING' }
  }

  return { ok: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/respawn-validation.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/respawn-validation.ts src/main/respawn-validation.test.ts
git commit -m "feat: pure validation helper for agent respawn requests"
```

---

## Task 3: Factor `spawnFromConfig` from `handleSpawnAgent` and `reconnectAgent`

This is a **pure refactor** — no behavior change. The two functions in `src/main/index.ts` (`handleSpawnAgent` at line 794 and `reconnectAgent` at line 672) share most of their body. We'll factor the common spawn-PTY-and-wire-callbacks logic into a private helper.

**Files:**
- Modify: `src/main/index.ts:670-940` (the two functions)

- [ ] **Step 1: Read both functions in full**

Run:
```bash
sed -n '670,940p' src/main/index.ts | head -300
```
Expected: see both functions. Note: `handleSpawnAgent` has theme/skills resolution logic at the top that `reconnectAgent` does NOT have. The PTY spawn block (`spawnAgentPty({ config, mcpConfigPath, extraEnv: mcpEnv, onData, onExit, onStatusChange, onClearDetected })`), the env-vars build, and the post-spawn `cmds` loop are identical between them.

- [ ] **Step 2: Add the shared helper above `reconnectAgent`**

Insert the following private function in `src/main/index.ts` immediately above `function reconnectAgent` (line 672). This represents the common path — both call sites will delegate to it after their own bespoke setup:

```ts
// Shared spawn path used by handleSpawnAgent (fresh) and reconnectAgent (auto-reconnect).
// Caller is responsible for: (1) registering with hub.registry, (2) deciding whether to
// register with hub.agentMetrics, (3) building the right initial prompt before this is called.
function spawnPtyAndWire(config: AgentConfig, mcpConfigPath: string, mcpEnv: Record<string, string>): void {
  const managed = spawnAgentPty({
    config,
    mcpConfigPath,
    extraEnv: mcpEnv,
    onData: (data) => {
      mainWindow.webContents.send(IPC.PTY_OUTPUT, config.id, data)
    },
    onExit: (exitCode) => {
      hub.registry.updateStatus(config.name, 'disconnected')
      mainWindow.webContents.send(IPC.PTY_EXIT, config.id, exitCode)
      mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
      if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)

      if (!manualKills.has(config.id) && config.cli !== 'terminal') {
        console.log(`Agent "${config.name}" exited unexpectedly (code ${exitCode}), reconnecting in ${RECONNECT_DELAY}ms...`)
        setTimeout(() => {
          if (manualKills.has(config.id)) {
            manualKills.delete(config.id)
            return
          }
          reconnectAgent(config)
        }, RECONNECT_DELAY)
      } else {
        manualKills.delete(config.id)
      }
    },
    onStatusChange: (status) => {
      hub.registry.updateStatus(config.name, status)
      mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())

      if (status === 'active' && !hasReceivedInitialPrompt.has(config.id)) {
        hasReceivedInitialPrompt.add(config.id)
        const prompt = initialPrompts.get(config.id)
        if (prompt) injectPrompt(managed, prompt, 0)
      }

      if (status === 'active') flushPendingNudges(config.name)
    },
    onClearDetected: () => {
      hasReceivedInitialPrompt.delete(config.id)
    }
  })

  agents.set(config.id, managed)
  mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())

  const cmds = buildCliLaunchCommands(config, mcpConfigPath, mcpServerPath, hub.port, hub.secret)
  if (cmds) {
    let delay = 1000
    for (const cmd of cmds) {
      setTimeout(() => writeToPty(managed, cmd + '\r'), delay)
      delay += 3000
    }
    setTimeout(() => hasReceivedInitialPrompt.delete(config.id), delay)
    setTimeout(() => {
      if (!hasReceivedInitialPrompt.has(config.id)) {
        hasReceivedInitialPrompt.add(config.id)
        const prompt = initialPrompts.get(config.id)
        if (prompt) injectPrompt(managed, prompt, 0)
      }
    }, delay + PROMPT_INJECT_FALLBACK_MS)
  }
}
```

Note: `mcpServerPath` is referenced inside but is defined locally in each caller — promote it to a module-level `getMcpServerPath()` call inside this helper. Replace `mcpServerPath` inside the helper body with `const mcpServerPath = getMcpServerPath()` at the top of the function.

- [ ] **Step 3: Update `reconnectAgent` to delegate**

Replace the body of `reconnectAgent` (lines 672–793) with:

```ts
function reconnectAgent(config: AgentConfig): void {
  // Clean up stale state from previous instance
  try { hub.registry.remove(config.name) } catch { /* already removed */ }
  agents.delete(config.id)
  hasReceivedInitialPrompt.delete(config.id)

  const mcpServerPath = getMcpServerPath()
  const mcpConfigPath = writeAgentMcpConfig({
    agentId: config.id,
    agentName: config.name,
    hubPort: hub.port,
    hubSecret: hub.secret,
    mcpServerPath
  })

  const mcpEnv = buildMcpEnv(config)
  hub.registry.register(config)

  const initialPrompt = buildReconnectPrompt(config)
  initialPrompts.set(config.id, initialPrompt)
  hasReceivedInitialPrompt.add(config.id)

  spawnPtyAndWire(config, mcpConfigPath, mcpEnv)
}
```

And factor the env-var block (currently duplicated at lines 690–710 in `reconnectAgent` and 827–847 in `handleSpawnAgent`) into a helper above `spawnPtyAndWire`:

```ts
function buildMcpEnv(config: AgentConfig): Record<string, string> {
  const env: Record<string, string> = {
    COG_HUB_PORT: String(hub.port),
    COG_HUB_SECRET: hub.secret,
    COG_AGENT_ID: config.id,
    COG_AGENT_NAME: config.name,
    AGENTORCH_HUB_PORT: String(hub.port),
    AGENTORCH_HUB_SECRET: hub.secret,
    AGENTORCH_AGENT_ID: config.id,
    AGENTORCH_AGENT_NAME: config.name
  }
  if (config.cli === 'grok' && config.model) env.GROK_MODEL = config.model
  if (config.cli === 'openclaude') {
    if (config.model) env.OPENAI_MODEL = config.model
    if (config.providerUrl) env.OPENAI_BASE_URL = config.providerUrl
  }
  if (config.tabId) {
    env.COG_TAB_ID = config.tabId
    env.AGENTORCH_TAB_ID = config.tabId
  }
  return env
}
```

- [ ] **Step 4: Update `handleSpawnAgent` to delegate**

Find `handleSpawnAgent` at line 794. Keep the theme resolution at the top (lines 795–813) and the skills/ceoNotes composition (lines 853–861) — those are unique to fresh spawn. Replace the env-vars block, PTY spawn block, and cmds block (roughly lines 824–940) with:

```ts
  const mcpServerPath = getMcpServerPath()
  const mcpConfigPath = writeAgentMcpConfig({
    agentId: config.id,
    agentName: config.name,
    hubPort: hub.port,
    hubSecret: hub.secret,
    mcpServerPath
  })

  const mcpEnv = buildMcpEnv(config)

  hub.registry.register(config)
  hub.agentMetrics.register(config.name)

  // Compose skill prompts into ceoNotes
  if (config.skills && config.skills.length > 0) {
    const skillPrompt = skillManager.resolveSkillPrompts(config.skills)
    if (skillPrompt) {
      const registered = hub.registry.get(config.name)
      if (registered) {
        registered.ceoNotes = [skillPrompt, registered.ceoNotes].filter(Boolean).join('\n\n')
      }
    }
  }

  const initialPrompt = buildInitialPrompt(config)
  initialPrompts.set(config.id, initialPrompt)
  hasReceivedInitialPrompt.add(config.id)

  spawnPtyAndWire(config, mcpConfigPath, mcpEnv)

  return { id: config.id, mcpConfigPath }
```

- [ ] **Step 5: Build + manual smoke**

Run: `npm run build`
Expected: PASS — no type errors.

Manual smoke (no automated coverage for this refactor):
1. `npm run dev` (or however the project runs locally — check `package.json` scripts)
2. Spawn a fresh Claude agent. Verify it boots normally.
3. Kill the agent's CLI process externally (e.g., close the underlying terminal). Verify auto-reconnect fires after 3s and the agent comes back.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "refactor: factor spawnPtyAndWire + buildMcpEnv from handleSpawnAgent and reconnectAgent"
```

---

## Task 4: Implement `agent:respawn` IPC handler

**Files:**
- Modify: `src/main/index.ts` (around line 1396, near `AGENT_CLEAR_CONTEXT` handler)

- [ ] **Step 1: Add the handler**

In `src/main/index.ts`, find the `AGENT_CLEAR_CONTEXT` handler around line 1399 and add this above or below it. The handler uses `validateRespawnRequest` from Task 2 and `spawnPtyAndWire`/`buildMcpEnv` from Task 3:

```ts
import { validateRespawnRequest } from './respawn-validation'
// (add this import at the top of the file alongside other ./shell/pty-manager etc. imports)
```

```ts
ipcMain.handle(IPC.AGENT_RESPAWN, async (_event, agentId: string, newConfigInput: Omit<AgentConfig, 'id'>): Promise<RespawnResult> => {
  const managed = agents.get(agentId)
  if (!managed) return { ok: false, error: 'AGENT_NOT_FOUND' }

  const currentConfig = managed.config
  const otherAgentNames = hub.registry.list().map(a => a.name)

  const validation = validateRespawnRequest({
    currentConfig,
    newConfig: newConfigInput,
    otherAgentNames,
    cwdExists: (p) => {
      try {
        return fs.statSync(p).isDirectory()
      } catch {
        return false
      }
    }
  })
  if (!validation.ok) return validation

  const oldName = currentConfig.name
  const newName = newConfigInput.name.trim()

  // Suppress auto-reconnect from the upcoming PTY exit
  manualKills.add(agentId)
  killPty(managed)

  // Wipe history under old name
  try { hub.registry.remove(oldName) } catch { /* ignore */ }
  hub.messages.clearAgent(oldName)
  pendingNudges.delete(oldName)
  lastNudgeDelivery.delete(oldName)
  const fallbackTimer = nudgeFallbackTimers.get(oldName)
  if (fallbackTimer) { clearTimeout(fallbackTimer); nudgeFallbackTimers.delete(oldName) }
  if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)
  initialPrompts.delete(agentId)
  hasReceivedInitialPrompt.delete(agentId)
  agents.delete(agentId)

  // Spawn fresh with new config — preserve agent.id so window position state survives
  const mergedConfig: AgentConfig = {
    ...newConfigInput,
    name: newName,
    id: agentId,
  }

  try {
    handleSpawnAgent(mergedConfig)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: 'INTERNAL', message: (err as Error).message }
  }
})
```

Note: `fs` should already be imported at the top of `src/main/index.ts`. If not, add `import fs from 'fs'` to the imports. `RespawnResult` should be imported from `../shared/types` next to other type imports.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Manual smoke from devtools console**

```
npm run dev
```

In renderer devtools console with one agent already spawned:

```js
// Pick an agent id from window.electronAPI.getAgents()
const agents = await window.electronAPI.getAgents()
const target = agents[0]
const result = await window.electronAPI.respawnAgent(target.id, {
  ...target,
  model: 'opus',  // change something
})
console.log(result)  // expected: { ok: true }
```

Expected behavior:
- Old PTY dies, terminal scrollback wipes
- New PTY launches with `--model opus`
- Window stays in the same x/y/width/height
- Agent panel chat history shows fresh start

Try a name collision:
```js
// With two agents 'worker-1' and 'worker-2' running:
await window.electronAPI.respawnAgent(workerOneId, { ...workerOne, name: 'worker-2' })
// expected: { ok: false, error: 'NAME_TAKEN' }
```

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: agent:respawn IPC handler with validation + history wipe"
```

---

## Task 5: Extract `<AgentConfigForm/>` from SpawnDialog

This is a **pure refactor** of the renderer side. The form fields, validation, and onChange wiring move into a new component. SpawnDialog becomes a thin wrapper.

**Files:**
- Create: `src/renderer/components/AgentConfigForm.tsx`
- Modify: `src/renderer/components/SpawnDialog.tsx`
- Modify: `src/renderer/components/PresetDialog.tsx:4` (update import)

- [ ] **Step 1: Create AgentConfigForm.tsx with the extracted form**

Create `src/renderer/components/AgentConfigForm.tsx`. Move the constants `ROLE_PRESETS`, `CLI_PRESETS`, `CLI_MODELS`, `OPENCLAUDE_PROVIDERS`, `WINDOWS_SHELLS`, `POSIX_SHELLS` from `SpawnDialog.tsx`. Define the props and the form body:

```tsx
import React, { useState, useEffect } from 'react'
import type { AgentConfig } from '../../shared/types'
import { SkillBrowser } from './SkillBrowser'

export const ROLE_PRESETS = [
  { label: 'Orchestrator', value: 'orchestrator', hint: 'Coordinates agents, dispatches tasks, synthesizes results' },
  { label: 'Worker', value: 'worker', hint: 'Executes tasks assigned by the orchestrator' },
  { label: 'Researcher', value: 'researcher', hint: 'Gathers information, reads docs, explores codebases' },
  { label: 'Reviewer', value: 'reviewer', hint: 'Reviews code and work from other agents' },
  { label: 'Custom', value: '', hint: '' }
]

export const CLI_PRESETS = [
  { label: 'Claude Code', value: 'claude' },
  { label: 'Codex CLI', value: 'codex' },
  { label: 'Kimi CLI', value: 'kimi' },
  { label: 'Gemini CLI', value: 'gemini' },
  { label: 'OpenClaude (Any Model)', value: 'openclaude' },
  { label: 'GitHub Copilot CLI', value: 'copilot' },
  { label: 'Grok CLI (Experimental)', value: 'grok' },
  { label: 'Plain Terminal', value: 'terminal' },
  { label: 'Custom', value: '' }
]

export const CLI_MODELS: Record<string, { label: string; value: string }[]> = {
  // (copy exactly from current SpawnDialog.tsx lines 30–105)
}

export const OPENCLAUDE_PROVIDERS: { label: string; url: string }[] = [
  // (copy exactly from current SpawnDialog.tsx lines 107–115)
]

const WINDOWS_SHELLS: AgentConfig['shell'][] = ['powershell', 'cmd']
const POSIX_SHELLS: AgentConfig['shell'][] = ['bash', 'zsh', 'fish']

export interface AgentConfigFormValue {
  name: string
  cli: string
  customCli: string
  cwd: string
  role: string
  customRole: string
  ceoNotes: string
  shell: AgentConfig['shell']
  admin: boolean
  autoMode: boolean
  promptRegex: string
  model: string
  customModel: string
  providerUrl: string
  customProviderUrl: string
  selectedSkills: Array<{ id: string; name: string }>
  showAdvanced: boolean
}

export interface AgentConfigFormProps {
  value: AgentConfigFormValue
  onChange: (next: AgentConfigFormValue) => void
  /** Inline error messages keyed by field name (e.g., name, cwd) */
  errors?: Partial<Record<keyof AgentConfigFormValue, string>>
}

export function buildSubmitConfig(v: AgentConfigFormValue): Omit<AgentConfig, 'id'> {
  return {
    name: v.name.trim(),
    cli: v.cli || v.customCli.trim(),
    cwd: v.cwd.trim(),
    role: (v.role || v.customRole).trim(),
    ceoNotes: v.ceoNotes.trim(),
    shell: v.shell,
    admin: v.admin,
    autoMode: v.autoMode,
    promptRegex: v.promptRegex.trim() || undefined,
    model: (v.model || v.customModel.trim()) || undefined,
    providerUrl: v.cli === 'openclaude' ? (v.providerUrl || v.customProviderUrl.trim()) || undefined : undefined,
    experimental: v.cli === 'grok' ? true : undefined,
    skills: v.selectedSkills.length > 0 ? v.selectedSkills.map(s => s.id) : undefined,
  }
}

export function emptyFormValue(defaults?: Partial<AgentConfigFormValue>): AgentConfigFormValue {
  const isWindows = navigator.platform.toLowerCase().includes('win')
  return {
    name: '',
    cli: 'claude',
    customCli: '',
    cwd: '',
    role: 'worker',
    customRole: '',
    ceoNotes: '',
    shell: isWindows ? 'powershell' : 'bash',
    admin: false,
    autoMode: false,
    promptRegex: '',
    model: 'sonnet',
    customModel: '',
    providerUrl: 'https://api.openai.com/v1',
    customProviderUrl: '',
    selectedSkills: [],
    showAdvanced: false,
    ...defaults,
  }
}

export function AgentConfigForm({ value, onChange, errors }: AgentConfigFormProps): React.ReactElement {
  const [showSkillBrowser, setShowSkillBrowser] = useState(false)
  const isWindows = navigator.platform.toLowerCase().includes('win')
  const shellOptions = isWindows ? WINDOWS_SHELLS : POSIX_SHELLS

  // Helper that produces an update callback for a single field
  const set = <K extends keyof AgentConfigFormValue>(key: K, v: AgentConfigFormValue[K]) => {
    onChange({ ...value, [key]: v })
  }

  // Preserve old SpawnDialog behavior: when CLI changes, reset model + provider to defaults
  // for the new CLI. We track the previous CLI in a ref to detect actual changes (not just renders).
  const prevCliRef = React.useRef(value.cli)
  useEffect(() => {
    if (prevCliRef.current !== value.cli) {
      prevCliRef.current = value.cli
      onChange({
        ...value,
        model: '',
        customModel: '',
        providerUrl: 'https://api.openai.com/v1',
        customProviderUrl: '',
      })
    }
  }, [value.cli])

  // Preserve old SpawnDialog behavior: when platform changes, ensure shell is valid
  useEffect(() => {
    if (!shellOptions.includes(value.shell)) {
      set('shell', shellOptions[0])
    }
  }, [isWindows])

  return (
    <>
      {/* Name */}
      <label style={labelStyle}>
        Name
        <input
          value={value.name}
          onChange={e => set('name', e.target.value)}
          required
          style={inputStyle}
          placeholder="worker-1"
        />
        {errors?.name && <span style={errorStyle}>{errors.name}</span>}
      </label>

      {/* CLI */}
      <label style={labelStyle}>
        CLI
        <select value={value.cli} onChange={e => set('cli', e.target.value)} style={inputStyle}>
          {CLI_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </label>

      {value.cli === '' && (
        <label style={labelStyle}>
          Custom Command
          <input value={value.customCli} onChange={e => set('customCli', e.target.value)} required style={inputStyle} placeholder="my-agent --flag" />
        </label>
      )}

      {/* Model — copy the same conditional block from SpawnDialog.tsx:218-225
          but use value.model / set('model', e.target.value) and CLI_MODELS[value.cli] */}

      {/* Grok experimental warning — copy from SpawnDialog.tsx:227-231, replace `cli` with `value.cli` */}

      {/* Provider (openclaude only) — copy from SpawnDialog.tsx:233-246,
          use value.providerUrl / set('providerUrl', …) */}

      {/* Custom Provider URL — SpawnDialog.tsx:248-259 — use value.customProviderUrl / set('customProviderUrl', …) */}

      {/* Custom Model Name — SpawnDialog.tsx:261-271 — use value.customModel / set('customModel', …) */}

      {/* Working Directory — SpawnDialog.tsx:273-288 — use value.cwd / set('cwd', …);
          on the Browse button click handler call window.electronAPI.browseDirectory(value.cwd).then(d => d && set('cwd', d));
          add {errors?.cwd && <span style={errorStyle}>{errors.cwd}</span>} after the input row */}

      {/* Role — SpawnDialog.tsx:290-298 — value.role / set('role', …) */}

      {/* Custom Role — SpawnDialog.tsx:300-305 — value.customRole / set('customRole', …) */}

      {/* Skills — SpawnDialog.tsx:307-343
          - selectedSkills.map → value.selectedSkills.map
          - the X click handler: set('selectedSkills', value.selectedSkills.filter(s => s.id !== skill.id))
          - "+ Add Skills" button onClick: setShowSkillBrowser(true) */}

      {/* CEO Notes — SpawnDialog.tsx:345-353 — value.ceoNotes / set('ceoNotes', …) */}

      {/* Auto-approve checkbox — SpawnDialog.tsx:355-366 — value.autoMode / set('autoMode', …);
          inside the hint span, use value.cli (not cli) */}

      {/* Run as admin — SpawnDialog.tsx:368-371 — value.admin / set('admin', …) */}

      {/* Advanced toggle button — SpawnDialog.tsx:373-379
          - onClick: set('showAdvanced', !value.showAdvanced)
          - label uses value.showAdvanced */}

      {value.showAdvanced && (
        <>
          {/* Shell — SpawnDialog.tsx:383-398 — value.shell / set('shell', e.target.value as AgentConfig['shell']) */}
          {/* Prompt Regex Override — SpawnDialog.tsx:399-402 — value.promptRegex / set('promptRegex', …) */}
        </>
      )}

      {showSkillBrowser && (
        <SkillBrowser
          selectedIds={value.selectedSkills.map(s => s.id)}
          onToggleSkill={(skill) => {
            const exists = value.selectedSkills.find(s => s.id === skill.id)
            const next = exists
              ? value.selectedSkills.filter(s => s.id !== skill.id)
              : [...value.selectedSkills, { id: skill.id, name: skill.name }]
            set('selectedSkills', next)
          }}
          onClose={() => setShowSkillBrowser(false)}
        />
      )}
    </>
  )
}

const errorStyle: React.CSSProperties = {
  color: '#e55', fontSize: '11px', marginTop: '2px'
}

const labelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '4px',
  fontSize: '12px', color: '#aaa'
}

const inputStyle: React.CSSProperties = {
  backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '4px',
  padding: '8px', color: '#e0e0e0', fontSize: '13px', fontFamily: 'inherit'
}
```

Carefully copy each form section from `SpawnDialog.tsx` — the Name/CLI/Model/Provider/CWD/Role/Skills/CEO Notes/checkboxes/Advanced sections — into the JSX returned from `AgentConfigForm`. Use the `value.X`/`set('X', …)` pattern for each. The skill browser modal is rendered at the end the same way SpawnDialog does it.

- [ ] **Step 2: Slim down SpawnDialog.tsx**

Replace the entire body of `SpawnDialog.tsx` with the wrapper that uses `AgentConfigForm`:

```tsx
import React, { useState, useEffect } from 'react'
import type { AgentConfig } from '../../shared/types'
import { AgentConfigForm, emptyFormValue, buildSubmitConfig, type AgentConfigFormValue } from './AgentConfigForm'

interface SpawnDialogProps {
  onSpawn: (config: Omit<AgentConfig, 'id'>) => void
  onCancel: () => void
}

export function SpawnDialog({ onSpawn, onCancel }: SpawnDialogProps): React.ReactElement {
  const [form, setForm] = useState<AgentConfigFormValue>(() => emptyFormValue())

  useEffect(() => {
    window.electronAPI.getCwd().then(cwd => setForm(prev => ({ ...prev, cwd })))
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSpawn(buildSubmitConfig(form))
  }

  return (
    <div style={overlayStyle}>
      <form onSubmit={handleSubmit} style={formStyle}>
        <h2 style={{ margin: 0, fontSize: '16px', color: '#e0e0e0' }}>New Agent</h2>
        <AgentConfigForm value={form} onChange={setForm} />
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
          <button type="button" onClick={onCancel} style={cancelBtnStyle}>Cancel</button>
          <button type="submit" disabled={!form.name.trim()} style={spawnBtnStyle}>Spawn</button>
        </div>
      </form>
    </div>
  )
}

// Re-export CLI_MODELS for backward compat with PresetDialog (which imports it from here)
export { CLI_MODELS } from './AgentConfigForm'

const overlayStyle: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  backgroundColor: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 99999
}

const formStyle: React.CSSProperties = {
  backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
  padding: '24px', width: '450px', display: 'flex', flexDirection: 'column', gap: '12px'
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 16px', backgroundColor: '#2a2a2a', border: '1px solid #444',
  borderRadius: '4px', color: '#aaa', cursor: 'pointer', fontSize: '13px'
}

const spawnBtnStyle: React.CSSProperties = {
  padding: '8px 16px', backgroundColor: '#2d5a2d', border: '1px solid #4caf50',
  borderRadius: '4px', color: '#4caf50', cursor: 'pointer', fontSize: '13px'
}
```

The `export { CLI_MODELS } from './AgentConfigForm'` line preserves the existing import in `PresetDialog.tsx`, so we don't have to touch it.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS — no type errors.

- [ ] **Step 4: Manual smoke**

```
npm run dev
```

1. Click "+ Spawn" in the top bar. The Spawn dialog should open and look exactly the same as before.
2. Try every field: name, cli (try claude → openclaude → terminal — model/provider sections should appear/disappear correctly), role (try Custom → custom field shows), skills picker, ceo notes, advanced toggle.
3. Spawn an agent. Verify it boots normally.
4. Open the Preset dialog (preset edit) and confirm models still show — `CLI_MODELS` re-export keeps PresetDialog working.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/AgentConfigForm.tsx src/renderer/components/SpawnDialog.tsx
git commit -m "refactor: extract AgentConfigForm from SpawnDialog"
```

---

## Task 6: Build `<EditAgentDialog/>`

**Files:**
- Create: `src/renderer/components/EditAgentDialog.tsx`

- [ ] **Step 1: Build the dialog component**

Create `src/renderer/components/EditAgentDialog.tsx`:

```tsx
import React, { useState, useEffect, useMemo } from 'react'
import type { AgentConfig, AgentState } from '../../shared/types'
import { AgentConfigForm, buildSubmitConfig, emptyFormValue, type AgentConfigFormValue } from './AgentConfigForm'

interface EditAgentDialogProps {
  agent: AgentState
  onClose: () => void
}

function configToFormValue(agent: AgentConfig): AgentConfigFormValue {
  const isPresetCli = ['claude', 'codex', 'kimi', 'gemini', 'openclaude', 'copilot', 'grok', 'terminal'].includes(agent.cli)
  const isPresetRole = ['orchestrator', 'worker', 'researcher', 'reviewer'].includes(agent.role)
  return {
    ...emptyFormValue(),
    name: agent.name,
    cli: isPresetCli ? agent.cli : '',
    customCli: isPresetCli ? '' : agent.cli,
    cwd: agent.cwd,
    role: isPresetRole ? agent.role : '',
    customRole: isPresetRole ? '' : agent.role,
    ceoNotes: agent.ceoNotes,
    shell: agent.shell,
    admin: agent.admin,
    autoMode: agent.autoMode,
    promptRegex: agent.promptRegex ?? '',
    model: agent.model ?? '',
    customModel: '',
    providerUrl: agent.providerUrl ?? 'https://api.openai.com/v1',
    customProviderUrl: '',
    selectedSkills: (agent.skills ?? []).map(id => ({ id, name: id })),  // names re-resolved below
    showAdvanced: !!agent.promptRegex,
  }
}

export function EditAgentDialog({ agent, onClose }: EditAgentDialogProps): React.ReactElement {
  const [form, setForm] = useState<AgentConfigFormValue>(() => configToFormValue(agent))
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({})
  const [busyConfirm, setBusyConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const initialForm = useMemo(() => configToFormValue(agent), [agent.id])
  const isDirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(initialForm),
    [form, initialForm]
  )

  // Resolve skill names from IDs
  useEffect(() => {
    if (!agent.skills || agent.skills.length === 0) return
    window.electronAPI.listSkills().then((skills: any[]) => {
      const named = agent.skills!.map(id => {
        const found = skills.find(s => s.id === id)
        return { id, name: found?.name ?? id }
      })
      setForm(prev => ({ ...prev, selectedSkills: named }))
    })
  }, [agent.id])

  const performRespawn = async () => {
    setSubmitting(true)
    setErrors({})
    try {
      const newConfig = buildSubmitConfig(form)
      const result = await window.electronAPI.respawnAgent(agent.id, newConfig)
      if (result.ok) {
        onClose()
      } else {
        const next: Record<string, string> = {}
        if (result.error === 'NAME_TAKEN') next.name = 'An agent with this name already exists'
        else if (result.error === 'CWD_MISSING') next.cwd = 'Directory does not exist'
        else next.name = result.message ?? 'Could not respawn agent'
        setErrors(next)
      }
    } catch (err) {
      setErrors({ name: (err as Error).message })
    } finally {
      setSubmitting(false)
      setBusyConfirm(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isDirty) { onClose(); return }
    if (agent.status === 'working') {
      setBusyConfirm(true)
      return
    }
    void performRespawn()
  }

  const handleCancel = () => {
    if (!isDirty) { onClose(); return }
    if (window.confirm('Discard changes?')) onClose()
  }

  return (
    <div style={overlayStyle}>
      <form onSubmit={handleSubmit} style={formStyle}>
        <h2 style={{ margin: 0, fontSize: '16px', color: '#e0e0e0' }}>
          Edit Agent — <span style={{ color: '#888' }}>{agent.name}</span>
        </h2>
        <AgentConfigForm value={form} onChange={setForm} errors={errors as any} />
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
          <button type="button" onClick={handleCancel} style={cancelBtnStyle} disabled={submitting}>Cancel</button>
          <button type="submit" disabled={!form.name.trim() || submitting} style={saveBtnStyle}>
            {submitting ? 'Respawning…' : 'Save & Respawn'}
          </button>
        </div>

        {busyConfirm && (
          <div style={busyConfirmStyle}>
            <div style={{ fontSize: '13px', color: '#e0e0e0', marginBottom: '8px' }}>
              Agent is busy — kill and respawn anyway?
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setBusyConfirm(false)} style={cancelBtnStyle}>Cancel</button>
              <button type="button" onClick={() => void performRespawn()} style={saveBtnStyle}>Kill and respawn</button>
            </div>
          </div>
        )}
      </form>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  backgroundColor: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 99999
}

const formStyle: React.CSSProperties = {
  backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
  padding: '24px', width: '450px', display: 'flex', flexDirection: 'column', gap: '12px',
  position: 'relative'
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 16px', backgroundColor: '#2a2a2a', border: '1px solid #444',
  borderRadius: '4px', color: '#aaa', cursor: 'pointer', fontSize: '13px'
}

const saveBtnStyle: React.CSSProperties = {
  padding: '8px 16px', backgroundColor: '#2d4a5a', border: '1px solid #4c8aaf',
  borderRadius: '4px', color: '#8cc4e0', cursor: 'pointer', fontSize: '13px'
}

const busyConfirmStyle: React.CSSProperties = {
  position: 'absolute', inset: '50% 24px auto 24px',
  transform: 'translateY(-50%)',
  backgroundColor: '#2a1e1e', border: '1px solid #6c3030', borderRadius: '6px',
  padding: '16px', boxShadow: '0 8px 24px rgba(0,0,0,0.6)'
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/EditAgentDialog.tsx
git commit -m "feat: EditAgentDialog wraps AgentConfigForm with respawn semantics"
```

---

## Task 7: Wire `onEdit` button into ThemeMenu

**Files:**
- Modify: `src/renderer/components/FloatingWindow.tsx:328-411` (ThemeMenu component + props)

- [ ] **Step 1: Update ThemeMenu props and JSX**

In `src/renderer/components/FloatingWindow.tsx`, find `ThemeMenuProps` (line 328) and the `ThemeMenu` function (line 337). Modify them to accept and render an optional `onEdit` callback:

```tsx
interface ThemeMenuProps {
  x: number
  y: number
  theme: AgentTheme | undefined
  onClose: () => void
  onApplyPreset: (theme: AgentTheme | null) => void
  onChangeField: (field: keyof AgentTheme, value: string) => void
  onEdit?: () => void  // when set, renders an "Edit agent…" button at the bottom
}
```

Inside the ThemeMenu's JSX, after the existing "Reset to Default" button (around line 406), add:

```tsx
        {onEdit && (
          <>
            <div style={{ borderTop: '1px solid #333', margin: '8px 0' }} />
            <button
              onClick={() => { onEdit(); onClose() }}
              style={{
                width: '100%', padding: '6px', fontSize: '11px',
                background: 'transparent', border: '1px solid #444', borderRadius: '4px',
                color: '#aaa', cursor: 'pointer', fontFamily: 'monospace'
              }}
            >Edit agent…</button>
          </>
        )}
```

- [ ] **Step 2: Add `onEditAgent` prop to FloatingWindow**

In the same file, find the `FloatingWindowProps` interface (line 8) and add:

```tsx
onEditAgent?: (agentId: string) => void
```

In the function signature destructuring (line 54+), add `onEditAgent` to the props pulled out.

Find both `<ThemeMenu …>` render sites (currently at lines 264 and 322) and add the `onEdit` prop:

```tsx
<ThemeMenu
  x={themeMenu.x}
  y={themeMenu.y}
  theme={theme}
  onClose={() => setThemeMenu(null)}
  onApplyPreset={applyPreset}
  onChangeField={updateThemeField}
  onEdit={onEditAgent && agentId ? () => onEditAgent(agentId) : undefined}
/>
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/FloatingWindow.tsx
git commit -m "feat: ThemeMenu shows Edit agent button when onEdit prop is set"
```

---

## Task 8: Wire `onEditAgent` from Workspace → App + render EditAgentDialog

**Files:**
- Modify: `src/renderer/components/Workspace.tsx:430-473` (FloatingWindow render)
- Modify: `src/renderer/components/Workspace.tsx` props interface (top of file)
- Modify: `src/renderer/App.tsx` (state + dialog render)

- [ ] **Step 1: Add `onEditAgent` to Workspace props**

In `src/renderer/components/Workspace.tsx`, find the `WorkspaceProps` interface and add:

```ts
onEditAgent?: (agentId: string) => void
```

Destructure it in the function signature alongside other props.

- [ ] **Step 2: Pass `onEditAgent` to FloatingWindow only for non-terminal agents**

In `Workspace.tsx`, find the `<FloatingWindow>` render around line 425. Add the `onEditAgent` prop to the FloatingWindow JSX:

```tsx
onEditAgent={agent && agent.cli !== 'terminal' ? onEditAgent : undefined}
```

This makes `onEditAgent` only available for real agent windows that have a CLI (not panels, not raw terminals).

- [ ] **Step 3: Wire state in App.tsx**

In `src/renderer/App.tsx`, near the other dialog state (around line 39):

```tsx
const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
```

Pass it to Workspace (find Workspace render — there are likely several tab Workspaces; pass to all of them):

```tsx
<Workspace
  ...
  onEditAgent={(id) => setEditingAgentId(id)}
/>
```

Add the import at the top:

```tsx
import { EditAgentDialog } from './components/EditAgentDialog'
```

Add the dialog render at the bottom alongside `showSpawnDialog`:

```tsx
{editingAgentId && (() => {
  const agent = agents.find(a => a.id === editingAgentId)
  if (!agent) {
    // Agent vanished externally — clear and skip render
    setEditingAgentId(null)
    return null
  }
  return <EditAgentDialog agent={agent} onClose={() => setEditingAgentId(null)} />
})()}
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Manual smoke — full feature path**

```
npm run dev
```

1. Spawn a Claude agent (sonnet, cwd = current project, role = worker, ceoNotes = "test").
2. Right-click the agent's title bar. Existing color popover opens. Verify:
   - Color swatches still work (click one, agent recolors).
   - Below them: a divider, then `Edit agent…` button.
3. Click `Edit agent…`. Modal opens, pre-filled:
   - Name = "<your name>"
   - CLI = Claude Code
   - Model = Sonnet
   - Role = Worker
   - CEO Notes = "test"
   - Skills (if any) — names resolved from IDs
4. Change the model to Opus. Click `Save & Respawn`.
5. Verify:
   - Old PTY dies, terminal scrollback wipes.
   - New PTY launches with Opus.
   - Window stays in the same x/y/width/height.
   - Agent panel chat history is empty (fresh start).
6. Right-click the agent again, change name to "researcher" (or any unused name). Save.
   - Verify: title bar updates to new name. Old name freed.
7. Spawn a second agent named "buddy". Right-click the first agent, try to rename it to "buddy". Save.
   - Verify: dialog stays open, inline error under Name: "An agent with this name already exists".
8. Right-click the first agent, change cwd to `C:\does\not\exist` (Windows) or `/does/not/exist` (mac/linux). Save.
   - Verify: dialog stays open, inline error under CWD: "Directory does not exist".
9. With one agent currently `working` (mid-task), open Edit dialog and change something. Save.
   - Verify: red "Agent is busy — kill and respawn anyway?" mini-confirm appears.
   - Cancel: dialog stays open, agent untouched.
   - Confirm: agent killed and respawned.
10. Spawn a "Plain Terminal" agent. Right-click. Verify the popover does NOT show `Edit agent…` button.
11. Open Edit dialog, make changes, click Cancel. Verify "Discard changes?" confirm appears.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/Workspace.tsx src/renderer/App.tsx
git commit -m "feat: wire Edit agent dialog from right-click context menu"
```

---

## Task 9: Final verification + cleanup pass

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: PASS — `respawn-validation.test.ts` and all existing trollbox tests still green.

- [ ] **Step 2: Full typecheck + build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Run any existing lint**

Check `package.json` for `lint` script, run if present.
Expected: PASS (or no script).

- [ ] **Step 4: Quick read-through of staged diffs**

Run: `git log --oneline -10` and `git diff main...HEAD --stat`
Sanity-check: every commit message describes one focused change. No dead code, no leftover console.logs, no TODO comments.

- [ ] **Step 5: Re-run full smoke checklist from Task 8 Step 5**

If everything passes, the feature is shippable.

- [ ] **Step 6: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "chore: cleanup after agent edit feature"
# (skip this step if there's nothing to commit)
```
