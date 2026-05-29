import { describe, it, expect } from 'vitest'
import { canAgentCancelSchedule, validateAgentScheduleRequest, MIN_AGENT_INTERVAL_MINUTES }
  from '../../src/main/scheduler/scheduler-helpers'
import type { ScheduledPrompt } from '../../src/shared/types'

const sched = (createdBy: string): ScheduledPrompt => ({
  id: 's', tabId: 't', agentId: 'a', name: 'n', promptText: 'p', intervalMinutes: 40,
  durationHours: 6, startedAt: 0, expiresAt: 1, nextFireAt: 1, pausedAt: null,
  status: 'active', fireHistory: [], createdBy
})

describe('canAgentCancelSchedule', () => {
  it('allows an agent to cancel its own schedule', () => {
    expect(canAgentCancelSchedule(sched('orchestrator'), 'orchestrator')).toBe(true)
  })
  it('forbids cancelling user or other-agent schedules', () => {
    expect(canAgentCancelSchedule(sched('user'), 'orchestrator')).toBe(false)
    expect(canAgentCancelSchedule(sched('worker9'), 'orchestrator')).toBe(false)
  })
})

describe('validateAgentScheduleRequest', () => {
  it('rejects interval below the floor', () => {
    expect(validateAgentScheduleRequest({ intervalMinutes: 1, durationHours: 6 }).ok).toBe(false)
  })
  it('rejects missing/invalid duration', () => {
    expect(validateAgentScheduleRequest({ intervalMinutes: 40, durationHours: 0 }).ok).toBe(false)
    expect(validateAgentScheduleRequest({ intervalMinutes: 40, durationHours: null as any }).ok).toBe(false)
  })
  it('accepts a valid request at the floor', () => {
    expect(validateAgentScheduleRequest({ intervalMinutes: MIN_AGENT_INTERVAL_MINUTES, durationHours: 6 }).ok).toBe(true)
  })
})
