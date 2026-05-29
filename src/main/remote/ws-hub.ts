import type { IncomingMessage } from 'http'
import type { Server as HttpServer } from 'http'
import type { Duplex } from 'stream'
import { WebSocketServer, WebSocket } from 'ws'
import type { TokenManager } from './token-manager'

// WebSocket protocol — minimal, JSON-only. The server pushes notifications;
// clients send subscribe/unsubscribe and the server fans out matching events.
//
// Client → Server messages:
//   { type: 'subscribe.output', agentId }
//   { type: 'unsubscribe.output', agentId }
//   { type: 'ping' }
//
// Server → Client messages:
//   { type: 'hello', deviceId, serverTime }
//   { type: 'agent.output', agentId, chunk: string }
//   { type: 'state.delta', changed: ('agents' | 'schedules' | 'inbox' | 'pinboard' | 'info')[] }
//   { type: 'pong' }
//
// The protocol is intentionally fire-and-forget. The HTTP /state endpoint
// remains the authoritative snapshot — WS deltas just tell the client when
// to re-fetch or which subset to refresh. Output deltas carry payload because
// they're the high-volume case that polling handled poorly.

export type WsServerToClient =
  | { type: 'hello'; deviceId: string | null; serverTime: number }
  | { type: 'agent.output'; agentId: string; chunk: string }
  | { type: 'state.delta'; changed: Array<'agents' | 'schedules' | 'inbox' | 'pinboard' | 'info'> }
  | { type: 'pong' }

export type WsClientToServer =
  | { type: 'subscribe.output'; agentId: string }
  | { type: 'unsubscribe.output'; agentId: string }
  | { type: 'ping' }

interface ConnectionState {
  ws: WebSocket
  deviceId: string | null
  ip: string
  outputSubs: Set<string>  // agentIds the client is watching
  lastPing: number
}

const WS_PATH_RE = /^\/r\/([A-Za-z0-9_-]+)\/ws$/
const PING_INTERVAL_MS = 30_000  // keep-alive — mobile sleep can drop idle sockets
const MAX_MESSAGE_BYTES = 4 * 1024  // client → server messages are tiny

export class RemoteWsHub {
  private wss: WebSocketServer
  private conns = new Set<ConnectionState>()
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null

  constructor(private tokenManager: TokenManager) {
    // noServer: true means we handle the HTTP upgrade ourselves so we can
    // gate it on token validity before allocating a WebSocket. This avoids
    // the cost (and DoS surface) of completing the WS handshake for any IP
    // that knows the URL pattern but not the token.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
    this.heartbeatHandle = setInterval(() => this.heartbeat(), PING_INTERVAL_MS)
  }

  attachToServer(httpServer: HttpServer): void {
    httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = req.url || ''
    const match = url.match(WS_PATH_RE)
    if (!match) {
      socket.destroy()
      return
    }
    const token = match[1]
    if (!this.tokenManager.isValid(token)) {
      // Mirror HTTP /state's 404 — never confirm a token is wrong.
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.tokenManager.bumpActivity()
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown'

    // Recover deviceId from the cookie if the client carries one. The HTTP
    // auth middleware would have set this on prior HTTP requests; the WS
    // upgrade just reads it back.
    let deviceId: string | null = null
    const cookie = req.headers.cookie
    if (typeof cookie === 'string') {
      const match = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('cog_did='))
      if (match) {
        const value = match.slice('cog_did='.length)
        if (/^[A-Za-z0-9_-]+$/.test(value)) deviceId = value
      }
    }
    this.tokenManager.trackSession(ip, deviceId ?? undefined, typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 200) : undefined)

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const state: ConnectionState = { ws, deviceId, ip, outputSubs: new Set(), lastPing: Date.now() }
      this.conns.add(state)
      ws.on('message', (data) => this.handleMessage(state, data.toString()))
      ws.on('close', () => { this.conns.delete(state) })
      ws.on('error', () => { /* `close` will fire next */ })
      // Send hello so the client can confirm WS is live and pick up its
      // device id (mainly for debugging — the cookie still carries it).
      this.send(state, { type: 'hello', deviceId, serverTime: Date.now() })
    })
  }

  private handleMessage(state: ConnectionState, raw: string): void {
    let msg: any
    try { msg = JSON.parse(raw) } catch { return }
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'subscribe.output':
        if (typeof msg.agentId === 'string') state.outputSubs.add(msg.agentId)
        return
      case 'unsubscribe.output':
        if (typeof msg.agentId === 'string') state.outputSubs.delete(msg.agentId)
        return
      case 'ping':
        state.lastPing = Date.now()
        this.send(state, { type: 'pong' })
        return
    }
  }

  // ── Broadcast surface ────────────────────────────────────────────────
  // These are the only methods the main process should call. They never
  // throw — broken connections are pruned on the next heartbeat.

  pushAgentOutput(agentId: string, chunk: string): void {
    if (chunk.length === 0) return
    // Find subscribers without allocating the JSON when nobody listens.
    let hasSubscribers = false
    for (const conn of this.conns) {
      if (conn.outputSubs.has(agentId)) { hasSubscribers = true; break }
    }
    if (!hasSubscribers) return
    const msg: WsServerToClient = { type: 'agent.output', agentId, chunk }
    for (const conn of this.conns) {
      if (conn.outputSubs.has(agentId)) this.send(conn, msg)
    }
  }

  pushStateDelta(changed: Array<'agents' | 'schedules' | 'inbox' | 'pinboard' | 'info'>): void {
    if (changed.length === 0) return
    const msg: WsServerToClient = { type: 'state.delta', changed }
    for (const conn of this.conns) this.send(conn, msg)
  }

  // ── Internals ────────────────────────────────────────────────────────

  private send(conn: ConnectionState, payload: WsServerToClient): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return
    try { conn.ws.send(JSON.stringify(payload)) } catch { /* prune on next heartbeat */ }
  }

  private heartbeat(): void {
    for (const conn of this.conns) {
      if (conn.ws.readyState === WebSocket.CLOSED || conn.ws.readyState === WebSocket.CLOSING) {
        this.conns.delete(conn)
        continue
      }
      // ping() schedules a control frame; clients reply with pong, ws lib
      // tracks it. We just use it as a liveness signal. If the socket is
      // wedged, ws will eventually close it.
      try { conn.ws.ping() } catch { /* ignore */ }
    }
  }

  close(): void {
    if (this.heartbeatHandle) { clearInterval(this.heartbeatHandle); this.heartbeatHandle = null }
    for (const conn of this.conns) {
      try { conn.ws.close(1001, 'server shutting down') } catch { /* ignore */ }
    }
    this.conns.clear()
    this.wss.close()
  }
}
