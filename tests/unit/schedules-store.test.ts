import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createDatabase } from '../../src/main/db/database'
import { SchedulesStore } from '../../src/main/scheduler/schedules-store'
import type { ScheduledPrompt } from '../../src/shared/types'

function sampleSchedule(overrides: Partial<ScheduledPrompt> = {}): ScheduledPrompt {
  return {
    id: 'sched-1',
    tabId: 'tab-default',
    agentId: 'agent-1',
    name: 'Keep going',
    promptText: 'keep going please',
    intervalMinutes: 45,
    durationHours: 8,
    startedAt: 1_000_000,
    expiresAt: 1_000_000 + 8 * 60 * 60_000,
    nextFireAt: 1_000_000 + 45 * 60_000,
    pausedAt: null,
    status: 'active',
    fireHistory: [],
    ...overrides
  }
}

describe('SchedulesStore', () => {
  let db: Database.Database
  let store: SchedulesStore

  beforeEach(() => {
    db = createDatabase(':memory:')
    store = new SchedulesStore(db)
  })

  it('saves and retrieves a schedule (round-trip all fields)', () => {
    const s = sampleSchedule()
    store.save(s)
    const loaded = store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toEqual(s)
  })

  it('persists fireHistory as JSON round-trip', () => {
    const s = sampleSchedule({
      fireHistory: [
        { timestamp: 1, outcome: 'fired' },
        { timestamp: 2, outcome: 'skipped_offline' }
      ]
    })
    store.save(s)
    const [loaded] = store.load()
    expect(loaded.fireHistory).toEqual(s.fireHistory)
  })

  it('persists null durationHours and expiresAt', () => {
    const s = sampleSchedule({ durationHours: null, expiresAt: null })
    store.save(s)
    const [loaded] = store.load()
    expect(loaded.durationHours).toBeNull()
    expect(loaded.expiresAt).toBeNull()
  })

  it('persists null pausedAt on active schedules', () => {
    const s = sampleSchedule()
    store.save(s)
    const [loaded] = store.load()
    expect(loaded.pausedAt).toBeNull()
  })

  it('persists pausedAt on paused schedules', () => {
    const s = sampleSchedule({ status: 'paused', pausedAt: 1_500_000 })
    store.save(s)
    const [loaded] = store.load()
    expect(loaded.pausedAt).toBe(1_500_000)
    expect(loaded.status).toBe('paused')
  })

  it('updates an existing schedule by id (upsert)', () => {
    store.save(sampleSchedule({ name: 'First' }))
    store.save(sampleSchedule({ name: 'Updated' }))
    const loaded = store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].name).toBe('Updated')
  })

  it('deletes a schedule by id', () => {
    store.save(sampleSchedule({ id: 'a' }))
    store.save(sampleSchedule({ id: 'b' }))
    store.delete('a')
    const loaded = store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('b')
  })

  it('deletes all schedules for a given tabId', () => {
    store.save(sampleSchedule({ id: 'a', tabId: 'tab-1' }))
    store.save(sampleSchedule({ id: 'b', tabId: 'tab-1' }))
    store.save(sampleSchedule({ id: 'c', tabId: 'tab-2' }))
    store.deleteByTabId('tab-1')
    const loaded = store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('c')
  })

  it('load returns schedules ordered by startedAt ascending', () => {
    store.save(sampleSchedule({ id: 'a', startedAt: 3000 }))
    store.save(sampleSchedule({ id: 'b', startedAt: 1000 }))
    store.save(sampleSchedule({ id: 'c', startedAt: 2000 }))
    const loaded = store.load()
    expect(loaded.map(s => s.id)).toEqual(['b', 'c', 'a'])
  })

  it('load returns empty array when table is empty', () => {
    expect(store.load()).toEqual([])
  })
})
