# Pi (pi.dev) CLI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Pi (pi.dev) as a selectable CLI in the Cog that spawns as a full hub agent (all 31 Cog MCP tools) via the `pi-mcp-adapter`, with per-agent identity isolation.

**Architecture:** On Pi spawn the Cog writes a per-agent `mcp.json` into `<tmp>/cog-pi-<id>/`, points Pi at it via the `PI_CODING_AGENT_DIR` env var (injected through the existing PTY `extraEnv` hook), and on the first Pi spawn per session prepends `pi install npm:pi-mcp-adapter` to the launch line. Pi reads that config through the adapter and reaches the hub. No model flag is passed (the user configures their model in Pi); Pi has no permission prompts so the auto-approve toggle is a no-op for it.

**Tech Stack:** TypeScript, Electron (main process), node-pty, Vitest. Spec: `docs/superpowers/specs/2026-06-02-pi-cli-integration-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/main/mcp/config-writer.ts` | Adds `piAgentDir()`, `writePiAgentConfig()`, `cleanupPiAgentDir()`; refactors the shared `cog` server entry so both writers stay DRY. |
| `src/main/cli-launch.ts` | Adds the `pi` launch branch + an optional `ensurePiAdapter` parameter that combines install + launch into one shell line. |
| `src/main/index.ts` | Selects the Pi config writer, injects `PI_CODING_AGENT_DIR`, guards the once-per-session adapter install, and cleans up the Pi dir on exit. |
| `src/renderer/components/AgentConfigForm.tsx` | Adds the Pi preset, its (non-flag) model entry, and the explanatory note. |
| `tests/unit/config-writer.test.ts` | Unit coverage for the new Pi config writer. |
| `tests/unit/cli-launch.test.ts` | Unit coverage for the new Pi launch branch. |

---

## Task 1: Pi per-agent config writer

**Files:**
- Modify: `src/main/mcp/config-writer.ts`
- Test: `tests/unit/config-writer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests to `tests/unit/config-writer.test.ts`. First update the imports at the top of the file:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { writeAgentMcpConfig, cleanupConfig, writePiAgentConfig, cleanupPiAgentDir, piAgentDir } from '../../src/main/mcp/config-writer'
import { existsSync, readFileSync, unlinkSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
```

Then add a new `describe` block at the end of the file (after the existing `describe('MCP Config Writer', ...)` block closes):

```typescript
describe('Pi Agent Config Writer', () => {
  const createdDirs: string[] = []

  afterEach(() => {
    for (const d of createdDirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
    createdDirs.length = 0
  })

  it('derives a per-agent dir from the agent id under tmpdir', () => {
    const dir = piAgentDir('agent-xyz')
    expect(dir).toBe(path.join(os.tmpdir(), 'cog-pi-agent-xyz'))
  })

  it('writes mcp.json into a per-agent dir and returns both paths', () => {
    const { agentDir, configPath } = writePiAgentConfig({
      agentId: 'pi-1',
      agentName: 'pi-worker',
      hubPort: 9999,
      hubSecret: 'abc123',
      mcpServerPath: '/path/to/mcp-server.js'
    })
    createdDirs.push(agentDir)

    expect(agentDir).toBe(path.join(os.tmpdir(), 'cog-pi-pi-1'))
    expect(configPath).toBe(path.join(agentDir, 'mcp.json'))
    expect(existsSync(configPath)).toBe(true)

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(content.mcpServers.cog.command).toBe('node')
    expect(content.mcpServers.cog.args).toContain('/path/to/mcp-server.js')
    // Dual-emit env vars: COG_* (new) + AGENTORCH_* (legacy)
    expect(content.mcpServers.cog.env.COG_HUB_PORT).toBe('9999')
    expect(content.mcpServers.cog.env.COG_AGENT_ID).toBe('pi-1')
    expect(content.mcpServers.cog.env.AGENTORCH_HUB_PORT).toBe('9999')
  })

  it('gives distinct agents distinct dirs', () => {
    const a = writePiAgentConfig({ agentId: 'a', agentName: 'A', hubPort: 1, hubSecret: 'x', mcpServerPath: '/m.js' })
    const b = writePiAgentConfig({ agentId: 'b', agentName: 'B', hubPort: 1, hubSecret: 'x', mcpServerPath: '/m.js' })
    createdDirs.push(a.agentDir, b.agentDir)
    expect(a.agentDir).not.toBe(b.agentDir)
  })

  it('cleanupPiAgentDir removes the whole dir', () => {
    const { agentDir, configPath } = writePiAgentConfig({ agentId: 'cleanup', agentName: 'C', hubPort: 1, hubSecret: 'x', mcpServerPath: '/m.js' })
    expect(existsSync(configPath)).toBe(true)
    cleanupPiAgentDir(agentDir)
    expect(existsSync(agentDir)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/config-writer.test.ts`
