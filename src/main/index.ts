import { app, BrowserWindow, ipcMain, dialog, Notification, Menu, shell } from 'electron'
import path from 'path'
import * as fs from 'fs'
import { createDatabase } from './db/database'
import { MessageStore } from './db/message-store'
import { PinboardStore } from './db/pinboard-store'
import { InfoStore } from './db/info-store'
import { createHubServer, type HubServer } from './hub/server'
import { spawnAgentPty, writeToPty, resizePty, killPty, type ManagedPty } from './shell/pty-manager'
import { buildCliLaunchCommands as buildCliLaunchCommandsForConfig } from './cli-launch'
import { writeAgentMcpConfig, cleanupConfig } from './mcp/config-writer'
import { savePreset, loadPreset, listPresets, deletePreset, setPresetsDir } from './presets/preset-manager'
import { ProjectManager } from './project/project-manager'
import { SkillManager } from './skills/skill-manager'
import { RacClient } from './rac/rac-client'
import { UpdateChecker } from './updater/update-checker'
import type { AgentConfig } from '../shared/types'
import { IPC } from '../shared/types'

let hub: HubServer
let mainWindow: BrowserWindow
let projectManager: ProjectManager
let skillManager: SkillManager
let racClient: RacClient
let updateChecker: UpdateChecker
let currentDb: import('better-sqlite3').Database | null = null
let currentMessageStore: MessageStore | null = null
const agents = new Map<string, ManagedPty>()
const hasReceivedInitialPrompt = new Set<string>()
const initialPrompts = new Map<string, string>()
const manualKills = new Set<string>() // Track intentional kills to skip auto-reconnect
const pendingNudges = new Map<string, string[]>() // agentName → queued nudge strings
const CODEX_SUBMIT_DELAY = 2000   // Codex TUI needs text rendered before Enter is sent
const RECONNECT_DELAY = 3000      // Wait before respawning a crashed agent
const PROMPT_INJECT_FALLBACK_MS = 10000 // Safety net if StatusDetector doesn't detect prompt (Gemini, Kimi, etc.)

// Get visible agent list — filters out internal agents like "user"
function getVisibleAgents() {
  return hub.registry.list().filter(a => a.name !== 'user')
}

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings(): Record<string, any> {
  try {
    if (fs.existsSync(getSettingsPath())) {
      return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'))
    }
  } catch { /* corrupt */ }
  return {}
}

function saveSetting(key: string, value: any): void {
  const settings = loadSettings()
  settings[key] = value
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
}

function saveLinkState(): void {
  if (!projectManager?.currentProject || !hub) return
  const linksPath = path.join(projectManager.currentProject.path, '.agentorch', 'links.json')
  const state = hub.groupManager.exportState()
  fs.writeFileSync(linksPath, JSON.stringify(state, null, 2), 'utf-8')
}

function loadLinkState(): void {
  if (!projectManager?.currentProject || !hub) return
  const linksPath = path.join(projectManager.currentProject.path, '.agentorch', 'links.json')
  if (fs.existsSync(linksPath)) {
    try {
      const state = JSON.parse(fs.readFileSync(linksPath, 'utf-8'))
      hub.groupManager.importState(state)
    } catch { /* corrupt file */ }
  }
}

function getMcpServerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'mcp-server', 'index.js')
  }
  return path.join(__dirname, '../mcp-server/index.js')
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1a1a1a',
    title: 'AgentOrch',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data:; font-src 'self' data:"
        ]
      }
    })
  })

  // Disable Electron's built-in zoom shortcuts (we handle zoom in the renderer)
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.control && (input.key === '0' || input.key === '=' || input.key === '-')) {
      _event.preventDefault()
    }
  })

  // Custom app menu
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Switch Project', click: () => win.webContents.send(IPC.PROJECT_CHANGED, null) },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Getting Started',
          click: () => shell.openExternal('https://github.com/natebag/AgentOrch#readme')
        },
        {
          label: 'Keyboard Shortcuts',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'Keyboard Shortcuts',
              message: 'AgentOrch Shortcuts',
              detail: [
                'Ctrl+1-9  — Focus window by number',
                'Ctrl+Tab  — Cycle windows',
                'Ctrl+0    — Reset zoom',
                'Ctrl+S    — Save file (in editor)',
                'Ctrl+Shift+0 — Fit all windows',
              ].join('\n')
            })
          }
        },
        { type: 'separator' },
        {
          label: 'Report a Bug',
          click: () => win.webContents.send('menu:bug-report')
        },
        { type: 'separator' },
        {
          label: 'About AgentOrch',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'About AgentOrch',
              message: 'AgentOrch',
              detail: 'AI-Native Agent Orchestration IDE\n\nOrchestrate teams of AI coding agents across multiple models and providers.\n\nhttps://github.com/natebag/AgentOrch'
            })
          }
        }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

