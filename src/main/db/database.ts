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

    CREATE TABLE IF NOT EXISTS scheduled_prompts (
      id TEXT PRIMARY KEY,
      tab_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      duration_hours INTEGER,
      started_at INTEGER NOT NULL,
      expires_at INTEGER,
      next_fire_at INTEGER NOT NULL,
      paused_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'stopped', 'expired')),
      fire_history TEXT NOT NULL,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS inbox_messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      message TEXT NOT NULL,
      priority TEXT NOT NULL CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      read_at TEXT,
      tab_id TEXT
    );

    CREATE TABLE IF NOT EXISTS team_proposals (
      id TEXT PRIMARY KEY,
      proposed_by TEXT NOT NULL,
      summary TEXT NOT NULL,
      agents TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      feedback TEXT,
      tab_id TEXT,
      kind TEXT NOT NULL DEFAULT 'team',
      payload TEXT
    );

    CREATE TABLE IF NOT EXISTS project_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS board_pages (
      id          TEXT PRIMARY KEY,
      order_index INTEGER NOT NULL,
      elements    TEXT NOT NULL DEFAULT '[]',
      strokes     TEXT NOT NULL DEFAULT '[]'
    );
  `)

  // Migrations for existing DBs — safe to fail if column already exists
  try { db.exec('ALTER TABLE scheduled_prompts ADD COLUMN created_by TEXT') } catch { /* column exists */ }
  try { db.exec('ALTER TABLE pinboard_tasks ADD COLUMN created_by TEXT') } catch { /* column exists */ }
  try { db.exec('ALTER TABLE pinboard_tasks ADD COLUMN tab_id TEXT') } catch { /* column exists */ }
  try { db.exec('ALTER TABLE pinboard_tasks ADD COLUMN target_agent TEXT') } catch { /* column exists */ }
  try { db.exec("ALTER TABLE team_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'team'") } catch { /* exists */ }
  try { db.exec("ALTER TABLE team_proposals ADD COLUMN payload TEXT") } catch { /* exists */ }

  return db
}
