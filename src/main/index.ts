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
const messagePollers = new Map<string, ReturnType<typeof setInterval>>()

// CLIs that natively support MCP (pull their own messages)
// CLIs that pull their own messages via MCP get_messages() tool.
// Codex registers MCP via `codex mcp add` so it IS MCP-capable.
const MCP_CAPABLE_CLIS = new Set(['claude', 'kimi', 'codex'])

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

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

// Returns one or more commands to type into the shell. Array = chain them sequentially.
function buildCliLaunchCommands(config: AgentConfig, mcpConfigPath: string, mcpServerPath: string): string[] | null {
  const cliBase = config.cli

  // Plain terminal: don't launch any CLI, just leave the shell open
  if (cliBase === 'terminal') return null

  if (cliBase === 'claude') {
    const parts = [`claude --mcp-config "${mcpConfigPath}"`]
    if (config.autoMode) parts[0] += ' --dangerously-skip-permissions'
    return parts
  }

  if (cliBase === 'codex') {
    // Codex uses `codex mcp add <name> -- <command>` to register MCP servers.
    // We register our server first, then launch codex. Env vars are on the PTY.
    const mcpName = `agentorch-${config.id.slice(0, 8)}`
    const cmds = [
      `codex mcp add ${mcpName} -- node "${mcpServerPath}"`,
    ]
    const codexCmd = config.autoMode ? 'codex --yolo' : 'codex'
    cmds.push(codexCmd)
    return cmds
  }

  if (cliBase === 'kimi') {
    const parts = [`kimi --mcp-config-file "${mcpConfigPath}"`]
    return parts
  }

  // Custom CLIs: just run the command, no MCP
  return [cliBase]
}

// For non-MCP agents: poll for messages and inject them into the terminal stdin
function startMessagePoller(config: AgentConfig, managed: ManagedPty): void {
  if (MCP_CAPABLE_CLIS.has(config.cli)) return // MCP agents pull their own messages

  const poller = setInterval(() => {
    const messages = hub.messages.getMessages(config.name)
    if (messages.length === 0) return

    for (const msg of messages) {
      // Format message as readable text and inject into the agent's stdin
      const formatted = `\r\n${msg.message}\r\n`
      writeToPty(managed, formatted)
    }
  }, 2000) // Check every 2 seconds

  messagePollers.set(config.id, poller)
}

function stopMessagePoller(agentId: string): void {
  const poller = messagePollers.get(agentId)
  if (poller) {
    clearInterval(poller)
    messagePollers.delete(agentId)
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
        stopMessagePoller(config.id)
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
    const cmds = buildCliLaunchCommands(config, mcpConfigPath, mcpServerPath)
    if (cmds) {
      let delay = 1000
      for (const cmd of cmds) {
        setTimeout(() => {
          writeToPty(managed, cmd + '\r')
        }, delay)
        delay += 3000 // Give each command time to complete
      }
    }

    // For non-MCP agents: poll and inject messages into stdin
    startMessagePoller(config, managed)

    return { id: config.id, mcpConfigPath }
  })

  ipcMain.handle(IPC.WRITE_TO_PTY, (_event, agentId: string, data: string) => {
    const managed = agents.get(agentId)
    if (managed) writeToPty(managed, data)
  })

  ipcMain.handle(IPC.KILL_AGENT, (_event, agentId: string) => {
    const managed = agents.get(agentId)
    if (managed) {
      stopMessagePoller(agentId)
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

  setupIPC()
  mainWindow = createWindow()
}

main()

app.on('window-all-closed', () => {
  for (const [id, managed] of agents) {
    stopMessagePoller(id)
    killPty(managed)
    if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)
  }
  agents.clear()
  hub?.close()
  app.quit()
})
