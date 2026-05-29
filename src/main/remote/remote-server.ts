import express, { type Request, type Response, type NextFunction, type Application } from 'express'
import * as fs from 'fs'
import * as path from 'path'
import { createHash, timingSafeEqual } from 'crypto'
import { resolveProjectPath } from '../shared/project-path'
import type { TokenManager } from './token-manager'

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 60

// Cookie scoped under /r/:token/ so each Remote View install has its own
// device id. Lasts a year — long enough to survive token rotation reinstalls.
const DEVICE_COOKIE_NAME = 'cog_did'
const DEVICE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 // seconds

interface RateBucket {
  count: number
  windowStart: number
}

// Parses a single cookie out of the `Cookie` header without pulling in
// cookie-parser. Returns null if absent. Tolerates whitespace and ignores
// other cookies — we only care about our own.
function readCookie(header: string | string[] | undefined, name: string): string | null {
  if (!header) return null
  // `cookie` is always string-or-undefined per HTTP spec, but Node's
  // IncomingHttpHeaders types it broader. Concatenate just in case.
  const raw = Array.isArray(header) ? header.join('; ') : header
  const parts = raw.split(';')
  for (const raw of parts) {
    const trimmed = raw.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq) !== name) continue
    const value = trimmed.slice(eq + 1)
    // Cookie values are only [A-Za-z0-9_-] in our format. Reject anything
    // else so a malformed header can't sneak control chars into logs.
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
    return value
  }
  return null
}

export interface RemoteAgentSummary {
  id: string
  name: string
  cli: string
  model: string
  role: string
  status: string
}

export interface RemoteScheduleSummary {
  id: string
  name: string
  agentName: string
  intervalMinutes: number
  durationHours: number | null
  nextFireAt: number
  expiresAt: number | null
  status: string
}

export interface RemoteTaskSummary {
  id: string
  title: string
  priority: string
  status: string
  claimedBy: string | null
}

export interface RemoteInboxMessage {
  id: string
  agentName: string
  message: string
  priority: string
  createdAt: string
  readAt?: string
  // If this message is wrapping a proposal, the renderer/3DS should render
  // approve/reject UI. proposalId points to the underlying TeamProposal.
  proposalId?: string
  // Lightweight summary of the proposed team so the 3DS can show it without
  // a second roundtrip. Pulled from the linked TeamProposal at read time.
  proposalSummary?: string
  proposalAgents?: Array<{ name: string; cli: string; model?: string; role: string }>
  proposalStatus?: string
}

