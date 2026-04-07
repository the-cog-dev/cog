import { v4 as uuid } from 'uuid'
import type { ScheduledPrompt, CreateScheduleInput, EditScheduleInput } from '../../shared/types'
import type { SchedulesStore } from './schedules-store'
import {
  computeNextFireAt,
  computeExpiresAt,
  isExpired,
  shouldFire,
  applyFire,
  applyPause,
  applyResume,
  applyRestart,
  applyStop
} from './scheduler-helpers'

export interface PromptSchedulerOptions {
  store: SchedulesStore
  clock: () => number
  ptyWriter: (agentId: string, text: string) => void
  agentLookup: (agentId: string) => boolean
  onChange: () => void
  onResumed: (count: number) => void
}

export const TICK_INTERVAL_MS = 30_000

export class PromptScheduler {
  private schedules = new Map<string, ScheduledPrompt>()
  private tickHandle: ReturnType<typeof setInterval> | null = null
  private scheduleCounter = 0

  constructor(private opts: PromptSchedulerOptions) {}

  // ----- Lifecycle -----

  load(): void {
    const now = this.opts.clock()
    const loaded = this.opts.store.load()
    let resumedCount = 0
    for (const s of loaded) {
      let cur = s
      if (cur.status === 'active') {
        if (isExpired(cur, now)) {
          cur = { ...cur, status: 'expired' }
          this.opts.store.save(cur)
        } else if (now >= cur.nextFireAt) {
          // Discard missed fires: reset nextFireAt to now + interval
          cur = { ...cur, nextFireAt: computeNextFireAt(now, cur.intervalMinutes) }
          this.opts.store.save(cur)
          resumedCount++
        } else {
          resumedCount++
        }
      }
      this.schedules.set(cur.id, cur)
      // Track the highest used counter so future defaults don't collide
      const match = cur.name.match(/^Schedule #(\d+)$/)
      if (match) {
        const n = parseInt(match[1], 10)
        if (n > this.scheduleCounter) this.scheduleCounter = n
      }
    }
    this.opts.onResumed(resumedCount)
  }

  startTicker(): void {
    if (this.tickHandle !== null) return
    this.tickHandle = setInterval(() => this.tick(), TICK_INTERVAL_MS)
  }

  stopTicker(): void {
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle)
      this.tickHandle = null
    }
  }

  // Exposed for tests — advances scheduler logic one tick without waiting
  tick(): void {
    const now = this.opts.clock()
    for (const [id, schedule] of this.schedules) {
      if (schedule.status !== 'active') continue

      // Expire first
      if (isExpired(schedule, now)) {
        const expired: ScheduledPrompt = { ...schedule, status: 'expired' }
        this.schedules.set(id, expired)
        this.opts.store.save(expired)
        this.opts.onChange()
        continue
      }

      if (shouldFire(schedule, now)) {
        const alive = this.opts.agentLookup(schedule.agentId)
        let outcome: 'fired' | 'skipped_offline' = 'skipped_offline'
        if (alive) {
          try {
            this.opts.ptyWriter(schedule.agentId, schedule.promptText)
            outcome = 'fired'
          } catch {
            outcome = 'skipped_offline'
          }
        }
        const updated = applyFire(schedule, now, outcome)
        this.schedules.set(id, updated)
        this.opts.store.save(updated)
        this.opts.onChange()
      }
    }
  }

  // ----- CRUD -----

  create(input: CreateScheduleInput): ScheduledPrompt {
    if (!input.promptText || input.promptText.trim().length === 0) {
      throw new Error('Scheduled prompt: promptText cannot be empty')
    }
    if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes <= 0) {
      throw new Error('Scheduled prompt: intervalMinutes must be a positive integer')
    }
    if (input.durationHours !== null) {
      if (!Number.isInteger(input.durationHours) || input.durationHours <= 0) {
        throw new Error('Scheduled prompt: durationHours must be null or a positive integer')
      }
    }

    const now = this.opts.clock()
    this.scheduleCounter++
    const name = input.name && input.name.trim().length > 0
      ? input.name.trim()
      : `Schedule #${this.scheduleCounter}`

    const schedule: ScheduledPrompt = {
      id: uuid(),
      tabId: input.tabId,
      agentId: input.agentId,
      name,
      promptText: input.promptText.trim(),
      intervalMinutes: input.intervalMinutes,
      durationHours: input.durationHours,
      startedAt: now,
      expiresAt: computeExpiresAt(now, input.durationHours),
      nextFireAt: computeNextFireAt(now, input.intervalMinutes),
      pausedAt: null,
      status: 'active',
      fireHistory: []
    }

    this.schedules.set(schedule.id, schedule)
    this.opts.store.save(schedule)
    this.opts.onChange()
    return schedule
  }

  list(): ScheduledPrompt[] {
    return Array.from(this.schedules.values()).sort((a, b) => a.startedAt - b.startedAt)
  }

  get(id: string): ScheduledPrompt | null {
    return this.schedules.get(id) ?? null
  }

  pause(id: string): ScheduledPrompt {
    const existing = this.requireSchedule(id)
    const updated = applyPause(existing, this.opts.clock())
    this.schedules.set(id, updated)
    this.opts.store.save(updated)
    this.opts.onChange()
    return updated
  }

  resume(id: string): ScheduledPrompt {
    const existing = this.requireSchedule(id)
    const updated = applyResume(existing, this.opts.clock())
    this.schedules.set(id, updated)
    this.opts.store.save(updated)
    this.opts.onChange()
    return updated
  }

  stop(id: string): ScheduledPrompt {
    const existing = this.requireSchedule(id)
    const updated = applyStop(existing)
    this.schedules.set(id, updated)
    this.opts.store.save(updated)
    this.opts.onChange()
    return updated
  }

  restart(id: string): ScheduledPrompt {
    const existing = this.requireSchedule(id)
    const updated = applyRestart(existing, this.opts.clock())
    this.schedules.set(id, updated)
    this.opts.store.save(updated)
    this.opts.onChange()
    return updated
  }

  edit(id: string, updates: EditScheduleInput): ScheduledPrompt {
    const existing = this.requireSchedule(id)
    if (existing.status === 'active' || existing.status === 'paused') {
      throw new Error('Stop the schedule before editing.')
    }
    if (updates.promptText !== undefined && updates.promptText.trim().length === 0) {
      throw new Error('Scheduled prompt: promptText cannot be empty')
    }
    if (updates.intervalMinutes !== undefined) {
      if (!Number.isInteger(updates.intervalMinutes) || updates.intervalMinutes <= 0) {
        throw new Error('Scheduled prompt: intervalMinutes must be a positive integer')
      }
    }
    if (updates.durationHours !== undefined && updates.durationHours !== null) {
      if (!Number.isInteger(updates.durationHours) || updates.durationHours <= 0) {
        throw new Error('Scheduled prompt: durationHours must be null or a positive integer')
      }
    }

    const updated: ScheduledPrompt = {
      ...existing,
      name: updates.name?.trim() || existing.name,
      promptText: updates.promptText?.trim() ?? existing.promptText,
      intervalMinutes: updates.intervalMinutes ?? existing.intervalMinutes,
      durationHours: updates.durationHours !== undefined ? updates.durationHours : existing.durationHours
    }
    this.schedules.set(id, updated)
    this.opts.store.save(updated)
    this.opts.onChange()
    return updated
  }

  delete(id: string): void {
    if (!this.schedules.has(id)) return
    this.schedules.delete(id)
    this.opts.store.delete(id)
    this.opts.onChange()
  }

  deleteByTabId(tabId: string): void {
    let removed = 0
    for (const [id, s] of this.schedules) {
      if (s.tabId === tabId) {
        this.schedules.delete(id)
        removed++
      }
    }
    this.opts.store.deleteByTabId(tabId)
    if (removed > 0) this.opts.onChange()
  }

  private requireSchedule(id: string): ScheduledPrompt {
    const s = this.schedules.get(id)
    if (!s) throw new Error(`Scheduled prompt not found: ${id}`)
    return s
  }
}
