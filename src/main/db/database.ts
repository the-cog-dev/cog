import Database from 'better-sqlite3'

export function createDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pinboard_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      created_by TEXT,
      claimed_by TEXT,
      result TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS info_entries (
      id TEXT PRIMARY KEY,
      "from" TEXT NOT NULL,
      note TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
  `)

  // Migrations for existing DBs — safe to fail if column already exists
  try { db.exec('ALTER TABLE pinboard_tasks ADD COLUMN created_by TEXT') } catch { /* column exists */ }
  try { db.exec('ALTER TABLE pinboard_tasks ADD COLUMN tab_id TEXT') } catch { /* column exists */ }

  return db
}