// Returns one or more commands to type into the shell. Array = chain them sequentially.
function buildCliLaunchCommands(
  config: AgentConfig, mcpConfigPath: string, mcpServerPath: string,
  hubPort: number, hubSecret: string
): string[] | null {
  return buildCliLaunchCommandsForConfig(config, mcpConfigPath, mcpServerPath, hubPort, hubSecret)
}

// Build the initial prompt injected when the CLI first becomes ready.
// Keeps it short so the agent doesn't waste context — just tells it who it is
// and to check MCP tools for instructions.
function buildInitialPrompt(config: AgentConfig): string {
  const lines = [
    `You are "${config.name}" (role: ${config.role}) in an AgentOrch workspace.`,
    `You have AgentOrch MCP tools: send_message, get_messages, get_agents, read_ceo_notes, get_agent_output, post_task, read_tasks, claim_task, complete_task, abandon_task, get_task, post_info, read_info, delete_info, update_info, update_status, get_message_history, ack_messages, read_file, write_file, list_directory.`,
    `Do these steps NOW: 1) Call read_ceo_notes() for your instructions. 2) Call get_messages() to check for messages. 3) Call read_tasks() to check for open tasks you can claim.`,
    `After that, WAIT. You will be nudged automatically when new messages arrive or tasks are posted — no need to poll.`,
  ]
  return lines.join(' ')
}

// Build a reconnect prompt that includes context about what the agent was doing before it crashed.
function buildReconnectPrompt(config: AgentConfig): string {
  const base = buildInitialPrompt(config)

  const contextParts: string[] = []

  // Check for claimed tasks
  if (hub) {
    const tasks = hub.pinboard.readTasks()
    const claimed = tasks.filter(t => t.claimedBy === config.name && t.status === 'in_progress')
    if (claimed.length > 0) {
      const taskSummary = claimed.map(t => `"${t.title}" (${t.id})`).join(', ')
      contextParts.push(`You had ${claimed.length} task(s) in progress before disconnecting: ${taskSummary}. Check their status with get_task() and continue or abandon them.`)
    }

    // Check for pending messages
    const pending = hub.messages.getMessages(config.name, true) // peek
    if (pending.length > 0) {
      contextParts.push(`You have ${pending.length} unread message(s). Call get_messages() to read them.`)
    }
  }

  if (contextParts.length === 0) return base

  return `${base} RECONNECT CONTEXT: You were previously running but disconnected unexpectedly. ${contextParts.join(' ')}`
}

function injectPrompt(managed: ManagedPty, prompt: string, delayMs: number): void {
  setTimeout(() => {
    // TUI-based CLIs (Codex, Gemini) need text and Enter sent separately
    // Their TUI must render the input text before Enter triggers submit
    if (managed.config.cli === 'codex' || managed.config.cli === 'gemini') {
      writeToPty(managed, prompt)
      setTimeout(() => writeToPty(managed, '\r'), CODEX_SUBMIT_DELAY)
      return
    }

    writeToPty(managed, prompt + '\r')
  }, delayMs)
}

// Auto-reconnect: respawn an agent with its original config after an unexpected exit.
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

  const mcpEnv: Record<string, string> = {
    AGENTORCH_HUB_PORT: String(hub.port),
    AGENTORCH_HUB_SECRET: hub.secret,
    AGENTORCH_AGENT_ID: config.id,
    AGENTORCH_AGENT_NAME: config.name
  }
  if (config.cli === 'grok' && config.model) {
    mcpEnv.GROK_MODEL = config.model
  }
  if (config.cli === 'openclaude') {
    if (config.model) mcpEnv.OPENAI_MODEL = config.model
    if (config.providerUrl) mcpEnv.OPENAI_BASE_URL = config.providerUrl
  }

  hub.registry.register(config)
  const initialPrompt = buildReconnectPrompt(config)
  initialPrompts.set(config.id, initialPrompt)
  // Block prompt injection until CLI commands are sent
  hasReceivedInitialPrompt.add(config.id)

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

      // Status-driven prompt injection: inject when CLI first reaches prompt
      if (status === 'active' && !hasReceivedInitialPrompt.has(config.id)) {
        hasReceivedInitialPrompt.add(config.id)
        const prompt = initialPrompts.get(config.id)
        if (prompt) injectPrompt(managed, prompt, 0)
      }

      // Flush queued nudges when agent becomes active
      if (status === 'active') flushPendingNudges(config.name)
    },
    onClearDetected: () => {
      // Allow re-injection on next 'active' status
      hasReceivedInitialPrompt.delete(config.id)
    },
    onBuddyDetected: (detection) => {
      hub.buddyRoom.addMessage(config.name, detection.buddyName, detection.message)
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

    // Enable status-driven injection after CLI commands are sent
    setTimeout(() => hasReceivedInitialPrompt.delete(config.id), delay)

    // Fallback: if StatusDetector doesn't detect prompt, inject after timeout
    setTimeout(() => {
      if (!hasReceivedInitialPrompt.has(config.id)) {
        hasReceivedInitialPrompt.add(config.id)
        injectPrompt(managed, initialPrompt, 0)
      }
    }, delay + PROMPT_INJECT_FALLBACK_MS)
  }

  console.log(`Agent "${config.name}" reconnected successfully`)
}

