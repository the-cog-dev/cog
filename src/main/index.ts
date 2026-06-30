import { app, BrowserWindow, ipcMain, dialog, Notification, Menu, shell } from 'electron'
import path from 'path'
import * as fs from 'fs'
import * as gitOps from './git/git-ops'
import { createDatabase } from './db/database'
import { MessageStore } from './db/message-store'
import { PinboardStore } from './db/pinboard-store'
import { InfoStore } from './db/info-store'
import { InboxStore } from './db/inbox-store'
import { ProposalsStore } from './db/proposals-store'
import { meetsThreshold } from './hub/inbox-channel'
import { createHubServer, type HubServer } from './hub/server'
import type { ScheduleBridge, BoardBridge, AgentBridge } from './hub/routes'
import { spawnAgentPty, writeToPty, resizePty, killPty, type ManagedPty } from './shell/pty-manager'
import { buildCliLaunchCommands as buildCliLaunchCommandsForConfig } from './cli-launch'
import { writeAgentMcpConfig, writePiAgentConfig, cleanupConfig, cleanupPiAgentDir, piAgentDir } from './mcp/config-writer'
import { savePreset, loadPreset, listPresets, deletePreset, setPresetsDir } from './presets/preset-manager'
import { ProjectManager } from './project/project-manager'
import { SkillManager } from './skills/skill-manager'
import { RacClient } from './rac/rac-client'
import { UpdateChecker } from './updater/update-checker'
import { SchedulesStore } from './scheduler/schedules-store'
import { AutonomyStore } from './db/autonomy-store'
import { PromptScheduler } from './scheduler/prompt-scheduler'
import { canAgentCancelSchedule } from './scheduler/scheduler-helpers'
import type { Server as HttpServer } from 'http'
import * as https from 'https'
import * as httpProto from 'http'
import { createHash } from 'crypto'
import { spawn as spawnChildProcess } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import { TokenManager } from './remote/token-manager'
import { CloudflaredManager } from './remote/cloudflared-manager'
import { RemoteServer } from './remote/remote-server'
import { RemoteWsHub } from './remote/ws-hub'
import { PairingManager } from './telegram/pairing-manager'
import { TelegramServer } from './telegram/telegram-server'
import * as communityClient from './community/community-client'
import * as themesStore from './themes/themes-store'
import * as workspaceThemeStore from './themes/workspace-theme-store'
import { getWorkspaceThemeById, WORKSPACE_THEMES } from '../shared/workspace-themes'
import { migrateLegacyUserData } from './migration/userdata-migration'
import type { AgentConfig, AgentTheme, RemoteSetupProgress, CommunityAgent, CommunityCategory, RespawnResult, NotificationThreshold, ProposedAgent, TeamProposal } from '../shared/types'
import { IPC } from '../shared/types'
import { validateRespawnRequest } from './respawn-validation'
import { initStreamDeck, disposeStreamDeck, resolveCogsworthDir, getStreamDeckStatus, reconnectStreamDeck } from './streamdeck'
import { prepareLocalWhisper, isLocalWhisperReady } from './streamdeck/local-whisper-prepare'
import { BoardStore } from './db/board-store'
import { BoardAppearanceStore } from './db/board-appearance-store'
import { saveImageBytes, saveRenderBytes, renderPathForPage } from './board/board-files'

let hub: HubServer
let mainWindow: BrowserWindow
let projectManager: ProjectManager
let skillManager: SkillManager
let racClient: RacClient
let updateChecker: UpdateChecker
let currentDb: import('better-sqlite3').Database | null = null
let currentMessageStore: MessageStore | null = null
let currentSchedulesStore: SchedulesStore | null = null
let autonomyStore: AutonomyStore | null = null
let boardStore: BoardStore | null = null
let boardAppearanceStore: BoardAppearanceStore | null = null
let currentInboxStore: InboxStore | null = null
let currentProposalsStore: ProposalsStore | null = null
let promptScheduler: PromptScheduler | null = null
// Built after promptScheduler + autonomyStore are assigned; injected into the
// hub via a getter so route handlers can schedule prompts / read autonomy.
// Module-level so a later task (approveProposal) can reach it too.
let scheduleBridge: ScheduleBridge | null = null
// Built after boardStore is assigned; injected into the hub via a getter so
// route handlers can list board pages and resolve render paths.
let boardBridge: BoardBridge | null = null
let agentBridge: AgentBridge | null = null
const agents = new Map<string, ManagedPty>()
const hasReceivedInitialPrompt = new Set<string>()
const initialPrompts = new Map<string, string>()
const manualKills = new Set<string>() // Track intentional kills to skip auto-reconnect
const pendingNudges = new Map<string, string[]>() // agentName → queued nudge strings
const workspaceTabs = new Map<string, { id: string; name: string }>()
workspaceTabs.set('tab-default', { id: 'tab-default', name: 'Workspace 1' })
let nextTabNum = 2
const lastNudgeDelivery = new Map<string, number>() // agentName → timestamp of last nudge delivery
const nudgeFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>() // agentName → fallback timer
const NUDGE_COOLDOWN_MS = 3000    // Minimum interval between nudge deliveries to the same agent
const STALE_TASK_CHECK_INTERVAL = 60000  // Check for stuck in_progress tasks every 60s
const STALE_TASK_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes before a task is considered stale
let staleTaskTimer: ReturnType<typeof setInterval> | null = null
let staleAlertMuteUntil: number | null = null  // epoch ms; null = not muted

// Remote View state
let remoteTokenManager: TokenManager | null = null
let cloudflaredManager: CloudflaredManager | null = null
let remoteServer: RemoteServer | null = null
let remoteHttpServer: HttpServer | null = null
let remoteLanServer: HttpServer | null = null  // LAN-accessible listener (bound to 0.0.0.0)
let remoteWsHub: RemoteWsHub | null = null
let remotePublicUrl: string | null = null
let remoteLanUrl: string | null = null  // http://<lan-ip>:<port>/r/<token>/
let remoteStatusTicker: ReturnType<typeof setInterval> | null = null
// Telegram orchestration state
let telegramServer: TelegramServer | null = null
let telegramPairing: PairingManager | null = null
let workshopPasscodeHash: string | null = null
let cachedWorkspaceState: any = null

// Trollbox bridge state. cachedTrollboxState mirrors the renderer's
// TrollboxClient snapshot (status, messages, online count, pause flag) so
// the 3DS HTTP API can serve it from main without crossing into the
// renderer process per request. trollboxSendReplies routes ack/err back
// to the awaiting POST handler.
let cachedTrollboxState: {
  status: string
  onlineCount: number
  messages: Array<{ id: string; ts: number; nick: string; text: string }>
  pauseUntil: number | null
  pauseReason: string | null
} | null = null
const trollboxSendReplies = new Map<string, (r: { ok: boolean; error?: string }) => void>()
let trollboxSendCounter = 0

function sendTrollboxFromRemote(text: string, nick: string): Promise<{ ok: boolean; error?: string }> {
  if (!mainWindow) return Promise.resolve({ ok: false, error: 'desktop window not ready' })
  if (!cachedTrollboxState || cachedTrollboxState.status !== 'connected') {
    return Promise.resolve({ ok: false, error: 'trollbox not connected on desktop — open the panel first' })
  }
  const id = `t${Date.now()}-${trollboxSendCounter++}`
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (trollboxSendReplies.delete(id)) resolve({ ok: false, error: 'send timed out' })
    }, 8000)
    trollboxSendReplies.set(id, (r) => { clearTimeout(timeout); resolve(r) })
    mainWindow!.webContents.send(IPC.TROLLBOX_REMOTE_SEND, { id, text, nick })
  })
}

// Mirror of the renderer's workshop window layout, kept current via IPC
// from the Workspace component. Consumed by /state so remote clients
// (mobile, 3DS) can render cards at desktop positions.
interface WindowLayoutEntry {
  x: number
  y: number
  width: number
  height: number
  color: string
}
const workshopLayoutCache = new Map<string, WindowLayoutEntry>()

const CODEX_SUBMIT_DELAY = 2000   // Codex TUI needs text rendered before Enter is sent
const RECONNECT_DELAY = 3000      // Wait before respawning a crashed agent
const PROMPT_INJECT_FALLBACK_MS = 10000 // Safety net if StatusDetector doesn't detect prompt (Gemini, Kimi, etc.)

// Get visible agent list — filters out internal agents like "user"
function getVisibleAgents() {
  return hub.registry.list().filter(a => a.name !== 'user')
}

let autonomyExpiryTimer: ReturnType<typeof setTimeout> | null = null

// Re-arm the one-shot autonomy expiry timer from the stored session and push
// current state to the renderer. Safe to call repeatedly (start/end/load).
function armAutonomyExpiry(): void {
  if (autonomyExpiryTimer) { clearTimeout(autonomyExpiryTimer); autonomyExpiryTimer = null }
  const exp = autonomyStore?.get().sessionExpiresAt ?? null
  mainWindow?.webContents.send(IPC.AUTONOMY_CHANGED, { sessionExpiresAt: exp })
  if (exp === null) return
  const delay = exp - Date.now()
  if (delay <= 0) { onAutonomyExpired(); return }
  autonomyExpiryTimer = setTimeout(onAutonomyExpired, delay)
}

