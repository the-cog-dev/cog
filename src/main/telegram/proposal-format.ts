import type { ProposalView } from './bridge'

/**
 * Pure rendering + parsing for Telegram team-proposal cards. No grammY, no hub —
 * just the message text and the callback-data round-trip, so the button wiring
 * is unit-testable.
 */

export type ProposalAction = 'approve' | 'reject' | 'info'

/** Encode a button's callback payload: prop:<action>:<proposalId>. */
export function proposalCallback(action: ProposalAction, id: string): string {
  return `prop:${action}:${id}`
}

/** Parse a callback payload back into (action, id), or null if it isn't ours. */
export function parseProposalCallback(data: string): { action: ProposalAction; id: string } | null {
  const m = /^prop:(approve|reject|info):(.+)$/.exec(data)
  return m ? { action: m[1] as ProposalAction, id: m[2] } : null
}

/** The card shown when a proposal first arrives (buttons attached separately). */
export function formatProposalMessage(p: ProposalView): string {
  const noun = p.kind === 'schedule' ? 'schedule' : 'team'
  const lines = [
    `🧩 ${p.proposedBy} is proposing a ${noun}:`,
    p.summary,
  ]
  if (p.agents.length) {
    lines.push('', 'Agents:')
    for (const a of p.agents) {
      const model = a.model ? ` · ${a.model}` : ''
      lines.push(`• ${a.name} — ${a.role} (${a.cli}${model})`)
    }
  }
  lines.push('', 'Approve to spawn, or reject.')
  return lines.join('\n')
}

/** The per-agent detail dump behind the 📋 Details button. */
export function formatProposalDetails(p: ProposalView): string {
  if (!p.agents.length) return 'No agent details available.'
  return p.agents.map(a => {
    const model = a.model ? ` · ${a.model}` : ''
    const notes = a.notes?.trim() ? `\n   ${a.notes.trim()}` : ''
    return `• ${a.name} — ${a.role} (${a.cli}${model})${notes}`
  }).join('\n\n')
}

/** What the card becomes once the proposal is settled (buttons removed). */
export function formatProposalResolved(p: ProposalView): string {
  const icon = p.status === 'approved' ? '✅' : p.status === 'rejected' ? '❌' : '⚪'
  const verb = p.status === 'approved' ? 'Approved' : p.status === 'rejected' ? 'Rejected' : p.status
  return `${icon} ${verb}: ${p.summary}`
}
