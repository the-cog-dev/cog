import express from 'express'
import { createServer, type Server } from 'http'
import { FederationRouter, type RegisteredCog } from './federation-router'

/**
 * Single-poller election + cross-process coordination for the Telegram bridge.
 *
 * Problem: N Cog instances share one bot token; if each long-polls, Telegram
 * splits inbound updates across them and ~1-1/N are lost. Fix: exactly one
 * instance (the GATEWAY) owns the poll; the rest are FOLLOWERS that register
 * with it and receive their inbound messages over loopback.
 *
 * Election is a race to bind a fixed loopback port: the winner is the gateway
 * and serves a tiny coordination API there; losers (EADDRINUSE) are followers.
 * Each follower also binds an ephemeral loopback port (its "callback" server)
 * so the gateway can push inbound messages to it and read its agent list for
 * /status. Best-effort failover: followers heartbeat; if the gateway vanishes
 * they retry the bind and one takes over.
 *
 * Sending never conflicts (any process can call the Bot API), so outbound relay
 * stays local to each Cog — only the poll + inbound routing are centralised.
 */

export const DEFAULT_GATEWAY_PORT = 47600
const HEARTBEAT_MS = 8000
const STALE_TTL_MS = 20000
const REELECT_MS = 5000
const CALLBACK_TIMEOUT_MS = 4000

export type GatewayRole = 'gateway' | 'follower'

/** One addressable agent in a Cog, for /status aggregation. */
export interface LocalTarget { name: string; role: string; status: string }

/** Supplied by index.ts so the coordinator can reach THIS process's orchestrator. */
export interface CoordinatorHooks {
  /** Route a user message to this Cog's active orchestrator. */
  deliverLocal: (chatId: number, text: string) => { ok: boolean; detail?: string }
  /** This Cog's addressable agents (for aggregated /status). */
  listLocalTargets: () => LocalTarget[]
}

export interface CoordinatorOptions {
  /** Stable-per-process id (random per launch is fine). */
  followerId: string
  /** This Cog's project name — shown in /status and message prefixes. */
  project: string
  /** Reach this process's orchestrator / agent list. */
  hooks?: CoordinatorHooks
  /** Loopback port to elect on. Overridable for tests. */
  port?: number
  onLog?: (m: string) => void
  /** Fired when this process becomes the gateway (start polling). */
  onBecomeGateway?: () => void
  /** Fired when this process becomes a follower (stop polling). */
  onBecomeFollower?: () => void
}

const NOOP_HOOKS: CoordinatorHooks = {
  deliverLocal: () => ({ ok: false, detail: 'no local handler' }),
  listLocalTargets: () => []
}

export class GatewayCoordinator {
  private readonly followerId: string
  private readonly project: string
  private readonly port: number
  private readonly hooks: CoordinatorHooks
  private readonly log: (m: string) => void
  private readonly onBecomeGateway?: () => void
  private readonly onBecomeFollower?: () => void

  readonly router = new FederationRouter()
  private role: GatewayRole = 'follower'
  private server: Server | null = null          // gateway coordination server (:port)
  private callbackServer: Server | null = null  // follower inbound-callback server (ephemeral)
  private callbackUrl = ''
  private heartbeatTimer: NodeJS.Timeout | null = null
  private pruneTimer: NodeJS.Timeout | null = null
  private reelectTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(o: CoordinatorOptions) {
    this.followerId = o.followerId
    this.project = o.project
    this.port = o.port ?? DEFAULT_GATEWAY_PORT
    this.hooks = o.hooks ?? NOOP_HOOKS
    this.log = o.onLog ?? (() => {})
    this.onBecomeGateway = o.onBecomeGateway
    this.onBecomeFollower = o.onBecomeFollower
  }

  getRole(): GatewayRole { return this.role }
  isGateway(): boolean { return this.role === 'gateway' }

  /** Elect a role and wire up the corresponding side (server or heartbeats). */
  async start(): Promise<GatewayRole> {
    this.stopped = false
    await this.elect()
    return this.role
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearTimers()
    if (this.role === 'follower') await this.deregister().catch(() => {})
    await this.closeServer('server')
    await this.closeServer('callbackServer')
  }

  // ── Public: gateway-side routing (called from the poller) ─────────────────