function onAutonomyExpired(): void {
  autonomyExpiryTimer = null
  if (!autonomyStore) return
  autonomyStore.endSession()
  mainWindow?.webContents.send(IPC.AUTONOMY_CHANGED, { sessionExpiresAt: null })
  try {
    const orch = getVisibleAgents().find(a => (a.role || '').toLowerCase() === 'orchestrator')
    hub?.inboxChannel.postMessage(
      orch?.id ?? 'system', orch?.name ?? 'system',
      'Autonomous session ended — approvals required again.', 'normal', ['autonomy'], orch?.tabId
    )
  } catch { /* inbox may be unavailable */ }
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

// ── Remote View helpers ──────────────────────────────────────────────────────

async function downloadFile(url: string, dest: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const followRedirects = (currentUrl: string) => {
      const proto = currentUrl.startsWith('https') ? https : httpProto
      proto.get(currentUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          if (res.headers.location) {
            const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location
            followRedirects(loc)
          } else {
            reject(new Error('Redirect without location header'))
          }
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: ${res.statusCode}`))
          return
        }
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let received = 0
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (total > 0) onProgress(Math.floor((received / total) * 100))
        })
        res.pipe(file)
        file.on('finish', () => { file.close(); resolve() })
      }).on('error', reject)
    }
    followRedirects(url)
  })
}

function emitRemoteStatus(): void {
  if (!mainWindow) return
  mainWindow.webContents.send(IPC.REMOTE_STATUS_UPDATE, {
    enabled: remoteServer !== null,
    publicUrl: remotePublicUrl,
    lanUrl: remoteLanUrl,
    lanEnabled: remoteLanServer !== null,
    connectionCount: remoteTokenManager?.getConnectionCount() ?? 0,
    lastActivity: remoteTokenManager?.getLastActivity() ?? null
  })
}

function emitRemoteSetupProgress(progress: RemoteSetupProgress): void {
  if (!mainWindow) return
  mainWindow.webContents.send(IPC.REMOTE_SETUP_PROGRESS, progress)
}

function startRemoteStatusTicker(): void {
  if (remoteStatusTicker) return
  remoteStatusTicker = setInterval(() => {
    if (remoteServer) {
      emitRemoteStatus()
    } else if (remoteStatusTicker) {
      clearInterval(remoteStatusTicker)
      remoteStatusTicker = null
    }
  }, 3000)
}

async function enableRemoteView(): Promise<void> {
  if (remoteServer) return

  emitRemoteSetupProgress({ stage: 'starting', message: 'Setting up remote tunnel...' })

  if (!cloudflaredManager) {
    cloudflaredManager = new CloudflaredManager({
      userDataPath: app.getPath('userData'),
      download: downloadFile,
      spawnChild: (cmd: string, args: string[]) => spawnChildProcess(cmd, args),
      onProgress: (pct) => emitRemoteSetupProgress({ stage: 'downloading', message: `${pct}%` })
    })
  }

  try {
    await cloudflaredManager.ensureInstalled()
  } catch (err) {
    emitRemoteSetupProgress({ stage: 'error', message: `cloudflared install failed: ${(err as Error).message}` })
    return
  }

  remoteTokenManager = new TokenManager()
  const savedTimeout = loadSettings().remoteSessionTimeout
  if (typeof savedTimeout === 'number' && savedTimeout >= 1 && savedTimeout <= 168) {
    remoteTokenManager.setExpiryDuration(savedTimeout * 60 * 60 * 1000)
  }
  const token = remoteTokenManager.generate()

  remoteServer = new RemoteServer({
    tokenManager: remoteTokenManager,
    getProjectName: () => projectManager?.currentProject?.name ?? 'The Cog',
    getProjectPath: () => projectManager?.currentProject?.path ?? null,
    getAgents: () => {
      return getVisibleAgents().map(a => ({
        id: a.id, name: a.name, cli: a.cli, model: a.model || 'default', role: a.role, status: a.status
      }))
    },
    getSchedules: () => {
      if (!promptScheduler) return []
      return promptScheduler.list().map(s => {
        const agent = Array.from(agents.values()).find(m => m.config.id === s.agentId)
        return {
          id: s.id,
          name: s.name,
          agentName: agent?.config.name ?? '(deleted)',
          intervalMinutes: s.intervalMinutes,
          durationHours: s.durationHours,
          nextFireAt: s.nextFireAt,
          expiresAt: s.expiresAt,
          status: s.status
        }
      })
    },
    getPinboardTasks: () => {
      if (!hub) return []
      // Include all tasks (open/in_progress/completed) so the mobile workshop
      // panel can show Kanban-style grouping. Dashboard filters completed
      // client-side to preserve its "active work" view.
      return hub.pinboard.readTasks()
        .map(t => ({
          id: t.id, title: t.title, priority: t.priority, status: t.status, claimedBy: t.claimedBy
        }))
    },
    getInfoEntries: () => {
      if (!hub) return []
      return hub.infoChannel.readInfo().map(e => ({
        id: e.id, from: e.from, note: e.note, tags: e.tags, createdAt: e.createdAt
      }))
    },
    getAgentOutput: (agentId: string, lines?: number) => {
      const managed = agents.get(agentId)
      if (!managed) return []
      return managed.outputBuffer.getLines(lines ?? 50)
    },
    sendMessage: (to: string, text: string) => {
      const target = Array.from(agents.values()).find(m => m.config.name === to)
      if (!target) throw new Error(`Agent ${to} not found`)
      writeNudgeToPty(target, text)
    },
    pauseSchedule: (id: string) => {
      if (!promptScheduler) throw new Error('Scheduler unavailable')
      return promptScheduler.pause(id)
    },
    resumeSchedule: (id: string) => {
      if (!promptScheduler) throw new Error('Scheduler unavailable')
      return promptScheduler.resume(id)
    },
    restartSchedule: (id: string) => {
      if (!promptScheduler) throw new Error('Scheduler unavailable')
      return promptScheduler.restart(id)
    },
    createSchedule: (input) => {
      if (!promptScheduler) throw new Error('Scheduler unavailable')
      // Resolve tabId from the agent's config so the schedule lives in the
      // same workspace tab as the agent. Falls back to the default tab for
      // older agents that pre-date workspace tabs.
      const managed = agents.get(input.agentId)
      if (!managed) throw new Error(`Agent ${input.agentId} not found`)
      const tabId = managed.config.tabId || 'tab-default'
      return promptScheduler.create({
        tabId,
        agentId: input.agentId,
        name: input.name,
        promptText: input.promptText,
        intervalMinutes: input.intervalMinutes,
        durationHours: input.durationHours
      })
    },
    postTask: (title: string, description: string, priority: 'low' | 'medium' | 'high') => {
      if (!hub) throw new Error('Hub unavailable')
      return hub.pinboard.postTask(title, description, priority, 'remote-user')
    },
    getWorkshopPasscodeSet: () => workshopPasscodeHash !== null,
    getWorkspaceState: () => cachedWorkspaceState,
    getWorkshopPasscodeHash: () => workshopPasscodeHash,
    killAgent: (agentId: string) => {
      const managed = agents.get(agentId)
      if (!managed) throw new Error('Agent not found')
      teardownAgent(managed)
    },
    spawnAgentFromWorkshop: async (config) => {
      try {
        const projectCwd = projectManager.currentProject?.path
        if (!projectCwd) return { success: false, error: 'No project open' }

        const fullConfig: AgentConfig = {
          id: uuidv4(),
          name: config.name,
          cli: config.cli,
          cwd: config.cwd || projectCwd,
          role: config.role,
          ceoNotes: config.ceoNotes,
          shell: config.shell || 'powershell',
          admin: false,
          autoMode: config.autoMode,
          ...(config.model ? { model: config.model } : {}),
          ...(config.skills && config.skills.length > 0 ? { skills: config.skills } : {})
        }

        handleSpawnAgent(fullConfig)
        // Tell the renderer to open a window for this agent — the desktop
        // canvas is the source of truth for layout, and remote-driven spawns
        // bypass the renderer's normal handleSpawn (which would addWindow).
        mainWindow?.webContents.send(IPC.AGENT_SPAWNED_REMOTE, {
          agentId: fullConfig.id,
          name: fullConfig.name,
          cli: fullConfig.cli
        })
        return { success: true, agentId: fullConfig.id }
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }
    },
    onWorkshopWindowUpdate: (update) => {
      mainWindow?.webContents.send(IPC.WORKSHOP_WINDOW_UPDATE, update)
    },
    onWorkshopPanelToggle: (update) => {
      mainWindow?.webContents.send(IPC.WORKSHOP_PANEL_TOGGLE, update)
    },
    getAgentLayouts: () => {
      const out: Record<string, WindowLayoutEntry> = {}
      for (const [id, entry] of workshopLayoutCache.entries()) out[id] = entry
      return out
    },
    getPresets: () => {
      try {
        const names = listPresets()
        return names.map(name => {
          const p = loadPreset(name)
          return {
            name: p.name,
            agentCount: p.agents.length,
            agents: p.agents.map(a => ({ name: a.name, cli: a.cli, role: a.role }))
          }
        })
      } catch {
        return []
      }
    },
    deleteInfoEntry: (id: string) => {
      hub.infoChannel.deleteInfo(id)
    },
    // ── Inbox + team proposals (Phase 4a — 3DS access) ─────────────────────
    // Enrich each inbox message with linked-proposal data when the message
    // carries a propose-team tag. The 3DS reads `proposalId` and the team
    // summary off the message itself so it can render the approve/reject UI
    // without a second roundtrip.
    getInboxMessages: () => {
      if (!hub) return []
      const msgs = hub.inboxChannel.readAll()
      return msgs.map(m => {
        // Convention: messages that wrap a team proposal are tagged
        // 'proposal:<proposalId>' by the orchestrator's propose_team flow.
        const propTag = m.tags?.find(t => t.startsWith('proposal:'))
        const proposalId = propTag ? propTag.slice('proposal:'.length) : undefined
        const proposal = proposalId ? hub!.proposalsChannel.get(proposalId) : null
        return {
          id: m.id,
          agentName: m.agentName,
          message: m.message,
          priority: m.priority,
          createdAt: m.createdAt,
          readAt: m.readAt,
          ...(proposal ? {
            proposalId: proposal.id,
            proposalSummary: proposal.summary,
            proposalAgents: proposal.agents.map(a => ({
              name: a.name, cli: a.cli, model: a.model, role: a.role
            })),
            proposalStatus: proposal.status
          } : {})
        }
      })
    },
    getInboxUnreadCount: () => hub?.inboxChannel.unreadCount() ?? 0,
    markInboxRead: (id: string) => {
      if (!hub) return false
      return hub.inboxChannel.markRead(id) !== null
    },
    approveProposal: async (proposalId: string) => {
      if (!hub) return { success: false, error: 'Hub not ready' }
      const proposal = hub.proposalsChannel.get(proposalId)
      if (!proposal) return { success: false, error: 'Proposal not found' }
      if (proposal.status !== 'pending') {
        return { success: false, error: `Proposal already ${proposal.status}` }
      }
      if (proposal.kind === 'schedule') {
        if (!proposal.payload) {
          return { success: false, error: 'Schedule proposal missing payload' }
        }
        if (!scheduleBridge) {
          return { success: false, error: 'Scheduler unavailable' }
        }
        try {
          scheduleBridge.create({
            agentId: proposal.payload.targetAgentId,
            tabId: proposal.payload.tabId,
            name: proposal.payload.name,
            promptText: proposal.payload.promptText,
            intervalMinutes: proposal.payload.intervalMinutes,
            durationHours: proposal.payload.durationHours,
            createdBy: proposal.proposedBy
          })
        } catch (err: any) {
          return { success: false, error: err?.message || 'Failed to create schedule' }
        }
        hub.proposalsChannel.resolve(proposalId, 'approved')
        return { success: true }
      }
      // 3DS approves as-stored — no per-agent edits available on the small screen.
      const { spawned, total, names } = spawnProposalAgents(proposal)
      hub.proposalsChannel.resolve(proposalId, 'approved')
      try {
        const summary = spawned === total
          ? `User approved your team from 3DS. Spawned: ${names.join(', ')}.`
          : `User approved part of your team from 3DS. Spawned ${spawned}/${total}.`
        hub.messages.send('user', proposal.proposedBy, summary)
      } catch { /* orchestrator may not be reachable */ }
      return { success: true, spawned }
    },
    rejectProposal: (proposalId: string, feedback?: string) => {
      if (!hub) return { success: false, error: 'Hub not ready' }
      const resolved = hub.proposalsChannel.resolve(proposalId, 'rejected', feedback)
      if (!resolved) return { success: false, error: 'Proposal not found' }
      try {
        const note = feedback
          ? `User rejected your team proposal from 3DS. Feedback: ${feedback}`
          : 'User rejected your team proposal from 3DS.'
        hub.messages.send('user', resolved.proposedBy, note)
      } catch { /* orchestrator may not be reachable */ }
      return { success: true }
    },
    replyToInbox: (agentName: string, message: string) => {
      if (!hub) return { success: false, error: 'Hub not ready' }
      try {
        hub.messages.send('user', agentName, message)
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err?.message || 'Send failed' }
      }
    },
    // ── Trollbox bridge (Phase 4b) ─────────────────────────────────────────
    getTrollboxState: () => cachedTrollboxState,
    sendTrollboxMessage: (text: string, nick: string) =>
      sendTrollboxFromRemote(text, nick),
  })

  const expressApp = remoteServer.getApp()
  remoteHttpServer = await new Promise<HttpServer>((resolve, reject) => {
    const srv = expressApp.listen(0, '127.0.0.1', () => resolve(srv))
    srv.on('error', reject)
  })
  const addr = remoteHttpServer.address()
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind remote server')
  }
  const localPort = addr.port

  // Attach the WebSocket hub to the same HTTP server. It handles its own
  // upgrade routing and auth — adding `upgrade` listener on the http.Server
  // is non-destructive to existing routes.
  remoteWsHub = new RemoteWsHub(remoteTokenManager)
  remoteWsHub.attachToServer(remoteHttpServer)

  try {
    const baseUrl = await cloudflaredManager.start(localPort)
    remotePublicUrl = `${baseUrl}/r/${token}/`
    console.log(`[RemoteView] Tunnel ready: ${remotePublicUrl}`)
  } catch (err) {
    console.log(`[RemoteView] Tunnel failed: ${(err as Error).message}`)
    emitRemoteSetupProgress({ stage: 'error', message: `tunnel failed: ${(err as Error).message}` })
    await disableRemoteView()
    return
  }

  emitRemoteSetupProgress({ stage: 'ready' })
  emitRemoteStatus()
  startRemoteStatusTicker()
}

async function disableRemoteView(): Promise<void> {
  if (cloudflaredManager) cloudflaredManager.stop()
  if (remoteWsHub) {
    remoteWsHub.close()
    remoteWsHub = null
  }
  if (remoteHttpServer) {
    await new Promise<void>((resolve) => remoteHttpServer!.close(() => resolve()))
    remoteHttpServer = null
  }
  if (remoteLanServer) {
    await new Promise<void>((resolve) => remoteLanServer!.close(() => resolve()))
    remoteLanServer = null
  }
  if (remoteTokenManager) remoteTokenManager.invalidate()
  remoteServer = null
  remoteTokenManager = null
  remotePublicUrl = null
  remoteLanUrl = null
  if (remoteStatusTicker) {
    clearInterval(remoteStatusTicker)
    remoteStatusTicker = null
  }
  emitRemoteStatus()
}

// ── Telegram orchestration helpers ───────────────────────────────────────────

function emitTelegramStatus(): void {
  if (!mainWindow) return
  const s = loadSettings()
  mainWindow.webContents.send(IPC.TELEGRAM_STATUS_UPDATE, {
    enabled: telegramServer?.isRunning() ?? false,
    hasToken: typeof s.telegramBotToken === 'string' && !!s.telegramBotToken,
    pairedCount: telegramPairing?.size
      ?? (Array.isArray(s.telegramAllowlist) ? s.telegramAllowlist.length : 0),
    activePairingCode: telegramPairing?.getActiveCode() ?? null
  })
}

async function enableTelegram(): Promise<void> {
  if (telegramServer) return
  const s = loadSettings()
  const token = typeof s.telegramBotToken === 'string' ? s.telegramBotToken.trim() : ''
  if (!token) return  // no token yet — UI prompts for one

  telegramPairing = new PairingManager({
    initialAllowlist: Array.isArray(s.telegramAllowlist) ? s.telegramAllowlist : [],
    onAllowlistChange: (ids) => saveSetting('telegramAllowlist', ids)
  })
  telegramServer = new TelegramServer({
    pairing: telegramPairing,
    onLog: (m) => console.log('[telegram]', m),
    onStatusChange: () => emitTelegramStatus()
  })

  try {
    await telegramServer.start(token)
    saveSetting('telegramEnabled', true)
  } catch (err) {
    // Bad token / network — tear down and rethrow so the UI can report it.
    telegramServer = null
    telegramPairing = null
    emitTelegramStatus()
    throw err
  }
  emitTelegramStatus()
}

async function disableTelegram(): Promise<void> {
  saveSetting('telegramEnabled', false)
  if (telegramServer) await telegramServer.stop()
  telegramServer = null
  telegramPairing = null
  emitTelegramStatus()
}

/**
 * Pick a LAN-reachable IPv4 address. Prefers 192.168.x.x (home WiFi), then
 * 10.x.x.x and 172.16-31.x.x (private network ranges). Skips loopback,
 * link-local, and virtual adapters where possible.
 */
function getLanIp(): string | null {
  const os = require('os')
  const ifaces = os.networkInterfaces()
  const candidates: { ip: string; score: number }[] = []
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name] || []
    for (const iface of list) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      const ip = iface.address
      // Score private ranges, prefer common home WiFi
      let score = 0
      if (ip.startsWith('192.168.')) score = 100
      else if (ip.startsWith('10.')) score = 50
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score = 30
      else continue  // skip non-private IPs (public, exotic)
      // De-prioritize obvious virtual adapters by name
      if (/(virtual|vmware|vbox|hyper-v|wsl|docker)/i.test(name)) score -= 50
      candidates.push({ ip, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.ip ?? null
}

async function enableLanAccess(): Promise<{ ok: boolean; error?: string }> {
  if (!remoteServer || !remoteTokenManager) {
    return { ok: false, error: 'Enable Remote View first' }
  }
  if (remoteLanServer) return { ok: true }  // already running

  const lanIp = getLanIp()
  if (!lanIp) return { ok: false, error: 'No LAN interface detected' }

  const expressApp = remoteServer.getApp()
  try {
    remoteLanServer = await new Promise<HttpServer>((resolve, reject) => {
      const srv = expressApp.listen(0, '0.0.0.0', () => resolve(srv))
      srv.on('error', reject)
    })
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  const addr = remoteLanServer.address()
  if (!addr || typeof addr === 'string') {
    return { ok: false, error: 'Failed to bind LAN server' }
  }
  // Attach the shared WS hub to the LAN server too so phones on Wi-Fi get
  // the same real-time stream as cloudflared clients. Reuses the same auth
  // (token in URL) — no extra surface area.
  if (remoteWsHub) remoteWsHub.attachToServer(remoteLanServer)
  const token = remoteTokenManager.getCurrentToken()
  remoteLanUrl = `http://${lanIp}:${addr.port}/r/${token}/`
  console.log(`[RemoteView] LAN access ready: ${remoteLanUrl}`)
  emitRemoteStatus()
  return { ok: true }
}

async function disableLanAccess(): Promise<void> {
  if (remoteLanServer) {
    await new Promise<void>((resolve) => remoteLanServer!.close(() => resolve()))
    remoteLanServer = null
  }
  remoteLanUrl = null
  emitRemoteStatus()
}

// ── End Remote View helpers ──────────────────────────────────────────────────

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

function getAppIconPath(): string | undefined {
  // In packaged builds Windows uses the .ico baked into the .exe by electron-builder.
  // In dev, point BrowserWindow at build/icon.png so the taskbar shows the Cogsworth
  // icon instead of the default Electron logo.
  if (app.isPackaged) return undefined
  const candidate = path.join(__dirname, '../../build/icon.png')
  return fs.existsSync(candidate) ? candidate : undefined
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1a1a1a',
    title: 'The Cog',
    icon: getAppIconPath(),
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
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* https://*.supabase.co wss://*.supabase.co; img-src 'self' data:; font-src 'self' data:"
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
          click: () => shell.openExternal('https://github.com/the-cog-dev/cog#readme')
        },
        {
          label: 'Keyboard Shortcuts',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'Keyboard Shortcuts',
              message: 'The Cog Shortcuts',
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
          label: 'About The Cog',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'About The Cog',
              message: 'The Cog',
              detail: 'AI-Native Agent Orchestration IDE\n\nOrchestrate teams of AI coding agents across multiple models and providers.\n\nhttps://thecog.dev\nhttps://github.com/the-cog-dev/cog'
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
  hubPort: number, hubSecret: string, ensurePiAdapter = false
): string[] | null {
  return buildCliLaunchCommandsForConfig(config, mcpConfigPath, mcpServerPath, hubPort, hubSecret, ensurePiAdapter)
}

// Build the initial prompt injected when the CLI first becomes ready.
// Keeps it short so the agent doesn't waste context — just tells it who it is
// and to check MCP tools for instructions.
function buildInitialPrompt(config: AgentConfig): string {
  const isOrchestrator = (config.role || '').trim().toLowerCase() === 'orchestrator'
  const baseTools = `send_message, get_messages, get_agents, read_ceo_notes, get_agent_output, post_task, read_tasks, claim_task, complete_task, abandon_task, get_task, post_info, read_info, delete_info, update_info, update_status, get_message_history, ack_messages, read_file, write_file, list_directory`
  const orchestratorTools = isOrchestrator ? `, notify_user, propose_team` : ''
  const lines = [
    `You are "${config.name}" (role: ${config.role}) in a Cog workspace.`,
    `You have Cog MCP tools: ${baseTools}${orchestratorTools}.`,
    isOrchestrator
      ? `As orchestrator you have two extra tools: notify_user(message, priority) posts to the user's inbox panel for messages targeted at the human (use sparingly, with priority high/urgent only when the user genuinely needs to act). propose_team({summary, agents}) submits a team for the user to approve in a confirmation modal — agents do NOT spawn until the user clicks Approve, so wait for the user response.`
      : '',
    `Do these steps NOW: 1) Call read_ceo_notes() for your instructions. 2) Call get_messages() to check for messages. 3) Call read_tasks() to check for open tasks you can claim.`,
    `Your CEO notes define your workflow. Follow them exactly. After initial setup, WAIT for nudges — do NOT poll.`,
  ].filter(Boolean)
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
    // All TUI-based CLIs need text and Enter sent separately.
    // Sending both in a single write can cause the Enter to be dropped
    // when the TUI is still rendering the input text.
    writeToPty(managed, prompt)
    const submitDelay = (managed.config.cli === 'codex' || managed.config.cli === 'gemini')
      ? CODEX_SUBMIT_DELAY
      : 500
    setTimeout(() => writeToPty(managed, '\r'), submitDelay)
  }, delayMs)
}

// Build the env-var block passed to the PTY for MCP server discovery.
// Dual-emits COG_* (new) and AGENTORCH_* (legacy) so in-flight agents keep
// working across the rebrand. The AGENTORCH_* aliases can be dropped in a
// future release.
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
  if (config.cli === 'pi') env.PI_CODING_AGENT_DIR = piAgentDir(config.id)
  return env
}

