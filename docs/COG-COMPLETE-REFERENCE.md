# The Cog — Complete Project Reference

**Version:** As of 2026-04-08
**Repo:** https://github.com/the-cog-dev/cog
**Author:** Nate (natebag)
**256+ commits | 72+ source files | 315+ tests**

---

## What Is The Cog?

The Cog is a desktop application for orchestrating multiple AI coding agents. Think of it as an IDE built from the ground up for AI agents as primary workers, with humans directing.

You open The Cog, point it at a project folder, and spawn a team of AI agents — each in its own terminal window. The agents communicate through a shared hub using MCP (Model Context Protocol) tools: messaging each other, posting tasks to a shared pinboard, sharing research findings, reading and writing project files. You watch them work, review their output, and steer from above.

**The key insight:** Instead of one AI assistant doing everything, you orchestrate a TEAM. An Opus-powered orchestrator breaks down work, Sonnet workers implement in parallel, a reviewer checks quality. Different models for different jobs. Different providers even — Claude, Codex, Kimi, Gemini, DeepSeek, local Ollama models — all in one workspace, all communicating through the same tools.

**And now:** schedule recurring "keep going" prompts so your team grinds while you're away, and check on everything from your phone via a Cloudflare-tunneled mobile dashboard.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 41 |
| Build system | electron-vite |
| Language | TypeScript (strict) |
| Renderer UI | React 19 |
| Hub server | Express 5 (runs inside Electron main process) |
| Database | better-sqlite3 (SQLite, per-project) |
| Terminal emulation | xterm.js + node-pty |
| Code editor | Monaco Editor (@monaco-editor/react) |
| Agent communication | MCP SDK (@modelcontextprotocol/sdk) |
| Floating windows | react-rnd |
| Testing | vitest |

---

## Architecture

