import * as fs from 'fs'
import * as path from 'path'
import type { RecentProject } from '../../shared/types'

const RECENT_FILE = 'recent-projects.json'
const COG_DIR = '.cog'
const LEGACY_DIR = '.agentorch'
const DB_FILE = 'cog.db'
const LEGACY_DB_FILE = 'agentorch.db'
const MAX_RECENT = 20

const GITIGNORE_CONTENT = `cog.db
cog.db-wal
cog.db-shm
agentorch.db
agentorch.db-wal
agentorch.db-shm
`

/**
 * Migrate a legacy .agentorch/ folder to .cog/ on project open.
 *
 * Handles every case that comes up in the wild:
 *  - Only .agentorch/ exists → rename to .cog/ (with copy fallback if Windows blocks rename)
 *  - Both exist, .cog/ DB is empty/small → use legacy DB (it has real data)
 *  - Both exist, .cog/ DB is real → already migrated, leave alone
 *  - Only .cog/ exists → fresh project, nothing to do
 *
 * After ANY successful migration: rename DB files agentorch.db → cog.db.
 */
function migrateLegacyFolder(projectPath: string): void {
  const cogDir = path.join(projectPath, COG_DIR)
  const legacyDir = path.join(projectPath, LEGACY_DIR)

  if (!fs.existsSync(legacyDir)) return

  const legacyDb = path.join(legacyDir, LEGACY_DB_FILE)
  const legacyDbExists = fs.existsSync(legacyDb)
  const cogDb = path.join(cogDir, DB_FILE)
  const cogDbExists = fs.existsSync(cogDb)

  // Case A: both DBs exist — compare sizes
  if (cogDbExists && legacyDbExists) {
    const legacySize = fs.statSync(legacyDb).size
    const cogSize = fs.statSync(cogDb).size
    // Empty SQLite DB with just schema is ~32KB. If legacy is meaningfully bigger,
    // it's the real data — the .cog/ DB was auto-created by an earlier failed
    // migration and contains nothing useful.
    if (legacySize > cogSize + 10_000) {
      console.log(`[ProjectManager] Legacy DB has more data (${legacySize} vs ${cogSize}) — recovering`)
      recoverLegacyData(legacyDir, cogDir)
      renameDbFiles(cogDir)
      console.log(`[ProjectManager] Recovered legacy data into ${COG_DIR}/`)
      return
    } else {
      console.log(`[ProjectManager] ${COG_DIR}/ has the current data; ${LEGACY_DIR}/ is stale`)
      return
    }
  }

  // Case B: .cog/ has data, no legacy DB — already migrated
  if (cogDbExists) return

  // Case C: only legacy exists, .cog/ doesn't exist — clean rename
  if (!fs.existsSync(cogDir) && fs.existsSync(legacyDir)) {
    if (tryRenameOrCopy(legacyDir, cogDir)) {
      renameDbFiles(cogDir)
      console.log(`[ProjectManager] Migrated ${LEGACY_DIR}/ → ${COG_DIR}/`)
    }
    return
  }

  // Case D: empty .cog/ exists, legacy has stuff — merge legacy into .cog/
  if (fs.existsSync(cogDir) && legacyDbExists) {
    console.log(`[ProjectManager] Empty ${COG_DIR}/ alongside ${LEGACY_DIR}/ — merging`)
    mergeDirInto(legacyDir, cogDir)
    try { fs.rmSync(legacyDir, { recursive: true, force: true }) } catch { /* swallow */ }
    renameDbFiles(cogDir)
    console.log(`[ProjectManager] Merge complete`)
  }
}

/**
 * Recover when the new .cog/ folder was auto-created (with empty DB) but the
 * real data still lives in .agentorch/. Backs up the empty DBs, moves legacy
 * DBs in, merges any other legacy contents, removes legacy folder.
 */
function recoverLegacyData(legacyDir: string, cogDir: string): void {
  // Back up empty cog DBs (in case we're wrong and the user needs to roll back)
  for (const suffix of ['', '-wal', '-shm']) {
    const emptyCogDb = path.join(cogDir, DB_FILE + suffix)
    if (fs.existsSync(emptyCogDb)) {
      try {
        fs.renameSync(emptyCogDb, emptyCogDb + '.empty-backup')
      } catch (err) {
        // Try copy + delete
        try {
          fs.copyFileSync(emptyCogDb, emptyCogDb + '.empty-backup')
          fs.unlinkSync(emptyCogDb)
        } catch (copyErr) {
          console.warn(`[ProjectManager] Could not back up ${emptyCogDb}: ${(copyErr as Error).message}`)
        }
      }
    }
  }
  // Move legacy DBs into .cog/ as agentorch.db (will be renamed to cog.db by renameDbFiles)
  for (const suffix of ['', '-wal', '-shm']) {
    const src = path.join(legacyDir, LEGACY_DB_FILE + suffix)
    const dest = path.join(cogDir, LEGACY_DB_FILE + suffix)
    if (fs.existsSync(src)) {
      try {
        fs.renameSync(src, dest)
      } catch {
        try {
          fs.copyFileSync(src, dest)
          fs.unlinkSync(src)
        } catch (copyErr) {
          console.warn(`[ProjectManager] Could not move ${src}: ${(copyErr as Error).message}`)
        }
      }
    }
  }
  // Move any other legacy contents (presets/, etc.) over
  mergeDirInto(legacyDir, cogDir)
  try { fs.rmSync(legacyDir, { recursive: true, force: true }) } catch { /* swallow */ }
}

