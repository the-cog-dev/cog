# Pi (pi.dev) CLI Integration — Design

**Date:** 2026-06-02
**Status:** Approved, ready for implementation plan
**Author:** Nate + Claude (brainstorming session)

## Goal

Add **Pi** (the pi.dev coding agent CLI) as a selectable CLI in the Cog, spawned as a
**full hub agent** — i.e. with access to all 31 Cog MCP hub tools (`send_message`,
`post_task`, `read_tasks`, `view_sketchpad_page`, `schedule_prompt`, …) — bridged through
the community `pi-mcp-adapter`. Primary motivation: run cheap, model-agnostic agents
(Pi's design point) instead of paying for Claude.

## Background / why this is non-trivial

Pi **deliberately has no native MCP support** (Mario Zechner's design decision — MCP tool
defs are considered too token-heavy). The Cog makes every agent a first-class hub citizen
by injecting its own MCP server into the agent. So a vanilla Pi agent cannot talk to the
hub or other agents.

The bridge is **`pi-mcp-adapter`** (github.com/nicobailon/pi-mcp-adapter), a Pi extension
that wraps one-or-more downstream MCP servers behind a **single ~200-token proxy tool**
(`search`/`describe`/`call`). The agent discovers tools on-demand and only pays token cost
for the tools it actually uses — which is *ideal* for the cheap-model use case, because the
Cog's MCP server exposes 31 tools and dumping all their defs into a small model's context
would be wasteful.

### Confirmed external facts (verified 2026-06-02)

- **Adapter install:** `pi install npm:pi-mcp-adapter` (Pi's own package manager), then Pi
  must be (re)started. Because the Cog runs this *before* launching `pi` in the same PTY,
  there is no "restart" problem — `pi` simply starts after the install command completes.
- **Adapter config:** standard `mcpServers` JSON (`command` / `args` / `env` / optional
  `lifecycle` / `cwd`). This is the **same shape** the Cog's existing
  `writeAgentMcpConfig()` already produces.
- **Config location & per-agent isolation:** the adapter reads
  `<Pi agent dir>/mcp.json`, which is `~/.pi/agent/mcp.json` by default **or
  `$PI_CODING_AGENT_DIR/mcp.json` when `PI_CODING_AGENT_DIR` is set.** Setting that env var
  per agent gives each Pi agent its own config and therefore its own hub identity.
- **No permission prompts:** Pi runs tools without confirmation by design ("no permission
  popups"). There is **no `--yolo` / `--dangerously-skip-permissions` flag** because Pi
  never prompts. A Pi agent in the Cog is therefore inherently "auto mode"; its safety story
  is "runs in its own cwd," which the Cog already provides.
- **Model:** Pi is model-agnostic; the user configures their provider/model during Pi's own
  first-run setup. The Cog therefore does **not** pass a model flag — launch is just `pi`.
- **Binary:** `pi`. The Cog assumes it is already installed and on PATH (same assumption it
  makes for claude/codex/kimi/gemini/etc.). The npm package is currently published as
  `@earendil-works/pi-coding-agent` (to confirm for the UI install hint).

## Decisions (locked during brainstorming)

1. **Auto-install the adapter.** On first Pi spawn per app session, the Cog runs
   `pi install npm:pi-mcp-adapter`. Zero setup for the user — Pi "just works" as a hub agent.
2. **Full hub agent (not tiered).** Ship the adapter-wired version directly; no separate
   "solo Pi first" phase.
3. **Per-agent identity via `PI_CODING_AGENT_DIR`.** Each Pi agent launches with
   `PI_CODING_AGENT_DIR` pointed at its own temp dir; the Cog writes that agent's `mcp.json`
   there. Full isolation, never touches the user's project folders, mirrors how the other
   CLIs already write configs to tmp.
4. **No model flag / no model dropdown logic for Pi.** Model selection is the user's
   responsibility, configured in Pi itself. The Cog's model dropdown shows a single
   informative non-flag entry (like kimi's "Default").
5. **Auto-approve toggle is a no-op for Pi.** Show an explanatory note instead of relying on
   the toggle.

## Architecture

### Data flow on Pi agent spawn

```
Cog spawns a Pi agent (config.cli === 'pi')
  1. compute agentDir = <os.tmpdir>/cog-pi-<agentId>/        (deterministic from agent id)
  2. writePiAgentConfig() → mkdir agentDir, write agentDir/mcp.json:
        { "mcpServers": { "cog": {
            "command": "node", "args": [<mcpServerPath>],
            "env": { COG_HUB_PORT, COG_HUB_SECRET, COG_AGENT_ID, COG_AGENT_NAME, + AGENTORCH_* } } } }
  3. spawn PTY with extraEnv: { PI_CODING_AGENT_DIR: agentDir }
  4. (first Pi spawn this app session only) type:  pi install npm:pi-mcp-adapter
  5. type:  pi
Pi boots → pi-mcp-adapter reads $PI_CODING_AGENT_DIR/mcp.json
  → exposes ONE ~200-token proxy tool
  → Pi reaches all 31 Cog hub tools on demand
  → node MCP server (src/mcp-server/index.ts) → hub HTTP routes
```

Two Pi agents → two distinct `PI_CODING_AGENT_DIR`s → two distinct `mcp.json`s → two
distinct hub identities. No collision.

### Why this reuses existing machinery

- The adapter's `mcpServers` block is the **same JSON shape** the Cog already writes — the
  new `writePiAgentConfig()` is a thin variant of `writeAgentMcpConfig()` that writes into a
  per-agent dir and returns that dir.
- `pty-manager.ts` already spawns each agent's shell with
  `env: { ...process.env, ...opts.extraEnv }` (pty-manager.ts:82). Injecting
  `PI_CODING_AGENT_DIR` is just passing it through `SpawnOptions.extraEnv` from the spawn
  site — **no per-shell quoting**.
- `AgentConfig.cli` is a plain `string` (no union), so no shared type needs to change.

## Components / files

| File | Responsibility | Change |
|---|---|---|
| `src/main/mcp/config-writer.ts` | Per-agent MCP config writing | Add `writePiAgentConfig(opts) → { agentDir, configPath }`: create `<tmp>/cog-pi-<id>/`, write `mcp.json` (reuse `mcpServers` shape, dual-emit `COG_*` + `AGENTORCH_*`). Add `cleanupPiAgentDir(agentDir)`. |
| `src/main/cli-launch.ts` | Build PTY launch command strings | Add `if (cliBase === 'pi')` branch returning `['pi']` (no model flag, no auto flag). Add exported pure `buildPiAdapterInstallCommand()` returning `'pi install npm:pi-mcp-adapter'`. Validate shell-safe tokens consistent with other branches. |
| `src/main/index.ts` | Orchestrate spawn | For `config.cli === 'pi'`: compute agentDir, call `writePiAgentConfig`, pass `extraEnv: { PI_CODING_AGENT_DIR }` into the PTY spawn, prepend the install command guarded by a session-level `piAdapterEnsured` flag, and clean up the agent dir on exit. |
| `src/main/shell/pty-manager.ts` | Spawn the PTY | Confirm `SpawnOptions.extraEnv` is threaded from the spawn site (it is already consumed at pty.spawn:82). No structural change expected beyond passing it in from index.ts. |
| `src/renderer/components/AgentConfigForm.tsx` | Spawn form UI | Add `{ label: 'Pi (pi.dev)', value: 'pi' }` to `CLI_PRESETS`; add `CLI_MODELS['pi'] = [{ label: 'Configured in Pi (set on first run)', value: '' }]`; for `cli === 'pi'` render a small note ("Pi runs tools without prompts — no separate auto-approve needed; configure your model/provider inside Pi"). The auto-approve toggle stays visible but the Pi launch branch ignores `config.autoMode` (it's a no-op); the note explains why. |
| `tests/unit/cli-launch.test.ts` | Unit coverage | Pi branch returns `['pi']`; `buildPiAdapterInstallCommand()` returns the expected string; shell-safe token validation still enforced. |
| `tests/unit/config-writer.test.ts` | Unit coverage | `writePiAgentConfig()` creates the per-agent dir, writes the correct `mcpServers` JSON, returns `{ agentDir, configPath }`; distinct agent ids → distinct dirs. |

## Error handling / edge cases

- **Adapter install fails** (offline, npm error): Pi still launches (solo, degraded — no hub
  tools). The failure surfaces in the agent's terminal output; the Cog does not block the
  spawn. Hub tools become available on a later spawn once install succeeds.
- **`pi` not on PATH:** identical failure mode to every other CLI — the shell prints
  "command not found." The form shows an install hint for Pi.
- **Two+ Pi agents concurrently:** isolated by `PI_CODING_AGENT_DIR` (decision 3).
- **Cleanup:** the per-agent dir is removed on agent exit, mirroring `cleanupConfig()` for
  the file-based configs. Reuse of the same agent id overwrites the dir's `mcp.json` in
  place (same race-safety note as the existing respawn path).
- **Install guard:** `piAdapterEnsured` is an in-memory, per-app-session flag. If the user
  uninstalls the adapter mid-session it won't be re-run until next app launch — acceptable
  edge case.

## Testing

**Unit (automated):**
- `cli-launch.test.ts`: Pi branch command building; `buildPiAdapterInstallCommand()`; token
  validation rejects unsafe ids.
- `config-writer.test.ts`: `writePiAgentConfig()` dir creation, JSON shape, per-agent
  isolation, cleanup.

**Manual (acceptance):**
1. With `pi` installed + provider configured, spawn one Pi agent from the Cog. Confirm the
   adapter install runs on first spawn, Pi boots, and the agent appears in `get_agents`.
2. From the Pi agent, exercise hub tools: `send_message`, `read_tasks`,
   `view_sketchpad_page`. Confirm round-trips work.
3. Spawn a second Pi agent; confirm both have distinct identities and can message each other.
4. Kill an agent; confirm its temp dir is cleaned up.

## Out of scope (YAGNI)

- Bundling/vendoring the adapter or Pi itself (assume user-installed, like all other CLIs).
- Model selection plumbing for Pi (user configures in Pi).
- `oh-my-pi` / `omp` fork support (can follow the same pattern later if wanted).
- Mid-session re-install / adapter version pinning.
