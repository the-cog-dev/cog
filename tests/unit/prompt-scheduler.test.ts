import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createDatabase } from '../../src/main/db/database'
import { SchedulesStore } from '../../src/main/scheduler/schedules-store'
import { PromptScheduler } from '../../src/main/scheduler/prompt-scheduler'
import type { CreateScheduleInput } from '../../src/shared/types'

function makeScheduler(overrides: {
  now?: () => number
  ptyWriter?: (id: string, text: string) => void
  agentLookup?: (id: string) => boolean
  onChange?: () => void
  onResumed?: (count: number) => void
} = {}) {
  const db = createDatabase(':memory:')
  const store = new SchedulesStore(db)
  const now = overrides.now ?? (() => 1_000_000)
  const ptyWriter = overrides.ptyWriter ?? vi.fn()
  const agentLookup = overrides.agentLookup ?? (() => true)
  const onChange = overrides.onChange ?? vi.fn()
  const onResumed = overrides.onResumed ?? vi.fn()
  const scheduler = new PromptScheduler({
    store,
    clock: now,
    ptyWriter,
    agentLookup,
    onChange,
    onResumed
  })
  return { db, store, scheduler, ptyWriter, agentLookup, onChange, onResumed }
}

const validInput: CreateScheduleInput = {
  tabId: 'tab-default',
  agentId: 'agent-1',
  name: 'Keep going',
  promptText: 'keep going please',
  intervalMinutes: 45,
  durationHours: 8
}

describe('PromptScheduler.create', () => {
  it('creates an active schedule with first fire waiting one full interval', () => {
    const { scheduler } = makeScheduler()
    const s = scheduler.create(validInput)
    expect(s.status).toBe('active')
    expect(s.startedAt).toBe(1_000_000)
    expect(s.nextFireAt).toBe(1_000_000 + 45 * 60_000)
    expect(s.expiresAt).toBe(1_000_000 + 8 * 60 * 60_000)
    expect(s.fireHistory).toEqual([])
  })

  it('defaults name to "Schedule #N" when not provided', () => {
    const { scheduler } = makeScheduler()
    const s1 = scheduler.create({ ...validInput, name: undefined })
    const s2 = scheduler.create({ ...validInput, name: undefined })
    expect(s1.name).toBe('Schedule #1')
    expect(s2.name).toBe('Schedule #2')
  })

  it('supports infinite duration', () => {
    const { scheduler } = makeScheduler()
    const s = scheduler.create({ ...validInput, durationHours: null })
    expect(s.durationHours).toBeNull()
    expect(s.expiresAt).toBeNull()
  })

  it('persists created schedule to store', () => {
    const { scheduler, store } = makeScheduler()
    scheduler.create(validInput)
    expect(store.load()).toHaveLength(1)
  })

  it('emits onChange after create', () => {
    const onChange = vi.fn()
    const { scheduler } = makeScheduler({ onChange })
    scheduler.create(validInput)
    expect(onChange).toHaveBeenCalled()
  })

  it('throws on empty promptText', () => {
    const { scheduler } = makeScheduler()
    expect(() => scheduler.create({ ...validInput, promptText: '   ' })).toThrow(/prompt/i)
  })

  it('throws on non-positive intervalMinutes', () => {
    const { scheduler } = makeScheduler()
    expect(() => scheduler.create({ ...validInput, intervalMinutes: 0 })).toThrow(/interval/i)
  })

  it('throws on non-positive durationHours when provided', () => {
    const { scheduler } = makeScheduler()
    expect(() => scheduler.create({ ...validInput, durationHours: 0 })).toThrow(/duration/i)
  })
})

describe('PromptScheduler.list', () => {
  it('returns all schedules sorted by startedAt asc', () => {
    let n = 1_000_000
    const { scheduler } = makeScheduler({ now: () => n })
    scheduler.create(validInput)
    n = 1_001_000
    scheduler.create({ ...validInput, name: 'Second' })
    const list = scheduler.list()
    expect(list).toHaveLength(2)
    expect(list[0].startedAt).toBeLessThan(list[1].startedAt)
  })
})