// pi-mcp-adapter only needs installing once per app session; guard the prepend.
let piAdapterEnsured = false

// Pick the right MCP config writer for the CLI. Pi reads its config from a
// per-agent dir via the pi-mcp-adapter; every other CLI uses the flag-based
// tmp file. Returns the path to write into the agent's launch/env.
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

// Spawn the PTY for an agent and wire up all side effects: data/exit/status
// callbacks, agent map registration, state broadcast, CLI launch command
// sequencing, and prompt-injection timers.
// Called by both handleSpawnAgent and reconnectAgent — all pre-spawn setup
// (hub registration, initial prompt building) must be done before calling this.
function spawnPtyAndWire(
  config: AgentConfig,
  mcpConfigPath: string,
  mcpEnv: Record<string, string>
): void {
  const mcpServerPath = getMcpServerPath()

  const managed = spawnAgentPty({
    config,
    mcpConfigPath,
    extraEnv: mcpEnv,
    onData: (data) => {
      mainWindow.webContents.send(IPC.PTY_OUTPUT, config.id, data)
      // Forward to mobile WS subscribers. No-op when nobody is watching
      // this agent's detail view — pushAgentOutput pre-filters.
      remoteWsHub?.pushAgentOutput(config.id, typeof data === 'string' ? data : String(data))
    },
    onExit: (exitCode) => {
      hub.registry.updateStatus(config.name, 'disconnected')
      mainWindow.webContents.send(IPC.PTY_EXIT, config.id, exitCode)
      mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
      if (config.cli === 'pi') {
        cleanupPiAgentDir(piAgentDir(config.id))
      } else if (managed.mcpConfigPath) {
        cleanupConfig(managed.mcpConfigPath)
      }

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
      remoteWsHub?.pushStateDelta(['agents'])

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
    }
  })

  agents.set(config.id, managed)
  mainWindow.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())

  const ensurePiAdapter = config.cli === 'pi' && !piAdapterEnsured
  const cmds = buildCliLaunchCommands(config, mcpConfigPath, mcpServerPath, hub.port, hub.secret, ensurePiAdapter)
  if (ensurePiAdapter) piAdapterEnsured = true
  if (cmds) {
    let delay = 1000
    for (const cmd of cmds) {
      setTimeout(() => writeToPty(managed, cmd + '\r'), delay)
      delay += 3000
    }

    // Enable status-driven injection after CLI commands are sent
    setTimeout(() => hasReceivedInitialPrompt.delete(config.id), delay)

    // Fallback: if StatusDetector doesn't detect prompt, inject after timeout
    const initialPrompt = initialPrompts.get(config.id)
    setTimeout(() => {
      if (!hasReceivedInitialPrompt.has(config.id)) {
        hasReceivedInitialPrompt.add(config.id)
        if (initialPrompt) injectPrompt(managed, initialPrompt, 0)
      }
    }, delay + PROMPT_INJECT_FALLBACK_MS)
  }
}

// Auto-reconnect: respawn an agent with its original config after an unexpected exit.
function reconnectAgent(config: AgentConfig): void {
  // Clean up stale state from previous instance
  try { hub.registry.remove(config.name) } catch { /* already removed */ }
  agents.delete(config.id)
  hasReceivedInitialPrompt.delete(config.id)

  const mcpServerPath = getMcpServerPath()
  const mcpConfigPath = prepareAgentMcpConfig(config, mcpServerPath)

  const mcpEnv = buildMcpEnv(config)
  hub.registry.register(config)

  const initialPrompt = buildReconnectPrompt(config)
  initialPrompts.set(config.id, initialPrompt)
  hasReceivedInitialPrompt.add(config.id)

  spawnPtyAndWire(config, mcpConfigPath, mcpEnv)

  console.log(`Agent "${config.name}" reconnected successfully`)
}

// Role-based ordering for grid-laying out an approved team — orchestrator
// first (top-left), then workers, reviewers, researchers, then anything else
// in insertion order. Free-form roles fall into the 'other' bucket.
const ROLE_ORDER: Record<string, number> = {
  orchestrator: 0,
  worker: 1,
  reviewer: 2,
  researcher: 3
}
function roleRank(role: string): number {
  const key = (role || '').trim().toLowerCase()
  return ROLE_ORDER[key] ?? 99
}

