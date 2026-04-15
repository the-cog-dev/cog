import express, { type Request, type Response, type NextFunction, type Application } from 'express'
import * as fs from 'fs'
import * as path from 'path'
import { createHash, timingSafeEqual } from 'crypto'
import type { TokenManager } from './token-manager'

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 60

interface RateBucket {
  count: number
  windowStart: number
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

export interface RemoteServerDeps {
  tokenManager: TokenManager
  getProjectName: () => string
  getAgents: () => RemoteAgentSummary[]
  getSchedules: () => RemoteScheduleSummary[]
  getPinboardTasks: () => RemoteTaskSummary[]
  getAgentOutput: (agentId: string, lines?: number) => string[]
  sendMessage: (to: string, text: string) => void
  pauseSchedule: (id: string) => unknown
  resumeSchedule: (id: string) => unknown
  restartSchedule: (id: string) => unknown
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
    shell?: 'cmd' | 'powershell' | 'bash' | 'zsh' | 'fish'
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

    this.app.use(express.json({ limit: '4kb' }))
    this.app.use('/r/:token', this.rateLimitMiddleware.bind(this))
    this.app.use('/r/:token', this.authMiddleware.bind(this))
    this.app.use('/r/:token', express.static(this.staticDir, { index: false }))
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
    this.deps.tokenManager.trackSession(req.ip || 'unknown')
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
      const snapshot = {
        projectName: this.deps.getProjectName(),
        agents: this.deps.getAgents(),
        schedules: this.deps.getSchedules(),
        pinboardTasks: this.deps.getPinboardTasks(),
        infoEntries: this.deps.getInfoEntries(),
        connectionCount: this.deps.tokenManager.getConnectionCount(),
        serverTime: Date.now(),
        sessionExpiresAt: this.deps.tokenManager.getExpiresAt(),
        workshopPasscodeSet: this.deps.getWorkshopPasscodeSet()
      }
      res.json(snapshot)
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
