import { randomBytes, timingSafeEqual } from 'crypto'

const DEFAULT_EXPIRY_MS = 8 * 60 * 60 * 1000         // 8 hours
const MAX_EXPIRY_MS = 168 * 60 * 60 * 1000            // 7 days
export const SESSION_EXPIRY_MS = 2 * 60 * 1000      // 2 minutes
const TOKEN_BYTE_LENGTH = 24                         // 24 bytes => 32-char base64url

export interface RemoteSession {
  ip: string
  firstSeen: number
  lastSeen: number
  workshopVerified?: boolean
  // Per-device identity. A device gets a random id on first connect and keeps
  // it across reloads (cookie-backed). Multiple devices behind the same NAT
  // share an `ip` — `devices` lets us count and audit each one separately.
  devices?: Map<string, RemoteDevice>
}

export interface RemoteDevice {
  id: string
  firstSeen: number
  lastSeen: number
  userAgent?: string
}

export class TokenManager {
  private currentToken: string | null = null
  private lastActivity: number | null = null
  private sessions = new Map<string, RemoteSession>()
  private expiryMs: number = DEFAULT_EXPIRY_MS

  constructor(private clock: () => number = Date.now) {}

  setExpiryDuration(ms: number): void {
    this.expiryMs = Math.min(Math.max(ms, 0), MAX_EXPIRY_MS)
    if (this.lastActivity !== null) {
      this.lastActivity = this.clock()
    }
  }

  getExpiresAt(): number | null {
    if (this.lastActivity === null) return null
    return this.lastActivity + this.expiryMs
  }

  generate(): string {
    this.currentToken = randomBytes(TOKEN_BYTE_LENGTH).toString('base64url')
    this.lastActivity = this.clock()
    return this.currentToken
  }

  getCurrentToken(): string | null {
    return this.currentToken
  }

  isValid(token: string): boolean {
    if (!this.currentToken) return false
    if (typeof token !== 'string') return false
    // Constant-time compare so the endpoint can't be used as a timing oracle
    const a = Buffer.from(token)
    const b = Buffer.from(this.currentToken)
    if (a.length !== b.length) return false
    if (!timingSafeEqual(a, b)) return false
    if (this.lastActivity === null) return false
    if (this.clock() - this.lastActivity > this.expiryMs) return false
    return true
  }

  bumpActivity(): void {
    this.lastActivity = this.clock()
  }

  invalidate(): void {
    this.currentToken = null
    this.lastActivity = null
    this.sessions.clear()
  }

  killAllSessions(): void {
    this.sessions.clear()
    this.generate()  // also rotate the token
  }

  trackSession(ip: string, deviceId?: string, userAgent?: string): void {
    const now = this.clock()
    let session = this.sessions.get(ip)
    if (!session) {
      session = { ip, firstSeen: now, lastSeen: now, devices: new Map() }
      this.sessions.set(ip, session)
    } else {
      session.lastSeen = now
      if (!session.devices) session.devices = new Map()
    }
    if (deviceId) {
      const existing = session.devices!.get(deviceId)
      if (existing) {
        existing.lastSeen = now
        if (userAgent && !existing.userAgent) existing.userAgent = userAgent
      } else {
        session.devices!.set(deviceId, { id: deviceId, firstSeen: now, lastSeen: now, userAgent })
      }
    }
  }

  // Issues a fresh device id. Caller is responsible for round-tripping it via
  // a cookie. Format mirrors the session token: 16 random bytes, base64url —
  // collision-resistant enough that we never reissue per IP.
  generateDeviceId(): string {
    return randomBytes(16).toString('base64url')
  }

  getActiveDevices(): RemoteDevice[] {
    const now = this.clock()
    const devices: RemoteDevice[] = []
    for (const session of this.sessions.values()) {
      if (!session.devices) continue
      for (const dev of session.devices.values()) {
        if (now - dev.lastSeen <= SESSION_EXPIRY_MS) devices.push(dev)
      }
    }
    return devices
  }

  getActiveSessions(): RemoteSession[] {
    const now = this.clock()
    const active: RemoteSession[] = []
    for (const session of this.sessions.values()) {
      if (now - session.lastSeen <= SESSION_EXPIRY_MS) {
        active.push(session)
      }
    }
    return active
  }

  verifyWorkshop(ip: string): void {
    const session = this.sessions.get(ip)
    if (session) session.workshopVerified = true
  }

  isWorkshopVerified(ip: string): boolean {
    const session = this.sessions.get(ip)
    return session?.workshopVerified === true
  }

  getConnectionCount(): number {
    // Prefer per-device count when at least one device has identified itself.
    // Falls back to per-IP for legacy clients (3DS, PSP) that don't store cookies.
    const devCount = this.getActiveDevices().length
    return devCount > 0 ? devCount : this.getActiveSessions().length
  }

  getLastActivity(): number | null {
    return this.lastActivity
  }
}