```
The Cog (Electron App)
│
├── Main Process (src/main/)
│   ├── Hub Server (Express on localhost, authenticated, per-project port)
│   │   ├── AgentRegistry — tracks all agents + status + heartbeat
│   │   ├── MessageRouter — agent-to-agent messaging with peek/ack, tab + group scoping
│   │   ├── Pinboard — shared task board with role targeting and tab isolation
│   │   ├── InfoChannel — shared knowledge feed (post/read/update/delete)
│   │   ├── BuddyRoom — companion speech log from all terminals
│   │   ├── GroupManager — communication graph (Blender-style node links)
│   │   ├── AgentMetrics — per-agent activity tracking
│   │   ├── Routes — HTTP API for all the above + file operations
│   │   └── Auth — shared secret, timing-safe validation
│   │
│   ├── Shell Management
│   │   ├── PtyManager — spawns node-pty terminals per agent
│   │   ├── StatusDetector — detects when agent is at prompt vs working
│   │   ├── OutputBuffer — rolling line buffer with partial-line handling
│   │   └── BuddyDetector — scans PTY output for companion speech
│   │
│   ├── Scheduler (src/main/scheduler/)
│   │   ├── PromptScheduler — recurring prompt fires with tick loop, pause/resume/restart
│   │   ├── SchedulesStore — SQLite CRUD with upsert, cascade delete by tab
│   │   └── scheduler-helpers — pure time-math helpers (isExpired, shouldFire, applyPause, etc.)
│   │
│   ├── Remote (src/main/remote/) [experimental]
│   │   ├── RemoteServer — separate Express app on its own port, 8 hardened endpoints
│   │   ├── TokenManager — 32-char URL tokens, 8h expiry, session tracking
│   │   ├── CloudflaredManager — lazy-downloads cloudflared binary, spawns quick tunnel
│   │   └── static/ — single-page vanilla HTML/CSS/JS mobile UI (no React)
│   │
│   ├── Git (src/main/git/)
│   │   └── git-ops — shell git commands (status, stage, commit, push, pull, log, diff, branch)
│   │
│   ├── Updater (src/main/updater/)
│   │   └── UpdateChecker — polls GitHub for new commits, git-pull + relaunch flow
│   │
│   ├── RAC (src/main/rac/)
│   │   └── RacClient — R.A.C. (Rent-A-Claude) HTTP client for in-house rental pool [private]
│   │
│   ├── MCP Config — writes per-agent MCP config files (temp dir)
│   ├── CLI Launch — builds launch commands per CLI type
│   ├── ProjectManager — per-project .cog/ folders, recent projects
│   ├── PresetManager — global saved team presets
│   ├── SkillManager — built-in + user skill definitions, prompt composition
│   └── Database — SQLite schema (messages, tasks, info entries, scheduled_prompts)
│
├── MCP Server (src/mcp-server/) — standalone Node process per agent
│   └── 25+ MCP tools that proxy to the hub via HTTP
│
├── Preload (src/preload/) — IPC bridge, context isolation
│
├── Renderer (src/renderer/) — React UI
│   ├── App.tsx — root, project state, dialog management, workspace tabs
│   ├── Workspace.tsx — infinite canvas with floating windows, tabs, panels
│   ├── TopBar.tsx — project switcher, tabs, agents dropdown, panels dropdown
│   ├── TabBar.tsx — workspace tab bar with inline rename + close + create
│   ├── FloatingWindow.tsx — draggable/resizable window container
│   ├── TerminalWindow.tsx — xterm.js terminal per agent
│   ├── SpawnDialog.tsx — agent creation (CLI, model, role, skills, CEO notes)
│   ├── PresetDialog.tsx — save/load presets + 39 templates with search/filter
│   ├── ProjectPickerDialog.tsx — project selection on launch
│   ├── SkillBrowser.tsx — browse, search, create, attach skills
│   ├── FilePanel.tsx — file explorer tree + Monaco editor with tabs
│   ├── GitPanel.tsx — full git UI (status, staging, commit, push/pull, branches, diff, log)
│   ├── PinboardPanel.tsx — shared task board viewer with clear-completed
│   ├── InfoChannelPanel.tsx — shared info feed viewer
│   ├── BuddyRoomPanel.tsx — companion speech log viewer
│   ├── SchedulesPanel.tsx — scheduled prompts with ScheduleRow + PastScheduleRow
│   ├── ScheduleDialog.tsx — create/edit scheduled prompt form
│   ├── UsagePanel.tsx — per-agent activity metrics + provider limit checks
│   ├── RacPanel.tsx — R.A.C. rental UI (password-gated)
│   ├── SettingsDialog.tsx — notifications + Remote View (experimental)
│   ├── LinkOverlay.tsx — SVG bezier/orthogonal routing for communication graph
│   ├── UpdateNotice.tsx — auto-updater UI
│   ├── WhatsNewDialog.tsx — changelog popup on update
│   ├── BugReportDialog.tsx — no-login bug submission
│   └── Hooks (useWindowManager, useAgents, useSnapZones)
│
└── Shared (src/shared/)
    └── types.ts — all interfaces, IPC channel constants (80+ channels)
```

---

## How It Works: The Agent Lifecycle

### 1. Project Selection
On launch, The Cog reads `recent-projects.json` from userData. If there's a recent project, it auto-opens. Otherwise, it shows a project picker dialog. Each project gets its own `.cog/` folder with an isolated SQLite database and presets directory.

### 2. Spawning an Agent
The user opens the SpawnDialog and configures:
- **Name** — e.g., "orchestrator", "worker-1"
- **CLI** — Claude Code, Codex, Kimi, Gemini, OpenClaude, Copilot, Grok, or plain terminal
- **Model** — specific model (Opus, Sonnet, GPT-4o, DeepSeek, etc.)
- **Role** — orchestrator, worker, researcher, reviewer, or custom
- **Skills** — composable capability modules from the skill browser (optional)
- **CEO Notes** — free-text instructions (combined with skills)
- **Working Directory** — where the agent operates
- **Auto-approve mode** — skip permission prompts

When spawned:
1. A per-agent MCP config file is written to temp dir
2. A PTY (pseudo-terminal) is spawned with the selected shell
3. The CLI launch command is typed into the shell
4. StatusDetector watches for the CLI to reach its prompt
5. An initial prompt is injected telling the agent its role and available MCP tools
6. The agent registers with the hub and starts working

### 3. Agent Communication
Agents communicate through 22 MCP tools that proxy to the hub's HTTP API:

