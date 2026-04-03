import * as fs from 'fs'
import * as path from 'path'
import type { RecentProject } from '../../shared/types'

const RECENT_FILE = 'recent-projects.json'
const AGENTORCH_DIR = '.agentorch'
const MAX_RECENT = 20

const GITIGNORE_CONTENT = `agentorch.db
agentorch.db-wal
agentorch.db-shm
`

export class ProjectManager {
  private _current: RecentProject | null = null

  constructor(private userDataPath: string) {}

  get currentProject(): RecentProject | null {
    return this._current
  }

  get dbPath(): string {
    if (!this._current) throw new Error('No project open')
    return path.join(this._current.path, AGENTORCH_DIR, 'agentorch.db')
  }

  get presetsDir(): string {
    if (!this._current) throw new Error('No project open')
    return path.join(this._current.path, AGENTORCH_DIR, 'presets')
  }

  initProject(projectPath: string): void {
    const agentorchDir = path.join(projectPath, AGENTORCH_DIR)
    const presetsDir = path.join(agentorchDir, 'presets')

    fs.mkdirSync(presetsDir, { recursive: true })

    const gitignorePath = path.join(agentorchDir, '.gitignore')
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
