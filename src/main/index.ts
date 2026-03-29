import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import { createDatabase } from './db/database'
import { MessageStore } from './db/message-store'
import { PinboardStore } from './db/pinboard-store'
import { InfoStore } from './db/info-store'
import { createHubServer, type HubServer } from './hub/server'
import { spawnAgentPty, writeToPty, resizePty, killPty, type ManagedPty } from './shell/pty-manager'
import { writeAgentMcpConfig, cleanupConfig } from './mcp/config-writer'
import { savePreset, loadPreset, listPresets, deletePreset } from './presets/preset-manager'
import type { AgentConfig } from '../shared/types'
import { IPC } from '../shared/types'

let hub: HubServer
let mainWindow: BrowserWindow
const agents = new Map<string, ManagedPty>()
const hasReceivedInitialPrompt = new Set<string>()
const initialPrompts = new Map<string, string>()
const manualKills = new Set<string>() // Track intentional kills to skip auto-reconnect
const CLI_LOAD_TIME = 10000
const CODEX_SUBMIT_DELAY = 2000
const RECONNECT_DELAY = 3000

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

  // Disable Electron's built-in zoom shortcuts (we handle zoom in the renderer)
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.control && (input.key === '0' || input.key === '=' || input.key === '-')) {
      _event.preventDefault()
    }
  })

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
  const cliBase = config.cli

  // Plain terminal: don't launch any CLI, just leave the shell open
  if (cliBase === 'terminal') return null

  if (cliBase === 'claude') {
    const parts = [`claude --mcp-config "${mcpConfigPath}"`]
    if (config.autoMode) parts[0] += ' --dangerously-skip-permissions'
    return parts
  }

  if (cliBase === 'codex') {
    // Codex uses `codex mcp add <name> -- <command> <args>` to register MCP servers.
    // Pass hub connection info as CLI args so codex's subprocess gets them
    // (env vars may not propagate through codex's process spawning).
    const cmds = [
      `codex mcp remove agentorch 2>$null; codex mcp add agentorch -- node "${mcpServerPath}" ${hubPort} ${hubSecret} ${config.id} ${config.name}`,
    ]
    const codexCmd = config.autoMode ? 'codex --yolo' : 'codex'
    cmds.push(codexCmd)
    return cmds
  }

  if (cliBase === 'kimi') {
    let cmd = `kimi --mcp-config-file "${mcpConfigPath}"`
    if (config.autoMode) cmd += ' --yolo'
    return [cmd]
  }

  // Custom CLIs: just run the command, no MCP
  return [cliBase]
}

// Build the initial prompt injected when the CLI first becomes ready.
// Keeps it short so the agent doesn't waste context — just tells it who it is
// and to check MCP tools for instructions.
function buildInitialPrompt(config: AgentConfig): string {
  const lines = [
    `You are "${config.name}" (role: ${config.role}) in an AgentOrch workspace.`,
    `You have AgentOrch MCP tools: send_message, get_messages, get_agents, read_ceo_notes, get_agent_output, post_task, read_tasks, claim_task, complete_task, post_info, read_info.`,
    `Call read_ceo_notes() now for your instructions, then get_messages() to check for tasks from the orchestrator.`,
  ]
  return lines.join(' ')
}

function injectPrompt(managed: ManagedPty, prompt: string, delayMs: number): void {
  setTimeout(() => {
    if (managed.config.cli === 'codex') {
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

  hub.registry.register(config)
  const initialPrompt = buildInitialPrompt(config)
  initialPrompts.set(config.id, initialPrompt)
  hasReceivedInitialPrompt.delete(config.id)

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
      mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, hub.registry.list())
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
      mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, hub.registry.list())
    },
    onClearDetected: () => {
      const prompt = initialPrompts.get(config.id)
      if (prompt) injectPrompt(managed, prompt, CLI_LOAD_TIME)
    }
  })

  agents.set(config.id, managed)
  mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, hub.registry.list())

  const cmds = buildCliLaunchCommands(config, mcpConfigPath, mcpServerPath, hub.port, hub.secret)
  if (cmds) {
    let delay = 1000
    for (const cmd of cmds) {
      setTimeout(() => writeToPty(managed, cmd + '\r'), delay)
      delay += 3000
    }
    setTimeout(() => {
      if (!hasReceivedInitialPrompt.has(config.id)) {
        hasReceivedInitialPrompt.add(config.id)
        injectPrompt(managed, initialPrompt, 0)
      }
    }, delay + CLI_LOAD_TIME)
  }

  console.log(`Agent "${config.name}" reconnected successfully`)
}

// When a message is queued for an agent, nudge them immediately via stdin.
// MCP agents get a nudge to call get_messages(). Non-MCP agents get the full message.
function setupMessageNudge(): void {
  hub.messages.onMessageQueued = (msg) => {
    // Find the target agent's PTY by name
    const target = hub.registry.get(msg.to)
    if (!target) return

    const managed = Array.from(agents.values()).find(a => a.config.name === msg.to)
    if (!managed) return

    const nudge = `[AgentOrch] New message from "${msg.from}". Call get_messages() now to read it.`
    if (managed.config.cli === 'codex') {
      // Codex needs the text and Enter as separate writes with a delay.
      // Its TUI must fully render the input text before Enter triggers submit.
      writeToPty(managed, nudge)
      setTimeout(() => writeToPty(managed, '\r'), 2000)
    } else {
      // Claude/Kimi: single write with \r works
      writeToPty(managed, nudge + '\r')
    }
  }
}

