# AgentOrch Live Test Checklist

**Created:** 2026-04-03
**For:** Nate + brother testing session (~10hrs from now)

---

## Pre-Flight

1. `cd F:\coding\AgentOrch`
2. `npm install` (in case deps changed)
3. `npm run dev` (or however you start the Electron app)

---

## Test 1: Project Picker (First Launch)

Since Phase 1 changed the DB/project system, your old userData DB is stale. You should see the **project picker dialog** on launch (full screen, "Open a Project").

- [ ] App launches and shows project picker (not empty workspace)
- [ ] "Open Folder" button works — pick any project folder (e.g., `F:\coding\AgentOrch` itself)
- [ ] `.agentorch/` folder created inside the chosen project
- [ ] `.agentorch/.gitignore` exists and contains `agentorch.db`
- [ ] `.agentorch/presets/` folder exists
- [ ] Window title shows `AgentOrch — <folder-name>`

## Test 2: Project Persistence (Restart)

- [ ] Close the app
- [ ] Reopen — should auto-open the last project (no picker)
- [ ] Pinboard tasks from last session are still there (no wipe!)
- [ ] Info channel entries persist
- [ ] Messages persist

## Test 3: Switch Project

- [ ] Click project name in top-left of TopBar
- [ ] Project picker dialog appears (overlay, not full screen)
- [ ] Recent projects list shows your previous project
- [ ] Pick a different folder — all agents killed, workspace resets
- [ ] New project gets its own `.agentorch/` folder
- [ ] Old project's data is untouched (switch back to verify)

## Test 4: Spawn & Basic Agent Ops

- [ ] Spawn a Claude agent with auto-mode on
- [ ] Agent gets initial prompt (status-driven, no 10s hardcoded wait)
- [ ] Agent can call `read_ceo_notes()` and `get_messages()`
- [ ] Send a message from orchestrator — agent gets nudged only when at prompt
- [ ] `get_agents` response does NOT include ceoNotes

## Test 5: New MCP Tools

- [ ] `get_messages()` returns messages without clearing queue (peek by default)
- [ ] `ack_messages()` clears specific messages
- [ ] `abandon_task()` resets a claimed task back to open
- [ ] `get_task()` fetches a single task by ID
- [ ] `get_message_history()` returns past messages from DB

## Test 6: Registry Upsert

- [ ] Kill an agent and let it auto-reconnect
- [ ] Should reconnect without "already exists" error
- [ ] Hub registry shows 1 agent (not duplicate)

## Test 7: R.A.C. Bridge (Needs Brother's Creds)

This is the big one — tests R.A.C. talking to AgentOrch's hub.

1. Start AgentOrch, open a project, note the hub port + secret (check console output)
2. In another terminal: start R.A.C. (`cd F:\coding\tools\RAC && bun run index.ts`)
3. R.A.C. bridge should connect to AgentOrch hub
4. Verify: R.A.C. can list agents, send messages, read pinboard
5. Verify: Messages persist after R.A.C. disconnects

---

## If Something Breaks

- Check console output (Ctrl+Shift+I in Electron for devtools)
- Hub server errors will show in the main process console
- MCP tool errors now return `isError: true` — check agent's tool output
- If DB is corrupt, delete `.agentorch/agentorch.db` in the project folder and restart

## What Changed (Summary)

### Phase 0 (Bug Fixes)
- hubFetch has error handling + `isError:true` on all MCP errors
- Registry upserts instead of throwing on duplicate
- ceoNotes stripped from GET /agents
- Tasks track createdBy
- Messages use peek+ack (non-destructive by default)
- Prompt injection is status-driven (no more 10s hardcoded wait)
- Nudges queue when agent is busy, flush when active
- New tools: abandon_task, get_task, get_message_history, ack_messages

### Phase 1 (Project Persistence)
- Project picker on first launch, auto-reopen last project
- Each project gets `.agentorch/` folder with isolated DB + presets
- DB no longer wiped on startup
- Window title shows project name
- Switch Project button in TopBar

### Phase 2 (OpenClaude)
- OpenClaude as CLI option in SpawnDialog with provider picker (OpenAI, DeepSeek, OpenRouter, Groq, Ollama, etc.)
- Model + provider env vars passed to PTY
- Requires: `git clone https://github.com/Gitlawb/openclaude && cd openclaude && npm install && npm run build && npm link`

### Phase 3 (Tools + Reliability)
- delete_info / update_info tools
- update_status tool (agent self-reporting)
- Rate limit bumped to 30/min
- OutputBuffer partial-line fix
- Reconnect context injection (claimed tasks + pending messages)
- Buddy Room: companion speech detection + UI panel + read_buddy_room MCP tool
- Heartbeat: MCP servers ping hub every 30s, health status on agent list

### Preset Templates
- 5 built-in team templates: Orchestrator+Workers, Research Squad, Code+Review, Multi-Model (OpenClaude), Local-Only (Ollama)
- Presets dialog now has 3 tabs: Save, Load, Templates

### File Operations (IDE Step)
- read_file, write_file, list_directory MCP tools
- Project-scoped security (agents can't escape project root)
- 1MB file size limit on reads
- Auto-creates parent directories on write

---

## Test 8: OpenClaude (Requires Install)

- [ ] Install OpenClaude: `git clone ... && npm install && npm run build && npm link`
- [ ] Set an API key: `export OPENAI_API_KEY=sk-...`
- [ ] Spawn an agent with CLI=OpenClaude, Provider=OpenAI, Model=gpt-4o
- [ ] Agent loads, gets initial prompt, can use MCP tools
- [ ] Try DeepSeek: Provider=DeepSeek, Model=deepseek-chat (needs DEEPSEEK_API_KEY or OPENAI_API_KEY for DeepSeek)

## Test 9: Preset Templates

- [ ] Open Presets dialog, switch to "Templates" tab
- [ ] See 5 built-in templates
- [ ] Pick "Orchestrator + Workers" — prompted for CWD
- [ ] All 3 agents spawn with correct configs

## Test 10: File MCP Tools

- [ ] Spawn an agent, have it call `list_directory()` — should see project files
- [ ] Have it call `read_file("package.json")` — should return file contents
- [ ] Have it call `write_file("test-output.txt", "hello")` — should create file
- [ ] Verify: agent CANNOT read files outside project root (e.g., `read_file("../../etc/passwd")`)

## Test 11: Buddy Room

- [ ] Open "Buddy" panel from TopBar
- [ ] Shows empty state initially
- [ ] If a companion speaks in any agent terminal, it should appear in the panel
- [ ] `read_buddy_room()` MCP tool returns buddy messages

## Test 12: Heartbeat

- [ ] Spawn an agent, wait 30s
- [ ] `GET /agents` should show `healthy: true`
- [ ] Kill the MCP server process (not the agent) — after 60s, `healthy: false`
# Update test