export interface RemoteServerDeps {
  tokenManager: TokenManager
  getProjectName: () => string
  // Absolute path to the open project root, or null when no project is open.
  // Used by the workshop-gated /files endpoints to sandbox reads/writes via
  // resolveProjectPath. Optional so existing tests that don't open a project
  // still construct a RemoteServer.
  getProjectPath?: () => string | null
  getAgents: () => RemoteAgentSummary[]
  getSchedules: () => RemoteScheduleSummary[]
  getPinboardTasks: () => RemoteTaskSummary[]
  getAgentOutput: (agentId: string, lines?: number) => string[]
  sendMessage: (to: string, text: string) => void
  pauseSchedule: (id: string) => unknown
  resumeSchedule: (id: string) => unknown
  restartSchedule: (id: string) => unknown
  // Creates a new scheduled prompt. Optional so tests that don't wire a
  // scheduler still construct a RemoteServer. Returns the created schedule
  // or throws on validation/agent-not-found.
  createSchedule?: (input: {
    agentId: string
    name?: string
    promptText: string
    intervalMinutes: number
    durationHours: number | null
  }) => unknown
  postTask: (title: string, description: string, priority: 'low' | 'medium' | 'high') => unknown
  getInfoEntries: () => { id: string; from: string; note: string; tags: string[]; createdAt: string }[]
  getWorkshopPasscodeSet: () => boolean
  getWorkspaceState: () => any
  getWorkshopPasscodeHash: () => string | null
  killAgent: (agentId: string) => void
  spawnAgentFromWorkshop: (config: {
    name: string
    cli: string
    model?: string
    role: string
    ceoNotes: string
    autoMode: boolean
    skills?: string[]
    shell?: 'cmd' | 'powershell' | 'wsl' | 'bash' | 'zsh' | 'fish'
    cwd?: string
  }) => Promise<{ success: boolean; agentId?: string; error?: string }>
  onWorkshopWindowUpdate: (update: {
    id: string
    x?: number
    y?: number
    width?: number
    height?: number
  }) => void
  onWorkshopPanelToggle: (update: { type: string; action: 'open' | 'close' | 'toggle' }) => void
  getAgentLayouts: () => Record<string, { x: number; y: number; width: number; height: number; color: string }>
  // ── Inbox + team proposals (Phase 4a) ────────────────────────────────────
  // Lets the 3DS show a unified inbox of orchestrator notifications and
  // pending team proposals, plus respond inline (mark-read or approve/reject)
  // without bouncing back to the desktop UI.
  getInboxMessages: () => RemoteInboxMessage[]
  getInboxUnreadCount: () => number
  markInboxRead: (id: string) => boolean
  // For proposal messages only. Approve = spawn the team as-is from the
  // stored proposal (no per-agent edit on 3DS — too cramped). Reject sends
  // the optional feedback back to the proposing orchestrator.
  approveProposal: (proposalId: string) => Promise<{ success: boolean; error?: string; spawned?: number }>
  rejectProposal: (proposalId: string, feedback?: string) => { success: boolean; error?: string }
  // Free-form reply to the agent that sent an inbox message. Mirrors the
  // desktop InboxPanel's Reply button — routed through the hub message
  // channel as 'user' → <agentName> so the agent sees it like any other.
  replyToInbox: (agentName: string, message: string) => { success: boolean; error?: string }
  // ── Trollbox bridge (Phase 4b) ──────────────────────────────────────────
  // The TrollboxClient lives in the renderer; main caches the latest state
  // it pushes us. If the renderer panel is closed, getTrollboxState returns
  // null and the 3DS shows an "offline" hint.
  getTrollboxState: () => null | {
    status: string
    onlineCount: number
    messages: Array<{ id: string; ts: number; nick: string; text: string }>
    pauseUntil: number | null
    pauseReason: string | null
  }
  sendTrollboxMessage: (text: string, nick: string) => Promise<{ ok: boolean; error?: string }>
}

// Find the static directory at runtime. In electron-vite dev mode, __dirname
// resolves to `out/main/` which may not contain the static files (the Vite copy
// plugin doesn't always work reliably in dev). Fall back to the source path.
function resolveStaticDir(): string {
  const candidates = [
    path.join(__dirname, 'static'),
    path.resolve(__dirname, '..', '..', 'src', 'main', 'remote', 'static'),
    path.resolve(process.cwd(), 'src', 'main', 'remote', 'static')
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      console.log(`[RemoteServer] Static dir resolved: ${dir}`)
      return dir
    }
  }
  console.warn(`[RemoteServer] WARNING: static dir not found. Tried: ${candidates.join(', ')}`)
  return candidates[0]
}

export class RemoteServer {
  private app: Application
  private rateBuckets = new Map<string, RateBucket>()
  private staticDir: string

