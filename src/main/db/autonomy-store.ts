import type Database from 'better-sqlite3'
import type { ProjectAutonomy } from '../../shared/types'

const KEY = 'autonomy'
const MIN_HOURS = 0.25
const MAX_HOURS = 72

export class AutonomyStore {
  private getStmt: Database.Statement
  private setStmt: Database.Statement
  private clock: () => number

  constructor(db: Database.Database, clock: () => number = () => Date.now()) {
    this.getStmt = db.prepare('SELECT value FROM project_settings WHERE key = ?')
    this.setStmt = db.prepare(
      `INSERT INTO project_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    this.clock = clock
  }

  get(): ProjectAutonomy {
    const row = this.getStmt.get(KEY) as { value: string } | undefined
    if (!row) return { sessionExpiresAt: null }
    try {
      const parsed = JSON.parse(row.value)
      const exp = typeof parsed?.sessionExpiresAt === 'number' ? parsed.sessionExpiresAt : null
      return { sessionExpiresAt: exp }
    } catch {
      return { sessionExpiresAt: null }
    }
  }

  isActive(): boolean {
    const { sessionExpiresAt } = this.get()
    return sessionExpiresAt !== null && this.clock() < sessionExpiresAt
  }

  startSession(durationHours: number): ProjectAutonomy {
    const hours = Math.min(MAX_HOURS, Math.max(MIN_HOURS, Number(durationHours) || 0))
    const value: ProjectAutonomy = { sessionExpiresAt: this.clock() + Math.round(hours * 3_600_000) }
    this.setStmt.run(KEY, JSON.stringify(value))
    return value
  }

  endSession(): ProjectAutonomy {
    const value: ProjectAutonomy = { sessionExpiresAt: null }
    this.setStmt.run(KEY, JSON.stringify(value))
    return value
  }
}
