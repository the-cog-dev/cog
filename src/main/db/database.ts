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

    -- Clear previous session data so each launch starts fresh
    DELETE FROM pinboard_tasks;
    DELETE FROM info_entries;
    DELETE FROM messages;
  `)

  return db
}