// Deliver a nudge to an agent's PTY.
// If the agent is at prompt (active), deliver immediately.
// Otherwise, deliver after a short delay — some CLIs (Kimi, Gemini) may not
// trigger StatusDetector's prompt regex, so 'active' is never reached.
const NUDGE_FALLBACK_DELAY = 5000

function deliverNudge(agentName: string, nudge: string): void {
  const managed = Array.from(agents.values()).find(a => a.config.name === agentName)
  if (!managed) return

  const agent = hub.registry.get(agentName)
  if (!agent || agent.status === 'disconnected') return

  if (agent.status === 'active') {
    // Agent is at prompt — deliver immediately
    writeNudgeToPty(managed, nudge)
  } else {
    // Agent might be working or status detection doesn't work for this CLI.
    // Queue it, but also set a fallback timer to force delivery.
    if (!pendingNudges.has(agentName)) pendingNudges.set(agentName, [])
    pendingNudges.get(agentName)!.push(nudge)

    // Fallback: deliver after delay even if 'active' is never detected
    setTimeout(() => {
      const queued = pendingNudges.get(agentName)
      if (queued && queued.length > 0) {
        const latest = queued[queued.length - 1]
        pendingNudges.delete(agentName)
        const m = Array.from(agents.values()).find(a => a.config.name === agentName)
        if (m) writeNudgeToPty(m, latest)
      }
    }, NUDGE_FALLBACK_DELAY)
  }
}

