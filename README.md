# AgentOrch

A desktop workspace for orchestrating multiple AI coding agents. Spawn Claude Code, Codex CLI, Kimi CLI, or any terminal — and let them talk to each other via MCP.

No more copy-pasting between terminals. The orchestrator sends tasks, workers pick them up, results flow back automatically.

## What It Does

- **Floating terminal windows** — drag, resize, overlap, minimize, maximize. Like a desktop window manager for your agent CLIs.
- **MCP-based messaging** — agents get `send_message`, `get_messages`, `get_agents`, and `read_ceo_notes` tools. The orchestrator dispatches work, workers report back.
- **Auto-nudge** — when a message arrives, the target agent's terminal gets nudged to check their inbox. No manual polling.
- **CEO Notes** — write per-agent instructions once. Every agent can read them. The orchestrator sees everyone's role and notes via `get_agents()`.
- **Multi-CLI support** — Claude Code, Codex CLI, Kimi CLI, plain terminals, or any custom command. Each gets the right MCP integration automatically.

## Quick Start

```bash
git clone https://github.com/natebag/AgentOrch.git
cd AgentOrch
npm install
npm run dev
```

Click **+** to spawn an agent. Fill in:
- **Name** — how other agents refer to this one (e.g., "orchestrator", "worker-1")
- **CLI** — Claude Code, Codex, Kimi, Plain Terminal, or Custom
- **Working Directory** — where the agent operates (use Browse to pick)
- **Role** — Orchestrator, Worker, Researcher, Reviewer, or Custom
- **CEO Notes** — instructions for this agent (visible to all other agents)
- **Auto-approve mode** — skip permission prompts (Claude: `--dangerously-skip-permissions`, Codex: `--yolo`, Kimi: `--dangerously-skip-permissions`)

## How Agents Communicate

Each agent gets 4 MCP tools:

| Tool | What it does |
|------|-------------|
| `send_message(to, message)` | Send a message to another agent by name |
| `get_messages()` | Check inbox — returns queued messages, clears the queue |
| `get_agents()` | See all agents, their roles, CLI types, CEO notes, and status |
| `read_ceo_notes()` | Re-read your own CEO notes and role |

**Example flow:**
1. You tell the orchestrator: "Dispatch work to the workers"
2. Orchestrator calls `get_agents()` to see who's available
3. Orchestrator calls `send_message("worker-1", "Decompile this class...")`
4. Worker-1 gets nudged, calls `get_messages()`, receives the task
5. Worker-1 does the work, calls `send_message("orchestrator", "Done, here's what I found...")`
6. Orchestrator picks it up and dispatches the next task

## Architecture

```
Electron App
  |
  +-- Hub HTTP Server (localhost, auto-port)
  |     +-- Agent Registry (names, roles, CEO notes, status)
  |     +-- Message Router (queues, nudges, delivery)
  |     +-- Auth (shared secret per session)
  |
  +-- Per-Agent MCP Server (spawned by each CLI via stdio)
  |     +-- Thin relay: MCP tool calls -> Hub HTTP API
  |
  +-- PTY Manager (node-pty)
  |     +-- Real terminal per agent
  |     +-- Status detection (idle/active/working/disconnected)
  |
  +-- React UI
        +-- Floating windows (react-rnd)
        +-- xterm.js terminals
        +-- Spawn dialog, top bar, agent pills
```

## CLI Integration

| CLI | MCP Method | Auto-approve |
|-----|-----------|-------------|
| Claude Code | `--mcp-config <file>` | `--dangerously-skip-permissions` |
| Codex CLI | `codex mcp add` (auto-registered) | `--yolo` |
| Kimi CLI | `--mcp-config-file <file>` | `--dangerously-skip-permissions` |
| Plain Terminal | No MCP (manual use) | N/A |
| Custom | No MCP | N/A |

**Note:** For Kimi, use "Command Prompt (cmd)" in Advanced > Shell if PowerShell can't find the `kimi` command.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+1` through `Ctrl+9` | Focus agent window by position |
| `Ctrl+Tab` | Cycle through windows |
| `Ctrl+C` | Copy selected text (or SIGINT if nothing selected) |
| `Ctrl+V` | Paste from clipboard |

## Tech Stack

- **Electron** + **React** + **TypeScript**
- **xterm.js** for terminal emulation
- **node-pty** for real PTY shells
- **@modelcontextprotocol/sdk** for MCP server
- **express** for the hub HTTP API
- **react-rnd** for draggable/resizable windows
- **electron-vite** for build tooling

## Development

```bash
npm run dev          # Start in dev mode
npm run build        # Production build
npm run test         # Run all tests (vitest)
npm run test:watch   # Watch mode
npm run build:mcp    # Rebuild MCP server bundle
```

## License

MIT