/** Try fs.renameSync; if it fails (Windows EPERM is common), fall back to copy + delete. */
function tryRenameOrCopy(src: string, dest: string): boolean {
  try {
    fs.renameSync(src, dest)
    return true
  } catch (err) {
    console.warn(`[ProjectManager] Rename ${src} → ${dest} failed (${(err as Error).message}). Falling back to copy.`)
    try {
      copyDirRecursive(src, dest)
      fs.rmSync(src, { recursive: true, force: true })
      return true
    } catch (copyErr) {
      console.warn(`[ProjectManager] Copy fallback failed: ${(copyErr as Error).message}`)
      return false
    }
  }
}

/** Rename agentorch.db → cog.db (plus -wal and -shm sidecars) inside cogDir. */
function renameDbFiles(cogDir: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const oldDb = path.join(cogDir, LEGACY_DB_FILE + suffix)
    const newDb = path.join(cogDir, DB_FILE + suffix)
    if (fs.existsSync(oldDb) && !fs.existsSync(newDb)) {
      try {
        fs.renameSync(oldDb, newDb)
      } catch (err) {
        try {
          fs.copyFileSync(oldDb, newDb)
          fs.unlinkSync(oldDb)
        } catch (copyErr) {
          console.warn(`[ProjectManager] DB file rename failed for ${oldDb}: ${(copyErr as Error).message}`)
        }
      }
    }
  }
}

/** Recursively move contents of srcDir into destDir without overwriting existing files. */
function mergeDirInto(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      mergeDirInto(srcPath, destPath)
    } else if (entry.isFile() && !fs.existsSync(destPath)) {
      try {
        fs.copyFileSync(srcPath, destPath)
      } catch { /* swallow */ }
    }
  }
}

/** Recursively copy srcDir into destDir, creating destDir as needed. */
function copyDirRecursive(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

export class ProjectManager {
  private _current: RecentProject | null = null

  constructor(private userDataPath: string) {}

  get currentProject(): RecentProject | null {
    return this._current
  }

  get dbPath(): string {
    if (!this._current) throw new Error('No project open')
    return path.join(this._current.path, COG_DIR, DB_FILE)
  }

  /**
   * DB path for an arbitrary project folder, independent of which project is
   * currently active. Lets a per-workspace context open its own `.cog/cog.db`
   * without mutating the global `currentProject` (used by concurrent contexts).
   */
  dbPathFor(projectPath: string): string {
    return path.join(projectPath, COG_DIR, DB_FILE)
  }

  get presetsDir(): string {
    if (!this._current) throw new Error('No project open')
    return path.join(this._current.path, COG_DIR, 'presets')
  }

  initProject(projectPath: string): void {
    // Migrate legacy .agentorch/ folder if present (one-time, seamless for existing users)
    migrateLegacyFolder(projectPath)

    const cogDir = path.join(projectPath, COG_DIR)
    const presetsDir = path.join(cogDir, 'presets')

    fs.mkdirSync(presetsDir, { recursive: true })

    const gitignorePath = path.join(cogDir, '.gitignore')
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, 'utf-8')
    }

    this._current = {
      path: projectPath,
      name: path.basename(projectPath),
      lastOpened: new Date().toISOString()
    }

    this.addRecent(this._current)
  }

  listRecent(): RecentProject[] {
    const filePath = path.join(this.userDataPath, RECENT_FILE)
    if (!fs.existsSync(filePath)) return []

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  getLastProject(): RecentProject | null {
    const recent = this.listRecent()
    for (const project of recent) {
      if (fs.existsSync(project.path)) return project
    }
    return null
  }

  removeRecent(projectPath: string): void {
    const recent = this.listRecent().filter(p => p.path !== projectPath)
    this.saveRecent(recent)
  }

  private addRecent(project: RecentProject): void {
    let recent = this.listRecent().filter(p => p.path !== project.path)
    recent.unshift(project)
    if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT)
    this.saveRecent(recent)
  }

  private saveRecent(recent: RecentProject[]): void {
    const filePath = path.join(this.userDataPath, RECENT_FILE)
    fs.writeFileSync(filePath, JSON.stringify(recent, null, 2), 'utf-8')
  }
}
