import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/main/db/database'
import { AutonomyStore } from '../../src/main/db/autonomy-store'

describe('AutonomyStore', () => {
  it('defaults scheduling to false', () => {
    const s = new AutonomyStore(createDatabase(':memory:'))
    expect(s.get().scheduling).toBe(false)
  })
  it('persists scheduling toggle', () => {
    const db = createDatabase(':memory:')
    new AutonomyStore(db).set({ scheduling: true })
    expect(new AutonomyStore(db).get().scheduling).toBe(true)
  })
})
