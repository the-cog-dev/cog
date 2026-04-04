import { execSync } from 'child_process'

const REPO_API = 'https://api.github.com/repos/natebag/AgentOrch/commits/main'
const CHECK_INTERVAL_MS = 30 * 60 * 1000 // Check every 30 minutes

export interface UpdateInfo {
  available: boolean
  currentSha: string
  remoteSha: string
  message: string
  date: string
}

export class UpdateChecker {
  private timer: ReturnType<typeof setInterval> | null = null
  private appPath: string
  onUpdateAvailable?: (info: UpdateInfo) => void

  constructor(appPath: string) {
    this.appPath = appPath
  }

  start(): void {
    this.check() // Check immediately on start
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async check(): Promise<UpdateInfo | null> {
    try {
      // Get local HEAD sha
      const localSha = execSync('git rev-parse HEAD', { cwd: this.appPath, encoding: 'utf-8' }).trim()

      // Get remote HEAD sha from GitHub API
      const res = await fetch(REPO_API, {
        headers: { 'Accept': 'application/vnd.github.v3+json' }
      })
      if (!res.ok) return null

      const data = await res.json()
      const remoteSha = data.sha
      const message = data.commit?.message?.split('\n')[0] || ''
      const date = data.commit?.committer?.date || ''

      if (localSha !== remoteSha) {
        const info: UpdateInfo = {
          available: true,
          currentSha: localSha.slice(0, 7),
          remoteSha: remoteSha.slice(0, 7),
          message,
          date
        }
        this.onUpdateAvailable?.(info)
        return info
      }

      return { available: false, currentSha: localSha.slice(0, 7), remoteSha: remoteSha.slice(0, 7), message: '', date: '' }
    } catch {
      // Not a git repo, no internet, etc — silently skip
      return null
    }
  }

  async performUpdate(): Promise<{ success: boolean; error?: string }> {
    try {
      execSync('git pull origin main', { cwd: this.appPath, encoding: 'utf-8', timeout: 30000 })
      execSync('npm install', { cwd: this.appPath, encoding: 'utf-8', timeout: 120000 })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}