**Messaging:**
- `send_message(to, message)` — direct message to another agent
- `get_messages(peek?)` — check inbox (peek mode doesn't clear queue)
- `ack_messages(message_ids)` — acknowledge processed messages
- `broadcast(message)` — message all agents at once
- `get_message_history(agent?, limit?)` — retrieve past messages from DB

**Task Management:**
- `post_task(title, description, priority)` — post to shared pinboard
- `read_tasks()` — list all tasks
- `get_task(task_id)` — fetch single task by ID
- `claim_task(task_id)` — claim an open task
- `complete_task(task_id, result?)` — mark task done
- `abandon_task(task_id)` — release a stuck task back to open

**Shared Knowledge:**
- `post_info(note, tags?)` — post to info channel
- `read_info(tags?)` — read info feed, optionally filtered by tags
- `update_info(id, note)` — update an existing entry
- `delete_info(id)` — remove an entry

**Agent Discovery:**
- `get_agents()` — list all agents (name, role, status, healthy flag)
- `read_ceo_notes()` — re-read your own instructions
- `update_status(status)` — self-report status (idle/active/working)
- `get_agent_output(agent, lines?)` — peek at another agent's terminal

**File Operations:**
- `read_file(path)` — read a project file (1MB limit)
- `write_file(path, content)` — write/create a file (auto-creates dirs)
- `list_directory(path?)` — list files and subdirectories

**Companion:**
- `read_buddy_room(count?)` — read companion speech from all terminals

### 4. Nudge System
Agents don't poll for work — they wait. When something needs their attention, the hub injects a nudge directly into their terminal:

- **Message nudge:** When a message is sent to an agent → "New message from X. Call get_messages() now."
- **Task nudge:** When a task is posted → "New task posted: Y. Call read_tasks() to claim it."
- **Info nudge:** When info is posted → orchestrators get nudged to read it.

Nudges are queue-aware: if the agent is at a prompt (`active` status), the nudge is delivered immediately. If the agent is mid-response, it's queued and delivered when they finish. A 5-second fallback timer ensures delivery even if the StatusDetector can't detect the prompt (fixes Kimi/Gemini).

### 5. Reconnection
If an agent crashes, The Cog auto-respawns it after 3 seconds with a reconnect prompt that includes context about what it was doing (claimed tasks + pending messages). The registry upserts on re-registration instead of throwing.

### 6. Heartbeat
Each MCP server pings the hub every 30 seconds. The `GET /agents` endpoint includes a `healthy` boolean. If pings stop for 60+ seconds, the agent shows as unhealthy.

---

## Project-Based Persistence

Each project folder gets:
```
/path/to/my-project/
├── .cog/
│   ├── .gitignore          # ignores DB files, presets are committable
│   ├── agentorch.db        # SQLite — messages, tasks, info entries, scheduled prompts
│   ├── links.json           # communication graph state
│   └── presets/             # (reserved for future project-scoped presets)
├── src/
└── ...
```

Global state (in `app.getPath('userData')`):
```
userData/
├── recent-projects.json     # last 20 projects
├── settings.json            # notifications toggles, remote view preference
├── presets/                  # saved team presets (global, follow user)
├── skills/                   # user-created skills
└── bin/                      # optional — lazy-downloaded binaries (cloudflared, etc.)
```

**SQLite schema (per-project):**
- `messages` — agent-to-agent messaging history
- `pinboard_tasks` — task board with `tab_id` column for isolation
- `info_entries` — shared knowledge feed
- `scheduled_prompts` — recurring prompts with nullable `duration_hours` and `expires_at` for infinite schedules

Data persists across sessions. No more DB wipe on startup.

---

## Multi-Model Support

The Cog supports 7+ CLI types:

| CLI | Provider | Models |
|-----|----------|--------|
| Claude Code | Anthropic | Opus, Sonnet, Haiku |
| Codex CLI | OpenAI | o4-mini, GPT-4.1, o3 |
| Kimi CLI | Moonshot | Default, K2.5, Thinking Turbo |
| Gemini CLI | Google | 2.5 Pro, 2.5 Flash, 2.0 Flash |
| OpenClaude | Any (200+ models) | GPT-4o, DeepSeek, Ollama, Mistral, etc. |
| GitHub Copilot | Microsoft | Default, GPT-4o, o3-mini |
| Grok CLI | xAI | Grok 3, Grok 3 Mini |

**OpenClaude** is the key: it's a Claude Code fork that replaces the Anthropic API layer with an OpenAI-compatible shim. This means any model gets Claude Code's full tool system (bash, file ops, MCP, agents). Install once, point at any provider via env vars.

---

## Preset Templates (39 Built-in)

Templates are pre-configured team compositions. The Templates tab has search + CLI filter chips so you only see teams you can actually run.

**Claude-only (8):** Orchestrator+Workers, Research Squad, Code+Review, Speed Swarm, Solo Opus, TDD Pipeline, Documentation Team, Rapid Prototyper

**Codex-only (3):** Solo, Orch+Workers, Code+Review

**Kimi-only (3):** Solo, Research Pair, Code+Review

**Gemini-only (3):** Solo, Research Squad, Code+Review

**Cross-CLI pairs (6):** Claude+Codex, Claude+Kimi, Claude+Gemini, Codex+Kimi, Codex+Gemini, Kimi+Gemini

**Creative mixes (3):** Codex+Claude Review, Gemini Lead+Claude Workers, Kimi Lead+Codex Workers

**Triples (4):** C+Cx+K, C+Cx+G, C+K+G, Cx+K+G

**Quads (2):** The Full Stack (all 4 CLIs), Everyone Reviews Claude

**OpenClaude (7):** GPT-4o+DeepSeek, Full OpenAI, DeepSeek Squad, Mixed Provider, OpenRouter Mix, Ollama Local, Hybrid Local+Cloud

Saved presets are global (follow you across projects). Templates ship with the repo.

---

## Skills System

Skills are composable prompt modules that enhance agent capabilities. Instead of writing manual CEO Notes for every agent, you snap on pre-built skill modules.

**15 built-in skills** in 5 categories:
- **Coding:** Code Reviewer, Security Auditor, TDD Enforcer, Refactoring Expert, Documentation Writer
- **Research:** Deep Researcher, Competitive Analyst, API Explorer
- **Workflow:** Task Decomposer, Progress Reporter, Blocker Detector
- **Language:** TypeScript Expert, Python Expert, Rust Expert, Go Expert

**How it works:**
1. SpawnDialog has a skill picker (chip-style multi-select)
2. Click "+ Add Skills" to open the SkillBrowser (3 tabs: Built-in, My Skills, Community)
3. Selected skills' prompts are combined and prepended to CEO Notes at spawn
4. Agent sees skills + CEO Notes when calling `read_ceo_notes()`
5. CEO Notes stays as free text on top of skills — custom instructions always available

**User-created skills** saved to `userData/skills/`. **Community** tab links to skills.sh (90,000+ community skills).

---

## UI Panels

The workspace has 8+ toggleable panels (from the TopBar Panels dropdown). Each panel is a floating, draggable, resizable window on the infinite canvas alongside agent terminals. Panels are tab-scoped — switching workspace tabs shows that tab's own panel state.

| Panel | What it shows |
|-------|--------------|
| **Files** | File explorer tree (left) + Monaco code editor with tabs (right). Browse project files, open/edit/save. |
| **Pinboard** | Shared task board with role-targeted tasks, tab isolation, and clear-completed. |
| **Info** | Shared info feed. Research findings, status updates, tagged entries. |
| **Buddy** | Companion speech log. Collects buddy/companion messages from all agent terminals. |
| **Git** | Full git UI — status, staging, commit, push/pull with ahead/behind, branch switcher, diff viewer, log. Manual refresh, capped at 200 files for performance. |
| **Schedules** | Scheduled prompts with create/pause/resume/stop/restart, past schedules section, 20-entry history ring buffer per schedule. |
| **Usage** | Per-agent activity metrics (messages sent/received, tasks posted/claimed/completed, info posted) + on-demand provider limit checks. |
| **R.A.C.** | Rent-A-Claude panel (password-gated, private). Browse available slots, rent, chat with rented Claude. |
| **Presets** | Save/Load personal presets + browse 39 templates with search and CLI filter. |

Additional dialogs: Settings (notifications, Remote View), Spawn (agent creation), Skill Browser, Project Picker, What's New (changelog), Bug Report, MCP Tools Reference.

---

## Key Source Files

### Main Process (`src/main/`)

| File | What it does |
|------|-------------|
| `index.ts` | Entry point. App lifecycle, IPC handlers, openProject/closeProject, spawn/kill agents, nudge system |
| `hub/server.ts` | Creates Express hub server with auth middleware |
| `hub/routes.ts` | All HTTP routes (agents, messages, tasks, info, files, buddy room, heartbeat) |
| `hub/agent-registry.ts` | In-memory agent state, upsert on duplicate, heartbeat tracking |
| `hub/message-router.ts` | Message queues, rate limiting (30/min), peek/ack, broadcast |
| `hub/pinboard.ts` | Task CRUD (post, claim, complete, abandon), callbacks |
| `hub/info-channel.ts` | Info entries with tags, FIFO cap at 500, update/delete |
| `hub/buddy-room.ts` | Companion message store, 200-message ring buffer |
| `hub/auth.ts` | Shared secret generation, timing-safe comparison |
| `shell/pty-manager.ts` | Spawn node-pty, wire data/exit/status callbacks |
| `shell/status-detector.ts` | ANSI stripping, prompt regex, silence timer → idle/working/active |
| `shell/output-buffer.ts` | Rolling line buffer with partial-line accumulation |
| `shell/buddy-detector.ts` | Chunk-based companion speech detection from PTY output |
| `cli-launch.ts` | CLI-specific launch command builders (claude, codex, kimi, gemini, openclaude, etc.) |
| `project/project-manager.ts` | .cog/ folder creation, recent projects, path resolution |
| `presets/preset-manager.ts` | Save/load/list/delete presets (global userData) |
| `skills/skill-manager.ts` | Load built-in + user skills, CRUD, prompt resolution |
| `mcp/config-writer.ts` | Write per-agent MCP config JSON to temp dir |
| `db/database.ts` | SQLite schema creation, migrations (messages, tasks, info, scheduled_prompts) |
| `db/message-store.ts` | Message persistence (insert, query by agent, history) |
| `db/pinboard-store.ts` | Task persistence (save, update, load) with tab_id |
| `db/info-store.ts` | Info entry persistence (save, load) |
| `hub/group-manager.ts` | Communication graph with union-find for connected components |
| `hub/agent-metrics.ts` | Per-agent activity tracking (messages, tasks, info counts) |
| `scheduler/prompt-scheduler.ts` | PromptScheduler class — tick loop, fire, pause/resume/restart/edit/delete/cascade |
| `scheduler/schedules-store.ts` | SchedulesStore with upsert semantics + deleteByTabId cascade |
| `scheduler/scheduler-helpers.ts` | Pure time-math helpers — no DB, no PTY, no Date.now (all injected for testability) |
| `remote/remote-server.ts` | Separate Express app — 8 endpoints, auth middleware, rate limit, body size cap, static UI serving |
| `remote/token-manager.ts` | 32-char URL tokens, 8h inactivity expire, per-IP session tracking, kill-all rotates |
| `remote/cloudflared-manager.ts` | Lazy downloads cloudflared from GitHub releases, spawns quick tunnel with empty `--config` override |
| `remote/static/index.html` | Mobile UI shell (no React, vanilla HTML) |
| `remote/static/app.js` | Polling, state rendering, action handlers, Page Visibility pause |
| `remote/static/style.css` | Mobile-first dark theme matching The Cog palette |
| `git/git-ops.ts` | Shell git wrappers (status, log, diff, stage, commit, push, pull, branches, checkout) |
| `updater/update-checker.ts` | Auto-update polling, git-pull mechanism, What's New dialog event |
| `rac/rac-client.ts` | R.A.C. HTTP client (private) |

### MCP Server (`src/mcp-server/`)

| File | What it does |
|------|-------------|
| `index.ts` | Standalone MCP server process. 22 tools. Heartbeat timer. Proxies to hub via HTTP. |

### Renderer (`src/renderer/`)

| File | What it does |
|------|-------------|
| `App.tsx` | Root component. Project state, dialog management, TopBar/Workspace wiring |
| `components/Workspace.tsx` | Infinite canvas. CSS transforms for zoom/pan. Renders floating windows. |
| `components/TopBar.tsx` | Project name, agent pills, panel toggles (Files/Pinboard/Info/Buddy/Presets) |
| `components/FloatingWindow.tsx` | react-rnd wrapper. Drag, resize, minimize, maximize, close, snap zones. |
| `components/TerminalWindow.tsx` | xterm.js terminal. PTY I/O via IPC. Focus event filtering. |
| `components/SpawnDialog.tsx` | Agent creation form. CLI picker, model selector, role, skills, CEO notes. |
| `components/PresetDialog.tsx` | Save/Load tabs + Templates tab (39 templates, search, CLI filter chips). |
| `components/ProjectPickerDialog.tsx` | First-launch project selection. Recent projects + open folder. |
| `components/SkillBrowser.tsx` | 3-tab skill browser (Built-in, My Skills, Community). Search, categories, create form. |
| `components/FilePanel.tsx` | Split panel: file tree (left) + Monaco editor with tabs (right). |
| `components/PinboardPanel.tsx` | Task list with status indicators. |
| `components/InfoChannelPanel.tsx` | Info feed with tag badges. |
| `components/BuddyRoomPanel.tsx` | Companion message log with timestamps. |
| `hooks/useWindowManager.ts` | Window state (position, size, z-order, minimize/maximize). |
| `hooks/useAgents.ts` | Agent lifecycle (spawn, kill, state updates via IPC). |
| `hooks/useSnapZones.ts` | Window-to-window and edge snapping during drag. |

### Shared (`src/shared/`)

| File | What it does |
|------|-------------|
| `types.ts` | All TypeScript interfaces (AgentConfig, AgentState, Message, PinboardTask, InfoEntry, BuddyMessage, Skill, etc.) + IPC channel constants |

---

## IPC Channels

All IPC communication uses named channels defined in `src/shared/types.ts`. 80+ channels total.

**Agent lifecycle:** `agent:spawn`, `agent:kill`, `agent:list`, `agent:state-update`, `agent:clear-context`
**Hub info:** `hub:info`, `hub:send-message`, `hub:get-message-history`
**PTY:** `pty:write`, `pty:output`, `pty:exit`, `pty:resize`
**Presets:** `preset:save`, `preset:load`, `preset:list`, `preset:delete`
**Pinboard:** `pinboard:get-tasks`, `pinboard:clear-completed`, `pinboard:task-update`
**Info:** `info:get-entries`, `info:entry-added`
**Buddy:** `buddy:get-messages`, `buddy:message-added`
**Project:** `project:get-current`, `project:switch`, `project:list-recent`, `project:open-folder`, `project:changed`
**Files:** `file:list`, `file:read`, `file:write`
**Skills:** `skill:list`, `skill:get`, `skill:create`, `skill:update`, `skill:delete`, `skill:search-community`, `skill:install-community`
**Groups:** `group:get-all`, `group:get-links`, `group:add-link`, `group:remove-link`
**Tabs:** `tab:get-all`, `tab:create`, `tab:close`, `tab:rename`
**Git:** `git:status`, `git:log`, `git:diff`, `git:stage`, `git:unstage`, `git:commit`, `git:push`, `git:pull`, `git:branches`, `git:checkout`, `git:new-branch`
**Usage:** `usage:get-metrics`, `usage:refresh-limits`
**Settings:** `settings:get`, `settings:set`
**R.A.C.:** `rac:get-available`, `rac:rent`, `rac:release`, `rac:get-sessions`, `rac:get-server`, `rac:set-server`
**Scheduler:** `schedules:list`, `schedules:create`, `schedules:pause`, `schedules:resume`, `schedules:stop`, `schedules:restart`, `schedules:edit`, `schedules:delete`, `schedules:updated`, `scheduler:resumed`
**Remote View:** `remote:enable`, `remote:disable`, `remote:state`, `remote:kill-sessions`, `remote:regenerate`, `remote:status-update`, `remote:setup-progress`
**Updates:** `update:check`, `update:available`, `update:perform`, `update:get-changelog`, `app:restart`
**Bug report:** `bug:submit`

---

## Hub HTTP API

All routes require `Authorization: Bearer <secret>` header.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/agents` | List agents (ceoNotes stripped, includes healthy flag) |
| POST | `/agents/register` | Register/upsert an agent |
| GET | `/agents/:name/ceo-notes` | Get agent's CEO notes + role |
| POST | `/agents/:name/status` | Agent self-reports status |
| POST | `/agents/:name/heartbeat` | MCP server heartbeat ping |
| GET | `/agents/:name/output` | Get agent's terminal output |
| POST | `/messages/send` | Send direct message |
| POST | `/messages/broadcast` | Message all agents |
| GET | `/messages/:name` | Get messages (supports ?peek=true) |
| POST | `/messages/:name/ack` | Acknowledge messages |
| GET | `/messages/history` | Query message history from DB |
| POST | `/pinboard/tasks` | Post a task |
| GET | `/pinboard/tasks` | List all tasks |
| GET | `/pinboard/tasks/:id` | Get single task |
| POST | `/pinboard/tasks/:id/claim` | Claim a task |
| POST | `/pinboard/tasks/:id/complete` | Complete a task |
| POST | `/pinboard/tasks/:id/abandon` | Abandon a task |
| POST | `/info` | Post info entry |
| GET | `/info` | Read info (supports ?tags= filter) |
| PATCH | `/info/:id` | Update info entry |
| DELETE | `/info/:id` | Delete info entry |
| GET | `/buddy-room` | Get buddy messages |
| GET | `/files/read` | Read a project file |
| POST | `/files/write` | Write a project file |
| GET | `/files/list` | List directory contents |

---

## Development Phases (Completed)

### Phase 0: Foundation Fixes
Fixed hubFetch error handling, added isError:true to MCP errors, registry upsert, stripped ceoNotes from GET /agents, added createdBy to tasks, non-destructive peek/ack messaging, status-driven prompt injection (replaced hardcoded 10s wait), queue-aware nudging.

### Phase 1: Project-Based Persistence
ProjectManager module, project picker dialog, per-project .cog/ folder, DB no longer wiped on startup, presets project-scoped (later moved to global), window title shows project name, switch project button.

### Phase 2: OpenClaude Multi-Model
Added OpenClaude as CLI type, provider picker (OpenAI, DeepSeek, OpenRouter, Together AI, Groq, Ollama), model + provider env vars passed to PTY.

### Phase 3: Tools + Reliability
Added delete_info/update_info, update_status, bumped rate limit 10→30/min, fixed OutputBuffer partial lines, reconnect context injection, Buddy Room (detection + storage + UI panel + MCP tool), heartbeat system.

### Phase 4: IDE Features
File operation MCP tools (read_file, write_file, list_directory) with project-scoped security. File Explorer sidebar + Monaco Editor panel with tabs, dirty indicators, Ctrl+S save.

### Preset Redesign
Moved saved presets to global storage. Expanded templates from 5→39 with search bar + CLI filter chips. Full coverage: Claude, Codex, Kimi, Gemini solo + all cross-CLI combos.

### Skills System
SkillManager module, 15 built-in skills, SpawnDialog skill picker, SkillBrowser dialog (3 tabs: built-in, my skills, community via skills.sh).

### Live Test Fixes
Buddy detector rewrite (chunk-based for ANSI cursor positioning), Kimi model fix (default instead of premium K2.5), Codex TUI fix (filter xterm.js focus sequences), task nudge system, nudge fallback timer (5s for CLIs where StatusDetector can't detect prompt), removed polling language from initial prompt.

### R.A.C. Integration (2026-04-04)
Rent-A-Claude panel with password gate (private/crew-only), rent/release UI, dedicated chat panel for rented Claude, hub message bridge for renter-to-rented communication. Kept out of public README.

### Git Panel (2026-04-04)
Full git UI — GitOps module wrapping shell git commands. Status, staging, commit, push/pull with ahead/behind indicators, branch switcher, diff viewer, log history. Manual refresh (no polling) + 200-file cap for performance on huge repos.

### Communication Graph (2026-04-04)
Blender-style node links between agents. Drag from an agent's port to another to create a link. Union-find algorithm detects connected components → forms isolated groups with scoped messaging/tasks/info. SVG bezier + orthogonal routing for clean visual lines. Unlinked agents have global access (backward compatible).

### Auto-Updater + Bug Reporter (2026-04-04)
UpdateChecker polls GitHub every 2 minutes. One-click update + git-pull + relaunch. "What's New" dialog shows changelog from commits. Bug reporter uses obfuscated PAT embedded in source — users submit bugs without any login or GitHub account.

### Usage Panel (2026-04-04)
AgentMetrics module in the hub tracks per-agent activity (messages sent/received, tasks posted/claimed/completed, info posted). Usage panel shows the counters + on-demand "/usage" provider limit check (writes the command to the PTY and parses the response).

### Workspace Tabs (2026-04-05)
Multiple isolated agent teams in the same project. Each tab has its own agents, pinboard, info, links, and canvas layout. Deep tab isolation: pinboard tasks, nudges, stale task watchdog all respect `tab_id`. Tab close cascades — kills all agents in that tab, deletes their scheduled prompts, cleans up MCP configs.

### Nudge System Overhaul + CEO Notes Primacy (2026-04-05 to 2026-04-06)
Reduced nudge cooldown 15s→3s. Added 60s stale-task watchdog that re-nudges agents sitting on in_progress tasks. Dedup + combine queued nudges so multiple tasks land in one message. Guaranteed fallback timer (5s) for CLIs where StatusDetector misses the "active" transition. Self-nudge prevention — task creators excluded from their own task nudges. **Removed hardcoded workflow instructions from initial prompt and claim_task response** — users dictate workflow via CEO Notes, tools are neutral utilities.

### Automated Bug Fixer (2026-04-05 onward)
Scheduled Claude task that runs hourly: checks GitHub issues labeled "bug", reads each one, reads the relevant code, fixes it, runs type-check + tests, commits, pushes, closes the issue. Has autonomously fixed issues #16 through #40+ including Gemini CLI quirks, paste bugs, nudge bugs, and UI crashes.

### Scheduled Prompts (2026-04-07)
Recurring prompt system — fire a custom prompt at any agent on an interval for a set duration (or indefinitely). Pure helper functions + PromptScheduler class + SchedulesStore SQLite persistence + SchedulesPanel UI. Pause/resume shifts both `nextFireAt` and `expiresAt` forward so paused time doesn't count against duration. Missed fires on resume are discarded (no obnoxious burst of nudges after overnight restart). Cascade delete on tab close. 50+ tests. Primary use case: leave a 45-minute "keep going" nudge on the orchestrator for 8 hours while at work.

### Remote View (2026-04-08) [experimental]
Tunnel the workshop to a public URL via lazy-downloaded cloudflared. Separate Express server (NOT the hub) on its own ephemeral port with 8 hardened endpoints — all behind a 32-char URL token with 8h inactivity expire. Single-page vanilla HTML/CSS/JS mobile dashboard served from `src/main/remote/static/`. Rate-limited (60/min per IP), 4KB body cap, 404 on bad token (not 401), no agent spawn/kill from remote (blast radius limit). Write-through `--config` empty file to override the user's existing `~/.cloudflared/config.yml`. Path fallback logic to find static files in dev vs packaged mode. QR code in Settings via qrcode-svg. Marked `(experimental)` in UI.

### Help Menu (2026-04-08)
Bug fixer added a Help menu with MCP Tools Reference dialog — users can browse all 25+ MCP tools and their signatures without leaving the app (closes #39).

---

## What's Next

- **`.exe` distribution + real auto-updater** — replace `git pull` update with electron-updater + GitHub Releases. Tag-triggered releases (`git tag v0.3.0` → GitHub Action → installer → auto-update). See `docs/superpowers/specs/2026-04-08-distribution-and-release-pipeline-notes.md` (local/gitignored).
- **Rebrand to "TheCog.dev"** — The Cog → Cog. Gear-icon branding. Domain secured.
- **File Change Notifications** — when an agent writes a file, other agents can subscribe
- **Agent Modes** — Architect/Coder/Reviewer/Tester with specialized prompts
- **Dynamic Model Switching** — switch_model MCP tool mid-task
- **Community Skills API** — full skills.sh integration (search + install without leaving the app)
- **P2P R.A.C. via Tailscale** — in-house R.A.C. sharing over Tailscale tailnet for friends (vs local-only)

---

## How to Run

```bash
git clone https://github.com/the-cog-dev/cog.git
cd The Cog
npm install
npm run dev
```

Requires: Node.js 20+, at least one AI CLI installed (Claude Code, Codex, Kimi, Gemini, etc.)

## How to Test

```bash
npm test              # run all tests
npx vitest run        # same thing
npx tsc --noEmit      # type-check only
```

Live test checklist: `docs/LIVE-TEST-CHECKLIST.md`