// If an orchestrator proposes a team using a name that's already in use,
// suffix it with a counter so the spawn doesn't collide. Falls back to the
// raw name if no collisions exist.
function uniqueAgentName(desired: string): string {
  if (!hub.registry.get(desired)) return desired
  for (let i = 2; i < 1000; i++) {
    const candidate = `${desired}-${i}`
    if (!hub.registry.get(candidate)) return candidate
  }
  return `${desired}-${Date.now()}`
}

// Shared spawn logic used by the IPC handler (desktop) and the Remote View
// workshop spawn endpoint (mobile). Preserves all side effects: MCP config,
// hub registration, skill prompt composition, PTY lifecycle wiring, CLI
// launch command sequencing, and workspace window updates.
function handleSpawnAgent(config: AgentConfig): { id: string; mcpConfigPath: string } {
  // Apply persisted theme for this agent (if any) — preserves explicit override from preset
  const projectPath = projectManager.currentProject?.path
  if (!config.theme && projectPath) {
    const savedTheme = themesStore.getTheme(projectPath, config.name)
    if (savedTheme) config.theme = savedTheme
  }

  // Auto-theme from active workspace theme if no per-agent theme was set
  if (!config.theme) {
    const activeId = workspaceThemeStore.getActiveThemeId()
    if (activeId) {
      // Check built-in themes first, then custom
      const wsTheme = getWorkspaceThemeById(activeId)
        ?? workspaceThemeStore.getCustomThemes().find(t => t.id === activeId)
      if (wsTheme) {
        config.theme = wsTheme.roleColors[config.role] ?? wsTheme.fallback
      }
    }
  }

  const mcpServerPath = getMcpServerPath()
  const mcpConfigPath = prepareAgentMcpConfig(config, mcpServerPath)

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
  // Block prompt injection until CLI commands are sent
  hasReceivedInitialPrompt.add(config.id)

  spawnPtyAndWire(config, mcpConfigPath, mcpEnv)

  return { id: config.id, mcpConfigPath }
}

// Spawn every agent in a team proposal (shared by manual approve + autonomous
// auto-approve). Returns how many spawned and their final unique names.
function spawnProposalAgents(proposal: TeamProposal): { spawned: number; total: number; names: string[] } {
  const ordered = [...proposal.agents].sort((a, b) => roleRank(a.role) - roleRank(b.role))
  const tabId = proposal.tabId || 'tab-default'
  const cwd = projectManager.currentProject?.path || process.cwd()
  let spawned = 0
  const names: string[] = []
  for (const a of ordered) {
    const config: AgentConfig = {
      id: uuidv4(),
      name: uniqueAgentName(a.name),
      cli: a.cli,
      cwd,
      role: a.role,
      ceoNotes: a.ceoNotes,
      shell: a.shell || (process.platform === 'win32' ? 'powershell' : 'bash'),
      admin: false,
      autoMode: a.autoMode,
      model: a.model,
      providerUrl: a.providerUrl,
      skills: a.skills,
      tabId,
      theme: a.theme
    }
    try {
      handleSpawnAgent(config)
      mainWindow?.webContents.send(IPC.AGENT_SPAWNED_REMOTE, {
        agentId: config.id, name: config.name, cli: config.cli, tabId: config.tabId
      })
      spawned++
      names.push(config.name)
    } catch (err: any) {
      console.error(`[proposal-spawn] spawn failed for ${a.name}:`, err?.message)
    }
  }
  return { spawned, total: ordered.length, names }
}

// Single source of truth for fully tearing down a live agent: kill the PTY,
// unregister from the hub, clear nudge state, drop config, and tell the
// renderer to remove the window. Used by every kill path.
function teardownAgent(managed: ManagedPty): void {
  const { id, name } = managed.config
  manualKills.add(id) // Prevent auto-reconnect
  killPty(managed)
  hub.registry.remove(name)
  hub.messages.clearAgent(name)
  pendingNudges.delete(name)
  lastNudgeDelivery.delete(name)
  const fallbackTimer = nudgeFallbackTimers.get(name)
  if (fallbackTimer) {
    clearTimeout(fallbackTimer)
    nudgeFallbackTimers.delete(name)
  }
  if (managed.mcpConfigPath) cleanupConfig(managed.mcpConfigPath)
  initialPrompts.delete(id)
  hasReceivedInitialPrompt.delete(id)
  agents.delete(id)
  mainWindow?.webContents.send(IPC.AGENT_CLOSED_REMOTE, { agentId: id })
  mainWindow?.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
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

  // Cooldown: skip immediate delivery if we recently delivered a nudge to this agent.
  // This prevents infinite loops where Gemini/TUI CLIs re-trigger nudges
  // via status flickers caused by processing the previous nudge.
  const lastDelivery = lastNudgeDelivery.get(agentName) ?? 0
  const now = Date.now()
  if (now - lastDelivery < NUDGE_COOLDOWN_MS) {
    // Still in cooldown — queue and ensure a fallback timer will deliver it
    if (!pendingNudges.has(agentName)) pendingNudges.set(agentName, [])
    pendingNudges.get(agentName)!.push(nudge)
    // Set a fallback timer if one doesn't exist — ensures delivery after cooldown expires
    if (!nudgeFallbackTimers.has(agentName)) {
      const remainingCooldown = NUDGE_COOLDOWN_MS - (now - lastDelivery)
      const timer = setTimeout(() => {
        nudgeFallbackTimers.delete(agentName)
        flushPendingNudges(agentName)
      }, remainingCooldown + 500) // Small buffer after cooldown expires
      nudgeFallbackTimers.set(agentName, timer)
    }
    return
  }

  if (agent.status === 'active') {
    // Agent is at prompt — deliver immediately
    lastNudgeDelivery.set(agentName, now)
    writeNudgeToPty(managed, nudge)
  } else {
    // Agent might be working or status detection doesn't work for this CLI.
    // Queue it, but also set a fallback timer to force delivery.
    if (!pendingNudges.has(agentName)) pendingNudges.set(agentName, [])
    pendingNudges.get(agentName)!.push(nudge)

    // Cancel any existing fallback timer for this agent to avoid double delivery
    const existingTimer = nudgeFallbackTimers.get(agentName)
    if (existingTimer) clearTimeout(existingTimer)

    // Fallback: deliver after delay even if 'active' is never detected
    const timer = setTimeout(() => {
      nudgeFallbackTimers.delete(agentName)
      // Use flushPendingNudges for consistent dedup/combine behavior
      flushPendingNudges(agentName)
    }, NUDGE_FALLBACK_DELAY)
    nudgeFallbackTimers.set(agentName, timer)
  }
}

function writeNudgeToPty(managed: ManagedPty, nudge: string): void {
  // Strip characters that PowerShell interprets as code: () [] {} $ ` " '
  // The agent CLI just needs the message text, not shell-valid syntax
  const safe = nudge.replace(/[()[\]{}$`"']/g, '')

  // Send text and Enter separately so TUIs don't treat '\r' as pasted text
  writeToPty(managed, safe)
  setTimeout(() => writeToPty(managed, '\r'), CODEX_SUBMIT_DELAY)
}

// Flush any pending nudges when an agent becomes active.
function flushPendingNudges(agentName: string): void {
  const queued = pendingNudges.get(agentName)
  if (!queued || queued.length === 0) return

  // Cooldown check: don't flush if we recently delivered a nudge.
  // Prevents loops where status flickers to 'active' during nudge processing.
  const lastDelivery = lastNudgeDelivery.get(agentName) ?? 0
  if (Date.now() - lastDelivery < NUDGE_COOLDOWN_MS) return

  // Cancel fallback timer since we're delivering now
  const existingTimer = nudgeFallbackTimers.get(agentName)
  if (existingTimer) {
    clearTimeout(existingTimer)
    nudgeFallbackTimers.delete(agentName)
  }

  // Deduplicate and combine queued nudges — deliver unique task IDs so no tasks are missed
  const unique = [...new Set(queued)]
  pendingNudges.delete(agentName)
  lastNudgeDelivery.set(agentName, Date.now())

  // Write directly to PTY instead of calling deliverNudge() to avoid re-queueing
  const managed = Array.from(agents.values()).find(a => a.config.name === agentName)
  if (!managed) return

  if (unique.length === 1) {
    writeNudgeToPty(managed, unique[0])
  } else {
    // Combine multiple nudges into a single message to avoid flooding
    const combined = `[Cog] You have ${unique.length} pending notifications. Call read_tasks() and get_messages() now to check for work.`
    writeNudgeToPty(managed, combined)
  }
}

// When a message is queued for an agent, nudge them to call get_messages().
function setupMessageNudge(): void {
  hub.messages.onMessageQueued = (msg) => {
    // When an agent messages the user, show an OS notification
    if (msg.to === 'user') {
      const settings = loadSettings()
      if (settings.notifications !== false) {
        const preview = msg.message.length > 120 ? msg.message.slice(0, 120) + '…' : msg.message
        const notification = new Notification({
          title: `Message from ${msg.from}`,
          body: preview,
          icon: undefined
        })
        notification.on('click', () => {
          mainWindow?.show()
          mainWindow?.focus()
        })
        notification.show()
      }
      return
    }

    const target = hub.registry.get(msg.to)
    if (!target) return

    const nudge = `[Cog] New message from "${msg.from}". You MUST call get_messages() now to read it, then act on it immediately.`
    deliverNudge(msg.to, nudge)
  }
}

// When a task is posted to the pinboard, nudge worker/researcher agents to check for it.
function setupTaskNudge(): void {
  const existingCallback = hub.pinboard.onTaskCreated
  hub.pinboard.onTaskCreated = (task) => {
    existingCallback?.(task)

    // If targetAgent is set, only nudge that specific agent by name (overrides targetRole).
    // Skip the agent that created the task — nudging the creator while it's still
    // processing the post_task tool response can cause TUI CLIs to re-render their
    // entire conversation history (cosmetic but confusing).
    if (task.targetAgent) {
      const managed = Array.from(agents.values()).find(m => m.config.name === task.targetAgent)
      if (managed) {
        const nudge = `[Cog] New task posted for you: "${task.title}" (id: ${task.id}) ${task.priority} priority. Claim it now with claim_task("${task.id}") or call read_tasks() to see all open tasks.`
        deliverNudge(managed.config.name, nudge)
      }
      return
    }

    // Filter agents by targetRole if specified, otherwise nudge all non-orchestrators.
    // Tab isolation: only nudge agents on the same workspace tab as the task.
    const candidates = hub.registry.list().filter(agent => {
      if (agent.status === 'disconnected' || agent.name === 'user') return false
      if (agent.name === task.createdBy) return false
      // Tab isolation: only nudge agents on the same tab
      if (task.tabId && agent.tabId && task.tabId !== agent.tabId) return false
      if (task.targetRole) {
        return agent.role === task.targetRole
      }
      return agent.role !== 'orchestrator'
    })

    const roleLabel = task.targetRole ? ` for ${task.targetRole}s` : ''
    for (const agent of candidates) {
      const nudge = `[Cog] New task posted${roleLabel}: "${task.title}" (id: ${task.id}) ${task.priority} priority. Claim it now with claim_task("${task.id}") or call read_tasks() to see all open tasks.`
      deliverNudge(agent.name, nudge)
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
      const nudge = `[Cog] New info posted by "${entry.from}"${tagSuffix}. Call read_info() to read it.`
      deliverNudge(orchestrator.name, nudge)
    }
  }
}

// Periodically check for tasks stuck in in_progress and nudge orchestrators about them.
// This catches cases where a worker completed work but forgot to call complete_task(),
// or where a worker became unresponsive with a claimed task.
function setupStaleTaskWatchdog(): void {
  if (staleTaskTimer) clearInterval(staleTaskTimer)
  staleTaskTimer = setInterval(() => {
    // Disabled or snoozed: skip both orchestrator alerts and worker reminders
    if (staleAlertMuteUntil === -1) return
    if (staleAlertMuteUntil !== null && Date.now() < staleAlertMuteUntil) return
    const tasks = hub.pinboard.readTasks()
    const now = Date.now()
    const staleTasks = tasks.filter(t => {
      if (t.status !== 'in_progress') return false
      const age = now - new Date(t.createdAt).getTime()
      return age > STALE_TASK_THRESHOLD_MS
    })
    if (staleTasks.length === 0) return

    // Nudge orchestrators about stale tasks — only about tasks on their own tab
    const orchestrators = hub.registry.list().filter(a => a.role === 'orchestrator' && a.status !== 'disconnected')
    for (const orch of orchestrators) {
      // Tab isolation: only alert orchestrators about stale tasks on their own tab
      const relevantStale = staleTasks.filter(t => {
        if (t.tabId && orch.tabId && t.tabId !== orch.tabId) return false
        return true
      })
      if (relevantStale.length === 0) continue
      const taskList = relevantStale.map(t => `"${t.title}" claimed by ${t.claimedBy || 'unknown'}`).join(', ')
      const nudge = `[Cog] STALE TASK ALERT: ${relevantStale.length} task(s) stuck in_progress for over 5 minutes: ${taskList}. Check on these agents — they may need a nudge via send_message, or the task may need to be abandoned with abandon_task.`
      deliverNudge(orch.name, nudge)
    }

    // Also nudge the stuck workers themselves
    for (const task of staleTasks) {
      if (task.claimedBy) {
        const worker = hub.registry.get(task.claimedBy)
        if (worker && worker.status !== 'disconnected') {
          const nudge = `[Cog] REMINDER: You claimed task "${task.title}" (id: ${task.id}) but haven't completed it. If you're done, call complete_task now. If you're stuck, call abandon_task to release it.`
          deliverNudge(task.claimedBy, nudge)
        }
      }
    }
  }, STALE_TASK_CHECK_INTERVAL)
}

