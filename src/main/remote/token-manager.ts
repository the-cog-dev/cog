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

  trackSession(ip: string): void {
    const now = this.clock()
    const existing = this.sessions.get(ip)
    if (existing) {
      existing.lastSeen = now
    } else {
      this.sessions.set(ip, { ip, firstSeen: now, lastSeen: now })
    }
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
    return this.getActiveSessions().length
  }

  getLastActivity(): number | null {
    return this.lastActivity
  }
}
