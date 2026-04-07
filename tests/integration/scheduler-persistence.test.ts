import { describe, it, expect, vi } from 'vitest'
import { createDatabase } from '../../src/main/db/database'
import { SchedulesStore } from '../../src/main/scheduler/schedules-store'
import { PromptScheduler } from '../../src/main/scheduler/prompt-scheduler'
import type { CreateScheduleInput } from '../../src/shared/types'

const HOUR_MS = 60 * 60_000
const MINUTE_MS = 60_000

const input: CreateScheduleInput = {
  tabId: 'tab-default',
  agentId: 'agent-1',
  name: 'Keep going',
  promptText: 'keep going please',
  intervalMinutes: 45,
  durationHours: 8
}

describe('Scheduler persistence round-trip', () => {
  it('resumes active/paused/stopped/expired schedules correctly after a simulated restart', () => {
    const db = createDatabase(':memory:')
    const store = new SchedulesStore(db)

    // --- First session: create and manipulate schedules ---
    let now = 1_000_000
    const firstSession = new PromptScheduler({
      store,
      clock: () => now,
      ptyWriter: vi.fn(),
      agentLookup: () => true,
      onChange: vi.fn(),
      onResumed: vi.fn()
    })
    firstSession.load()

    const a = firstSession.create(input) // active
    const b = firstSession.create({ ...input, name: 'Second' })
    const c = firstSession.create({ ...input, name: 'Will be paused' })
    const d = firstSession.create({ ...input, name: 'Will be stopped' })

    now = 1_000_000 + 10 * MINUTE_MS
    firstSession.pause(c.id)
    firstSession.stop(d.id)

    // --- Second session: load from store (simulating app restart) ---
    now = 1_000_000 + 20 * MINUTE_MS // 20 min later, no missed fires yet
    const onResumed = vi.fn()
    const secondSession = new PromptScheduler({
      store,
      clock: () => now,
      ptyWriter: vi.fn(),
      agentLookup: () => true,
      onChange: vi.fn(),
      onResumed
    })
    secondSession.load()

    const list = secondSession.list()
    expect(list).toHaveLength(4)
    expect(secondSession.get(a.id)!.status).toBe('active')
    expect(secondSession.get(b.id)!.status).toBe('active')
    expect(secondSession.get(c.id)!.status).toBe('paused')
    expect(secondSession.get(d.id)!.status).toBe('stopped')

    // Two schedules were active when loaded
    expect(onResumed).toHaveBeenCalledWith(2)
  })

  it('expired schedules stay expired after restart and are not counted in resume count', () => {
    const db = createDatabase(':memory:')
    const store = new SchedulesStore(db)

    let now = 1_000_000
    const firstSession = new PromptScheduler({
      store,
      clock: () => now,
      ptyWriter: vi.fn(),
      agentLookup: () => true,
      onChange: vi.fn(),
      onResumed: vi.fn()
    })
    firstSession.load()
    const a = firstSession.create({ ...input, durationHours: 1 })

    // Second session: simulate restart well past the expiresAt
    now = 1_000_000 + 10 * HOUR_MS
    const onResumed = vi.fn()
    const secondSession = new PromptScheduler({
      store,
      clock: () => now,
      ptyWriter: vi.fn(),
      agentLookup: () => true,
      onChange: vi.fn(),
      onResumed
    })
    secondSession.load()

    expect(secondSession.get(a.id)!.status).toBe('expired')
    expect(onResumed).toHaveBeenCalledWith(0)
  })

  it('discards missed fires on load (no burst of catch-up fires)', () => {
    const db = createDatabase(':memory:')
    const store = new SchedulesStore(db)

    let now = 1_000_000
    const firstPty = vi.fn()
    const firstSession = new PromptScheduler({
      store,
      clock: () => now,
      ptyWriter: firstPty,
      agentLookup: () => true,
      onChange: vi.fn(),
      onResumed: vi.fn()
    })
    firstSession.load()
    const a = firstSession.create({ ...input, durationHours: null }) // infinite

    // Simulate 10 hours passing while the app is closed
    now = 1_000_000 + 10 * HOUR_MS

    // Second session resumes
    const secondPty = vi.fn()
    const secondSession = new PromptScheduler({
      store,
      clock: () => now,
      ptyWriter: secondPty,
      agentLookup: () => true,
      onChange: vi.fn(),
      onResumed: vi.fn()
    })
    secondSession.load()

    // No fires should have been replayed during load
    expect(firstPty).not.toHaveBeenCalled()
    expect(secondPty).not.toHaveBeenCalled()

    // nextFireAt should now be now + 45 minutes, not burst-firing
    const loaded = secondSession.get(a.id)!
    expect(loaded.nextFireAt).toBe(now + 45 * MINUTE_MS)

    // A single tick right after load should NOT fire
    secondSession.tick()
    expect(secondPty).not.toHaveBeenCalled()
  })

  it('cascade delete removes all schedules for a tab across restart', () => {
    const db = createDatabase(':memory:')
    const store = new SchedulesStore(db)

    let now = 1_000_000
    const firstSession = new PromptScheduler({
      store,
      clock: () => now,
      ptyWriter: vi.fn(),
      agentLookup: () => true,
      onChange: vi.fn(),
      onResumed: vi.fn()
    })
    firstSession.load()
    firstSession.create({ ...input, tabId: 'tab-1' })
    firstSession.create({ ...input, tabId: 'tab-1', name: 'Second' })
    firstSession.create({ ...input, tabId: 'tab-2', name: 'Third' })
    firstSession.deleteByTabId('tab-1')

    const secondSession = new PromptScheduler({
      store,
      clock: () => now,
      ptyWriter: vi.fn(),
      agentLookup: () => true,
      onChange: vi.fn(),
      onResumed: vi.fn()
    })
    secondSession.load()
    const list = secondSession.list()
    expect(list).toHaveLength(1)
    expect(list[0].tabId).toBe('tab-2')
  })
})
