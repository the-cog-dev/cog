import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/main/db/database'
import { ProposalsStore } from '../../src/main/db/proposals-store'
import type { TeamProposal } from '../../src/shared/types'

const db = () => createDatabase(':memory:')

describe('ProposalsStore kind/payload', () => {
  it('round-trips a schedule proposal', () => {
    const store = new ProposalsStore(db())
    const p: TeamProposal = {
      id: 'p1', proposedBy: 'orchestrator', summary: 'sitrep loop', agents: [],
      status: 'pending', createdAt: new Date(0).toISOString(), kind: 'schedule',
      payload: { targetAgentId: 'a1', targetAgentName: 'sonnetworker2', tabId: 'tab-default',
                 promptText: 'post sitrep', intervalMinutes: 40, durationHours: 6 }
    }
    store.saveProposal(p)
    const got = store.getProposal('p1')!
    expect(got.kind).toBe('schedule')
    expect(got.payload?.targetAgentName).toBe('sonnetworker2')
  })
  it('defaults a team proposal kind', () => {
    const store = new ProposalsStore(db())
    const p: TeamProposal = {
      id: 'p2', proposedBy: 'o', summary: 's', agents: [], status: 'pending',
      createdAt: new Date(0).toISOString(), kind: 'team'
    }
    store.saveProposal(p)
    expect(store.getProposal('p2')!.kind).toBe('team')
  })
})
