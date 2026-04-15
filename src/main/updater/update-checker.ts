import { execFileSync } from 'child_process'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
import path from 'path'

const REPO_API = 'https://api.github.com/repos/the-cog-dev/cog/commits/main'
const CHECK_INTERVAL_MS = 2 * 60 * 1000 // Check every 2 minutes

// Accept only full/abbrev git SHAs — these values flow into git argv and are
// read from an on-disk JSON file, so a strict format gate removes argument
// smuggling even if the file is tampered with.
const SHA_PATTERN = /^[0-9a-f]{4,64}$/i

// The remote we allow the in-app updater to pull from. `git pull origin main`
// blindly trusts whatever `origin` points at; an attacker who can write
// `.git/config` can redirect updates. Binding to a known URL closes that hole.
const TRUSTED_REMOTE_URL = 'https://github.com/the-cog-dev/cog.git'
const TRUSTED_REMOTE_BRANCH = 'main'

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
      const localSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.appPath, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
      }).trim()

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
      const fromSha = String(info?.fromSha ?? '')
      const toSha = String(info?.toSha ?? '')
      // If the on-disk file was tampered with, refuse to use either value.
      if (!SHA_PATTERN.test(fromSha) || !SHA_PATTERN.test(toSha)) {
        try { unlinkSync(infoPath) } catch { /* best effort */ }
        return null
      }
      const log = execFileSync('git', ['log', '--oneline', `${fromSha}..${toSha}`], {
        cwd: this.appPath, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
      })
      const commits = log.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split(' ')
        parts.shift()
        return parts.join(' ')
      })
      unlinkSync(infoPath)
      return { commits, fromSha: fromSha.slice(0, 7), toSha: toSha.slice(0, 7) }
    } catch {
      return null
    }
  }

  async performUpdate(): Promise<{ success: boolean; error?: string }> {
    const gitExec = (args: string[], timeoutMs: number): string =>
      execFileSync('git', args, {
        cwd: this.appPath, encoding: 'utf-8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe']
      }).trim()

    try {
      const beforeSha = gitExec(['rev-parse', 'HEAD'], 5000)

      // Pin the update source. If origin has been redirected to an attacker URL
      // (malicious dep rewriting .git/config, compromised prior update, etc.),
      // fail closed instead of pulling.
      let originUrl = ''
      try { originUrl = gitExec(['remote', 'get-url', 'origin'], 5000) } catch { /* unset */ }
      const normalize = (u: string) => u.replace(/\.git\/?$/, '').replace(/\/+$/, '').toLowerCase()
      if (normalize(originUrl) !== normalize(TRUSTED_REMOTE_URL)) {
        return { success: false, error: `origin is ${originUrl || 'unset'}, expected ${TRUSTED_REMOTE_URL}` }
      }

      // Reset local mutations (linter output, built artifacts) so git fetch is clean.
      try { gitExec(['checkout', '--', '.'], 5000) } catch { /* best effort */ }
      try { gitExec(['clean', '-fd'], 5000) } catch { /* best effort */ }

      // Fetch + fast-forward rather than a bare `git pull`, so we can verify
      // the incoming commit before it becomes HEAD.
      gitExec(['fetch', '--force', TRUSTED_REMOTE_URL, `+refs/heads/${TRUSTED_REMOTE_BRANCH}:refs/remotes/origin/${TRUSTED_REMOTE_BRANCH}`], 60000)
      const incomingSha = gitExec(['rev-parse', `refs/remotes/origin/${TRUSTED_REMOTE_BRANCH}`], 5000)
      if (!SHA_PATTERN.test(incomingSha)) {
        return { success: false, error: 'Invalid incoming SHA from fetch' }
      }

      // Best-effort GPG signature logging. Don't hard-fail when unsigned since
      // releases aren't reliably signed today, but log the state.
      let signatureState = 'unverified'
      try {
        gitExec(['verify-commit', incomingSha], 10000)
        signatureState = 'verified'
      } catch {
        signatureState = 'unsigned'
      }
      console.log(`[UpdateChecker] Incoming commit ${incomingSha.slice(0, 8)}: ${signatureState}`)

      gitExec(['reset', '--hard', incomingSha], 30000)

      execFileSync('npm', ['install'], {
        cwd: this.appPath, encoding: 'utf-8', timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32'
      })
      execFileSync('npm', ['run', 'build'], {
        cwd: this.appPath, encoding: 'utf-8', timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32'
      })

      const afterSha = gitExec(['rev-parse', 'HEAD'], 5000)
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
