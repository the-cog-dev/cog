import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import { createHubServer, type HubServer } from './hub/server'
import { spawnAgentPty, writeToPty, resizePty, killPty, type ManagedPty } from './shell/pty-manager'
import { writeAgentMcpConfig, cleanupConfig } from './mcp/config-writer'
import type { AgentConfig } from '../shared/types'
import { IPC } from '../shared/types'

let hub: HubServer
let mainWindow: BrowserWindow
const agents = new Map<string, ManagedPty>()
const hasReceivedInitialPrompt = new Set<string>()

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
    if (config.autoMode) cmd += ' --dangerously-skip-permissions'
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
    `You have AgentOrch MCP tools: send_message, get_messages, get_agents, read_ceo_notes.`,
    `Call read_ceo_notes() now for your instructions, then get_messages() to check for tasks from the orchestrator.`,
  ]
  return lines.join(' ')
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
    // Single write with \r appended — this is what works for Claude
    writeToPty(managed, nudge + '\r')
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
      },
      onStatusChange: (status) => {
        hub.registry.updateStatus(config.name, status)
        mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, hub.registry.list())
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
      const CLI_LOAD_TIME = 10000 // 10s for CLI to initialize after last command
      setTimeout(() => {
        if (!hasReceivedInitialPrompt.has(config.id)) {
          hasReceivedInitialPrompt.add(config.id)
          const prompt = buildInitialPrompt(config)
          writeToPty(managed, prompt + '\r')
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
      killPty(managed)
      hub.registry.remove(managed.config.name)
      hub.messages.clearAgent(managed.config.name)
      if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)
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
}

async function main(): Promise<void> {
  await app.whenReady()

  hub = await createHubServer()
  console.log(`Hub server running on port ${hub.port}`)
  setupMessageNudge()

  setupIPC()
  mainWindow = createWindow()
}

main()

app.on('window-all-closed', () => {
  for (const [, managed] of agents) {
    killPty(managed)
    if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)
  }
  agents.clear()
  hub?.close()
  app.quit()
})