Expected: FAIL — `writePiAgentConfig`, `cleanupPiAgentDir`, `piAgentDir` are not exported.

- [ ] **Step 3: Implement the writer**

Edit `src/main/mcp/config-writer.ts`. Change the imports on line 1 to add `mkdirSync` and `rmSync`:

```typescript
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs'
```

Extract the shared `cog` server entry so both writers stay DRY. Add this helper above `writeAgentMcpConfig` (after the `McpConfigOptions` interface):

```typescript
// The `cog` MCP server entry shared by every agent config (file-based and Pi).
// Dual-emit COG_* (new) + AGENTORCH_* (legacy) so in-flight agents keep working.
function cogServerEntry(opts: McpConfigOptions) {
  return {
    command: 'node',
    args: [opts.mcpServerPath],
    env: {
      COG_HUB_PORT: String(opts.hubPort),
      COG_HUB_SECRET: opts.hubSecret,
      COG_AGENT_ID: opts.agentId,
      COG_AGENT_NAME: opts.agentName,
      AGENTORCH_HUB_PORT: String(opts.hubPort),
      AGENTORCH_HUB_SECRET: opts.hubSecret,
      AGENTORCH_AGENT_ID: opts.agentId,
      AGENTORCH_AGENT_NAME: opts.agentName
    }
  }
}
```

Replace the inline `config` object inside `writeAgentMcpConfig` so it uses the helper:

```typescript
  const config = {
    mcpServers: {
      cog: cogServerEntry(opts)
    }
  }
```

Then append the Pi writer functions at the end of the file:

```typescript
/**
 * Pi (pi.dev) has no native MCP support; the pi-mcp-adapter reads its downstream
 * MCP servers from `$PI_CODING_AGENT_DIR/mcp.json`. We give each Pi agent its own
 * dir so concurrent Pi agents get distinct hub identities (no global collision).
 */
export function piAgentDir(agentId: string): string {
  return path.join(os.tmpdir(), `cog-pi-${agentId}`)
}

export function writePiAgentConfig(opts: McpConfigOptions): { agentDir: string; configPath: string } {
  const agentDir = piAgentDir(opts.agentId)
  mkdirSync(agentDir, { recursive: true })
  const configPath = path.join(agentDir, 'mcp.json')
  const config = {
    mcpServers: {
      cog: cogServerEntry(opts)
    }
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
  return { agentDir, configPath }
}

export function cleanupPiAgentDir(agentDir: string): void {
  try {
    rmSync(agentDir, { recursive: true, force: true })
  } catch {
    // Dir already removed or inaccessible
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/config-writer.test.ts`
Expected: PASS — all tests green (existing 2 + new 4).

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/config-writer.ts tests/unit/config-writer.test.ts
git commit -m "feat(pi): per-agent MCP config writer for Pi adapter"
```

---

## Task 2: Pi launch command + adapter install

**Files:**
- Modify: `src/main/cli-launch.ts:95-209`
- Test: `tests/unit/cli-launch.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests inside the existing `describe('buildCliLaunchCommands', ...)` block in `tests/unit/cli-launch.test.ts`:

