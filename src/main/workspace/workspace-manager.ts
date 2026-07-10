import * as fs from 'fs'
import * as path from 'path'
import type { WorkspaceTab } from '../../shared/types'

const WORKSPACES_FILE = 'workspaces.json'
export const DEFAULT_WORKSPACE_ID = 'tab-default'

interface PersistedState {
  workspaces: WorkspaceTab[]
  activeId: string
}

/**
 * Tracks the app's open workspaces. A workspace is a named tab bound to its own
 * project folder — its team spawns there and (P2) its hub context persists to
 * that folder's .cog/cog.db. Multiple are open at once; exactly one is active
 * (drives which project the UI panels show).
 *
 * Pure in-memory state + JSON persistence in userData (like ProjectManager's
 * recent-projects). No hub, no Electron — unit-testable.
 */
export class WorkspaceManager {
  private workspaces: WorkspaceTab[] = []
  private activeId = DEFAULT_WORKSPACE_ID

  constructor(private userDataPath: string) {
    this.load()
  }

  list(): WorkspaceTab[] {
    return this.workspaces.map(w => ({ ...w }))
  }

  getActiveId(): string {
    return this.activeId
  }

  getActive(): WorkspaceTab | null {
    return this.get(this.activeId)
  }

  get(id: string): WorkspaceTab | null {
    const w = this.workspaces.find(w => w.id === id)
    return w ? { ...w } : null
  }

  /** The folder a workspace is bound to, or null if unbound. */
  projectPathFor(id: string): string | null {
    return this.workspaces.find(w => w.id === id)?.projectPath ?? null
  }

  /** Add a workspace (optionally bound to a folder). Returns the created tab. */
  add(name: string, projectPath?: string, id = `tab-${genId()}`): WorkspaceTab {
    const tab: WorkspaceTab = { id, name: name.trim() || defaultName(this.workspaces.length), projectPath }
    this.workspaces.push(tab)
    this.save()
    return { ...tab }
  }

  /** Remove a workspace. The last remaining one can't be removed. Re-points
   *  active to a neighbour if the active one was removed. Returns new active id. */
  remove(id: string): string {
    if (this.workspaces.length <= 1) return this.activeId
    const idx = this.workspaces.findIndex(w => w.id === id)
    if (idx === -1) return this.activeId
    this.workspaces.splice(idx, 1)
    if (this.activeId === id) {
      const neighbour = this.workspaces[Math.max(0, idx - 1)]
      this.activeId = neighbour.id
    }
    this.save()
    return this.activeId
  }

  rename(id: string, name: string): boolean {
    const w = this.workspaces.find(w => w.id === id)
    if (!w) return false
    w.name = name.trim() || w.name
    this.save()
    return true
  }

  /** Bind (or rebind) a workspace to a project folder. */
  setProjectPath(id: string, projectPath: string): boolean {
    const w = this.workspaces.find(w => w.id === id)
    if (!w) return false
    w.projectPath = projectPath
    this.save()
    return true
  }

  setActive(id: string): boolean {
    if (!this.workspaces.some(w => w.id === id)) return false
    this.activeId = id
    this.save()
    return true
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private filePath(): string {
    return path.join(this.userDataPath, WORKSPACES_FILE)
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath(), 'utf-8')
      const data = JSON.parse(raw) as PersistedState
      if (Array.isArray(data.workspaces) && data.workspaces.length) {
        this.workspaces = data.workspaces.filter(w => w && w.id && w.name)
        this.activeId = this.workspaces.some(w => w.id === data.activeId)
          ? data.activeId
          : this.workspaces[0].id
        return
      }
    } catch { /* missing or corrupt — fall through to default */ }
    // Default: a single unbound workspace (migrated to the app's current project
    // by the caller, preserving today's single-project behaviour).
    this.workspaces = [{ id: DEFAULT_WORKSPACE_ID, name: 'Workspace 1' }]
    this.activeId = DEFAULT_WORKSPACE_ID
  }

  private save(): void {
    const state: PersistedState = { workspaces: this.workspaces, activeId: this.activeId }
    try {
      fs.writeFileSync(this.filePath(), JSON.stringify(state, null, 2), 'utf-8')
    } catch { /* best-effort; in-memory state is still authoritative this session */ }
  }
}

function defaultName(count: number): string {
  return `Workspace ${count + 1}`
}

// Short, collision-resistant id without pulling in uuid at this layer.
function genId(): string {
  return Math.random().toString(36).slice(2, 10)
}