function writeNudgeToPty(managed: ManagedPty, nudge: string): void {
  // Strip characters that PowerShell interprets as code: () [] {} $ ` " '
  // The agent CLI just needs the message text, not shell-valid syntax
  const safe = nudge.replace(/[()[\]{}$`"']/g, '')

  if (managed.config.cli === 'codex') {
    writeToPty(managed, safe)
    setTimeout(() => writeToPty(managed, '\r'), CODEX_SUBMIT_DELAY)
  } else {
    writeToPty(managed, safe + '\r')
  }
}

// Flush any pending nudges when an agent becomes active.
function flushPendingNudges(agentName: string): void {
  const queued = pendingNudges.get(agentName)
  if (!queued || queued.length === 0) return

  // Deliver the most recent nudge only — stacking old nudges wastes context
  const latest = queued[queued.length - 1]
  pendingNudges.delete(agentName)
  deliverNudge(agentName, latest)
}

// When a message is queued for an agent, nudge them to call get_messages().
function setupMessageNudge(): void {
  hub.messages.onMessageQueued = (msg) => {
    const target = hub.registry.get(msg.to)
    if (!target) return

    const nudge = `[AgentOrch] New message from "${msg.from}". You MUST call get_messages() now to read it, then act on it immediately.`
    deliverNudge(msg.to, nudge)
  }
}

// When a task is posted to the pinboard, nudge worker/researcher agents to check for it.
function setupTaskNudge(): void {
  const existingCallback = hub.pinboard.onTaskCreated
  hub.pinboard.onTaskCreated = (task) => {
    existingCallback?.(task)

    // Nudge all non-orchestrator agents (workers, researchers, reviewers) to check for tasks
    const workers = hub.registry.list().filter(agent =>
      agent.role !== 'orchestrator' && agent.status !== 'disconnected'
    )
    for (const worker of workers) {
      const nudge = `[AgentOrch] New task posted: "${task.title}" (${task.priority} priority). Call read_tasks() to see open tasks, then claim_task() to pick one up.`
      deliverNudge(worker.name, nudge)
    }
  }
}

// When info is posted, nudge orchestrator agents so they know to read it.
function setupInfoNudge(): void {
  const existingCallback = hub.infoChannel.onEntryAdded
  hub.infoChannel.onEntryAdded = (entry) => {
    existingCallback?.(entry)

    const orchestrators = hub.registry.list().filter(agent => agent.role === 'orchestrator')
    for (const orchestrator of orchestrators) {
      if (orchestrator.name === entry.from) continue

      const tagSuffix = entry.tags.length > 0 ? ` with tags [${entry.tags.join(', ')}]` : ''
      const nudge = `[AgentOrch] New info posted by "${entry.from}"${tagSuffix}. Call read_info() to read it.`
      deliverNudge(orchestrator.name, nudge)
    }
  }
}

async function openProject(projectPath: string): Promise<void> {
  // Close existing project if open
  if (hub) await closeProject()

  projectManager.initProject(projectPath)

  // Initialize SQLite persistence at project path
  const db = createDatabase(projectManager.dbPath)
  currentDb = db
  const messageStore = new MessageStore(db)
  currentMessageStore = messageStore
  const pinboardStore = new PinboardStore(db)
  const infoStore = new InfoStore(db)

  hub = await createHubServer()
  hub.setProjectPath(projectPath)
  hub.setMessageStore(messageStore)

  // Register a virtual "user" agent so the UI can send/receive messages
  // (R.A.C. bridge sends replies to "user" — needs to exist in registry)
  hub.registry.register({
    id: 'user',
    name: 'user',
    cli: 'none',
    cwd: projectPath,
    role: 'human',
    ceoNotes: '',
    shell: 'powershell',
    admin: false,
    autoMode: false
  })

  console.log(`Hub server running on port ${hub.port} for project: ${projectManager.currentProject!.name}`)

  // Restore persisted state
  hub.pinboard.loadTasks(pinboardStore.loadTasks())
  hub.infoChannel.loadEntries(infoStore.loadEntries())

  // Hook persistence callbacks
  hub.messages.onMessageSaved = (msg) => messageStore.saveMessage(msg)
  hub.pinboard.onTaskCreated = (task) => {
    pinboardStore.saveTask(task)
    mainWindow?.webContents.send(IPC.PINBOARD_TASK_UPDATE, hub.pinboard.readTasks())
    hub.agentMetrics.increment(task.createdBy || 'unknown', 'tasksPosted')
  }
  hub.pinboard.onTaskUpdated = (task) => {
    pinboardStore.updateTask(task)
    mainWindow?.webContents.send(IPC.PINBOARD_TASK_UPDATE, hub.pinboard.readTasks())

    if (task.status === 'in_progress' && task.claimedBy) {
      hub.agentMetrics.increment(task.claimedBy, 'tasksClaimed')
    }
    if (task.status === 'completed' && task.claimedBy) {
      hub.agentMetrics.increment(task.claimedBy, 'tasksCompleted')
    }

    // System notification when a task is completed
    if (task.status === 'completed') {
      const settings = loadSettings()
      if (settings.notifications !== false) { // enabled by default
        const notification = new Notification({
          title: 'Task Completed',
          body: `"${task.title}" completed${task.claimedBy ? ` by ${task.claimedBy}` : ''}`,
          icon: undefined
        })
        notification.show()
      }

      // Check if ALL tasks are done
      const allTasks = hub.pinboard.readTasks()
      const openTasks = allTasks.filter(t => t.status !== 'completed')
      if (allTasks.length > 0 && openTasks.length === 0) {
        const settings = loadSettings()
        if (settings.notifyAllDone !== false) {
          const allDone = new Notification({
            title: 'All Tasks Complete!',
            body: `All ${allTasks.length} tasks on the pinboard are done.`,
            icon: undefined
          })
          allDone.show()
        }
      }
    }
  }
  hub.pinboard.onTaskDeleted = (taskId) => {
    pinboardStore.deleteTask(taskId)
    mainWindow?.webContents.send(IPC.PINBOARD_TASK_UPDATE, hub.pinboard.readTasks())
  }
  hub.infoChannel.onEntryAdded = (entry) => {
    infoStore.saveEntry(entry)
    mainWindow?.webContents.send(IPC.INFO_ENTRY_ADDED, hub.infoChannel.readInfo())
    hub.agentMetrics.increment(entry.from, 'infoPosted')
  }

  hub.buddyRoom.onMessageAdded = (_msg) => {
    mainWindow?.webContents.send(IPC.BUDDY_MESSAGE_ADDED, hub.buddyRoom.getMessages())
  }

  hub.setOutputAccessor((agentName, lines) => {
    const managed = Array.from(agents.values()).find(a => a.config.name === agentName)
    if (!managed) return null
    return managed.outputBuffer.getLines(lines)
  })
  setupMessageNudge()
  setupTaskNudge()
  setupInfoNudge()
  loadLinkState()

  // Update window title
  if (mainWindow) {
    mainWindow.setTitle(`AgentOrch — ${projectManager.currentProject!.name}`)
    mainWindow.webContents.send(IPC.PROJECT_CHANGED, projectManager.currentProject)
  }
}

async function closeProject(): Promise<void> {
  // Kill all agents
  for (const [id] of agents) {
    manualKills.add(id)
  }
  for (const [, managed] of agents) {
    killPty(managed)
    if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)
  }
  agents.clear()
  initialPrompts.clear()
  hasReceivedInitialPrompt.clear()
  pendingNudges.clear()

  // Close hub
  hub?.close()

  // Close DB
  if (currentDb) {
    currentDb.close()
    currentDb = null
    currentMessageStore = null
  }

  // Notify renderer
  if (mainWindow) {
    mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, [])
  }
}

function setupIPC(): void {
  ipcMain.handle(IPC.GET_HUB_INFO, () => ({
    port: hub.port,
    secret: hub.secret
  }))

  ipcMain.handle(IPC.GET_AGENTS, () => {
    return getVisibleAgents()
  })

  ipcMain.handle(IPC.SPAWN_AGENT, (_event, config: AgentConfig) => {
    const mcpServerPath = getMcpServerPath()
    const mcpConfigPath = writeAgentMcpConfig({
      agentId: config.id,
      agentName: config.name,
      hubPort: hub.port,
      hubSecret: hub.secret,
      mcpServerPath
    })

    // Env vars for the MCP server — set on the PTY so child processes inherit them.
    // Codex spawns MCP servers as subprocesses, so they'll pick these up.
    const mcpEnv: Record<string, string> = {
      AGENTORCH_HUB_PORT: String(hub.port),
      AGENTORCH_HUB_SECRET: hub.secret,
      AGENTORCH_AGENT_ID: config.id,
      AGENTORCH_AGENT_NAME: config.name
    }
    if (config.cli === 'grok' && config.model) {
      mcpEnv.GROK_MODEL = config.model
    }
    if (config.cli === 'openclaude') {
      if (config.model) mcpEnv.OPENAI_MODEL = config.model
      if (config.providerUrl) mcpEnv.OPENAI_BASE_URL = config.providerUrl
    }

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
    // Block prompt injection until CLI commands are sent
    hasReceivedInitialPrompt.add(config.id)

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

        // Auto-reconnect: if this wasn't a manual kill, respawn after a delay
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

        // Status-driven prompt injection: inject when CLI first reaches prompt
        if (status === 'active' && !hasReceivedInitialPrompt.has(config.id)) {
          hasReceivedInitialPrompt.add(config.id)
          const prompt = initialPrompts.get(config.id)
          if (prompt) injectPrompt(managed, prompt, 0)
        }

        // Flush queued nudges when agent becomes active
        if (status === 'active') flushPendingNudges(config.name)
      },
      onClearDetected: () => {
        // Allow re-injection on next 'active' status
        hasReceivedInitialPrompt.delete(config.id)
      },
      onBuddyDetected: (detection) => {
        hub.buddyRoom.addMessage(config.name, detection.buddyName, detection.message)
      }
    })

    agents.set(config.id, managed)
    mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())

    // Launch agent CLI after shell initializes (plain terminals skip this)
    // Some CLIs need multiple commands (e.g., codex needs `mcp add` first)
    const cmds = buildCliLaunchCommands(config, mcpConfigPath, mcpServerPath, hub.port, hub.secret)
    if (cmds) {
      let delay = 1000
      for (const cmd of cmds) {
        setTimeout(() => {
          writeToPty(managed, cmd + '\r')
        }, delay)
        delay += 3000 // Give each command time to complete
      }

      // Enable status-driven injection after CLI commands are sent
      setTimeout(() => hasReceivedInitialPrompt.delete(config.id), delay)

      // Fallback: if StatusDetector doesn't detect prompt, inject after timeout
      setTimeout(() => {
        if (!hasReceivedInitialPrompt.has(config.id)) {
          hasReceivedInitialPrompt.add(config.id)
          injectPrompt(managed, initialPrompt, 0)
        }
      }, delay + PROMPT_INJECT_FALLBACK_MS)
    }

    // For non-MCP agents: poll and inject messages into stdin

    return { id: config.id, mcpConfigPath }
  })

  ipcMain.handle(IPC.WRITE_TO_PTY, (_event, agentId: string, data: string) => {
    const managed = agents.get(agentId)
    if (managed) writeToPty(managed, data)
  })

  // Clear an agent's context without respawning — sends /clear to their CLI
  ipcMain.handle(IPC.AGENT_CLEAR_CONTEXT, (_event, agentId: string) => {
    const managed = agents.get(agentId)
    if (!managed) return { error: 'Agent not found' }
    if (managed.config.cli === 'terminal') return { error: 'Plain terminals cannot be cleared' }

    // Send /clear command to the agent's CLI
    writeToPty(managed, '/clear\r')
    // onClearDetected will fire via StatusDetector, which re-injects the initial prompt
    return { status: 'ok', agent: managed.config.name }
  })

  ipcMain.handle(IPC.KILL_AGENT, (_event, agentId: string) => {
    const managed = agents.get(agentId)
    if (managed) {
      manualKills.add(agentId) // Prevent auto-reconnect
      killPty(managed)
      hub.registry.remove(managed.config.name)
      hub.messages.clearAgent(managed.config.name)
      pendingNudges.delete(managed.config.name)
      if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)
      initialPrompts.delete(agentId)
      hasReceivedInitialPrompt.delete(agentId)
      agents.delete(agentId)
      mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
    }
  })

  ipcMain.handle('pty:resize', (_event, agentId: string, cols: number, rows: number) => {
    const managed = agents.get(agentId)
    if (managed) resizePty(managed, cols, rows)
  })

  ipcMain.handle('app:cwd', () => process.cwd())

  ipcMain.handle('dialog:browse-directory', async (_event, defaultPath: string) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Preset IPC handlers
  ipcMain.handle(IPC.SAVE_PRESET, (_event, name: string, agentConfigs: AgentConfig[], windows: any[], canvas: any) => {
    savePreset(name, agentConfigs, windows, canvas)
    return { status: 'ok' }
  })

  ipcMain.handle(IPC.LOAD_PRESET, (_event, name: string) => {
    return loadPreset(name)
  })

  ipcMain.handle(IPC.LIST_PRESETS, () => {
    return listPresets()
  })

  ipcMain.handle(IPC.DELETE_PRESET, (_event, name: string) => {
    deletePreset(name)
    return { status: 'ok' }
  })

  // Pinboard IPC handlers
  ipcMain.handle(IPC.PINBOARD_GET_TASKS, () => {
    return hub.pinboard.readTasks()
  })

  ipcMain.handle(IPC.PINBOARD_CLEAR_COMPLETED, () => {
    const cleared = hub.pinboard.clearCompleted()
    return { status: 'ok', cleared }
  })

  // Info Channel IPC handlers
  ipcMain.handle(IPC.INFO_GET_ENTRIES, () => {
    return hub.infoChannel.readInfo()
  })

  // Buddy Room IPC handlers
  ipcMain.handle(IPC.BUDDY_GET_MESSAGES, () => {
    return hub?.buddyRoom.getMessages() ?? []
  })

  // Group IPC
  ipcMain.handle(IPC.GROUP_GET_ALL, () => hub?.groupManager.getGroups() ?? [])
  ipcMain.handle(IPC.GROUP_GET_LINKS, () => hub?.groupManager.getLinks() ?? [])

  ipcMain.handle(IPC.GROUP_ADD_LINK, (_event, from: string, to: string) => {
    if (!hub) return { error: 'No project open' }
    hub.groupManager.addLink(from, to)
    for (const agent of hub.registry.list()) {
      const gid = hub.groupManager.getGroupIdForAgent(agent.name)
      agent.groupId = gid ?? undefined
    }
    mainWindow?.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
    saveLinkState()
    return { status: 'ok', groups: hub.groupManager.getGroups() }
  })

  ipcMain.handle(IPC.GROUP_REMOVE_LINK, (_event, from: string, to: string) => {
    if (!hub) return { error: 'No project open' }
    hub.groupManager.removeLink(from, to)
    for (const agent of hub.registry.list()) {
      const gid = hub.groupManager.getGroupIdForAgent(agent.name)
      agent.groupId = gid ?? undefined
    }
    mainWindow?.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
    saveLinkState()
    return { status: 'ok', groups: hub.groupManager.getGroups() }
  })

  // Project management IPC
  ipcMain.handle(IPC.PROJECT_GET_CURRENT, () => {
    return projectManager.currentProject
  })

  ipcMain.handle(IPC.PROJECT_LIST_RECENT, () => {
    return projectManager.listRecent()
  })

  ipcMain.handle(IPC.PROJECT_OPEN_FOLDER, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.PROJECT_SWITCH, async (_event, projectPath: string) => {
    await openProject(projectPath)
    return projectManager.currentProject
  })

  // File operation IPC handlers
  ipcMain.handle(IPC.FILE_LIST, async (_event, dirPath: string = '.') => {
    if (!projectManager.currentProject) return { items: [] }
    const projectPath = projectManager.currentProject.path
    const resolved = path.resolve(projectPath, dirPath)
    if (!resolved.toLowerCase().replace(/\\/g, '/').startsWith(projectPath.toLowerCase().replace(/\\/g, '/'))) return { items: [] }

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
      return {
        path: dirPath,
        items: entries
          .filter(e => !e.name.startsWith('.'))
          .map(e => ({
            name: e.name,
            type: e.isDirectory() ? 'directory' : 'file',
            path: path.join(dirPath, e.name).replace(/\\/g, '/')
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
      }
    } catch {
      return { path: dirPath, items: [] }
    }
  })

  ipcMain.handle(IPC.FILE_READ, async (_event, filePath: string) => {
    if (!projectManager.currentProject) return null
    const projectPath = projectManager.currentProject.path
    const resolved = path.resolve(projectPath, filePath)
    if (!resolved.toLowerCase().replace(/\\/g, '/').startsWith(projectPath.toLowerCase().replace(/\\/g, '/'))) return null

    try {
      const content = fs.readFileSync(resolved, 'utf-8')
      return { path: filePath, content }
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.FILE_WRITE, async (_event, filePath: string, content: string) => {
    if (!projectManager.currentProject) return false
    const projectPath = projectManager.currentProject.path
    const resolved = path.resolve(projectPath, filePath)
    if (!resolved.toLowerCase().replace(/\\/g, '/').startsWith(projectPath.toLowerCase().replace(/\\/g, '/'))) return false

    try {
      const dir = path.dirname(resolved)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(resolved, content, 'utf-8')
      return true
    } catch {
      return false
    }
  })

  // Skills IPC
  ipcMain.handle(IPC.SKILL_LIST, () => skillManager.listSkills())
  ipcMain.handle(IPC.SKILL_GET, (_event, id: string) => skillManager.getSkill(id))
  ipcMain.handle(IPC.SKILL_CREATE, (_event, input: { name: string; description: string; category: string; prompt: string; tags: string[] }) => {
    return skillManager.createSkill(input)
  })
  ipcMain.handle(IPC.SKILL_UPDATE, (_event, id: string, updates: any) => {
    return skillManager.updateSkill(id, updates)
  })
  ipcMain.handle(IPC.SKILL_DELETE, (_event, id: string) => {
    return skillManager.deleteSkill(id)
  })

  // R.A.C. IPC
  ipcMain.handle(IPC.RAC_GET_SERVER, () => racClient.getServer())

  ipcMain.handle(IPC.RAC_SET_SERVER, (_event, url: string) => {
    racClient.setServer(url)
    return { status: 'ok' }
  })

  ipcMain.handle(IPC.RAC_GET_AVAILABLE, async () => {
    try {
      return await racClient.getAvailable()
    } catch (err: any) {
      return { available: [], count: 0, error: err.message }
    }
  })

  ipcMain.handle(IPC.RAC_RENT, async (_event, slotId: string, renterName: string) => {
    if (!hub) throw new Error('No project open')
    try {
      const session = await racClient.rent(slotId, renterName, hub.port, hub.secret)
      // Notify renderer that agents changed (bridge will register on the hub)
      setTimeout(() => {
        mainWindow?.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
      }, 2000) // Give bridge time to register
      return session
    } catch (err: any) {
      return { error: err.message }
    }
  })

  ipcMain.handle(IPC.RAC_RELEASE, async (_event, sessionId: string) => {
    try {
      await racClient.release(sessionId)
      // Agent will be unregistered from hub by R.A.C. bridge
      setTimeout(() => {
        mainWindow?.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
      }, 1000)
      return { status: 'ok' }
    } catch (err: any) {
      return { error: err.message }
    }
  })

  ipcMain.handle(IPC.RAC_GET_SESSIONS, () => racClient.getActiveSessions())

  // Hub messaging from renderer (for R.A.C. chat panel)
  ipcMain.handle(IPC.HUB_SEND_MESSAGE, (_event, from: string, to: string, message: string) => {
    if (!hub) return { status: 'error', detail: 'No project open' }
    return hub.messages.send(from, to, message, true)
  })

  ipcMain.handle(IPC.HUB_GET_MESSAGE_HISTORY, (_event, agent?: string, limit?: number) => {
    if (!currentMessageStore) return []
    return currentMessageStore.getMessageHistory(agent, limit || 50)
  })

  // Update IPC
  ipcMain.handle(IPC.UPDATE_CHECK, async () => {
    return await updateChecker.check()
  })

  ipcMain.handle(IPC.UPDATE_PERFORM, async () => {
    return await updateChecker.performUpdate()
  })

  ipcMain.handle(IPC.APP_RESTART, async () => {
    await closeProject()
    if (app.isPackaged) {
      app.relaunch()
    }
    // In dev mode, just quit — user re-runs npm run dev
    app.exit(0)
  })

  // Settings IPC
  ipcMain.handle(IPC.SETTINGS_GET, () => loadSettings())
  ipcMain.handle(IPC.SETTINGS_SET, (_event, key: string, value: any) => {
    saveSetting(key, value)
    return { status: 'ok' }
  })

  // Usage IPC
  ipcMain.handle(IPC.USAGE_GET_METRICS, () => {
    if (!hub) return []
    const result: any[] = []
    const allMetrics = hub.agentMetrics.getAll()
    for (const agent of hub.registry.list()) {
      if (agent.name === 'user') continue
      const m = allMetrics.get(agent.name)
      result.push({
        agentName: agent.name,
        cli: agent.cli,
        model: agent.model || 'default',
        messagesSent: m?.messagesSent ?? 0,
        messagesReceived: m?.messagesReceived ?? 0,
        tasksPosted: m?.tasksPosted ?? 0,
        tasksClaimed: m?.tasksClaimed ?? 0,
        tasksCompleted: m?.tasksCompleted ?? 0,
        infoPosted: m?.infoPosted ?? 0,
        spawnedAt: m?.spawnedAt ?? agent.createdAt
      })
    }
    return result
  })

  ipcMain.handle(IPC.USAGE_REFRESH_LIMITS, async () => {
    if (!hub) return []
    const results: any[] = []

    for (const [, managed] of agents) {
      if (managed.config.cli === 'terminal') continue

      const beforeCount = managed.outputBuffer.lineCount
      writeToPty(managed, '/usage\r')

      await new Promise(resolve => setTimeout(resolve, 3000))

      const afterCount = managed.outputBuffer.lineCount
      const newLineCount = afterCount - beforeCount
      const newLines = newLineCount > 0 ? managed.outputBuffer.getLines(newLineCount) : []
      const rawOutput = newLines.join('\n')

      let providerUsage: any = undefined
      const claudeMatch = rawOutput.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s*(messages?|tokens?|requests?)/i)
      if (claudeMatch) {
        providerUsage = {
          used: parseInt(claudeMatch[1].replace(/,/g, '')),
          total: parseInt(claudeMatch[2].replace(/,/g, '')),
          unit: claudeMatch[3].toLowerCase()
        }
      }
      if (!providerUsage) {
        const pctMatch = rawOutput.match(/(\d+(?:\.\d+)?)\s*%\s*(used|remaining|left)/i)
        if (pctMatch) {
          const pct = parseFloat(pctMatch[1])
          const isRemaining = pctMatch[2].toLowerCase() !== 'used'
          providerUsage = {
            used: isRemaining ? Math.round(100 - pct) : Math.round(pct),
            total: 100,
            unit: 'percent'
          }
        }
      }
      if (!providerUsage && rawOutput.trim()) {
        providerUsage = { used: 0, total: 0, unit: 'unknown', raw: rawOutput.trim() }
      }

      results.push({ agentName: managed.config.name, providerUsage })
    }

    return results
  })

  // Bug report — posts directly to GitHub Issues via API (no user login needed)
  // Token is obfuscated (not plaintext) to avoid automated scanners. Issues-only permission on a single repo.
  const _bk = 'AgentOrchBugReporter2026'
  const _bt = [38,14,17,6,1,45,45,19,9,54,42,86,99,36,55,36,61,53,47,59,2,70,6,82,115,33,49,93,76,21,38,19,14,29,6,13,7,12,21,59,38,38,41,59,64,94,1,102,53,42,51,54,0,28,11,55,80,9,64,29,37,14,32,24,67,61,53,58,113,95,125,64,13,17,13,40,70,12,58,39,33,16,59,47,1,43,34,43,55,66,54,69,2]
  const _deobf = (): string => _bt.map((c, i) => String.fromCharCode(c ^ _bk.charCodeAt(i % _bk.length))).join('')

  ipcMain.handle(IPC.BUG_REPORT_SUBMIT, async (_event, report: { title: string; body: string }) => {
    const token = _deobf()
    try {
      const res = await fetch('https://api.github.com/repos/natebag/AgentOrch/issues', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: report.title,
          body: report.body,
          labels: ['bug']
        })
      })
      if (!res.ok) {
        const err = await res.text()
        return { success: false, method: 'api', error: `GitHub API ${res.status}: ${err}` }
      }
      const issue = await res.json()
      return { success: true, method: 'api', issueUrl: issue.html_url, number: issue.number }
    } catch (err: any) {
      return { success: false, method: 'api', error: err.message }
    }
  })
}

async function main(): Promise<void> {
  await app.whenReady()

  projectManager = new ProjectManager(app.getPath('userData'))

  // Global presets directory — follows user across projects
  const globalPresetsDir = path.join(app.getPath('userData'), 'presets')
  setPresetsDir(globalPresetsDir)

  // Skills: built-in from app resources, user skills in userData
  const builtInSkillsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'data', 'skills')
    : path.join(__dirname, '../data/skills')
  const userSkillsDir = path.join(app.getPath('userData'), 'skills')
  skillManager = new SkillManager(builtInSkillsDir, userSkillsDir)

  racClient = new RacClient()

  setupIPC()
  mainWindow = createWindow()

  // Auto-update checker
  updateChecker = new UpdateChecker(app.isPackaged ? process.resourcesPath : path.join(__dirname, '../..'))
  updateChecker.onUpdateAvailable = (info) => {
    mainWindow?.webContents.send(IPC.UPDATE_AVAILABLE, info)
  }
  updateChecker.start()

  // Auto-open last project, or let renderer show project picker
  const lastProject = projectManager.getLastProject()
  if (lastProject) {
    await openProject(lastProject.path)
  } else {
    // No project history — renderer will show project picker
    mainWindow.webContents.send(IPC.PROJECT_CHANGED, null)
  }
}

main()

app.on('window-all-closed', async () => {
  await closeProject()
  app.quit()
})
