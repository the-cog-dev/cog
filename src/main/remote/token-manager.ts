import { randomBytes } from 'crypto'

export const TOKEN_EXPIRY_MS = 8 * 60 * 60 * 1000   // 8 hours
export const SESSION_EXPIRY_MS = 2 * 60 * 1000      // 2 minutes
const TOKEN_BYTE_LENGTH = 24                         // 24 bytes => 32-char base64url

export interface RemoteSession {
  ip: string
  firstSeen: number
  lastSeen: number
}

export class TokenManager {
  private currentToken: string | null = null
  private lastActivity: number | null = null
  private sessions = new Map<string, RemoteSession>()

  constructor(private clock: () => number = Date.now) {}

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
    if (token !== this.currentToken) return false
    if (this.lastActivity === null) return false
    if (this.clock() - this.lastActivity > TOKEN_EXPIRY_MS) return false
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

  getConnectionCount(): number {
    return this.getActiveSessions().length
  }

  getLastActivity(): number | null {
    return this.lastActivity
  }
}
