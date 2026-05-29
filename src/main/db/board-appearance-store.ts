import type Database from 'better-sqlite3'
import type { BoardAppearance } from '../../shared/types'

const KEY = 'board-appearance'
const DEFAULT: BoardAppearance = { bgColor: '#101010', showGrid: false, gridColor: '#2a2a2a' }

export class BoardAppearanceStore {
  private getStmt: Database.Statement
  private setStmt: Database.Statement

  constructor(db: Database.Database) {
    this.getStmt = db.prepare('SELECT value FROM project_settings WHERE key = ?')
    this.setStmt = db.prepare(
      `INSERT INTO project_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
  }

  get(): BoardAppearance {
    const row = this.getStmt.get(KEY) as { value: string } | undefined
    if (!row) return { ...DEFAULT }
    try { return { ...DEFAULT, ...JSON.parse(row.value) } } catch { return { ...DEFAULT } }
  }

  set(value: BoardAppearance): void {
    this.setStmt.run(KEY, JSON.stringify(value))
  }
}