// When info is posted, nudge orchestrator agents so they know to read it.
function setupInfoNudge(): void {
  const existingCallback = hub.infoChannel.onEntryAdded
  hub.infoChannel.onEntryAdded = (entry) => {
    // Preserve the existing persistence + renderer behavior before nudging.
    existingCallback?.(entry)

    const orchestrators = hub.registry.list().filter(agent => agent.role === 'orchestrator')
    for (const orchestrator of orchestrators) {
      if (orchestrator.name === entry.from) continue

      const managed = Array.from(agents.values()).find(agent => agent.config.name === orchestrator.name)
      if (!managed) continue

      const tagSuffix = entry.tags.length > 0 ? ` with tags [${entry.tags.join(', ')}]` : ''
      const nudge = `[AgentOrch] New info posted by "${entry.from}"${tagSuffix}. Call read_info() to read it.`
      if (managed.config.cli === 'codex') {
        writeToPty(managed, nudge)
        setTimeout(() => writeToPty(managed, '\r'), CODEX_SUBMIT_DELAY)
      } else {
        writeToPty(managed, nudge + '\r')
      }
    }
  }
}

function setupIPC(): void {
  ipcMain.handle(IPC.GET_HUB_INFO, () => ({
    port: hub.port,
    secret: hub.secret
  }))

  ipcMain.handle(IPC.GET_AGENTS, () => {
    return hub.registry.list()
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

    hub.registry.register(config)
    const initialPrompt = buildInitialPrompt(config)
    initialPrompts.set(config.id, initialPrompt)

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
        mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, hub.registry.list())
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
        mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, hub.registry.list())
      },
      onClearDetected: () => {
        const prompt = initialPrompts.get(config.id)
        if (prompt) injectPrompt(managed, prompt, CLI_LOAD_TIME)
      }
    })

    agents.set(config.id, managed)
    mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, hub.registry.list())

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

      // Inject initial prompt AFTER the CLI has had time to fully load.
      // This goes into the agent CLI's input, not PowerShell.
      setTimeout(() => {
        if (!hasReceivedInitialPrompt.has(config.id)) {
          hasReceivedInitialPrompt.add(config.id)
          injectPrompt(managed, initialPrompt, 0)
        }
      }, delay + CLI_LOAD_TIME)
    }

    // For non-MCP agents: poll and inject messages into stdin

    return { id: config.id, mcpConfigPath }
  })

  ipcMain.handle(IPC.WRITE_TO_PTY, (_event, agentId: string, data: string) => {
    const managed = agents.get(agentId)
    if (managed) writeToPty(managed, data)
  })

  ipcMain.handle(IPC.KILL_AGENT, (_event, agentId: string) => {
    const managed = agents.get(agentId)
    if (managed) {
      manualKills.add(agentId) // Prevent auto-reconnect
      killPty(managed)
      hub.registry.remove(managed.config.name)
      hub.messages.clearAgent(managed.config.name)
      if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)
      initialPrompts.delete(agentId)
      hasReceivedInitialPrompt.delete(agentId)
      agents.delete(agentId)
      mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, hub.registry.list())
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

  // Info Channel IPC handlers
  ipcMain.handle(IPC.INFO_GET_ENTRIES, () => {
    return hub.infoChannel.readInfo()
  })
}

async function main(): Promise<void> {
  await app.whenReady()

  // Initialize SQLite persistence
  const dbPath = path.join(app.getPath('userData'), 'agentorch.db')
  const db = createDatabase(dbPath)
  const messageStore = new MessageStore(db)
  const pinboardStore = new PinboardStore(db)
  const infoStore = new InfoStore(db)

  hub = await createHubServer()
  console.log(`Hub server running on port ${hub.port}`)

  // Restore persisted state into in-memory stores
  hub.pinboard.loadTasks(pinboardStore.loadTasks())
  hub.infoChannel.loadEntries(infoStore.loadEntries())

  // Hook persistence callbacks (write-behind to SQLite) + push to renderer
  hub.messages.onMessageSaved = (msg) => messageStore.saveMessage(msg)
  hub.pinboard.onTaskCreated = (task) => {
    pinboardStore.saveTask(task)
    mainWindow?.webContents.send(IPC.PINBOARD_TASK_UPDATE, hub.pinboard.readTasks())
  }
  hub.pinboard.onTaskUpdated = (task) => {
    pinboardStore.updateTask(task)
    mainWindow?.webContents.send(IPC.PINBOARD_TASK_UPDATE, hub.pinboard.readTasks())
  }
  hub.infoChannel.onEntryAdded = (entry) => {
    infoStore.saveEntry(entry)
    mainWindow?.webContents.send(IPC.INFO_ENTRY_ADDED, hub.infoChannel.readInfo())
  }

  hub.setOutputAccessor((agentName, lines) => {
    const managed = Array.from(agents.values()).find(a => a.config.name === agentName)
    if (!managed) return null
    return managed.outputBuffer.getLines(lines)
  })
  setupMessageNudge()
  setupInfoNudge()

  setupIPC()
  mainWindow = createWindow()
}

main()

app.on('window-all-closed', () => {
  // Mark all as manual kills to prevent auto-reconnect during shutdown
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
  hub?.close()
  app.quit()
})
