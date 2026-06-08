import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/main/db/database'
import { AutonomyStore } from '../../src/main/db/autonomy-store'

describe('AutonomyStore', () => {
  it('defaults to no active session', () => {
    const s = new AutonomyStore(createDatabase(':memory:'))
    expect(s.get().sessionExpiresAt).toBeNull()
    expect(s.isActive()).toBe(false)
  })

  it('startSession sets a future expiry and is active inside the window', () => {
    const now = 1_000_000
    const s = new AutonomyStore(createDatabase(':memory:'), () => now)
    const r = s.startSession(6)
    expect(r.sessionExpiresAt).toBe(now + 6 * 3_600_000)
    expect(s.isActive()).toBe(true)
  })

  it('isActive flips to false at and after expiry', () => {
    let now = 0
    const s = new AutonomyStore(createDatabase(':memory:'), () => now)
    s.startSession(1) // expires at 3_600_000
    now = 3_600_000
    expect(s.isActive()).toBe(false)
    now = 3_600_001
    expect(s.isActive()).toBe(false)
  })

  it('clamps duration to [0.25, 72] hours', () => {
    const now = 0
    const s = new AutonomyStore(createDatabase(':memory:'), () => now)
    expect(s.startSession(999).sessionExpiresAt).toBe(72 * 3_600_000)
    expect(s.startSession(0).sessionExpiresAt).toBe(0.25 * 3_600_000)
  })

  it('endSession clears the window', () => {
    const s = new AutonomyStore(createDatabase(':memory:'))
    s.startSession(6)
    s.endSession()
    expect(s.get().sessionExpiresAt).toBeNull()
    expect(s.isActive()).toBe(false)
  })

  it('reads a legacy { scheduling:true } value as off', () => {
    const db = createDatabase(':memory:')
    db.prepare(`INSERT INTO project_settings (key, value) VALUES ('autonomy', ?)`).run(JSON.stringify({ scheduling: true }))
    expect(new AutonomyStore(db).get().sessionExpiresAt).toBeNull()
  })

  it('rehydrates an in-window session from the DB', () => {
    const now = 5_000_000
    const db = createDatabase(':memory:')
    new AutonomyStore(db, () => now).startSession(2)
    expect(new AutonomyStore(db, () => now).isActive()).toBe(true)
  })
})