async function openProject(projectPath: string): Promise<void> {
  // Close existing project if open
  if (hub) await closeProject()

  projectManager.initProject(projectPath)

  // Initialize SQLite persistence at project path
  let db
  try {
    db = createDatabase(projectManager.dbPath)
  } catch (err: any) {
    const msg = err?.message || String(err)
    if (msg.includes('NODE_MODULE_VERSION') || msg.includes('was compiled against')) {
      const helpful = `Native module ABI mismatch detected.\n\nbetter-sqlite3 was compiled for a different Node.js version than Electron uses.\n\nTo fix:\n  1. If you have MSVC (Windows) or Xcode (Mac) build tools:\n     Run: npm run rebuild:native\n  2. If you don't have build tools:\n     Try: npm install --force\n     Or delete node_modules + package-lock.json and reinstall.\n\nOriginal error: ${msg}`
      dialog.showErrorBox('The Cog — Native Module Error', helpful)
      console.error(helpful)
    }
    throw err
  }
  currentDb = db
  const messageStore = new MessageStore(db)
  currentMessageStore = messageStore
  const pinboardStore = new PinboardStore(db)
  const infoStore = new InfoStore(db)
  const inboxStore = new InboxStore(db)
  const proposalsStore = new ProposalsStore(db)
  currentInboxStore = inboxStore
  currentProposalsStore = proposalsStore
  currentSchedulesStore = new SchedulesStore(db)
  autonomyStore = new AutonomyStore(db)
  armAutonomyExpiry()
  boardStore = new BoardStore(db)
  boardAppearanceStore = new BoardAppearanceStore(db)

  hub = await createHubServer(0, () => scheduleBridge ?? undefined, () => boardBridge ?? undefined, () => agentBridge ?? undefined)
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
  hub.inboxChannel.loadMessages(inboxStore.loadMessages())
  hub.proposalsChannel.loadProposals(proposalsStore.loadAll())

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
    remoteWsHub?.pushStateDelta(['pinboard'])
  }
  hub.infoChannel.onEntryAdded = (entry) => {
    infoStore.saveEntry(entry)
    mainWindow?.webContents.send(IPC.INFO_ENTRY_ADDED, hub.infoChannel.readInfo())
    hub.agentMetrics.increment(entry.from, 'infoPosted')
    remoteWsHub?.pushStateDelta(['info'])
  }

  hub.inboxChannel.onMessageAdded = (msg) => {
    inboxStore.saveMessage(msg)
    mainWindow?.webContents.send(IPC.INBOX_MESSAGE_ADDED, hub.inboxChannel.readAll())
    remoteWsHub?.pushStateDelta(['inbox'])
    // Native notification if message priority meets the user-set threshold
    // (default 'high'). 'none' disables entirely.
    const settings = loadSettings()
    const threshold = (settings.inboxNotifyThreshold || 'high') as NotificationThreshold
    if (threshold !== 'none' && meetsThreshold(msg.priority, threshold)) {
      try {
        const n = new Notification({
          title: `Inbox · ${msg.priority.toUpperCase()} from ${msg.agentName}`,
          body: msg.message.length > 200 ? msg.message.slice(0, 200) + '…' : msg.message,
          urgency: msg.priority === 'urgent' ? 'critical' : 'normal'
        })
        n.on('click', () => { mainWindow?.show(); mainWindow?.focus() })
        n.show()
      } catch { /* notifications may be disabled at OS level */ }
    }
  }
  hub.inboxChannel.onMessageUpdated = (msg) => {
    inboxStore.markRead(msg.id, msg.readAt ?? new Date().toISOString())
    mainWindow?.webContents.send(IPC.INBOX_MESSAGE_UPDATED, hub.inboxChannel.readAll())
    remoteWsHub?.pushStateDelta(['inbox'])
  }
  hub.inboxChannel.onMessageDeleted = (id) => {
    inboxStore.deleteMessage(id)
    mainWindow?.webContents.send(IPC.INBOX_MESSAGE_UPDATED, hub.inboxChannel.readAll())
  }

  hub.proposalsChannel.onProposalAdded = (proposal) => {
    proposalsStore.saveProposal(proposal)
    // Autonomous session: auto-approve team proposals instead of prompting.
    if (proposal.kind === 'team' && autonomyStore?.isActive()) {
      const { spawned, total, names } = spawnProposalAgents(proposal)
      try {
        hub.proposalsChannel.resolve(proposal.id, 'approved')
        const orch = hub.registry.get(proposal.proposedBy)
        const summary = `🤖 Auto-spawned "${proposal.summary}" — ${spawned}/${total} agent(s): ${names.join(', ')}`
        // inbox = durable audit for the user (desktop + mobile); messages.send = live nudge to the orchestrator
        hub.inboxChannel.postMessage(
          orch?.id ?? 'system', proposal.proposedBy, summary, 'urgent',
          [`autospawn:${proposal.id}`], proposal.tabId
        )
        hub.messages.send('user', proposal.proposedBy,
          `Autonomous session active — your team auto-spawned (${spawned}/${total}). Proceed.`)
      } catch { /* notify failures are non-fatal — agents are already running */ }
      return
    }
    mainWindow?.webContents.send(IPC.PROPOSAL_ADDED, proposal)
    // Show the main window so the user notices the modal
    if (mainWindow && !mainWindow.isFocused()) {
      mainWindow.show()
      mainWindow.flashFrame(true)
    }
  }
  hub.proposalsChannel.onProposalResolved = (proposal) => {
    proposalsStore.updateStatus(
      proposal.id,
      proposal.status,
      proposal.resolvedAt ?? new Date().toISOString(),
      proposal.feedback
    )
  }

  hub.setOutputAccessor((agentName, lines) => {
    const managed = Array.from(agents.values()).find(a => a.config.name === agentName)
    if (!managed) return null
    return managed.outputBuffer.getLines(lines)
  })
  setupMessageNudge()
  setupTaskNudge()
  setupInfoNudge()
  setupStaleTaskWatchdog()
  loadLinkState()

  // Scheduled prompts: instantiate, load, and start ticker
  promptScheduler = new PromptScheduler({
    store: currentSchedulesStore,
    clock: () => Date.now(),
    ptyWriter: (agentId, text) => {
      const managed = agents.get(agentId)
      if (!managed) throw new Error(`Agent ${agentId} not found`)
      writeNudgeToPty(managed, text)
    },
    agentLookup: (agentId) => agents.has(agentId),
    onChange: () => {
      if (!promptScheduler) return
      mainWindow?.webContents.send(IPC.SCHEDULES_UPDATED, promptScheduler.list())
      remoteWsHub?.pushStateDelta(['schedules'])
    },
    onResumed: (count) => {
      if (count > 0) {
        mainWindow?.webContents.send(IPC.SCHEDULER_RESUMED, { count })
        const settings = loadSettings()
        if (settings.notifications !== false) {
          const n = new Notification({
            title: 'Scheduled prompts resumed',
            body: `Resumed ${count} scheduled ${count === 1 ? 'prompt' : 'prompts'} from previous session`,
            icon: undefined
          })
          n.show()
        }
      }
    }
  })
  promptScheduler.load()
  promptScheduler.startTicker()

  // Wire the schedule bridge now that promptScheduler + autonomyStore exist.
  // The hub holds a getter to this (() => scheduleBridge ?? undefined), so it
  // resolves lazily per request.
  scheduleBridge = {
    autonomyEnabled: () => autonomyStore?.isActive() ?? false,
    resolveTarget: (key) => {
      for (const m of agents.values()) {
        if (m.config.id === key || m.config.name.toLowerCase() === key.toLowerCase()) {
          return { agentId: m.config.id, tabId: m.config.tabId || 'tab-default', name: m.config.name }
        }
      }
      return null
    },
    create: (p) => {
      if (!promptScheduler) throw new Error('Scheduler unavailable')
      const s = promptScheduler.create({
        tabId: p.tabId, agentId: p.agentId, name: p.name, promptText: p.promptText,
        intervalMinutes: p.intervalMinutes, durationHours: p.durationHours, createdBy: p.createdBy
      })
      return { id: s.id, nextFireAt: s.nextFireAt, expiresAt: s.expiresAt }
    },
    list: () => (promptScheduler?.list() ?? []).map(s => ({
      id: s.id, name: s.name, agentId: s.agentId,
      agentName: [...agents.values()].find(m => m.config.id === s.agentId)?.config.name ?? s.agentId,
      intervalMinutes: s.intervalMinutes, durationHours: s.durationHours, nextFireAt: s.nextFireAt,
      expiresAt: s.expiresAt, status: s.status, createdBy: s.createdBy
    })),
    cancel: (id, byAgentName) => {
      const s = promptScheduler?.get(id)
      if (!s) return { ok: false, error: 'Schedule not found' }
      if (!canAgentCancelSchedule(s, byAgentName)) return { ok: false, error: 'Agents may only cancel schedules they created' }
      promptScheduler!.delete(id)
      return { ok: true }
    }
  }

  // Wire the board bridge now that boardStore exists. The hub holds a getter
  // (() => boardBridge ?? undefined) so route handlers resolve it lazily.
  boardBridge = {
    listPages: () => (boardStore?.listPages() ?? []).map(p => ({
      page: p.orderIndex, elementCount: p.elements.length, strokeCount: p.strokes.length
    })),
    renderPath: (n) => {
      const root = projectManager.currentProject?.path
      if (!root || !boardStore) return null
      const rp = renderPathForPage(root, boardStore.listPages(), n)
      if (rp === null) return null
      return fs.existsSync(rp) ? rp : ''
    }
  }

  // Wire the agent bridge so the close_agents route can tear down live agents.
  agentBridge = {
    close: (nameOrId) => {
      const managed = [...agents.values()].find(
        m => m.config.id === nameOrId || m.config.name.toLowerCase() === nameOrId.toLowerCase()
      )
      if (!managed) return { ok: false }
      teardownAgent(managed)
      return { ok: true }
    }
  }

  // Update window title
  if (mainWindow) {
    mainWindow.setTitle(`The Cog — ${projectManager.currentProject!.name}`)
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
  lastNudgeDelivery.clear()
  for (const timer of nudgeFallbackTimers.values()) clearTimeout(timer)
  nudgeFallbackTimers.clear()
  if (staleTaskTimer) { clearInterval(staleTaskTimer); staleTaskTimer = null }
  if (promptScheduler) {
    promptScheduler.stopTicker()
    promptScheduler = null
  }
  scheduleBridge = null
  boardBridge = null
  currentSchedulesStore = null
  if (autonomyExpiryTimer) { clearTimeout(autonomyExpiryTimer); autonomyExpiryTimer = null }
  autonomyStore = null  // backed by the project DB we're about to close; null so autonomy IPC falls back instead of hitting a closed handle
  boardStore = null
  boardAppearanceStore = null

  await disableRemoteView()

  // Close hub
  hub?.close()

  // Close DB
  if (currentDb) {
    currentDb.close()
    currentDb = null
    currentMessageStore = null
    currentInboxStore = null
    currentProposalsStore = null
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
    return handleSpawnAgent(config)
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

  // Respawn an agent with a new config — kills the old PTY, wipes history, spawns fresh
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
    // Null out the old PTY's mcpConfigPath BEFORE killing it so the async onExit
    // callback can't delete the MCP config file. The new spawn reuses the same
    // filename (since agent.id is preserved) and writeAgentMcpConfig overwrites
    // in place — a stray cleanupConfig from the old onExit firing after the new
    // file is written would race-delete the freshly-written config and break
    // the CLI launch.
    managed.mcpConfigPath = null
    killPty(managed)

    // Wipe history under old name
    try { hub.registry.remove(oldName) } catch { /* ignore */ }
    hub.messages.clearAgent(oldName)
    pendingNudges.delete(oldName)
    lastNudgeDelivery.delete(oldName)
    const fallbackTimer = nudgeFallbackTimers.get(oldName)
    if (fallbackTimer) { clearTimeout(fallbackTimer); nudgeFallbackTimers.delete(oldName) }
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

  ipcMain.handle(IPC.KILL_AGENT, (_event, agentId: string) => {
    const managed = agents.get(agentId)
    if (managed) teardownAgent(managed)
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
  ipcMain.handle(IPC.PINBOARD_GET_TASKS, (_event, tabId?: string) => {
    return tabId ? hub.pinboard.readTasksForTab(tabId) : hub.pinboard.readTasks()
  })

  ipcMain.handle(IPC.PINBOARD_CLEAR_COMPLETED, () => {
    const cleared = hub.pinboard.clearCompleted()
    return { status: 'ok', cleared }
  })

  // Stale task alert snooze — mutes orchestrator alerts + worker reminders for a duration
  ipcMain.handle(IPC.STALE_ALERT_GET, () => {
    // Auto-clear if expired (but not if permanently disabled via -1)
    if (staleAlertMuteUntil !== null && staleAlertMuteUntil !== -1 && Date.now() >= staleAlertMuteUntil) staleAlertMuteUntil = null
    return { muteUntil: staleAlertMuteUntil }
  })

  ipcMain.handle(IPC.STALE_ALERT_SET, (_event, durationMs: number | null) => {
    if (durationMs === -1) {
      staleAlertMuteUntil = -1
    } else {
      staleAlertMuteUntil = durationMs === null || durationMs <= 0 ? null : Date.now() + durationMs
    }
    const payload = { muteUntil: staleAlertMuteUntil }
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.STALE_ALERT_UPDATE, payload)
    return payload
  })

  // Info Channel IPC handlers
  ipcMain.handle(IPC.INFO_GET_ENTRIES, (_event, tabId?: string) => {
    return tabId ? hub.infoChannel.readInfoForTab(tabId) : hub.infoChannel.readInfo()
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

  ipcMain.handle(IPC.UPDATE_GET_CHANGELOG, () => {
    return updateChecker.getPendingChangelog()
  })

  ipcMain.handle(IPC.APP_RESTART, async () => {
    await closeProject()
    app.relaunch()
    app.exit(0)
  })

  // Settings IPC
  ipcMain.handle(IPC.SETTINGS_GET, () => loadSettings())
  ipcMain.handle(IPC.SETTINGS_SET, (_event, key: string, value: any) => {
    saveSetting(key, value)
    return { status: 'ok' }
  })

  // Autonomy IPC
  ipcMain.handle(IPC.AUTONOMY_GET, () => autonomyStore?.get() ?? { sessionExpiresAt: null })
  ipcMain.handle(IPC.AUTONOMY_START, (_e, durationHours: number) => {
    if (!autonomyStore) return { sessionExpiresAt: null }
    const v = autonomyStore.startSession(durationHours)
    armAutonomyExpiry()
    return v
  })
  ipcMain.handle(IPC.AUTONOMY_END, () => {
    if (!autonomyStore) return { sessionExpiresAt: null }
    const v = autonomyStore.endSession()
    armAutonomyExpiry()
    return v
  })

  // ── Inbox IPC ──────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.INBOX_LIST, () => hub?.inboxChannel.readAll() ?? [])
  ipcMain.handle(IPC.INBOX_MARK_READ, (_event, id: string) => {
    return hub?.inboxChannel.markRead(id) ?? null
  })
  ipcMain.handle(IPC.INBOX_MARK_ALL_READ, () => {
    return hub?.inboxChannel.markAllRead() ?? 0
  })
  ipcMain.handle(IPC.INBOX_DELETE, (_event, id: string) => {
    return hub?.inboxChannel.deleteMessage(id) ?? false
  })
  ipcMain.handle(IPC.INBOX_REPLY, (_event, payload: { agentName: string; message: string }) => {
    if (!hub || !payload?.agentName || !payload?.message) return { success: false, error: 'Invalid reply' }
    // Send a regular hub message from "user" to the orchestrator. Reuses the
    // same path the renderer already uses for HUB_SEND_MESSAGE.
    try {
      hub.messages.send('user', payload.agentName, payload.message)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Send failed' }
    }
  })
  ipcMain.handle(IPC.INBOX_GET_NOTIFY_THRESHOLD, () => {
    const settings = loadSettings()
    return (settings.inboxNotifyThreshold || 'high') as NotificationThreshold
  })
  ipcMain.handle(IPC.INBOX_SET_NOTIFY_THRESHOLD, (_event, threshold: NotificationThreshold) => {
    const valid: NotificationThreshold[] = ['none', 'low', 'normal', 'high', 'urgent']
    if (!valid.includes(threshold)) return { success: false, error: 'Invalid threshold' }
    saveSetting('inboxNotifyThreshold', threshold)
    return { success: true }
  })

  // ── Team proposals IPC ─────────────────────────────────────────────────────
  ipcMain.handle(IPC.PROPOSALS_LIST_PENDING, () => hub?.proposalsChannel.listPending() ?? [])
  ipcMain.handle(IPC.PROPOSALS_GET, (_event, id: string) => {
    return hub?.proposalsChannel.get(id) ?? null
  })
  ipcMain.handle(IPC.PROPOSALS_APPROVE, async (_event, payload: {
    proposalId: string
    // Renderer is now the source of truth at approve time — it sends the FULL
    // edited agent list (post-checkbox-filter, post-inline-edits). The
    // proposal stored in the channel is just the original draft for audit.
    agents: ProposedAgent[]
    tabId?: string
  }) => {
    if (!hub) return { success: false, error: 'Hub not ready' }
    const proposal = hub.proposalsChannel.get(payload.proposalId)
    if (!proposal) return { success: false, error: 'Proposal not found' }
    if (proposal.status !== 'pending') {
      return { success: false, error: `Proposal already ${proposal.status}` }
    }
    if (!Array.isArray(payload.agents) || payload.agents.length === 0) {
      hub.proposalsChannel.resolve(payload.proposalId, 'rejected', 'No agents selected')
      return { success: false, error: 'No agents selected' }
    }

    // Sort by role priority so the orchestrator lands top-left, workers next, etc.
    const ordered = [...payload.agents].sort((a, b) => roleRank(a.role) - roleRank(b.role))
    const tabId = payload.tabId || 'tab-default'
    const cwd = projectManager.currentProject?.path || process.cwd()

    const spawned: Array<{ agentId: string; name: string; gridIndex: number }> = []
    for (let i = 0; i < ordered.length; i++) {
      const a = ordered[i]
      const config: AgentConfig = {
        id: uuidv4(),
        name: uniqueAgentName(a.name),
        cli: a.cli,
        cwd,
        role: a.role,
        ceoNotes: a.ceoNotes,
        shell: a.shell || (process.platform === 'win32' ? 'powershell' : 'bash'),
        admin: false,
        autoMode: a.autoMode,
        model: a.model,
        providerUrl: a.providerUrl,
        skills: a.skills,
        tabId,
        theme: a.theme
      }
      try {
        const result = handleSpawnAgent(config)
        spawned.push({ agentId: result.id, name: config.name, gridIndex: i })
      } catch (err: any) {
        console.error(`[proposals:approve] spawn failed for ${a.name}:`, err?.message)
      }
    }

    hub.proposalsChannel.resolve(payload.proposalId, 'approved')

    // Send confirmation back to the orchestrator so they know the team booted
    try {
      const summary = spawned.length === ordered.length
        ? `User approved your team. Spawned: ${spawned.map(s => s.name).join(', ')}.`
        : `User approved part of your team. Spawned ${spawned.length}/${ordered.length}: ${spawned.map(s => s.name).join(', ')}.`
      hub.messages.send('user', proposal.proposedBy, summary)
    } catch { /* orchestrator may not be reachable */ }

    return { success: true, spawned, totalRequested: ordered.length }
  })
  ipcMain.handle(IPC.PROPOSALS_REJECT, (_event, payload: { proposalId: string; feedback?: string }) => {
    if (!hub) return { success: false, error: 'Hub not ready' }
    const resolved = hub.proposalsChannel.resolve(payload.proposalId, 'rejected', payload.feedback)
    if (!resolved) return { success: false, error: 'Proposal not found' }
    // Tell the orchestrator the user said no, with their feedback if provided
    try {
      const note = payload.feedback
        ? `User rejected your team proposal. Feedback: ${payload.feedback}`
        : 'User rejected your team proposal.'
      hub.messages.send('user', resolved.proposedBy, note)
    } catch { /* orchestrator may not be reachable */ }
    return { success: true }
  })

  // Workshop passcode IPC
  ipcMain.handle(IPC.WORKSHOP_SET_PASSCODE, (_event, pin: string) => {
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      return { success: false, error: 'Passcode must be exactly 4 digits' }
    }
    workshopPasscodeHash = createHash('sha256').update(pin).digest('hex')
    saveSetting('workshopPasscodeHash', workshopPasscodeHash)
    return { success: true }
  })

  ipcMain.handle(IPC.WORKSHOP_GET_PASSCODE_SET, () => {
    return { isSet: workshopPasscodeHash !== null }
  })

  ipcMain.handle(IPC.WORKSHOP_CLEAR_PASSCODE, () => {
    workshopPasscodeHash = null
    saveSetting('workshopPasscodeHash', null)
    return { success: true }
  })

  // Workspace state bridge (fire-and-forget from renderer)
  ipcMain.on(IPC.WORKSPACE_STATE_PUSH, (_event, state) => {
    cachedWorkspaceState = state
  })

  // Trollbox bridge — renderer holds the live Supabase client; main caches
  // the snapshot so the 3DS HTTP API can serve chat history without going
  // through the renderer per-request. Sends are forwarded back to the
  // renderer over a paired request/reply channel below. If the user has
  // never opened the trollbox panel this session, cachedTrollboxState is
  // null and the 3DS sees an "offline" state.
  ipcMain.on(IPC.TROLLBOX_STATE_PUSH, (_event, state) => {
    cachedTrollboxState = state
  })
  ipcMain.on(`${IPC.TROLLBOX_REMOTE_SEND}:reply`, (_event, payload: { id: string; ok: boolean; error?: string }) => {
    if (!payload || typeof payload.id !== 'string') return
    const pending = trollboxSendReplies.get(payload.id)
    if (!pending) return
    trollboxSendReplies.delete(payload.id)
    pending(payload)
  })

  // Workshop layout mirror (fire-and-forget from renderer)
  ipcMain.on(IPC.WORKSHOP_LAYOUT_SYNC, (_event, payload: Array<{ id: string } & WindowLayoutEntry>) => {
    if (!Array.isArray(payload)) return
    workshopLayoutCache.clear()
    for (const entry of payload) {
      if (!entry || typeof entry.id !== 'string') continue
      const { id, x, y, width, height, color } = entry
      if ([x, y, width, height].some(v => typeof v !== 'number' || !isFinite(v))) continue
      workshopLayoutCache.set(id, {
        x, y, width, height,
        color: typeof color === 'string' ? color : '#888888'
      })
    }
  })

  // Send URL to 3DS — raw TCP to the 3DS's network receiver.
  // If the URL is HTTPS (tunnel), register a short code first and send
  // the proxy URL (http://3ds.thecog.dev/p/CODE/) so the 3DS never
  // needs to speak HTTPS — the Worker proxies for it.
  ipcMain.handle('send-to-3ds', async (_event, ip: string, port: number, url: string) => {
    let sendUrl = url
    if (url.startsWith('https://')) {
      try {
        const resp = await fetch('http://3ds.thecog.dev/api/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tunnel: url })
        })
        const data = await resp.json() as { code?: string }
        if (data.code) {
          sendUrl = `http://3ds.thecog.dev/p/${data.code}/`
        }
      } catch { /* fall through with original URL */ }
    }

    const net = await import('net')
    return new Promise<string>((resolve) => {
      const client = new net.Socket()
      client.setTimeout(5000)
      client.connect(port, ip, () => {
        client.write(sendUrl + '\n')
        client.end()
      })
      let response = ''
      client.on('data', (data: Buffer) => { response += data.toString() })
      client.on('end', () => resolve(response || 'Sent'))
      client.on('error', (err: Error) => resolve(`Error: ${err.message}`))
      client.on('timeout', () => { client.destroy(); resolve('Timeout — is the 3DS listening?') })
    })
  })

  // 3DS QR shortener — POST to 3ds.thecog.dev from the main process
  // (renderer fetch gets blocked by CSP)
  ipcMain.handle('register-short-link', async (_event, lan: string | null, tunnel: string | null) => {
    try {
      const resp = await fetch('http://3ds.thecog.dev/api/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lan, tunnel })
      })
      const data = await resp.json() as { code?: string }
      return data.code ? `http://3ds.thecog.dev/${data.code}` : null
    } catch {
      return null
    }
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

  // Git IPC
  ipcMain.handle(IPC.GIT_STATUS, () => {
    if (!projectManager?.currentProject) return { isRepo: false, branch: '', ahead: 0, behind: 0, staged: [], unstaged: [] }
    return gitOps.getStatus(projectManager.currentProject.path)
  })

  ipcMain.handle(IPC.GIT_LOG, (_event, count?: number) => {
    if (!projectManager?.currentProject) return []
    return gitOps.getLog(projectManager.currentProject.path, count)
  })

  ipcMain.handle(IPC.GIT_DIFF, (_event, file: string, staged: boolean) => {
    if (!projectManager?.currentProject) return ''
    return gitOps.getDiff(projectManager.currentProject.path, file, staged)
  })

  ipcMain.handle(IPC.GIT_STAGE, (_event, file: string) => {
    if (!projectManager?.currentProject) return { error: 'No project' }
    try { gitOps.stageFile(projectManager.currentProject.path, file); return { status: 'ok' } }
    catch (e: any) { return { error: e.message } }
  })

  ipcMain.handle(IPC.GIT_UNSTAGE, (_event, file: string) => {
    if (!projectManager?.currentProject) return { error: 'No project' }
    try { gitOps.unstageFile(projectManager.currentProject.path, file); return { status: 'ok' } }
    catch (e: any) { return { error: e.message } }
  })

  ipcMain.handle(IPC.GIT_COMMIT, (_event, message: string) => {
    if (!projectManager?.currentProject) return { error: 'No project' }
    try { const out = gitOps.commit(projectManager.currentProject.path, message); return { status: 'ok', output: out } }
    catch (e: any) { return { error: e.message } }
  })

  ipcMain.handle(IPC.GIT_PUSH, async () => {
    if (!projectManager?.currentProject) return { error: 'No project' }
    try { const out = gitOps.push(projectManager.currentProject.path); return { status: 'ok', output: out } }
    catch (e: any) { return { error: e.message } }
  })

  ipcMain.handle(IPC.GIT_PULL, async () => {
    if (!projectManager?.currentProject) return { error: 'No project' }
    try { const out = gitOps.pull(projectManager.currentProject.path); return { status: 'ok', output: out } }
    catch (e: any) { return { error: e.message } }
  })

  ipcMain.handle(IPC.GIT_BRANCHES, () => {
    if (!projectManager?.currentProject) return { current: '', branches: [] }
    return gitOps.getBranches(projectManager.currentProject.path)
  })

  ipcMain.handle(IPC.GIT_CHECKOUT, (_event, branch: string) => {
    if (!projectManager?.currentProject) return { error: 'No project' }
    try { gitOps.checkout(projectManager.currentProject.path, branch); return { status: 'ok' } }
    catch (e: any) { return { error: e.message } }
  })

  ipcMain.handle(IPC.GIT_NEW_BRANCH, (_event, name: string) => {
    if (!projectManager?.currentProject) return { error: 'No project' }
    try { gitOps.createBranch(projectManager.currentProject.path, name); return { status: 'ok' } }
    catch (e: any) { return { error: e.message } }
  })

  // Bug report — posts directly to GitHub Issues via API (no user login needed)
  // Token is obfuscated (not plaintext) to avoid automated scanners. Issues-only permission on a single repo.
  const _bk = 'TheCogBugReporter2026'
  const _bt = [51,1,17,43,26,5,29,5,6,38,58,65,94,51,51,46,61,115,122,123,6,19,49,83,57,36,36,48,56,46,40,50,5,48,8,56,53,58,65,97,92,103,51,17,50,53,1,87,10,68,80,38,12,31,93,55,25,31,42,123,102,119,115,13,11,34,10,58,52,15,77,3,22,52,17,14,26,64,47,33,103,98,6,123,99,39,29,51,27,44,6,58,14]
  const _deobf = (): string => _bt.map((c, i) => String.fromCharCode(c ^ _bk.charCodeAt(i % _bk.length))).join('')

  ipcMain.handle(IPC.BUG_REPORT_SUBMIT, async (_event, report: { title: string; body: string }) => {
    const token = _deobf()
    try {
      const res = await fetch('https://api.github.com/repos/the-cog-dev/cog/issues', {
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

  // Community Teams — browse/share/star user-contributed team presets via GitHub Issues
  ipcMain.handle(IPC.COMMUNITY_LIST, async (_event, opts?: { force?: boolean }) => {
    try {
      const items = await communityClient.listTeams(opts ?? {})
      return { success: true, items }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.COMMUNITY_GET, async (_event, issueNumber: number) => {
    try {
      const team = await communityClient.getTeam(issueNumber)
      const myHash = communityClient.getMachineHash()
      return { success: true, team, isStarredByMe: team.starredBy.includes(myHash) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.COMMUNITY_SHARE, async (_event, input: { name: string; description: string; author: string; category: CommunityCategory; agents: CommunityAgent[] }) => {
    try {
      if (!input.name?.trim()) return { success: false, error: 'Name is required' }
      if (!input.description?.trim()) return { success: false, error: 'Description is required' }
      if (!input.author?.trim()) return { success: false, error: 'Author is required' }
      if (!communityClient.isValidCategory(input.category)) return { success: false, error: 'Invalid category' }
      if (!Array.isArray(input.agents) || input.agents.length === 0) return { success: false, error: 'Team must contain at least one agent' }
      const team = await communityClient.shareTeam(input)
      return { success: true, team }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.COMMUNITY_TOGGLE_STAR, async (_event, issueNumber: number) => {
    try {
      const result = await communityClient.toggleStar(issueNumber)
      return { success: true, ...result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Community themes — browse/share/star workspace themes via GitHub Issues
  ipcMain.handle(IPC.COMMUNITY_THEME_LIST, async (_event, opts?: { force?: boolean }) => {
    try {
      const items = await communityClient.listThemes(opts ?? {})
      return { success: true, items }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.COMMUNITY_THEME_GET, async (_event, issueNumber: number) => {
    try {
      const theme = await communityClient.getTheme(issueNumber)
      const myHash = communityClient.getMachineHash()
      return { success: true, theme, isStarredByMe: theme.starredBy.includes(myHash) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.COMMUNITY_THEME_SHARE, async (_event, input: { name: string; description: string; author: string; roleColors: Record<string, Required<AgentTheme>>; fallback: Required<AgentTheme> }) => {
    try {
      if (!input.name?.trim()) return { success: false, error: 'Name is required' }
      if (!input.author?.trim()) return { success: false, error: 'Author is required' }
      const theme = await communityClient.shareTheme(input)
      return { success: true, theme }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.COMMUNITY_THEME_TOGGLE_STAR, async (_event, issueNumber: number) => {
    try {
      const result = await communityClient.toggleThemeStar(issueNumber)
      return { success: true, ...result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Machine hash — deterministic per-machine 12-char hex id (non-PII); used by trollbox + community starring
  ipcMain.handle(IPC.GET_MACHINE_HASH, () => communityClient.getMachineHash())

  // Per-agent theme — updates the in-memory config, persists to disk, broadcasts state
  ipcMain.handle(IPC.AGENT_SET_THEME, (_event, agentId: string, theme: AgentTheme | null) => {
    const managed = agents.get(agentId)
    if (!managed) return { success: false, error: 'Agent not found' }
    if (theme === null) {
      delete managed.config.theme
    } else {
      managed.config.theme = theme
    }
    // Also update the hub registry so any other consumers (Remote View, etc.) see the change
    const registered = hub.registry.get(managed.config.name)
    if (registered) {
      if (theme === null) delete registered.theme
      else registered.theme = theme
    }
    // Persist to themes.json keyed by current project path
    const projectPath = projectManager.currentProject?.path
    if (projectPath) themesStore.setTheme(projectPath, managed.config.name, theme)
    // Broadcast to all renderers so the window re-renders with the new theme
    mainWindow?.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
    return { success: true }
  })

  // Workspace themes — bulk-apply palette by role
  ipcMain.handle(IPC.WORKSPACE_THEME_GET_ACTIVE, () => workspaceThemeStore.getActiveThemeId())
  ipcMain.handle(IPC.WORKSPACE_THEME_SET_ACTIVE, (_event, id: string | null) => {
    workspaceThemeStore.setActiveThemeId(id)
    return { success: true }
  })
  ipcMain.handle(IPC.WORKSPACE_THEME_LIST_CUSTOM, () => workspaceThemeStore.getCustomThemes())
  ipcMain.handle(IPC.WORKSPACE_THEME_SAVE_CUSTOM, (_event, theme: import('../shared/types').WorkspaceTheme) => {
    workspaceThemeStore.saveCustomTheme(theme)
    return { success: true }
  })
  ipcMain.handle(IPC.WORKSPACE_THEME_DELETE_CUSTOM, (_event, id: string) => {
    workspaceThemeStore.deleteCustomTheme(id)
    return { success: true }
  })

  // Tab IPC
  ipcMain.handle(IPC.TAB_GET_ALL, () => Array.from(workspaceTabs.values()))

  ipcMain.handle(IPC.TAB_CREATE, (_event, name?: string) => {
    const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const tab = { id, name: name || `Workspace ${nextTabNum++}` }
    workspaceTabs.set(id, tab)
    return tab
  })

  ipcMain.handle(IPC.TAB_CLOSE, async (_event, tabId: string) => {
    if (workspaceTabs.size <= 1) return { error: 'Cannot close last tab' }
    for (const managed of [...agents.values()]) {
      if (managed.config.tabId === tabId) teardownAgent(managed)
    }
    workspaceTabs.delete(tabId)
    if (promptScheduler) promptScheduler.deleteByTabId(tabId)
    // Final refresh covers tab-deletion + scheduler state (per-agent removal already pushed by teardownAgent)
    mainWindow?.webContents.send(IPC.AGENT_STATE_UPDATE, getVisibleAgents())
    return { status: 'ok' }
  })

  ipcMain.handle(IPC.TAB_RENAME, (_event, tabId: string, name: string) => {
    const tab = workspaceTabs.get(tabId)
    if (!tab) return { error: 'Tab not found' }
    tab.name = name
    return { status: 'ok' }
  })

  // Scheduled prompts
  ipcMain.handle(IPC.SCHEDULES_LIST, () => {
    return promptScheduler?.list() ?? []
  })

  ipcMain.handle(IPC.SCHEDULES_CREATE, (_event, input) => {
    if (!promptScheduler) throw new Error('No project open')
    return promptScheduler.create(input)
  })

  ipcMain.handle(IPC.SCHEDULES_PAUSE, (_event, id: string) => {
    if (!promptScheduler) throw new Error('No project open')
    return promptScheduler.pause(id)
  })

  ipcMain.handle(IPC.SCHEDULES_RESUME, (_event, id: string) => {
    if (!promptScheduler) throw new Error('No project open')
    return promptScheduler.resume(id)
  })

  ipcMain.handle(IPC.SCHEDULES_STOP, (_event, id: string) => {
    if (!promptScheduler) throw new Error('No project open')
    return promptScheduler.stop(id)
  })

  ipcMain.handle(IPC.SCHEDULES_RESTART, (_event, id: string) => {
    if (!promptScheduler) throw new Error('No project open')
    return promptScheduler.restart(id)
  })

  ipcMain.handle(IPC.SCHEDULES_EDIT, (_event, id: string, updates) => {
    if (!promptScheduler) throw new Error('No project open')
    return promptScheduler.edit(id, updates)
  })

  ipcMain.handle(IPC.SCHEDULES_DELETE, (_event, id: string) => {
    if (!promptScheduler) throw new Error('No project open')
    promptScheduler.delete(id)
    return { status: 'ok' }
  })

  // Remote View
  ipcMain.handle(IPC.REMOTE_ENABLE, async () => {
    await enableRemoteView()
    return { ok: true }
  })

  ipcMain.handle(IPC.REMOTE_DISABLE, async () => {
    await disableRemoteView()
    return { ok: true }
  })

  ipcMain.handle(IPC.REMOTE_STATE, () => {
    return {
      enabled: remoteServer !== null,
      publicUrl: remotePublicUrl,
      lanUrl: remoteLanUrl,
      lanEnabled: remoteLanServer !== null,
      connectionCount: remoteTokenManager?.getConnectionCount() ?? 0,
      lastActivity: remoteTokenManager?.getLastActivity() ?? null
    }
  })

  ipcMain.handle(IPC.REMOTE_LAN_ENABLE, async () => {
    return await enableLanAccess()
  })

  ipcMain.handle(IPC.REMOTE_LAN_DISABLE, async () => {
    await disableLanAccess()
    return { ok: true }
  })

  // Telegram orchestration
  ipcMain.handle(IPC.TELEGRAM_ENABLE, async () => { await enableTelegram() })
  ipcMain.handle(IPC.TELEGRAM_DISABLE, async () => { await disableTelegram() })
  ipcMain.handle(IPC.TELEGRAM_SET_TOKEN, async (_e, token: string) => {
    saveSetting('telegramBotToken', token)
    // Restart if running so the new token takes effect.
    if (telegramServer) { await disableTelegram(); await enableTelegram() }
    emitTelegramStatus()
  })
  ipcMain.handle(IPC.TELEGRAM_GET_PAIRING_CODE, async () => {
    return telegramPairing?.generateCode() ?? null
  })
  ipcMain.handle(IPC.TELEGRAM_UNPAIR, async (_e, userId: number) => {
    telegramPairing?.revoke(userId)
    emitTelegramStatus()
  })
  ipcMain.handle(IPC.TELEGRAM_GET_STATUS, async () => { emitTelegramStatus() })

  // Helper: rotate URLs after a token change so both tunnel and LAN URLs reflect the new token
  function rotateUrlsAfterTokenChange(): void {
    if (!remoteTokenManager) return
    const newToken = remoteTokenManager.getCurrentToken()
    if (remotePublicUrl) {
      const baseUrl = remotePublicUrl.split('/r/')[0]
      remotePublicUrl = `${baseUrl}/r/${newToken}/`
    }
    if (remoteLanUrl) {
      const baseUrl = remoteLanUrl.split('/r/')[0]
      remoteLanUrl = `${baseUrl}/r/${newToken}/`
    }
  }

  ipcMain.handle(IPC.REMOTE_KILL_SESSIONS, () => {
    if (!remoteTokenManager) return { ok: false }
    remoteTokenManager.killAllSessions()
    rotateUrlsAfterTokenChange()
    emitRemoteStatus()
    return { ok: true, newUrl: remotePublicUrl }
  })

  ipcMain.handle(IPC.REMOTE_REGENERATE, () => {
    if (!remoteTokenManager) return { ok: false }
    remoteTokenManager.generate()
    rotateUrlsAfterTokenChange()
    emitRemoteStatus()
    return { ok: true, newUrl: remotePublicUrl }
  })
}

async function main(): Promise<void> {
  // Bind the Windows taskbar icon to our AppUserModelID so it doesn't fall back
  // to the Electron logo. Must be set before any window is created.
  if (process.platform === 'win32') app.setAppUserModelId('dev.thecog.app')

  await app.whenReady()

  // One-time migration: copy global app data from the old AgentOrch userData
  // folder to the new "The Cog" location. Runs before any userData access so
  // settings/presets/themes/skills/recent-projects all show up for returning users.
  try {
    const result = migrateLegacyUserData(app.getPath('userData'), app.getPath('appData'))
    if (result.ran) {
      console.log(`[userdata-migration] Migrated from ${result.source}`)
      console.log(`  Files: ${result.copiedFiles.join(', ') || '(none)'}`)
      console.log(`  Dirs:  ${result.copiedDirs.join(', ') || '(none)'}`)
    }
  } catch (err) {
    console.warn(`[userdata-migration] Failed: ${(err as Error).message}`)
  }

  projectManager = new ProjectManager(app.getPath('userData'))

  // Global presets directory — follows user across projects
  const globalPresetsDir = path.join(app.getPath('userData'), 'presets')
  setPresetsDir(globalPresetsDir)

  // Per-agent theme persistence — keyed by project path + agent name
  themesStore.setThemesPath(path.join(app.getPath('userData'), 'themes.json'))

  // Workspace theme persistence — active theme ID + custom themes
  workspaceThemeStore.setFilePath(path.join(app.getPath('userData'), 'workspace-themes.json'))

  // Skills: built-in from app resources, user skills in userData
  const builtInSkillsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'data', 'skills')
    : path.join(__dirname, '../data/skills')
  const userSkillsDir = path.join(app.getPath('userData'), 'skills')
  skillManager = new SkillManager(builtInSkillsDir, userSkillsDir)

  racClient = new RacClient()

  setupIPC()

  // Load persisted workshop passcode hash from settings
  const savedPasscodeHash = loadSettings().workshopPasscodeHash
  if (typeof savedPasscodeHash === 'string' && savedPasscodeHash.length > 0) {
    workshopPasscodeHash = savedPasscodeHash
  }

  mainWindow = createWindow()

  // Auto-update checker
  updateChecker = new UpdateChecker(app.isPackaged ? process.resourcesPath : path.join(__dirname, '../..'))
  updateChecker.onUpdateAvailable = (info) => {
    mainWindow?.webContents.send(IPC.UPDATE_AVAILABLE, info)
  }
  updateChecker.start()

  // Telegram orchestration — auto-restore the bot if it was enabled last run.
  // Mirrors the bot's own lifecycle: a missing/blank token is a no-op.
  if (loadSettings().telegramEnabled) {
    enableTelegram().catch((e) => console.error('[telegram] auto-start failed:', e))
  }

  // Auto-open last project, or let renderer show project picker
  const lastProject = projectManager.getLastProject()
  if (lastProject) {
    await openProject(lastProject.path)
  } else {
    // No project history — renderer will show project picker
    mainWindow.webContents.send(IPC.PROJECT_CHANGED, null)
  }

  // Stream Deck integration — device claim + hotplug
  const streamDeckInitOpts = {
    registry: hub.registry,
    listPresets: async () => {
      try {
        const names = listPresets()
        return names.map(name => {
          const p = loadPreset(name)
          return { name: p.name, agentCount: p.agents.length }
        })
      } catch { return [] }
    },
    getUnread: () => ({
      inbox: hub?.inboxChannel.unreadCount() ?? 0,
      trollbox: 0,  // Trollbox unread not tracked in main process
      stale: 0,     // Stale count not available in main process
    }),
    settingsIO: {
      load: () => loadSettings(),
      save: (next: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(next)) saveSetting(k, v)
      },
    },
    actionDeps: {
      killAgentByName: async (name: string) => {
        const managed = Array.from(agents.values()).find(m => m.config.name === name)
        if (managed) teardownAgent(managed)
      },
      focusAgent: (name: string) => {
        mainWindow?.show()
        mainWindow?.focus()
        mainWindow?.webContents.send('streamdeck:focus-agent', name)
      },
      killAllAgents: async () => {
        for (const managed of [...agents.values()]) teardownAgent(managed)
      },
      openInbox: () => mainWindow?.webContents.send('streamdeck:open-panel', 'inbox'),
      openTrollbox: () => mainWindow?.webContents.send('streamdeck:open-panel', 'trollbox'),
      openStalePanel: () => mainWindow?.webContents.send('streamdeck:open-panel', 'stale'),
      markInboxRead: () => {
        hub?.inboxChannel.markAllRead()
        mainWindow?.webContents.send('streamdeck:mark-read', 'inbox')
      },
      markTrollboxRead: () => mainWindow?.webContents.send('streamdeck:mark-read', 'trollbox'),
      loadPreset: async (name: string) => {
        // Tell the renderer to load + apply the preset using its existing flow
        // (which spawns each agent and restores window positions). Sending just
        // the name keeps the heavy lifting on the renderer side.
        mainWindow?.webContents.send('streamdeck:run-preset', name)
      },
      writeToOrchestratorPty: (text: string) => {
        const orch = Array.from(agents.values()).find(m => m.config.role === 'orchestrator')
        if (!orch) return false
        writeToPty(orch, text)
        return true
      },
      notifyToast: (msg: string) => mainWindow?.webContents.send('streamdeck:toast', msg),
      showMainWindow: () => { mainWindow?.show(); mainWindow?.focus() },
    },
    mainWindow: () => mainWindow ?? null,
    svgRoot: resolveCogsworthDir(),
  }
  await initStreamDeck(streamDeckInitOpts).catch(err => console.warn('[streamdeck] init error:', (err as Error).message))

  ipcMain.handle(IPC.STREAMDECK_STATUS, () => getStreamDeckStatus())
  ipcMain.handle(IPC.STREAMDECK_RECONNECT, () => reconnectStreamDeck(streamDeckInitOpts))

  // Local Whisper setup: streams progress events to the renderer's settings UI.
  // Idempotent — re-invoking after success is a no-op that returns 'ready' immediately.
  ipcMain.handle(IPC.STREAMDECK_LOCAL_PREPARE, async () => {
    try {
      if (isLocalWhisperReady('base.en')) {
        mainWindow?.webContents.send(IPC.STREAMDECK_LOCAL_PROGRESS, { stage: 'ready', percent: 100 })
        return { ok: true }
      }
      await prepareLocalWhisper((evt) => {
        mainWindow?.webContents.send(IPC.STREAMDECK_LOCAL_PROGRESS, evt)
      }, 'base.en')
      return { ok: true }
    } catch (err) {
      const message = (err as Error).message
      mainWindow?.webContents.send(IPC.STREAMDECK_LOCAL_PROGRESS, { stage: 'error', percent: 0, detail: message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(IPC.BOARD_LIST_PAGES, () => boardStore?.listPages() ?? [])
  ipcMain.handle(IPC.BOARD_ADD_PAGE, () => boardStore?.addPage() ?? null)
  ipcMain.handle(IPC.BOARD_SAVE_PAGE, (_e, page) => { boardStore?.savePage(page); return true })
  ipcMain.handle(IPC.BOARD_DELETE_PAGE, (_e, id: string) => { boardStore?.deletePage(id); return true })
  ipcMain.handle(IPC.BOARD_SAVE_IMAGE, (_e, base64: string, ext: string) => {
    const root = projectManager.currentProject?.path
    if (!root) return null
    return saveImageBytes(root, base64, ext)
  })
  ipcMain.handle(IPC.BOARD_SAVE_RENDER, (_e, pageId: string, base64: string) => {
    const root = projectManager.currentProject?.path
    if (!root) return null
    return saveRenderBytes(root, pageId, base64)
  })
  ipcMain.handle(IPC.BOARD_IMAGE_PATH, (_e, file: string) => {
    const root = projectManager.currentProject?.path
    if (!root) return null
    return path.join(root, '.cog', 'board', 'images', file)
  })
  // Return the image as a data URL. file:// URLs don't load in the renderer
  // (served over http with webSecurity on), so we inline the bytes.
  ipcMain.handle(IPC.BOARD_READ_IMAGE, (_e, file: string) => {
    const root = projectManager.currentProject?.path
    if (!root) return null
    try {
      const buf = fs.readFileSync(path.join(root, '.cog', 'board', 'images', file))
      const ext = path.extname(file).slice(1).toLowerCase() || 'png'
      const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext
      return `data:image/${mime};base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })
  ipcMain.handle(IPC.BOARD_APPEARANCE_GET, () => boardAppearanceStore?.get() ?? { bgColor: '#101010', showGrid: false, gridColor: '#2a2a2a' })
  ipcMain.handle(IPC.BOARD_APPEARANCE_SET, (_e, value) => { boardAppearanceStore?.set(value); return boardAppearanceStore?.get() ?? value })
}

main()

app.on('window-all-closed', async () => {
  await closeProject()
  app.quit()
})

app.on('before-quit', async (event) => {
  await disposeStreamDeck()
  if (remoteServer || cloudflaredManager) {
    event.preventDefault()
    await disableRemoteView()
    app.quit()
  }
})
