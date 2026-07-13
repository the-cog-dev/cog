import type Database from 'better-sqlite3'
import type { AgentConfig } from '../../shared/types'

/**
 * Per-project persistence of a workspace's live agent roster — the set of
 * agents that should come back when the app relaunches. Stored in the
 * workspace's own `.cog/cog.db` (one store per WorkspaceCtx), so the roster is
 * naturally workspace-scoped.
 *
 * save() on spawn, remove() on a user-initiated teardown; the roster is NOT
 * cleared on app quit / context close, which is exactly what lets the agents
 * respawn on next boot. The stored config is the ORIGINAL AgentConfig (skills
 * compose into the registry copy, not the config), so respawning re-composes
 * cleanly without double-applying skill prompts.
 */
export class AgentRosterStore {
  private upsertStmt: Database.Statement
  private removeStmt: Database.Statement
  private listStmt: Database.Statement
  private clearStmt: Database.Statement

  constructor(private db: Database.Database) {
    this.upsertStmt = db.prepare(
      `INSERT INTO agent_roster (id, config, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`
    )
    this.removeStmt = db.prepare(`DELETE FROM agent_roster WHERE id = ?`)
    this.listStmt = db.prepare(`SELECT config FROM agent_roster ORDER BY updated_at ASC`)
    this.clearStmt = db.prepare(`DELETE FROM agent_roster`)
  }

  save(config: AgentConfig, now = new Date().toISOString()): void {
    this.upsertStmt.run(config.id, JSON.stringify(config), now)
  }

  remove(id: string): void {
    this.removeStmt.run(id)
  }

  /** Every persisted agent config, oldest-first (roughly spawn order). */
  list(): AgentConfig[] {
    const rows = this.listStmt.all() as Array<{ config: string }>
    const out: AgentConfig[] = []
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.config) as AgentConfig)
      } catch {
        /* skip a corrupt row rather than fail the whole restore */
      }
    }
    return out
  }

  clear(): void {
    this.clearStmt.run()
  }
}
