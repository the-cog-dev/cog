import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TokenManager, SESSION_EXPIRY_MS } from '../../src/main/remote/token-manager'

const DEFAULT_EXPIRY_MS = 8 * 60 * 60 * 1000  // matches default in token-manager

describe('TokenManager', () => {
  let now: number
  let mgr: TokenManager

  beforeEach(() => {
    now = 1_000_000
    mgr = new TokenManager(() => now)
  })

  describe('token lifecycle', () => {
    it('starts with no active token', () => {
      expect(mgr.getCurrentToken()).toBeNull()
      expect(mgr.isValid('anything')).toBe(false)
    })

    it('generate() creates a new URL-safe token', () => {
      const token = mgr.generate()
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(token.length).toBeGreaterThanOrEqual(32)
      expect(mgr.getCurrentToken()).toBe(token)
    })

    it('isValid() returns true for the current token', () => {
      const token = mgr.generate()
      expect(mgr.isValid(token)).toBe(true)
    })

    it('isValid() returns false for an old token after regenerate', () => {
      const t1 = mgr.generate()
      const t2 = mgr.generate()
      expect(mgr.isValid(t1)).toBe(false)
      expect(mgr.isValid(t2)).toBe(true)
    })

    it('isValid() returns false after token expires from inactivity', () => {
      const token = mgr.generate()
      now += DEFAULT_EXPIRY_MS + 1
      expect(mgr.isValid(token)).toBe(false)
    })

    it('bumpActivity() resets inactivity timer', () => {
      const token = mgr.generate()
      now += DEFAULT_EXPIRY_MS - 1000
      mgr.bumpActivity()
      now += DEFAULT_EXPIRY_MS - 1000
      expect(mgr.isValid(token)).toBe(true)
    })

    it('invalidate() kills the token immediately', () => {
      const token = mgr.generate()
      mgr.invalidate()
      expect(mgr.isValid(token)).toBe(false)
      expect(mgr.getCurrentToken()).toBeNull()
    })
  })

  describe('session tracking', () => {
    it('starts with zero sessions', () => {
      expect(mgr.getActiveSessions()).toHaveLength(0)
      expect(mgr.getConnectionCount()).toBe(0)
    })

    it('trackSession(ip) adds new session', () => {
      mgr.generate()
      mgr.trackSession('1.2.3.4')
      expect(mgr.getConnectionCount()).toBe(1)
      const sessions = mgr.getActiveSessions()
      expect(sessions[0].ip).toBe('1.2.3.4')
      expect(sessions[0].firstSeen).toBe(now)
      expect(sessions[0].lastSeen).toBe(now)
    })

    it('trackSession() updates lastSeen for existing IP', () => {
      mgr.generate()
      mgr.trackSession('1.2.3.4')
      const firstTime = now
      now += 30_000
      mgr.trackSession('1.2.3.4')
      expect(mgr.getConnectionCount()).toBe(1)
      const [s] = mgr.getActiveSessions()
      expect(s.firstSeen).toBe(firstTime)
      expect(s.lastSeen).toBe(now)
    })

    it('tracks multiple unique IPs as separate sessions', () => {
      mgr.generate()
      mgr.trackSession('1.1.1.1')
      mgr.trackSession('2.2.2.2')
      expect(mgr.getConnectionCount()).toBe(2)
    })

    it('getConnectionCount() excludes sessions inactive longer than SESSION_EXPIRY_MS', () => {
      mgr.generate()
      mgr.trackSession('1.1.1.1')
      mgr.trackSession('2.2.2.2')
      now += 30_000
      mgr.trackSession('2.2.2.2') // refresh second only
      now += SESSION_EXPIRY_MS - 30_000 + 1
      expect(mgr.getConnectionCount()).toBe(1)
    })

    it('killAllSessions() clears the sessions map AND regenerates the token', () => {
      const t1 = mgr.generate()
      mgr.trackSession('1.1.1.1')
      mgr.killAllSessions()
      expect(mgr.getConnectionCount()).toBe(0)
      expect(mgr.isValid(t1)).toBe(false)
      // A new token has been generated
      expect(mgr.getCurrentToken()).not.toBeNull()
      expect(mgr.getCurrentToken()).not.toBe(t1)
    })

    it('invalidate() also clears sessions', () => {
      mgr.generate()
      mgr.trackSession('1.1.1.1')
      mgr.invalidate()
      expect(mgr.getConnectionCount()).toBe(0)
    })

    it('lastActivity returns the most recent bumpActivity time, or null if none', () => {
      expect(mgr.getLastActivity()).toBeNull()
      mgr.generate()
      expect(mgr.getLastActivity()).toBe(now)
      now += 5000
      mgr.bumpActivity()
      expect(mgr.getLastActivity()).toBe(now)
    })
  })
})
