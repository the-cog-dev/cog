import express, { type Request, type Response, type NextFunction, type Application } from 'express'
import * as fs from 'fs'
import * as path from 'path'
import type { TokenManager } from './token-manager'

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

export interface RemoteBuddyMessage {
  timestamp: string
  agentName: string
  message: string
}

export interface RemoteServerDeps {
  tokenManager: TokenManager
  getProjectName: () => string
  getAgents: () => RemoteAgentSummary[]
  getSchedules: () => RemoteScheduleSummary[]
  getPinboardTasks: () => RemoteTaskSummary[]
  getBuddyRoom: () => RemoteBuddyMessage[]
  getAgentOutput: (agentId: string) => string[]
  sendMessage: (to: string, text: string) => void
  pauseSchedule: (id: string) => unknown
  resumeSchedule: (id: string) => unknown
  restartSchedule: (id: string) => unknown
  postTask: (title: string, description: string, priority: 'low' | 'medium' | 'high') => unknown
}

export class RemoteServer {
  private app: Application

  constructor(private deps: RemoteServerDeps) {
    this.app = express()
    this.app.use(express.json({ limit: '4kb' }))
    this.app.use('/r/:token', this.authMiddleware.bind(this))
    this.registerRoutes()
  }

  getApp(): Application {
    return this.app
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
    // GET / - serves the mobile UI HTML
    this.app.get('/r/:token/', (req: Request, res: Response) => {
      const htmlPath = path.join(__dirname, 'static', 'index.html')
      let html: string
      try {
        html = fs.readFileSync(htmlPath, 'utf-8')
      } catch {
        res.status(500).send('Static UI not found')
        return
      }
      html = html.replace('__TOKEN_PLACEHOLDER__', req.params.token)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.send(html)
    })

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
      try {
        this.deps.sendMessage(to, text.trim())
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
        buddyRoom: this.deps.getBuddyRoom(),
        connectionCount: this.deps.tokenManager.getConnectionCount(),
        serverTime: Date.now()
      }
      res.json(snapshot)
    })
  }
}