```typescript
  it('launches Pi with just `pi` (no model/auto flags) when adapter is already ensured', () => {
    expect(buildCliLaunchCommands(
      makeConfig({ cli: 'pi', model: 'whatever', autoMode: true }),
      'C:\\temp\\cog-pi-agent-1\\mcp.json',
      'C:\\temp\\mcp-server.js',
      7777,
      'secret',
      false
    )).toEqual(['pi'])
  })

  it('prepends the adapter install on first Pi spawn, separated for the shell', () => {
    // PowerShell / posix use `;` to run pi regardless of install result
    expect(buildCliLaunchCommands(
      makeConfig({ cli: 'pi', shell: 'powershell' }),
      'C:\\temp\\cog-pi-agent-1\\mcp.json',
      'C:\\temp\\mcp-server.js',
      7777,
      'secret',
      true
    )).toEqual(['pi install npm:pi-mcp-adapter ; pi'])
  })

  it('uses `&` to chain install+launch on cmd.exe', () => {
    expect(buildCliLaunchCommands(
      makeConfig({ cli: 'pi', shell: 'cmd' }),
      'C:\\temp\\cog-pi-agent-1\\mcp.json',
      'C:\\temp\\mcp-server.js',
      7777,
      'secret',
      true
    )).toEqual(['pi install npm:pi-mcp-adapter & pi'])
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/cli-launch.test.ts`
Expected: FAIL — `buildCliLaunchCommands` ignores the 6th arg and returns `['pi']`-style output incorrectly (Pi branch doesn't exist yet, so it falls through to `return [cliBase]` → `['pi']` for the first test by accident, but the install tests fail).

- [ ] **Step 3: Implement the Pi branch**

Edit `src/main/cli-launch.ts`. Add the optional `ensurePiAdapter` parameter to the `buildCliLaunchCommands` signature (currently lines 95-101):

```typescript
export function buildCliLaunchCommands(
  config: AgentConfig,
  mcpConfigPath: string,
  mcpServerPath: string,
  hubPort: number,
  hubSecret: string,
  ensurePiAdapter = false
): string[] | null {
```

Add the Pi branch immediately before the final `return [cliBase]` (currently line 208). Pi takes no model/auto flags and interpolates no user-controlled tokens into the command (identity flows via the config file + `PI_CODING_AGENT_DIR` env), so there is nothing to shell-escape here:

```typescript
  if (cliBase === 'pi') {
    // Pi has no permission prompts (autoMode is a no-op) and reads its model from
    // its own provider config (no --model flag). Identity reaches the hub via the
    // pi-mcp-adapter reading $PI_CODING_AGENT_DIR/mcp.json, set by the spawn site.
    if (ensurePiAdapter) {
      // Combine install + launch on one PTY line so `pi` only runs after the
      // install command returns (avoids the fixed inter-command delay racing a
      // slow npm install). `;`/`&` run `pi` regardless of install success, so a
      // failed install degrades to a solo Pi rather than no agent at all.
      const sep = config.shell === 'cmd' ? ' & ' : ' ; '
      return [`pi install npm:pi-mcp-adapter${sep}pi`]
    }
    return ['pi']
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/cli-launch.test.ts`
Expected: PASS — all tests green (existing + new 3).

- [ ] **Step 5: Commit**

```bash
git add src/main/cli-launch.ts tests/unit/cli-launch.test.ts
git commit -m "feat(pi): Pi launch branch + first-spawn adapter install"
```

---

## Task 3: Wire Pi into the spawn flow

**Files:**
- Modify: `src/main/index.ts` (import line 16; `buildCliLaunchCommands` wrapper ~855; `buildMcpEnv` ~925; `spawnPtyAndWire` ~953 incl. onExit ~974 and cmd build ~1013; the two writer call sites ~1043 and ~1115)

This task is integration wiring; it is verified by a clean build (which typechecks) and the existing unit suites staying green. Runtime behavior is verified manually after the build.

- [ ] **Step 1: Extend imports and add the session guard**

In `src/main/index.ts`, change the config-writer import (line 16) to:

```typescript
import { writeAgentMcpConfig, writePiAgentConfig, cleanupConfig, cleanupPiAgentDir, piAgentDir } from './mcp/config-writer'
```

Add a module-level guard flag near the other top-level mutable state (e.g. just after the `agents` map / other `let`/`const` module state — anywhere at module scope before `spawnPtyAndWire`):

```typescript
// pi-mcp-adapter only needs installing once per app session; guard the prepend.
let piAdapterEnsured = false
```

- [ ] **Step 2: Inject PI_CODING_AGENT_DIR in buildMcpEnv**

In `buildMcpEnv` (ends ~line 945), add this just before `return env`:

```typescript
  if (config.cli === 'pi') env.PI_CODING_AGENT_DIR = piAgentDir(config.id)
```

- [ ] **Step 3: Add a writer-selection helper and use it at both call sites**

Add this helper above `spawnPtyAndWire` (around line 947):

```typescript
// Pick the right MCP config writer for the CLI. Pi reads its config from a
// per-agent dir via the adapter; every other CLI uses the flag-based tmp file.
function prepareAgentMcpConfig(config: AgentConfig, mcpServerPath: string): string {
  const opts = {
    agentId: config.id,
    agentName: config.name,
    hubPort: hub.port,
    hubSecret: hub.secret,
    mcpServerPath
  }
  if (config.cli === 'pi') return writePiAgentConfig(opts).configPath
  return writeAgentMcpConfig(opts)
}
```

Replace the writer call in `reconnectAgent` (lines 1043-1049) with:

```typescript
  const mcpConfigPath = prepareAgentMcpConfig(config, mcpServerPath)
```

Replace the writer call in the primary spawn handler (lines 1115-1121) with:

```typescript
  const mcpConfigPath = prepareAgentMcpConfig(config, mcpServerPath)
```

- [ ] **Step 4: Clean up the Pi dir on exit**

In `spawnPtyAndWire`'s `onExit` callback, replace the cleanup line (line 974):

```typescript
      if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)
```

with:

```typescript
      if (config.cli === 'pi') {
        cleanupPiAgentDir(piAgentDir(config.id))
      } else if (managed.mcpConfigPath) {
        cleanupConfig(managed.mcpConfigPath)
      }
```

- [ ] **Step 5: Pass the install guard through to the command builder**

In `spawnPtyAndWire`, replace the command-build line (line 1013):

```typescript
  const cmds = buildCliLaunchCommands(config, mcpConfigPath, mcpServerPath, hub.port, hub.secret)
```

with:

```typescript
  const ensurePiAdapter = config.cli === 'pi' && !piAdapterEnsured
  const cmds = buildCliLaunchCommands(config, mcpConfigPath, mcpServerPath, hub.port, hub.secret, ensurePiAdapter)
  if (ensurePiAdapter) piAdapterEnsured = true
```

Then update the local wrapper `buildCliLaunchCommands` (lines 855-860) to accept and forward the flag:

```typescript
function buildCliLaunchCommands(
  config: AgentConfig, mcpConfigPath: string, mcpServerPath: string,
  hubPort: number, hubSecret: string, ensurePiAdapter = false
): string[] | null {
  return buildCliLaunchCommandsForConfig(config, mcpConfigPath, mcpServerPath, hubPort, hubSecret, ensurePiAdapter)
}
```

- [ ] **Step 6: Build to typecheck the whole change**

Run: `npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 7: Re-run the unit suites for the touched modules**

Run: `npx vitest run tests/unit/cli-launch.test.ts tests/unit/config-writer.test.ts`
Expected: PASS (all green).

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(pi): wire Pi into spawn flow (config, env, install guard, cleanup)"
```

---

## Task 4: Pi in the spawn form UI

**Files:**
- Modify: `src/renderer/components/AgentConfigForm.tsx` (`CLI_PRESETS` ~13-22; `CLI_MODELS` ~25; the per-CLI note block ~249-253; the auto-mode caption ~382-388)

This task is UI; it is verified by a clean build (typecheck) and a visual check.

- [ ] **Step 1: Add the Pi preset**

In `CLI_PRESETS` (lines 13-22), add the Pi entry after the Grok line and before the `Plain Terminal` line:

```typescript
  { label: 'Grok CLI (Experimental)', value: 'grok' },
  { label: 'Pi (pi.dev)', value: 'pi' },
  { label: 'Plain Terminal', value: 'terminal' },
```

- [ ] **Step 2: Add the Pi model entry**

In the `CLI_MODELS` record (starts line 25), add a `pi` key (place it after the `grok` block). Pi takes no model flag — this single entry documents that and emits no `--model`:

```typescript
  pi: [
    // Pi is model-agnostic; you pick the model/provider during Pi's own first-run
    // setup. The Cog passes no --model flag. See cli-launch.ts pi branch.
    { label: 'Configured in Pi (set on first run)', value: '' },
  ],
```

- [ ] **Step 3: Add the explanatory note**

After the existing Grok note block (lines 249-253), add a Pi note:

```tsx
      {value.cli === 'pi' && (
        <div style={{ color: '#7da87d', fontSize: '11px' }}>
          Pi runs tools without permission prompts and uses the model/provider you
          set up inside Pi. The Cog auto-installs pi-mcp-adapter on first launch so
          Pi can reach the hub tools. Requires the `pi` CLI on your PATH.
        </div>
      )}
```

- [ ] **Step 4: Handle the auto-approve caption for Pi**

In the auto-mode caption span (lines 382-388), add a `pi` case. Change:

```tsx
           value.cli === 'copilot' ? '(--allow-all)' : '(auto-run)'}
```

to:

```tsx
           value.cli === 'copilot' ? '(--allow-all)' :
           value.cli === 'pi' ? '(Pi has no prompts — always auto)' : '(auto-run)'}
```

- [ ] **Step 5: Build to typecheck the renderer**

Run: `npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 6: Visual check**

Open the spawn/agent-config form, select "Pi (pi.dev)" from the CLI dropdown. Confirm: the model dropdown shows the single "Configured in Pi" entry, the green Pi note appears, and the auto-approve caption reads "(Pi has no prompts — always auto)".

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/AgentConfigForm.tsx
git commit -m "feat(pi): add Pi to the spawn form (preset, note, model entry)"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: success, no errors.

- [ ] **Step 2: Run the touched unit suites**

Run: `npx vitest run tests/unit/cli-launch.test.ts tests/unit/config-writer.test.ts`
Expected: PASS (all green).

- [ ] **Step 3: Manual acceptance (requires `pi` installed + a provider configured in Pi)**

1. Spawn one Pi agent from the Cog. On the first spawn, confirm `pi install npm:pi-mcp-adapter` runs in the terminal, then `pi` launches.
2. From another agent (or the hub view), confirm the Pi agent appears in `get_agents`.
3. From the Pi agent, exercise hub tools via the adapter's proxy: `read_tasks`, `send_message`, `view_sketchpad_page`. Confirm round-trips work.
4. Spawn a second Pi agent; confirm both have distinct identities (distinct `cog-pi-<id>` dirs) and can message each other.
5. Kill a Pi agent; confirm its `<tmp>/cog-pi-<id>` dir is removed.

Note: on the very first Pi spawn the install can take longer than the normal inter-command delay; the initial orchestrator prompt may be injected slightly late or land in install output. Status-driven injection recovers once Pi reaches its prompt. This is an accepted V1 limitation.

---

## Self-Review

**Spec coverage:**
- Auto-install adapter (decision 1) → Task 2 (install command) + Task 3 Step 5 (session guard).
- Full hub agent (decision 2) → Task 1 (cog server entry in Pi config) + Task 3 (env injection).
- Per-agent `PI_CODING_AGENT_DIR` isolation (decision 3) → Task 1 (`piAgentDir`/`writePiAgentConfig`) + Task 3 Step 2.
- No model flag / single dropdown entry (decision 4) → Task 2 (no flag) + Task 4 Step 2.
- Auto-approve no-op + note (decision 5) → Task 2 (ignores autoMode) + Task 4 Steps 3-4.
- Error handling: install failure degrades to solo Pi → Task 2 (`;`/`&` separator). `pi` not on PATH → standard shell failure + Task 4 note. Cleanup on exit → Task 3 Step 4.
- Testing → Tasks 1, 2 (unit) + Task 5 (manual acceptance).

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step shows complete code. The npm package-name detail from the spec is intentionally not in any command (the Cog assumes `pi` is on PATH; the package name only appears in the spec's prose, not the implementation).

**Type consistency:** `writePiAgentConfig` returns `{ agentDir, configPath }` everywhere it's used (Task 1 tests, Task 3 `prepareAgentMcpConfig`). `piAgentDir(agentId)` is used identically in config-writer, `buildMcpEnv`, and onExit cleanup. `ensurePiAdapter` is the 6th param in both the `cli-launch.ts` export (Task 2) and the `index.ts` wrapper (Task 3 Step 5). `McpConfigOptions` is reused unchanged.
