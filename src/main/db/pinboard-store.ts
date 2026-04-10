import type Database from 'better-sqlite3'
import type { PinboardTask } from '../hub/pinboard'

export class PinboardStore {
  private insertStmt: Database.Statement
  private updateStmt: Database.Statement
  private deleteStmt: Database.Statement
  private loadStmt: Database.Statement

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO pinboard_tasks (id, title, description, priority, status, created_by, claimed_by, result, created_at, tab_id, target_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.updateStmt = db.prepare(
      `UPDATE pinboard_tasks SET status = ?, claimed_by = ?, result = ? WHERE id = ?`
    )
    this.deleteStmt = db.prepare(
      `DELETE FROM pinboard_tasks WHERE id = ?`
    )
    this.loadStmt = db.prepare(
      `SELECT id, title, description, priority, status, created_by AS createdBy, claimed_by AS claimedBy, result, created_at AS createdAt, tab_id AS tabId, target_agent AS targetAgent
       FROM pinboard_tasks ORDER BY created_at ASC`
    )
  }

  saveTask(task: PinboardTask): void {
    this.insertStmt.run(
      task.id, task.title, task.description, task.priority,
      task.status, task.createdBy, task.claimedBy, task.result, task.createdAt, task.tabId ?? null, task.targetAgent ?? null
    )
  }

  updateTask(task: PinboardTask): void {
    this.updateStmt.run(task.status, task.claimedBy, task.result, task.id)
  }

  deleteTask(id: string): void {
    this.deleteStmt.run(id)
  }

  loadTasks(): PinboardTask[] {
    return this.loadStmt.all() as PinboardTask[]
  }
}
