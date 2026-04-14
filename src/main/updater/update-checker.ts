import { execSync } from 'child_process'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
import path from 'path'

const REPO_API = 'https://api.github.com/repos/the-cog-dev/cog/commits/main'
const CHECK_INTERVAL_MS = 2 * 60 * 1000 // Check every 2 minutes

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

  saveUpdateInfo(fromSha: string, toSha: string): void {
    try {
      const infoPath = path.join(this.appPath, '.update-info.json')
      writeFileSync(infoPath, JSON.stringify({ fromSha, toSha, updatedAt: new Date().toISOString() }), 'utf-8')
    } catch { /* best effort */ }
  }

  getPendingChangelog(): { commits: string[]; fromSha: string; toSha: string } | null {
    try {
      const infoPath = path.join(this.appPath, '.update-info.json')
      if (!existsSync(infoPath)) return null
      const info = JSON.parse(readFileSync(infoPath, 'utf-8'))
      const log = execSync(`git log --oneline ${info.fromSha}..${info.toSha}`, { cwd: this.appPath, encoding: 'utf-8', timeout: 5000 })
      const commits = log.trim().split('\n').filter(Boolean).map(line => {
        // Strip sha prefix, just keep the message
        const parts = line.split(' ')
        parts.shift()
        return parts.join(' ')
      })
      // Delete the file after reading
      unlinkSync(infoPath)
      return { commits, fromSha: info.fromSha.slice(0, 7), toSha: info.toSha.slice(0, 7) }
    } catch {
      return null
    }
  }

  async performUpdate(): Promise<{ success: boolean; error?: string }> {
    try {
      const beforeSha = execSync('git rev-parse HEAD', { cwd: this.appPath, encoding: 'utf-8', timeout: 5000 }).trim()
      // Force-reset any local changes (linter mods, built files, etc.) before pulling
      // This is safe because the user's actual work is in their project folder, not the app source
      try { execSync('git checkout -- .', { cwd: this.appPath, encoding: 'utf-8', timeout: 5000 }) } catch { /* clean */ }
      try { execSync('git clean -fd', { cwd: this.appPath, encoding: 'utf-8', timeout: 5000 }) } catch { /* clean */ }
      execSync('git pull origin main', { cwd: this.appPath, encoding: 'utf-8', timeout: 30000 })
      execSync('npm install', { cwd: this.appPath, encoding: 'utf-8', timeout: 120000 })
      execSync('npm run build', { cwd: this.appPath, encoding: 'utf-8', timeout: 120000 })
      const afterSha = execSync('git rev-parse HEAD', { cwd: this.appPath, encoding: 'utf-8', timeout: 5000 }).trim()
      if (beforeSha !== afterSha) {
        this.saveUpdateInfo(beforeSha, afterSha)
      }
      return { success: true }
    } catch (err: any) {
      const msg = err.message?.split('\n')[0] || 'Update failed'
      return { success: false, error: msg }
    }
  }
}
