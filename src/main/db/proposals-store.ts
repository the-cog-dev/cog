import type Database from 'better-sqlite3'
import type { ProposedAgent, SchedulePayload, TeamProposal, TeamProposalStatus } from '../../shared/types'

export class ProposalsStore {
  private insertStmt: Database.Statement
  private loadAllStmt: Database.Statement
  private loadPendingStmt: Database.Statement
  private getStmt: Database.Statement
  private updateStatusStmt: Database.Statement
  private deleteStmt: Database.Statement

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO team_proposals
         (id, proposed_by, summary, agents, status, created_at, resolved_at, feedback, tab_id, kind, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.loadAllStmt = db.prepare(
      `SELECT id,
              proposed_by AS proposedBy,
              summary,
              agents,
              status,
              created_at  AS createdAt,
              resolved_at AS resolvedAt,
              feedback,
              tab_id      AS tabId,
              kind,
              payload
       FROM team_proposals
       ORDER BY created_at DESC`
    )
    this.loadPendingStmt = db.prepare(
      `SELECT id,
              proposed_by AS proposedBy,
              summary,
              agents,
              status,
              created_at  AS createdAt,
              resolved_at AS resolvedAt,
              feedback,
              tab_id      AS tabId,
              kind,
              payload
       FROM team_proposals
       WHERE status = 'pending'
       ORDER BY created_at ASC`
    )
    this.getStmt = db.prepare(
      `SELECT id,
              proposed_by AS proposedBy,
              summary,
              agents,
              status,
              created_at  AS createdAt,
              resolved_at AS resolvedAt,
              feedback,
              tab_id      AS tabId,
              kind,
              payload
       FROM team_proposals
       WHERE id = ?`
    )
    this.updateStatusStmt = db.prepare(
      `UPDATE team_proposals SET status = ?, resolved_at = ?, feedback = ? WHERE id = ?`
    )
    this.deleteStmt = db.prepare(`DELETE FROM team_proposals WHERE id = ?`)
  }

  saveProposal(proposal: TeamProposal): void {
    this.insertStmt.run(
      proposal.id,
      proposal.proposedBy,
      proposal.summary,
      JSON.stringify(proposal.agents),
      proposal.status,
      proposal.createdAt,
      proposal.resolvedAt ?? null,
      proposal.feedback ?? null,
      proposal.tabId ?? null,
      proposal.kind,
      proposal.payload ? JSON.stringify(proposal.payload) : null
    )
  }

  loadAll(): TeamProposal[] {
    return (this.loadAllStmt.all() as Array<RawProposal>).map(rowToProposal)
  }

  loadPending(): TeamProposal[] {
    return (this.loadPendingStmt.all() as Array<RawProposal>).map(rowToProposal)
  }

  getProposal(id: string): TeamProposal | null {
    const row = this.getStmt.get(id) as RawProposal | undefined
    return row ? rowToProposal(row) : null
  }

  updateStatus(
    id: string,
    status: TeamProposalStatus,
    resolvedAt: string,
    feedback?: string
  ): boolean {
    const result = this.updateStatusStmt.run(status, resolvedAt, feedback ?? null, id)
    return result.changes > 0
  }

  deleteProposal(id: string): boolean {
    const result = this.deleteStmt.run(id)
    return result.changes > 0
  }
}

interface RawProposal {
  id: string
  proposedBy: string
  summary: string
  agents: string
  status: TeamProposalStatus
  createdAt: string
  resolvedAt: string | null
  feedback: string | null
  tabId: string | null
  kind: 'team' | 'schedule'
  payload: string | null
}

function rowToProposal(row: RawProposal): TeamProposal {
  return {
    id: row.id,
    proposedBy: row.proposedBy,
    summary: row.summary,
    agents: JSON.parse(row.agents) as ProposedAgent[],
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
    feedback: row.feedback ?? undefined,
    tabId: row.tabId ?? undefined,
    kind: row.kind ?? 'team',
    payload: row.payload ? JSON.parse(row.payload) as SchedulePayload : undefined
  }
}
