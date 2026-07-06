import { describe, it, expect } from 'vitest'
import {
  proposalCallback, parseProposalCallback,
  formatProposalMessage, formatProposalDetails, formatProposalResolved
} from './proposal-format'
import type { ProposalView } from './bridge'

const p: ProposalView = {
  id: 'abc-123',
  proposedBy: 'Cara',
  summary: 'A research pod',
  kind: 'team',
  status: 'pending',
  agents: [
    { name: 'Ada', role: 'researcher', cli: 'claude', model: 'opus', notes: 'digs sources' },
    { name: 'Rex', role: 'reviewer', cli: 'codex' }
  ]
}

describe('proposal callback round-trip', () => {
  it('encodes and parses each action', () => {
    for (const action of ['approve', 'reject', 'info'] as const) {
      const data = proposalCallback(action, 'abc-123')
      expect(parseProposalCallback(data)).toEqual({ action, id: 'abc-123' })
    }
  })
  it('preserves ids containing colons/dashes', () => {
    expect(parseProposalCallback('prop:approve:a-b:c')).toEqual({ action: 'approve', id: 'a-b:c' })
  })
  it('rejects foreign or malformed payloads', () => {
    expect(parseProposalCallback('other:approve:x')).toBeNull()
    expect(parseProposalCallback('prop:delete:x')).toBeNull()
    expect(parseProposalCallback('prop:approve:')).toBeNull()
  })
})

describe('proposal formatting', () => {
  it('lists agents in the card', () => {
    const msg = formatProposalMessage(p)
    expect(msg).toContain('Cara is proposing a team')
    expect(msg).toContain('A research pod')
    expect(msg).toContain('Ada — researcher (claude · opus)')
    expect(msg).toContain('Rex — reviewer (codex)')
  })
  it('includes per-agent notes in details', () => {
    const d = formatProposalDetails(p)
    expect(d).toContain('digs sources')
  })
  it('marks the resolved state with an icon', () => {
    expect(formatProposalResolved({ ...p, status: 'approved' })).toContain('✅ Approved')
    expect(formatProposalResolved({ ...p, status: 'rejected' })).toContain('❌ Rejected')
  })
})