describe('PromptScheduler.load', () => {
  it('loads active schedules from store and emits onResumed with active count only', () => {
    const db = createDatabase(':memory:')
    const store = new SchedulesStore(db)
    store.save({
      id: 'a', tabId: 't', agentId: 'g', name: 'A', promptText: 'x',
      intervalMinutes: 45, durationHours: 8,
      startedAt: 1000, expiresAt: 1000 + 8 * 60 * 60_000,
      nextFireAt: 1000 + 45 * 60_000, pausedAt: null,
      status: 'active', fireHistory: []
    })
    store.save({
      id: 'b', tabId: 't', agentId: 'g', name: 'B', promptText: 'x',
      intervalMinutes: 45, durationHours: 8,
      startedAt: 1000, expiresAt: 1000 + 8 * 60 * 60_000,
      nextFireAt: 1000 + 45 * 60_000, pausedAt: 1500,
      status: 'paused', fireHistory: []
    })
    store.save({
      id: 'c', tabId: 't', agentId: 'g', name: 'C', promptText: 'x',
      intervalMinutes: 45, durationHours: 8,
      startedAt: 1000, expiresAt: 2000,
      nextFireAt: 1000 + 45 * 60_000, pausedAt: null,
      status: 'expired', fireHistory: []
    })
    const onResumed = vi.fn()
    const scheduler = new PromptScheduler({
      store,
      clock: () => 1_500_000,
      ptyWriter: vi.fn(),
      agentLookup: () => true,
      onChange: vi.fn(),
      onResumed
    })
    scheduler.load()
    expect(scheduler.list()).toHaveLength(3)
    expect(onResumed).toHaveBeenCalledWith(1) // only 'a' is active
  })

  it('marks schedules as expired on load if past expiresAt', () => {
    const db = createDatabase(':memory:')
    const store = new SchedulesStore(db)
    store.save({
      id: 'a', tabId: 't', agentId: 'g', name: 'A', promptText: 'x',
      intervalMinutes: 45, durationHours: 1,
      startedAt: 1000, expiresAt: 5000,
      nextFireAt: 1000 + 45 * 60_000, pausedAt: null,
      status: 'active', fireHistory: []
    })
    const scheduler = new PromptScheduler({
      store,
      clock: () => 10_000, // well past expiresAt
      ptyWriter: vi.fn(),
      agentLookup: () => true,
      onChange: vi.fn(),
      onResumed: vi.fn()
    })
    scheduler.load()
    const list = scheduler.list()
    expect(list[0].status).toBe('expired')
  })

  it('discards missed fires on load (nextFireAt reset to now + interval)', () => {
    const db = createDatabase(':memory:')
    const store = new SchedulesStore(db)
    const startedAt = 1_000_000
    const expiresAt = startedAt + 100 * 60 * 60_000 // far future
    store.save({
      id: 'a', tabId: 't', agentId: 'g', name: 'A', promptText: 'x',
      intervalMinutes: 45, durationHours: 100,
      startedAt, expiresAt,
      nextFireAt: startedAt + 45 * 60_000, pausedAt: null,
      status: 'active', fireHistory: []
    })
    const now = startedAt + 10 * 60 * 60_000 // 10 hours later, many missed fires
    const scheduler = new PromptScheduler({
      store,
      clock: () => now,
      ptyWriter: vi.fn(),
      agentLookup: () => true,
      onChange: vi.fn(),
      onResumed: vi.fn()
    })
    scheduler.load()
    const [s] = scheduler.list()
    expect(s.nextFireAt).toBe(now + 45 * 60_000)
    expect(s.fireHistory).toEqual([])
  })
})

describe('PromptScheduler.tick', () => {
  it('fires when now >= nextFireAt and agent is alive', () => {
    let now = 1_000_000
    const ptyWriter = vi.fn()
    const { scheduler } = makeScheduler({ now: () => now, ptyWriter })
    const created = scheduler.create(validInput)
    now = created.nextFireAt
    scheduler.tick()
    expect(ptyWriter).toHaveBeenCalledWith('agent-1', 'keep going please')
    const after = scheduler.get(created.id)!
    expect(after.fireHistory).toHaveLength(1)
    expect(after.fireHistory[0].outcome).toBe('fired')
    expect(after.nextFireAt).toBe(now + 45 * 60_000)
  })

  it('does not fire before nextFireAt', () => {
    let now = 1_000_000
    const ptyWriter = vi.fn()
    const { scheduler } = makeScheduler({ now: () => now, ptyWriter })
    const created = scheduler.create(validInput)
    now = created.nextFireAt - 1
    scheduler.tick()
    expect(ptyWriter).not.toHaveBeenCalled()
  })

  it('records skipped_offline when agentLookup returns false', () => {
    let now = 1_000_000
    const ptyWriter = vi.fn()
    const { scheduler } = makeScheduler({
      now: () => now,
      ptyWriter,
      agentLookup: () => false
    })
    const created = scheduler.create(validInput)
    now = created.nextFireAt
    scheduler.tick()
    expect(ptyWriter).not.toHaveBeenCalled()
    const after = scheduler.get(created.id)!
    expect(after.fireHistory[0].outcome).toBe('skipped_offline')
    expect(after.nextFireAt).toBe(now + 45 * 60_000)
    expect(after.status).toBe('active') // still alive
  })

  it('records skipped_offline when ptyWriter throws', () => {
    let now = 1_000_000
    const ptyWriter = vi.fn(() => { throw new Error('pty dead') })
    const { scheduler } = makeScheduler({ now: () => now, ptyWriter })
    const created = scheduler.create(validInput)
    now = created.nextFireAt
    scheduler.tick()
    const after = scheduler.get(created.id)!
    expect(after.fireHistory[0].outcome).toBe('skipped_offline')
  })

  it('transitions to expired when now >= expiresAt', () => {
    let now = 1_000_000
    const { scheduler } = makeScheduler({ now: () => now })
    const created = scheduler.create(validInput)
    now = created.expiresAt! + 1
    scheduler.tick()
    expect(scheduler.get(created.id)!.status).toBe('expired')
  })

  it('infinite schedules never transition to expired', () => {
    let now = 1_000_000
    const { scheduler } = makeScheduler({ now: () => now })
    const created = scheduler.create({ ...validInput, durationHours: null })
    now = 1_000_000 + 10_000 * 60 * 60_000 // 10,000 hours later
    scheduler.tick()
    expect(scheduler.get(created.id)!.status).toBe('active')
  })

  it('persists fire to store after each tick', () => {
    let now = 1_000_000
    const { scheduler, store } = makeScheduler({ now: () => now })
    const created = scheduler.create(validInput)
    now = created.nextFireAt
    scheduler.tick()
    const [persisted] = store.load()
    expect(persisted.fireHistory).toHaveLength(1)
  })
})

