import type { SupabaseClient } from '@supabase/supabase-js'
import { nanoid } from 'nanoid'
import { TROLLBOX_CHANNEL } from '../../../shared/trollbox-config'
import { sealFp, signAdmin, verifyAdmin, openFp } from '../../../shared/trollbox-crypto'

export type ConnectionStatus =
  | 'closed'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'paused'

export interface ChatMsg {
  type: 'chat'
  id: string
  ts: number
  nick: string
  fp_enc: string
  text: string
}

export interface TrollboxState {
  status: ConnectionStatus
  onlineCount: number
  messages: ChatMsg[]
  pauseUntil: number | null
  pauseReason: string | null
}

interface Deps {
  supabase: SupabaseClient
  machineHash: string
  adminX25519Pub: Uint8Array
  adminEd25519Pub: Uint8Array
}

const MAX_BUFFER = 500

export class TrollboxClient {
  private state: TrollboxState = {
    status: 'closed',
    onlineCount: 0,
    messages: [],
    pauseUntil: null,
    pauseReason: null,
  }
  private listeners = new Set<(s: TrollboxState) => void>()
  private channel: ReturnType<SupabaseClient['channel']> | null = null
  private lastSendAt = 0
  // Self-send minimum interval. 0 disables the check entirely. Admin can update
  // this at runtime via admin.config broadcasts.
  private rateLimitMs = 1000
  private sourceWindow: Map<string, number[]> = new Map()
  private readonly SOURCE_WINDOW_MS = 10_000
  private readonly SOURCE_WINDOW_MAX = 10
  private localBans: Map<string, number> = new Map()
  private adminEdPriv: Uint8Array | null = null
  private adminXPriv: Uint8Array | null = null
  private adminDecryptedFps = new Map<string, string>()
  private pauseTickTimer: ReturnType<typeof setInterval> | null = null
  private pauseRebroadcastTimer: ReturnType<typeof setInterval> | null = null

  constructor(private deps: Deps) {}

  // Nick-ban is enforced everywhere. Fp-ban is enforced only by admin (who has
  // decrypted the fp via Task 13's adminDecryptedFps map). Non-admin clients
  // pass null for decryptedFp and only nick-bans apply.
  private isBanned(msg: ChatMsg, decryptedFp: string | null): boolean {
    const now = Date.now()
    const checks = [`nick:${msg.nick}`]
    if (decryptedFp) checks.push(`fp:${decryptedFp}`)
    for (const key of checks) {
      const exp = this.localBans.get(key)
      if (exp !== undefined) {
        if (exp > now) return true
        this.localBans.delete(key)
      }
    }
    return false
  }

  private allowSource(fp_enc: string): boolean {
    const now = Date.now()
    const list = this.sourceWindow.get(fp_enc) ?? []
    const recent = list.filter(t => now - t < this.SOURCE_WINDOW_MS)
    if (recent.length >= this.SOURCE_WINDOW_MAX) {
      this.sourceWindow.set(fp_enc, recent)
      return false
    }
    recent.push(now)
    this.sourceWindow.set(fp_enc, recent)
    return true
  }

  onState(cb: (s: TrollboxState) => void): () => void {
    this.listeners.add(cb)
    cb(this.state)
    return () => { this.listeners.delete(cb) }
  }

  getDecryptedFp(msgId: string): string | undefined {
    return this.adminDecryptedFps.get(msgId)
  }

