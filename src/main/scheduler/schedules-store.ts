import type Database from 'better-sqlite3'
import type { ScheduledPrompt, ScheduleStatus } from '../../shared/types'

interface Row {
  id: string
  tab_id: string
  agent_id: string
  name: string
  prompt_text: string
  interval_minutes: number
  duration_hours: number | null
  started_at: number
  expires_at: number | null
  next_fire_at: number
  paused_at: number | null
  status: string
  fire_history: string
}

export class SchedulesStore {
  private upsertStmt: Database.Statement
  private deleteStmt: Database.Statement
  private deleteByTabStmt: Database.Statement
  private loadStmt: Database.Statement

  constructor(private db: Database.Database) {
    this.upsertStmt = db.prepare(`
      INSERT INTO scheduled_prompts
        (id, tab_id, agent_id, name, prompt_text, interval_minutes, duration_hours,
         started_at, expires_at, next_fire_at, paused_at, status, fire_history)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tab_id = excluded.tab_id,
        agent_id = excluded.agent_id,
        name = excluded.name,
        prompt_text = excluded.prompt_text,
        interval_minutes = excluded.interval_minutes,
        duration_hours = excluded.duration_hours,
        started_at = excluded.started_at,
        expires_at = excluded.expires_at,
        next_fire_at = excluded.next_fire_at,
        paused_at = excluded.paused_at,
        status = excluded.status,
        fire_history = excluded.fire_history
    `)
    this.deleteStmt = db.prepare('DELETE FROM scheduled_prompts WHERE id = ?')
    this.deleteByTabStmt = db.prepare('DELETE FROM scheduled_prompts WHERE tab_id = ?')
    this.loadStmt = db.prepare('SELECT * FROM scheduled_prompts ORDER BY started_at ASC')
  }

  save(s: ScheduledPrompt): void {
    this.upsertStmt.run(
      s.id,
      s.tabId,
      s.agentId,
      s.name,
      s.promptText,
      s.intervalMinutes,
      s.durationHours,
      s.startedAt,
      s.expiresAt,
      s.nextFireAt,
      s.pausedAt,
      s.status,
      JSON.stringify(s.fireHistory)
    )
  }

  delete(id: string): void {
    this.deleteStmt.run(id)
  }

  deleteByTabId(tabId: string): void {
    this.deleteByTabStmt.run(tabId)
  }

  load(): ScheduledPrompt[] {
    const rows = this.loadStmt.all() as Row[]
    return rows.map(this.rowToSchedule)
  }

  private rowToSchedule(row: Row): ScheduledPrompt {
    return {
      id: row.id,
      tabId: row.tab_id,
      agentId: row.agent_id,
      name: row.name,
      promptText: row.prompt_text,
      intervalMinutes: row.interval_minutes,
      durationHours: row.duration_hours,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
      nextFireAt: row.next_fire_at,
      pausedAt: row.paused_at,
      status: row.status as ScheduleStatus,
      fireHistory: JSON.parse(row.fire_history)
    }
  }
}