describe('PromptScheduler.pause / resume / stop', () => {
  it('pause sets status to paused and stores pausedAt', () => {
    let now = 1_000_000
    const { scheduler } = makeScheduler({ now: () => now })
    const created = scheduler.create(validInput)
    now = 1_000_000 + 20 * 60_000
    const paused = scheduler.pause(created.id)
    expect(paused.status).toBe('paused')
    expect(paused.pausedAt).toBe(now)
  })

  it('paused schedules skip fires even when nextFireAt reached', () => {
    let now = 1_000_000
    const ptyWriter = vi.fn()
    const { scheduler } = makeScheduler({ now: () => now, ptyWriter })
    const created = scheduler.create(validInput)
    scheduler.pause(created.id)
    now = created.nextFireAt + 10_000
    scheduler.tick()
    expect(ptyWriter).not.toHaveBeenCalled()
  })

  it('resume shifts nextFireAt and expiresAt forward by pause duration', () => {
    let now = 1_000_000
    const { scheduler } = makeScheduler({ now: () => now })
    const created = scheduler.create(validInput)
    const originalNextFire = created.nextFireAt
    const originalExpires = created.expiresAt!
    now = 1_000_000 + 20 * 60_000
    scheduler.pause(created.id)
    now = 1_000_000 + 30 * 60_000 // paused for 10 minutes
    const resumed = scheduler.resume(created.id)
    expect(resumed.status).toBe('active')
    expect(resumed.pausedAt).toBeNull()
    expect(resumed.nextFireAt).toBe(originalNextFire + 10 * 60_000)
    expect(resumed.expiresAt).toBe(originalExpires + 10 * 60_000)
  })

  it('resume on infinite schedule keeps expiresAt null', () => {
    let now = 1_000_000
    const { scheduler } = makeScheduler({ now: () => now })
    const created = scheduler.create({ ...validInput, durationHours: null })
    now += 20 * 60_000
    scheduler.pause(created.id)
    now += 10 * 60_000
    const resumed = scheduler.resume(created.id)
    expect(resumed.expiresAt).toBeNull()
  })

  it('stop sets status to stopped and schedule stays in list', () => {
    const { scheduler } = makeScheduler()
    const created = scheduler.create(validInput)
    scheduler.stop(created.id)
    expect(scheduler.get(created.id)!.status).toBe('stopped')
    expect(scheduler.list()).toHaveLength(1)
  })

  it('stopped schedules do not fire', () => {
    let now = 1_000_000
    const ptyWriter = vi.fn()
    const { scheduler } = makeScheduler({ now: () => now, ptyWriter })
    const created = scheduler.create(validInput)
    scheduler.stop(created.id)
    now = created.nextFireAt + 10_000
    scheduler.tick()
    expect(ptyWriter).not.toHaveBeenCalled()
  })

  it('pause/resume/stop throw on unknown id', () => {
    const { scheduler } = makeScheduler()
    expect(() => scheduler.pause('nope')).toThrow(/not found/i)
    expect(() => scheduler.resume('nope')).toThrow(/not found/i)
    expect(() => scheduler.stop('nope')).toThrow(/not found/i)
  })
})