  constructor(private deps: RemoteServerDeps) {
    this.staticDir = resolveStaticDir()
    this.app = express()

    // Express binds to loopback; the public-facing layer is the cloudflared tunnel
    // which connects back over loopback. Trusting the loopback hop lets req.ip
    // resolve to the X-Forwarded-For client IP so per-IP rate limit and workshop
    // PIN lockout key on the actual remote client, not the single tunnel address.
    this.app.set('trust proxy', 'loopback')

    // No-auth health check — lets you verify the tunnel reaches the server.
    // Returns a minimal HTML page so ancient browsers (3DS, PSP, feature phones)
    // actually render something visible. Pure text/plain sometimes renders blank.
    this.app.get('/health', (_req, res) => {
      res.status(200).type('text/html').send(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>The Cog</title>' +
        '<style>body{background:#0a0a0a;color:#f5d76e;font-family:monospace;text-align:center;padding:20px;font-size:16px}</style>' +
        '</head><body>' +
        '<h1 style="color:#f5d76e">◇ The Cog</h1>' +
        '<p style="color:#6ee7b7">✓ Tunnel connected</p>' +
        '<p style="color:#ccc;font-size:12px">Health check OK. Your device can reach this server.</p>' +
        '<p style="color:#888;font-size:10px">Now enter the full /r/&lt;token&gt;/ URL to access Remote View.</p>' +
        '</body></html>'
      )
    })

    // 64kb leaves headroom for /workshop/spawn ceoNotes (free-form textarea
    // that easily exceeds a few kb). Endpoint is already token-gated, per-IP
    // rate limited, and workshop-PIN protected — small DoS surface.
    this.app.use(express.json({ limit: '64kb' }))
    this.app.use('/r/:token', this.rateLimitMiddleware.bind(this))
    this.app.use('/r/:token', this.authMiddleware.bind(this))
    this.app.use('/r/:token', express.static(this.staticDir, {
      index: false,
      // Some browsers (iOS Safari) refuse to install a PWA when the
      // manifest comes back with the wrong Content-Type. Forcing the
      // correct MIME on the way out is cheaper than depending on the
      // ambient mime-types db being current.
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.webmanifest')) {
          res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8')
        } else if (filePath.endsWith('sw.js')) {
          // SW updates must not be cached by the CDN/intermediaries —
          // browsers also need a fresh fetch to detect SW byte changes.
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
          res.setHeader('Service-Worker-Allowed', '/')
        }
      }
    }))
    this.registerRoutes()
  }

  getApp(): Application {
    return this.app
  }

  private rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip || 'unknown'
    const now = Date.now()
    let bucket = this.rateBuckets.get(ip)
    if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      bucket = { count: 0, windowStart: now }
      this.rateBuckets.set(ip, bucket)
    }
    bucket.count++
    if (bucket.count > RATE_LIMIT_MAX) {
      res.status(429).json({ error: 'rate limit exceeded' })
      return
    }
    next()
  }

  private authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const token = req.params.token
    if (!token || !this.deps.tokenManager.isValid(token)) {
      res.status(404).end()
      return
    }
    this.deps.tokenManager.bumpActivity()

    // Issue or honor the device cookie. Devices that don't store cookies
    // (legacy 3DS/PSP browsers) just keep getting null — that path still
    // works, falling back to per-IP session tracking.
    let deviceId = readCookie(req.headers.cookie, DEVICE_COOKIE_NAME)
    if (!deviceId) {
      deviceId = this.deps.tokenManager.generateDeviceId()
      const cookieParts = [
        `${DEVICE_COOKIE_NAME}=${deviceId}`,
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${DEVICE_COOKIE_MAX_AGE}`,
        `Path=/r/${token}/`
      ]
      // cloudflared serves over HTTPS but Express sees the loopback hop as
      // plain http. Setting Secure unconditionally is safe in practice —
      // browsers reaching the cloudflared URL are already over TLS.
      cookieParts.push('Secure')
      res.setHeader('Set-Cookie', cookieParts.join('; '))
    }
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 200) : undefined
    this.deps.tokenManager.trackSession(req.ip || 'unknown', deviceId, ua)
    // Expose the resolved deviceId on the request for downstream handlers
    // (audit log, WS upgrade auth, future per-device rate limits).
    ;(req as any).deviceId = deviceId
    next()
  }

  private registerRoutes(): void {
    // GET / - serves the mobile UI HTML (matches both /r/:token and /r/:token/)
    const htmlHandler = (req: Request, res: Response): void => {
      const htmlPath = path.join(this.staticDir, 'index.html')
      let html: string
      try {
        html = fs.readFileSync(htmlPath, 'utf-8')
      } catch (err) {
        console.log(`[RemoteServer] Failed to read HTML at ${htmlPath}: ${(err as Error).message}`)
        res.status(500).send('Static UI not found')
        return
      }
      html = html.replace('__TOKEN_PLACEHOLDER__', req.params.token)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.send(html)
    }
    this.app.get('/r/:token/', htmlHandler)
    this.app.get('/r/:token', htmlHandler)

    // POST /task - post a new task to the pinboard
    this.app.post('/r/:token/task', (req: Request, res: Response) => {
      const { title, description, priority } = req.body ?? {}
      if (typeof title !== 'string' || title.trim().length === 0) {
        res.status(400).json({ error: 'title required' })
        return
      }
      if (typeof description !== 'string' || description.trim().length === 0) {
        res.status(400).json({ error: 'description required' })
        return
      }
      const validPriorities = ['low', 'medium', 'high'] as const
      type Priority = typeof validPriorities[number]
      const p: Priority = priority ?? 'medium'
      if (!validPriorities.includes(p)) {
        res.status(400).json({ error: 'priority must be low, medium, or high' })
        return
      }
      try {
        const task = this.deps.postTask(title.trim(), description.trim(), p)
        res.json(task)
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // POST /schedule/:id/{pause|resume|restart} - manage scheduled prompts
    const scheduleAction = (
      fn: (id: string) => unknown
    ) => (req: Request, res: Response) => {
      try {
        const result = fn(req.params.id)
        res.json(result)
      } catch (err) {
        res.status(400).json({ error: (err as Error).message })
      }
    }

    this.app.post('/r/:token/schedule/:id/pause', scheduleAction((id) => this.deps.pauseSchedule(id)))
    this.app.post('/r/:token/schedule/:id/resume', scheduleAction((id) => this.deps.resumeSchedule(id)))
    this.app.post('/r/:token/schedule/:id/restart', scheduleAction((id) => this.deps.restartSchedule(id)))

    // POST /workshop/schedule/create — create a new scheduled prompt.
    // Workshop-gated because it can trigger arbitrary prompts on agents.
    // Validation mirrors the desktop UI: positive integer interval, optional
    // positive integer duration in hours, non-empty prompt text.
    this.app.post('/r/:token/workshop/schedule/create', (req: Request, res: Response, next: NextFunction) => {
      // Inline workshop check — `requireWorkshop` is declared below this scope
      // by historic ordering of the file. Keep the same guarantees by hand.
      const ip = req.ip || 'unknown'
      if (!this.deps.tokenManager.isWorkshopVerified(ip)) {
        res.status(403).json({ error: 'Workshop not verified' })
        return
      }
      if (!this.deps.createSchedule) {
        res.status(503).json({ error: 'Scheduler not available' })
        return
      }
      const { agentId, name, promptText, intervalMinutes, durationHours } = req.body ?? {}
      if (typeof agentId !== 'string' || !agentId.trim()) {
        res.status(400).json({ error: 'agentId required' })
        return
      }
      if (typeof promptText !== 'string' || !promptText.trim()) {
        res.status(400).json({ error: 'promptText required' })
        return
      }
      if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
        res.status(400).json({ error: 'intervalMinutes must be a positive integer' })
        return
      }
      let normalizedDuration: number | null = null
      if (durationHours !== null && durationHours !== undefined) {
        if (!Number.isInteger(durationHours) || durationHours <= 0) {
          res.status(400).json({ error: 'durationHours must be null or a positive integer' })
          return
        }
        normalizedDuration = durationHours
      }
      try {
        const result = this.deps.createSchedule({
          agentId: agentId.trim(),
          name: typeof name === 'string' && name.trim() ? name.trim() : undefined,
          promptText: promptText.trim(),
          intervalMinutes,
          durationHours: normalizedDuration
        })
        res.json({ ok: true, schedule: result })
      } catch (err) {
        res.status(400).json({ error: (err as Error).message })
      }
      // intentionally not calling next()
      void next
    })

    // POST /message - send a message to an agent (writes to their PTY)
    this.app.post('/r/:token/message', (req: Request, res: Response) => {
      const { to, text } = req.body ?? {}
      if (typeof to !== 'string' || typeof text !== 'string' || text.trim().length === 0) {
        res.status(400).json({ error: 'Missing or invalid `to` or `text`' })
        return
      }
      // Strip ASCII control characters (CR, LF, form feed, etc.) so a remote caller
      // can't embed newline-terminated commands that a plain-terminal agent's shell
      // would execute as separate lines.
      const safeText = text.replace(/[\x00-\x1F\x7F]/g, ' ').trim()
      if (safeText.length === 0) {
        res.status(400).json({ error: 'Message is empty after sanitization' })
        return
      }
      try {
        this.deps.sendMessage(to, safeText)
        res.json({ ok: true })
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // GET /agent/:agentId/output - last 50 lines, lazy fetched on tap-to-expand
    this.app.get('/r/:token/agent/:agentId/output', (req: Request, res: Response) => {
      const lines = this.deps.getAgentOutput(req.params.agentId)
      res.json({ lines })
    })

    // GET /state - full snapshot for the mobile UI to render
    this.app.get('/r/:token/state', (_req: Request, res: Response) => {
      const layouts = this.deps.getAgentLayouts()
      const agents = this.deps.getAgents().map(a => {
        const layout = layouts[a.id]
        return layout ? { ...a, x: layout.x, y: layout.y, width: layout.width, height: layout.height, color: layout.color } : a
      })
      // Inject open panel windows into the agents array so they flow
      // through the same data path — the 3DS treats them as cards with
      // a special status. No separate openPanels parsing needed.
      const ws = this.deps.getWorkspaceState()
      if (ws && Array.isArray(ws.windows)) {
        for (const w of ws.windows) {
          if (w.panelType && !w.minimized) {
            agents.push({
              id: w.id,
              name: w.panelType.charAt(0).toUpperCase() + w.panelType.slice(1),
              cli: w.panelType,
              status: 'panel',
              role: 'panel',
              x: w.x ?? 0,
              y: w.y ?? 0,
              width: w.width ?? 300,
              height: w.height ?? 200,
              color: '#333333'
            } as any)
          }
        }
      }

      // Send the most recent N inbox messages inline so the 3DS canvas can
      // show an Inbox panel card with a badge on the first poll. The full
      // list is available via GET /inbox if the user opens the detail view.
      const allInbox = this.deps.getInboxMessages()
      const inboxRecent = allInbox.slice(0, 20)
      const inboxUnread = this.deps.getInboxUnreadCount()

      const snapshot = {
        projectName: this.deps.getProjectName(),
        agents,
        schedules: this.deps.getSchedules(),
        pinboardTasks: this.deps.getPinboardTasks(),
        infoEntries: this.deps.getInfoEntries(),
        connectionCount: this.deps.tokenManager.getConnectionCount(),
        serverTime: Date.now(),
        sessionExpiresAt: this.deps.tokenManager.getExpiresAt(),
        workshopPasscodeSet: this.deps.getWorkshopPasscodeSet(),
        presets: this.deps.getPresets(),
        inbox: inboxRecent,
        inboxUnread
      }
      res.json(snapshot)
    })

    // ── Inbox + team proposal endpoints (Phase 4a) ───────────────────────
    // Read-only list (full, not the snapshot's truncated tail).
    this.app.get('/r/:token/inbox', (_req: Request, res: Response) => {
      res.json({ messages: this.deps.getInboxMessages(), unread: this.deps.getInboxUnreadCount() })
    })

    // Mark a single message as read. Idempotent; returning ok even if the
    // id no longer exists keeps the 3DS happy under retry.
    this.app.post('/r/:token/inbox/:id/read', (req: Request, res: Response) => {
      try {
        this.deps.markInboxRead(req.params.id)
        res.json({ success: true })
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message || 'Failed to mark read' })
      }
    })

    // Respond to a proposal-type message. Body: { action: 'approve' | 'reject', feedback?: string }
    // For non-proposal messages this is a no-op past the read mark.
    this.app.post('/r/:token/inbox/:id/respond', async (req: Request, res: Response) => {
      const { action, feedback, proposalId } = req.body ?? {}
      if (action !== 'approve' && action !== 'reject') {
        res.status(400).json({ success: false, error: "action must be 'approve' or 'reject'" })
        return
      }
      // proposalId comes from the inbox message wrapper. Fall back to
      // looking it up from the inbox list by message id if the 3DS forgot.
      let pid = typeof proposalId === 'string' ? proposalId : undefined
      if (!pid) {
        const msg = this.deps.getInboxMessages().find(m => m.id === req.params.id)
        pid = msg?.proposalId
      }
      if (!pid) {
        res.status(400).json({ success: false, error: 'message has no proposal to respond to' })
        return
      }
      try {
        if (action === 'approve') {
          const result = await this.deps.approveProposal(pid)
          // Mark the wrapper message read once the proposal is resolved so
          // the badge clears on the next poll.
          try { this.deps.markInboxRead(req.params.id) } catch { /* ignore */ }
          res.json(result)
        } else {
          const result = this.deps.rejectProposal(pid, typeof feedback === 'string' ? feedback : undefined)
          try { this.deps.markInboxRead(req.params.id) } catch { /* ignore */ }
          res.json(result)
        }
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message || 'Respond failed' })
      }
    })

    // Free-form reply to the agent that sent an inbox message. Looks up the
    // sender from the inbox by id (the 3DS doesn't send it — keeps the wire
    // tight), routes through the hub message channel as 'user' → agent, and
    // marks the message read so the badge clears on the next poll.
    this.app.post('/r/:token/inbox/:id/reply', (req: Request, res: Response) => {
      const { message } = req.body ?? {}
      if (typeof message !== 'string' || !message.trim()) {
        res.status(400).json({ success: false, error: 'message required' })
        return
      }
      const msg = this.deps.getInboxMessages().find(m => m.id === req.params.id)
      if (!msg) {
        res.status(404).json({ success: false, error: 'message not found' })
        return
      }
      const result = this.deps.replyToInbox(msg.agentName, message.trim())
      if (result.success) {
        try { this.deps.markInboxRead(req.params.id) } catch { /* ignore */ }
      }
      res.json(result)
    })

    // ── Workshop endpoints ────────────────────────────────────────────────

    // Track workshop PIN attempts per IP
    const workshopAttempts = new Map<string, { count: number; lockedUntil: number }>()

    this.app.post('/r/:token/workshop/verify', (req, res) => {
      const ip = req.ip || 'unknown'
      const now = Date.now()
      const attempt = workshopAttempts.get(ip)
      if (attempt && attempt.lockedUntil > now) {
        const waitSec = Math.ceil((attempt.lockedUntil - now) / 1000)
        res.json({ verified: false, error: `Locked out. Try again in ${waitSec}s`, attemptsLeft: 0 })
        return
      }
      const { pin } = req.body ?? {}
      if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
        res.status(400).json({ error: 'Invalid PIN format' })
        return
      }
      const hash = createHash('sha256').update(pin).digest('hex')
      const expected = this.deps.getWorkshopPasscodeHash()
      if (!expected) {
        res.status(400).json({ error: 'No passcode configured' })
        return
      }
      // Constant-time compare so response timing can't leak partial hash matches
      const hashBuf = Buffer.from(hash, 'hex')
      const expectedBuf = Buffer.from(expected, 'hex')
      const matches = hashBuf.length === expectedBuf.length && timingSafeEqual(hashBuf, expectedBuf)
      if (matches) {
        workshopAttempts.delete(ip)
        this.deps.tokenManager.verifyWorkshop(ip)
        res.json({ verified: true })
      } else {
        const a = attempt ?? { count: 0, lockedUntil: 0 }
        a.count++
        if (a.count >= 5) {
          a.lockedUntil = now + 60_000
          a.count = 0
        }
        workshopAttempts.set(ip, a)
        const left = 5 - a.count
        res.json({ verified: false, attemptsLeft: left })
      }
    })

    const requireWorkshop = (req: Request, res: Response, next: NextFunction): void => {
      const ip = req.ip || 'unknown'
      if (!this.deps.tokenManager.isWorkshopVerified(ip)) {
        res.status(403).json({ error: 'Workshop not verified' })
        return
      }
      next()
    }

    // ── Trollbox endpoints (Phase 4b) ─────────────────────────────────────
    // GET returns up to N most recent messages + connection metadata. POST
    // forwards a chat to the renderer's live client. Workshop-PIN gated —
    // same trust boundary as spawn/kill, since the device owner is already
    // authenticated. The 3DS reads /trollbox on a 2-3s poll while its modal
    // viewer is open; closing the modal stops the poll.
    this.app.get('/r/:token/trollbox', requireWorkshop, (_req: Request, res: Response) => {
      const state = this.deps.getTrollboxState()
      if (!state) {
        res.json({
          status: 'offline',
          onlineCount: 0,
          messages: [],
          pauseUntil: null,
          pauseReason: null,
          hint: 'Open the Trollbox panel on desktop to enable 3DS chat.'
        })
        return
      }
      // Cap to last 80 — keeps the JSON small enough for the 3DS to parse.
      const recent = state.messages.slice(-80)
      res.json({
        status: state.status,
        onlineCount: state.onlineCount,
        messages: recent,
        pauseUntil: state.pauseUntil,
        pauseReason: state.pauseReason
      })
    })

    this.app.post('/r/:token/trollbox/send', requireWorkshop, async (req: Request, res: Response) => {
      const { text, nick } = req.body ?? {}
      if (typeof text !== 'string' || !text.trim()) {
        res.status(400).json({ ok: false, error: 'text required' })
        return
      }
      if (typeof nick !== 'string' || !nick.trim()) {
        res.status(400).json({ ok: false, error: 'nick required' })
        return
      }
      const safeText = text.slice(0, 200)
      const safeNick = nick.slice(0, 24)
      try {
        const result = await this.deps.sendTrollboxMessage(safeText, safeNick)
        res.status(result.ok ? 200 : 400).json(result)
      } catch (err: any) {
        res.status(500).json({ ok: false, error: err?.message || 'send failed' })
      }
    })

    this.app.get('/r/:token/workshop/state', requireWorkshop, (_req, res) => {
      const ws = this.deps.getWorkspaceState()
      if (!ws) {
        res.json({ windows: [], canvas: { zoom: 1, panX: 0, panY: 0 } })
        return
      }
      const visible = ws.windows.filter((w: any) => !w.minimized)
      res.json({ windows: visible, canvas: { zoom: ws.zoom, panX: ws.panX, panY: ws.panY } })
    })

    this.app.get('/r/:token/workshop/output/:agentId', requireWorkshop, (req, res) => {
      const lines = Math.min(parseInt(req.query.lines as string) || 200, 500)
      const output = this.deps.getAgentOutput(req.params.agentId, lines)
      res.json({ lines: output })
    })

    this.app.post('/r/:token/workshop/kill/:agentId', requireWorkshop, (req, res) => {
      try {
        this.deps.killAgent(req.params.agentId)
        res.json({ ok: true })
      } catch (err) {
        res.status(400).json({ error: (err as Error).message })
      }
    })

    this.app.post('/r/:token/workshop/spawn', requireWorkshop, async (req: Request, res: Response) => {
      const body = req.body ?? {}
      if (typeof body.name !== 'string' || !body.name.trim()) { res.status(400).json({ error: 'name required' }); return }
      if (typeof body.cli !== 'string' || !body.cli.trim()) { res.status(400).json({ error: 'cli required' }); return }
      if (typeof body.role !== 'string' || !body.role.trim()) { res.status(400).json({ error: 'role required' }); return }
      try {
        const result = await this.deps.spawnAgentFromWorkshop({
          name: String(body.name).trim(),
          cli: String(body.cli).trim(),
          model: body.model ? String(body.model).trim() : undefined,
          role: String(body.role).trim(),
          ceoNotes: String(body.ceoNotes || ''),
          autoMode: body.autoMode === true,
          skills: Array.isArray(body.skills) ? body.skills.map(String) : [],
          shell: body.shell,
          cwd: body.cwd
        })
        if (result.success) res.json({ ok: true, agentId: result.agentId })
        else res.status(400).json({ error: result.error || 'Spawn failed' })
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    this.app.post('/r/:token/workshop/window/:id', requireWorkshop, (req: Request, res: Response) => {
      const id = req.params.id
      const { x, y, width, height } = req.body ?? {}
      if (typeof id !== 'string' || !id) { res.status(400).json({ error: 'id required' }); return }
      // Validate numeric fields if present
      const update: { id: string; x?: number; y?: number; width?: number; height?: number } = { id }
      if (typeof x === 'number') update.x = x
      if (typeof y === 'number') update.y = y
      if (typeof width === 'number' && width > 0) update.width = width
      if (typeof height === 'number' && height > 0) update.height = height
      this.deps.onWorkshopWindowUpdate(update)
      res.json({ ok: true })
    })

    // ── File operations (Phase 5 — mobile console) ───────────────────────
    // Workshop-gated read/list/write inside the open project sandbox.
    // resolveProjectPath enforces both lexical containment AND realpath
    // containment (symlink-safe) — same helper hub/routes.ts uses for the
    // local MCP file API. Writes are capped to the 64kb body limit.
    const FILES_MAX_READ_BYTES = 1024 * 1024
    const FILES_MAX_LIST_ENTRIES = 500

    this.app.get('/r/:token/workshop/files/list', requireWorkshop, (req: Request, res: Response) => {
      const dirPath = (req.query.path as string) || '.'
      const root = this.deps.getProjectPath?.() ?? null
      const resolved = resolveProjectPath(root, dirPath)
      if (!resolved) { res.status(403).json({ error: 'Path outside project directory' }); return }
      try {
        if (!fs.existsSync(resolved)) { res.status(404).json({ error: `Directory not found: ${dirPath}` }); return }
        const stat = fs.statSync(resolved)
        if (!stat.isDirectory()) { res.status(400).json({ error: 'Path is a file, use /files/read instead' }); return }
        const entries = fs.readdirSync(resolved, { withFileTypes: true }).slice(0, FILES_MAX_LIST_ENTRIES)
        const items = entries.map(entry => {
          let size: number | null = null
          if (entry.isFile()) {
            try { size = fs.statSync(path.join(resolved, entry.name)).size } catch { /* unreadable — leave null */ }
          }
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            path: path.join(dirPath, entry.name).replace(/\\/g, '/'),
            size
          }
        })
        items.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        res.json({ path: dirPath, items })
      } catch (err: any) {
        res.status(500).json({ error: 'File operation failed' })
      }
    })

    this.app.get('/r/:token/workshop/files/read', requireWorkshop, (req: Request, res: Response) => {
      const filePath = req.query.path as string
      if (!filePath) { res.status(400).json({ error: 'path query parameter is required' }); return }
      const root = this.deps.getProjectPath?.() ?? null
      const resolved = resolveProjectPath(root, filePath)
      if (!resolved) { res.status(403).json({ error: 'Path outside project directory' }); return }
      try {
        if (!fs.existsSync(resolved)) { res.status(404).json({ error: `File not found: ${filePath}` }); return }
        const stat = fs.statSync(resolved)
        if (stat.isDirectory()) { res.status(400).json({ error: 'Path is a directory, use /files/list instead' }); return }
        if (stat.size > FILES_MAX_READ_BYTES) {
          res.status(413).json({ error: `File too large (${stat.size} bytes). Max ${FILES_MAX_READ_BYTES} bytes.` })
          return
        }
        const content = fs.readFileSync(resolved, 'utf-8')
        res.json({ path: filePath, content, size: stat.size })
      } catch (err: any) {
        res.status(500).json({ error: 'File operation failed' })
      }
    })

    this.app.post('/r/:token/workshop/files/write', requireWorkshop, (req: Request, res: Response) => {
      const { path: filePath, content } = req.body ?? {}
      if (typeof filePath !== 'string' || content === undefined) { res.status(400).json({ error: 'path and content are required' }); return }
      if (typeof content !== 'string') { res.status(400).json({ error: 'content must be a string' }); return }
      const root = this.deps.getProjectPath?.() ?? null
      const resolved = resolveProjectPath(root, filePath)
      if (!resolved) { res.status(403).json({ error: 'Path outside project directory' }); return }
      try {
        const dir = path.dirname(resolved)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(resolved, content, 'utf-8')
        const stat = fs.statSync(resolved)
        res.json({ path: filePath, size: stat.size, status: 'ok' })
      } catch (err: any) {
        res.status(500).json({ error: 'File operation failed' })
      }
    })

    this.app.post('/r/:token/workshop/panel/:type', requireWorkshop, (req: Request, res: Response) => {
      const type = req.params.type
      const action = (req.body && req.body.action) || 'toggle'
      const validTypes = ['pinboard', 'info', 'files', 'schedules', 'git', 'usage', 'rac']
      if (!validTypes.includes(type)) { res.status(400).json({ error: 'Invalid panel type' }); return }
      const validActions = ['open', 'close', 'toggle']
      if (!validActions.includes(action)) { res.status(400).json({ error: 'Invalid action' }); return }
      this.deps.onWorkshopPanelToggle({ type, action: action as 'open' | 'close' | 'toggle' })
      res.json({ ok: true })
    })
  }
}