  async connect(): Promise<void> {
    // Allow manual reconnect from 'connecting' (stuck callback) or 'disconnected'.
    // Only refuse if we're already connected.
    if (this.state.status === 'connected') return
    // If a previous channel is still hanging around, tear it down before a retry.
    if (this.channel) {
      try { await this.channel.unsubscribe() } catch { /* ignore */ }
      this.channel = null
    }
    this.setState({ status: 'connecting' })

    const chan = this.deps.supabase.channel(TROLLBOX_CHANNEL, {
      config: { broadcast: { self: false }, presence: { key: this.deps.machineHash } },
    })
    this.channel = chan

    chan.on('presence', { event: 'sync' }, () => {
      const presenceState = chan.presenceState() as Record<string, unknown[]>
      this.setState({ onlineCount: Object.keys(presenceState).length })
    })

    chan.on('broadcast', { event: 'chat' }, ({ payload }: any) => {
      if (!this.isValidChat(payload)) return
      if (!this.allowSource(payload.fp_enc)) return
      // Admin-only: decrypt fp first so ban check can use it
      let decryptedFp: string | null = null
      if (this.adminXPriv) {
        decryptedFp = openFp(payload.fp_enc, this.adminXPriv, this.deps.adminX25519Pub)
      }
      if (this.isBanned(payload, decryptedFp)) return
      const next = [...this.state.messages, payload as ChatMsg]
      if (next.length > MAX_BUFFER) {
        const dropped = next.splice(0, next.length - MAX_BUFFER)
        for (const d of dropped) this.adminDecryptedFps.delete(d.id)
      }
      this.setState({ messages: next })
      if (decryptedFp) this.adminDecryptedFps.set(payload.id, decryptedFp)
    })

    chan.on('broadcast', { event: 'admin' }, ({ payload }: any) => {
      if (!payload || typeof payload.type !== 'string') return
      if (!verifyAdmin(payload, this.deps.adminEd25519Pub)) return
      this.applyAdmin(payload)
    })

    // Any non-SUBSCRIBED terminal status → disconnected. We also time out after
    // 15s to avoid getting stuck in 'connecting' when the server never replies.
    await new Promise<void>((resolve) => {
      let settled = false
      const settle = (nextStatus: 'connected' | 'disconnected') => {
        if (settled) return
        settled = true
        this.setState({ status: nextStatus })
        resolve()
      }
      const timeout = setTimeout(() => settle('disconnected'), 15_000)
      chan.subscribe((status: string) => {
        if (settled) return
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout)
          chan.track({})
          settle('connected')
        } else if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED'
        ) {
          clearTimeout(timeout)
          settle('disconnected')
        }
      })
    })
  }

  async disconnect(): Promise<void> {
    if (this.pauseTickTimer) { clearInterval(this.pauseTickTimer); this.pauseTickTimer = null }
    this.stopPauseRebroadcast()
    this.unloadAdminKeys()
    if (!this.channel) return
    try {
      await this.channel.untrack()
      await this.channel.unsubscribe()
    } finally {
      this.channel = null
      this.sourceWindow.clear()
      this.lastSendAt = 0
      this.localBans.clear()
      this.adminDecryptedFps.clear()
      this.setState({
        status: 'closed',
        onlineCount: 0,
        messages: [],
        pauseUntil: null,
        pauseReason: null,
      })
    }
  }

  loadAdminKeys(edPriv: Uint8Array, xPriv: Uint8Array): void {
    this.adminEdPriv = edPriv
    this.adminXPriv = xPriv
  }

  unloadAdminKeys(): void {
    this.adminEdPriv = null
    this.adminXPriv = null
    this.adminDecryptedFps.clear()
    this.stopPauseRebroadcast()
  }

  // All admin senders below also applyAdmin locally. Supabase broadcasts with
  // `self: false`, so the admin never receives their own message back — without
  // this self-apply, the admin's client state wouldn't reflect their own actions
  // (e.g. banned users would keep appearing in admin's log).

  async adminDelete(targetId: string): Promise<void> {
    if (!this.adminEdPriv || !this.channel) return
    const signed = signAdmin({ type: 'admin.delete', target_id: targetId, ts: Date.now() }, this.adminEdPriv)
    await this.channel.send({ type: 'broadcast', event: 'admin', payload: signed })
    this.applyAdmin(signed)
  }

  async adminBan(kind: 'nick' | 'fp', target: string, duration_ms: number): Promise<void> {
    if (!this.adminEdPriv || !this.channel) return
    const signed = signAdmin({ type: 'admin.ban', kind, target, duration_ms, ts: Date.now() }, this.adminEdPriv)
    await this.channel.send({ type: 'broadcast', event: 'admin', payload: signed })
    this.applyAdmin(signed)
  }

  async adminUnban(kind: 'nick' | 'fp', target: string): Promise<void> {
    if (!this.adminEdPriv || !this.channel) return
    const signed = signAdmin({ type: 'admin.unban', kind, target, ts: Date.now() }, this.adminEdPriv)
    await this.channel.send({ type: 'broadcast', event: 'admin', payload: signed })
    this.applyAdmin(signed)
  }

  getActiveBans(): Array<{ kind: 'nick' | 'fp'; target: string; expiresAt: number }> {
    const now = Date.now()
    const out: Array<{ kind: 'nick' | 'fp'; target: string; expiresAt: number }> = []
    for (const [key, exp] of this.localBans.entries()) {
      if (exp <= now) continue
      const colon = key.indexOf(':')
      if (colon < 0) continue
      const kindStr = key.slice(0, colon)
      if (kindStr !== 'nick' && kindStr !== 'fp') continue
      out.push({ kind: kindStr, target: key.slice(colon + 1), expiresAt: exp })
    }
    return out.sort((a, b) => a.expiresAt - b.expiresAt)
  }

  async adminPause(reason: string, duration_ms: number): Promise<void> {
    if (!this.adminEdPriv || !this.channel) return
    const signed = signAdmin(
      { type: 'admin.pause', reason, until: Date.now() + duration_ms, ts: Date.now() },
      this.adminEdPriv,
    )
    await this.channel.send({ type: 'broadcast', event: 'admin', payload: signed })
    this.applyAdmin(signed)
  }

  async adminUnpause(): Promise<void> {
    if (!this.adminEdPriv || !this.channel) return
    const signed = signAdmin({ type: 'admin.unpause', ts: Date.now() }, this.adminEdPriv)
    await this.channel.send({ type: 'broadcast', event: 'admin', payload: signed })
    this.applyAdmin(signed)
  }

  private ensurePauseTick(): void {
    if (this.pauseTickTimer) return
    this.pauseTickTimer = setInterval(() => {
      if (this.state.pauseUntil !== null && Date.now() >= this.state.pauseUntil) {
        this.setState({
          status: this.channel ? 'connected' : 'closed',
          pauseUntil: null,
          pauseReason: null,
        })
        if (this.pauseTickTimer) {
          clearInterval(this.pauseTickTimer)
          this.pauseTickTimer = null
        }
      }
    }, 1_500)
  }

  private maybeStartPauseRebroadcast(pause: { reason: string; until: number }): void {
    if (!this.adminEdPriv) return  // only admins re-broadcast
    if (this.pauseRebroadcastTimer) return
    this.pauseRebroadcastTimer = setInterval(async () => {
      if (!this.adminEdPriv || !this.channel) return this.stopPauseRebroadcast()
      if (this.state.pauseUntil === null || Date.now() >= this.state.pauseUntil) {
        return this.stopPauseRebroadcast()
      }
      const signed = signAdmin(
        { type: 'admin.pause', reason: pause.reason, until: pause.until, ts: Date.now() },
        this.adminEdPriv,
      )
      await this.channel.send({ type: 'broadcast', event: 'admin', payload: signed })
    }, 30_000)
  }

  private stopPauseRebroadcast(): void {
    if (this.pauseRebroadcastTimer) {
      clearInterval(this.pauseRebroadcastTimer)
      this.pauseRebroadcastTimer = null
    }
  }

  private applyAdmin(a: any): void {
    switch (a.type) {
      case 'admin.delete': {
        const next = this.state.messages.filter(m => m.id !== a.target_id)
        if (next.length !== this.state.messages.length) this.setState({ messages: next })
        return
      }
      case 'admin.ban': {
        if (a.kind !== 'nick' && a.kind !== 'fp') return
        if (typeof a.target !== 'string' || typeof a.duration_ms !== 'number') return
        const key = `${a.kind}:${a.target}` // 'nick:<nick>' or 'fp:<plaintext-fp>'
        this.localBans.set(key, Date.now() + a.duration_ms)
        return
      }
      case 'admin.unban': {
        if (a.kind !== 'nick' && a.kind !== 'fp') return
        if (typeof a.target !== 'string') return
        const key = `${a.kind}:${a.target}`
        this.localBans.delete(key)
        return
      }
      case 'admin.pause': {
        if (typeof a.reason !== 'string' || typeof a.until !== 'number') return
        this.setState({
          status: 'paused',
          pauseUntil: a.until,
          pauseReason: a.reason.slice(0, 80),
        })
        this.maybeStartPauseRebroadcast({ reason: a.reason, until: a.until })
        this.ensurePauseTick()
        return
      }
      case 'admin.unpause': {
        this.setState({
          status: this.channel ? 'connected' : 'closed',
          pauseUntil: null,
          pauseReason: null,
        })
        this.stopPauseRebroadcast()
        return
      }
      case 'admin.config': {
        if (typeof a.rate_limit_ms !== 'number' || a.rate_limit_ms < 0) return
        this.rateLimitMs = a.rate_limit_ms
        return
      }
    }
  }

  getRateLimitMs(): number {
    return this.rateLimitMs
  }

  async adminSetRateLimit(rate_limit_ms: number): Promise<void> {
    if (!this.adminEdPriv || !this.channel) return
    const signed = signAdmin(
      { type: 'admin.config', rate_limit_ms, ts: Date.now() },
      this.adminEdPriv,
    )
    await this.channel.send({ type: 'broadcast', event: 'admin', payload: signed })
    this.applyAdmin(signed)
  }

  private isValidChat(p: any): boolean {
    return p && p.type === 'chat'
      && typeof p.id === 'string'
      && typeof p.ts === 'number'
      && typeof p.nick === 'string'
      && typeof p.fp_enc === 'string'
      && typeof p.text === 'string'
  }

  async sendChat(
    nick: string,
    text: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.state.status === 'paused') {
      return { ok: false, reason: 'paused' }
    }
    if (!this.channel || this.state.status !== 'connected') {
      return { ok: false, reason: 'not-connected' }
    }
    // If our own nick is banned locally, refuse to send so the sender sees
    // the ban take effect (local-echo would otherwise make it look like posts worked).
    const nickKey = `nick:${nick.slice(0, 24).trim()}`
    const nickBanExp = this.localBans.get(nickKey)
    if (nickBanExp !== undefined && nickBanExp > Date.now()) {
      return { ok: false, reason: 'banned' }
    }
    const now = Date.now()
    if (this.rateLimitMs > 0 && now - this.lastSendAt < this.rateLimitMs) {
      return { ok: false, reason: 'rate-limit' }
    }
    this.lastSendAt = now

    const fp_enc = sealFp(this.deps.machineHash, this.deps.adminX25519Pub)
    const payload: ChatMsg = {
      type: 'chat',
      id: nanoid(10),
      ts: now,
      nick: nick.slice(0, 24).trim(),
      fp_enc,
      text: text.slice(0, 280),
    }
    await this.channel.send({ type: 'broadcast', event: 'chat', payload })

    // Local echo: Supabase is configured with `broadcast: { self: false }` so the
    // server never echoes our own message back. Append to our local buffer so
    // the sender sees their own message immediately.
    const next = [...this.state.messages, payload]
    if (next.length > MAX_BUFFER) next.splice(0, next.length - MAX_BUFFER)
    this.setState({ messages: next })
    // Admin-side: cache our own plaintext fp too, so fp-ban actions on our own
    // messages work symmetrically with those on remote messages.
    if (this.adminXPriv) {
      this.adminDecryptedFps.set(payload.id, this.deps.machineHash)
    }
    return { ok: true }
  }

  getState(): TrollboxState { return this.state }

  protected setState(patch: Partial<TrollboxState>): void {
    this.state = { ...this.state, ...patch }
    for (const cb of this.listeners) cb(this.state)
  }
}