  /**
   * Route an inbound plain-text to the chat's active Cog. Self → local
   * orchestrator; a follower → its callback server. Returns which project it
   * went to so the caller can confirm to the user.
   */
  async routeInbound(chatId: number, text: string): Promise<{ ok: boolean; project?: string; detail?: string }> {
    const cog = this.router.resolveActive(chatId)
    if (!cog) return { ok: false, detail: 'No Cog instances are registered.' }
    if (cog.isSelf) {
      const r = this.hooks.deliverLocal(chatId, text)
      return { ok: r.ok, project: cog.project, detail: r.detail }
    }
    try {
      const res = await this.postJson(`${cog.callbackUrl}/inbound`, { chatId, text })
      return { ok: res.ok, project: cog.project, detail: res.ok ? undefined : `HTTP ${res.status}` }
    } catch (err: any) {
      return { ok: false, project: cog.project, detail: err?.message ?? 'callback unreachable' }
    }
  }

  /** Pin the chat's active Cog by project name (exact or unique prefix). */
  setActiveByProject(chatId: number, name: string): RegisteredCog | null {
    const cog = this.router.resolveByProject(name)
    if (!cog) return null
    this.router.setActive(chatId, cog.id)
    return cog
  }

  /** The project a chat is currently addressing (its active Cog). */
  activeProject(chatId: number): string | null {
    return this.router.resolveActive(chatId)?.project ?? null
  }

  /** True when the chat's active Cog is a *different* process (needs forwarding). */
  isFollowerActive(chatId: number): boolean {
    const c = this.router.resolveActive(chatId)
    return !!c && !c.isSelf
  }

  /** Every registered Cog's project (self + followers), for /cog and /status. */
  listProjects(): Array<{ project: string; isSelf: boolean }> {
    return this.router.list().map(c => ({ project: c.project, isSelf: c.isSelf }))
  }

  /** How many Cog instances are federated right now (1 = single instance). */
  cogCount(): number {
    return this.router.list().length
  }

  /** Aggregate every registered Cog's agents (self locally, followers via callback). */
  async aggregateTargets(): Promise<Array<{ project: string; isSelf: boolean; targets: LocalTarget[] }>> {
    const out: Array<{ project: string; isSelf: boolean; targets: LocalTarget[] }> = []
    for (const cog of this.router.list()) {
      if (cog.isSelf) {
        out.push({ project: cog.project, isSelf: true, targets: this.hooks.listLocalTargets() })
      } else {
        let targets: LocalTarget[] = []
        try {
          const res = await this.getJson(`${cog.callbackUrl}/targets`)
          if (Array.isArray(res)) targets = res
        } catch { /* follower unreachable — show it with no targets */ }
        out.push({ project: cog.project, isSelf: false, targets })
      }
    }
    return out
  }

  // ── Election ──────────────────────────────────────────────────────────────

  private async elect(): Promise<void> {
    try {
      this.server = await this.bindGatewayServer(this.port)
      this.becomeGateway()
    } catch (err: any) {
      if (err?.code !== 'EADDRINUSE') {
        this.log(`gateway bind error (${err?.message ?? err}) — running as follower`)
      }
      await this.becomeFollower()
    }
  }

  private becomeGateway(): void {
    this.role = 'gateway'
    this.router.register({ id: this.followerId, project: this.project, isSelf: true, lastSeen: Date.now() })
    this.startPruneLoop()
    this.log(`elected GATEWAY on :${this.port}`)
    this.onBecomeGateway?.()
  }

  private async becomeFollower(): Promise<void> {
    this.role = 'follower'
    this.onBecomeFollower?.()
    await this.ensureCallbackServer().catch(e => this.log(`callback server failed: ${e?.message ?? e}`))
    await this.register().catch(e => this.log(`register failed: ${e?.message ?? e}`))
    this.startHeartbeatLoop()
    this.log('running as FOLLOWER')
  }

  // ── Gateway HTTP (followers register / heartbeat here) ────────────────────

  private bindGatewayServer(port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      const app = express()
      app.use(express.json())

      app.post('/register', (req, res) => {
        const { followerId, project, callbackUrl } = req.body ?? {}
        if (!followerId || !project) { res.status(400).json({ error: 'followerId, project required' }); return }
        this.router.register({ id: followerId, project, isSelf: false, callbackUrl, lastSeen: Date.now() })
        this.log(`follower registered: ${project} (${followerId})`)
        res.json({ ok: true })
      })

      app.post('/heartbeat', (req, res) => {
        const ok = this.router.touch(req.body?.followerId, Date.now())
        res.json({ ok, known: ok })
      })

      app.delete('/register/:id', (req, res) => {
        this.router.deregister(req.params.id)
        res.json({ ok: true })
      })

      // app.listen swallows EADDRINUSE and resolves anyway (which would let two
      // instances both think they're gateway); http.createServer rejects cleanly.
      const server = createServer(app)
      const onError = (err: unknown) => { server.removeListener('listening', onListening); reject(err) }
      const onListening = () => { server.removeListener('error', onError); resolve(server) }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
  }

