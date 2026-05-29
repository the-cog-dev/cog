import { v4 as uuid } from 'uuid'
import type { ProposedAgent, SchedulePayload, TeamProposal, TeamProposalStatus } from '../../shared/types'

const MAX_AGENTS_PER_PROPOSAL = 24
const MAX_SUMMARY_SIZE = 2 * 1024
const MAX_CEO_NOTES_SIZE = 8 * 1024

export class ProposalsChannel {
  private proposals: TeamProposal[] = []
  onProposalAdded?: (proposal: TeamProposal) => void
  onProposalResolved?: (proposal: TeamProposal) => void
  onProposalDeleted?: (id: string) => void

  /**
   * Create a new pending team proposal. Validates the shape but does NOT spawn
   * any agents — that happens later when the user approves via IPC. Each
   * agent's name must be unique within the proposal so the UI can address
   * per-agent checkboxes safely.
   */
  createProposal(
    proposedBy: string,
    summary: string,
    agents: ProposedAgent[],
    tabId?: string
  ): TeamProposal {
    if (!summary || typeof summary !== 'string') {
      throw new Error('summary is required')
    }
    if (summary.length > MAX_SUMMARY_SIZE) {
      throw new Error(`summary exceeds max size of ${MAX_SUMMARY_SIZE} bytes`)
    }
    if (!Array.isArray(agents) || agents.length === 0) {
      throw new Error('agents must be a non-empty array')
    }
    if (agents.length > MAX_AGENTS_PER_PROPOSAL) {
      throw new Error(`agents exceeds max of ${MAX_AGENTS_PER_PROPOSAL}`)
    }

    const seenNames = new Set<string>()
    for (const a of agents) {
      validateProposedAgent(a)
      const key = a.name.trim().toLowerCase()
      if (seenNames.has(key)) {
        throw new Error(`duplicate agent name in proposal: '${a.name}'`)
      }
      seenNames.add(key)
    }

    const proposal: TeamProposal = {
      id: uuid(),
      proposedBy,
      summary,
      agents,
      status: 'pending',
      createdAt: new Date().toISOString(),
      tabId: tabId ?? undefined,
      kind: 'team' as const
    }

    this.proposals.unshift(proposal)
    this.onProposalAdded?.(proposal)
    return proposal
  }

  resolve(
    id: string,
    status: Exclude<TeamProposalStatus, 'pending'>,
    feedback?: string
  ): TeamProposal | null {
    const proposal = this.proposals.find(p => p.id === id)
    if (!proposal) return null
    if (proposal.status !== 'pending') {
      throw new Error(`Proposal ${id} is already ${proposal.status}`)
    }
    proposal.status = status
    proposal.resolvedAt = new Date().toISOString()
    if (feedback) proposal.feedback = feedback
    this.onProposalResolved?.(proposal)
    return proposal
  }

  get(id: string): TeamProposal | null {
    return this.proposals.find(p => p.id === id) ?? null
  }

  listAll(): TeamProposal[] {
    return [...this.proposals]
  }

  listPending(): TeamProposal[] {
    return this.proposals.filter(p => p.status === 'pending')
  }

  delete(id: string): boolean {
    const idx = this.proposals.findIndex(p => p.id === id)
    if (idx === -1) return false
    this.proposals.splice(idx, 1)
    this.onProposalDeleted?.(id)
    return true
  }

  loadProposals(proposals: TeamProposal[]): void {
    this.proposals.push(...proposals)
  }

  clear(): void {
    this.proposals = []
  }

  /** Create a pending schedule proposal (no agents; carries a SchedulePayload). */
  createScheduleProposal(
    proposedBy: string,
    summary: string,
    payload: SchedulePayload,
    tabId?: string
  ): TeamProposal {
    if (!summary || typeof summary !== 'string') throw new Error('summary is required')
    if (!payload || typeof payload.promptText !== 'string' || !payload.promptText.trim()) {
      throw new Error('payload.promptText is required')
    }
    const proposal: TeamProposal = {
      id: uuid(), proposedBy, summary, agents: [], status: 'pending',
      createdAt: new Date().toISOString(), tabId: tabId ?? undefined,
      kind: 'schedule', payload
    }
    this.proposals.unshift(proposal)
    this.onProposalAdded?.(proposal)
    return proposal
  }
}

function validateProposedAgent(a: unknown): asserts a is ProposedAgent {
  if (!a || typeof a !== 'object') throw new Error('each agent must be an object')
  const x = a as Record<string, unknown>
  if (typeof x.name !== 'string' || x.name.trim().length === 0) {
    throw new Error('agent.name is required')
  }
  if (typeof x.cli !== 'string' || x.cli.trim().length === 0) {
    throw new Error(`agent '${x.name}'.cli is required`)
  }
  if (typeof x.role !== 'string') {
    throw new Error(`agent '${x.name}'.role is required`)
  }
  if (typeof x.ceoNotes !== 'string') {
    throw new Error(`agent '${x.name}'.ceoNotes is required (use empty string if none)`)
  }
  if ((x.ceoNotes as string).length > MAX_CEO_NOTES_SIZE) {
    throw new Error(`agent '${x.name}'.ceoNotes exceeds ${MAX_CEO_NOTES_SIZE} bytes`)
  }
  if (typeof x.autoMode !== 'boolean') {
    throw new Error(`agent '${x.name}'.autoMode must be boolean`)
  }
}