  // ── Follower callback HTTP (gateway pushes inbound / reads targets here) ───

  private ensureCallbackServer(): Promise<void> {
    if (this.callbackServer) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const app = express()
      app.use(express.json())

      app.post('/inbound', (req, res) => {
        const { chatId, text } = req.body ?? {}
        const r = this.hooks.deliverLocal(Number(chatId), String(text ?? ''))
        res.json(r)
      })

      app.get('/targets', (_req, res) => {
        res.json(this.hooks.listLocalTargets())
      })

      const server = createServer(app)
      const onError = (err: unknown) => { server.removeListener('listening', onListening); reject(err) }
      const onListening = () => {
        server.removeListener('error', onError)
        const addr = server.address()
        const p = addr && typeof addr !== 'string' ? addr.port : 0
        this.callbackServer = server
        this.callbackUrl = `http://127.0.0.1:${p}`
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1') // ephemeral loopback port
    })
  }

  // ── Follower client (talks to the gateway) ────────────────────────────────

  private gatewayUrl(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`
  }

  private async register(): Promise<void> {
    const res = await this.postJson(this.gatewayUrl('/register'), {
      followerId: this.followerId,
      project: this.project,
      callbackUrl: this.callbackUrl
    })
    if (!res.ok) throw new Error(`register HTTP ${res.status}`)
  }

  private async deregister(): Promise<void> {
    await fetch(this.gatewayUrl(`/register/${this.followerId}`), { method: 'DELETE' }).catch(() => {})
  }

  private async heartbeat(): Promise<boolean> {
    try {
      const res = await this.postJson(this.gatewayUrl('/heartbeat'), { followerId: this.followerId })
      if (!res.ok) return false
      const body = await res.json().catch(() => ({} as any))
      if (body && body.known === false) await this.register().catch(() => {}) // gateway restarted — re-register
      return true
    } catch {
      return false // gateway unreachable — likely died
    }
  }

  // ── HTTP helpers (small timeouts so a dead peer never hangs routing) ──────

  private async postJson(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS)
    })
  }

  private async getJson(url: string): Promise<any> {
    const res = await fetch(url, { signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  // ── Timers ────────────────────────────────────────────────────────────────

  private startHeartbeatLoop(): void {
    this.clearTimer('heartbeat')
    this.heartbeatTimer = setInterval(async () => {
      if (this.stopped) return
      const alive = await this.heartbeat()
      if (!alive) this.onGatewayLost()
    }, HEARTBEAT_MS)
  }

  private startPruneLoop(): void {
    this.clearTimer('prune')
    this.pruneTimer = setInterval(() => {
      const removed = this.router.prune(Date.now(), STALE_TTL_MS)
      if (removed.length) this.log(`pruned stale followers: ${removed.join(', ')}`)
    }, HEARTBEAT_MS)
  }

  /** Gateway went away — try to take over (best-effort failover). */
  private onGatewayLost(): void {
    if (this.stopped || this.role === 'gateway' || this.reelectTimer) return
    this.log('gateway unreachable — attempting takeover')
    this.clearTimer('heartbeat')
    this.reelectTimer = setInterval(async () => {
      if (this.stopped) { this.clearTimer('reelect'); return }
      try {
        this.server = await this.bindGatewayServer(this.port)
        this.clearTimer('reelect')
        // Keep the callback server running; harmless as gateway.
        this.becomeGateway()
      } catch {
        // Someone else grabbed it first — resume following.
        this.clearTimer('reelect')
        await this.becomeFollower()
      }
    }, REELECT_MS)
  }

  private clearTimer(which: 'heartbeat' | 'prune' | 'reelect'): void {
    const t = which === 'heartbeat' ? this.heartbeatTimer : which === 'prune' ? this.pruneTimer : this.reelectTimer
    if (t) clearInterval(t)
    if (which === 'heartbeat') this.heartbeatTimer = null
    if (which === 'prune') this.pruneTimer = null
    if (which === 'reelect') this.reelectTimer = null
  }

  private clearTimers(): void {
    this.clearTimer('heartbeat'); this.clearTimer('prune'); this.clearTimer('reelect')
  }

  private async closeServer(which: 'server' | 'callbackServer'): Promise<void> {
    const s = which === 'server' ? this.server : this.callbackServer
    if (!s) return
    await new Promise<void>(res => s.close(() => res()))
    if (which === 'server') this.server = null
    else this.callbackServer = null
  }
}
