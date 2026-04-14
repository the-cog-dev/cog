const TRYCLOUDFLARE_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

export function parseTunnelUrl(buffer: string): string | null {
  const match = buffer.match(TRYCLOUDFLARE_REGEX)
  return match ? match[0] : null
}

export function resolveBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

export function resolveDownloadUrl(platform: NodeJS.Platform, arch: string): string {
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/'
  if (platform === 'win32') {
    if (arch === 'x64') return `${base}cloudflared-windows-amd64.exe`
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return `${base}cloudflared-darwin-amd64.tgz`
    if (arch === 'arm64') return `${base}cloudflared-darwin-arm64.tgz`
  }
  if (platform === 'linux') {
    if (arch === 'x64') return `${base}cloudflared-linux-amd64`
    if (arch === 'arm64') return `${base}cloudflared-linux-arm64`
  }
  throw new Error(`Unsupported platform/arch for cloudflared: ${platform}/${arch}`)
}

import * as fs from 'fs'
import * as path from 'path'
import type { ChildProcess } from 'child_process'

export type DownloadFn = (url: string, dest: string, onProgress: (pct: number) => void) => Promise<void>
export type SpawnChildFn = (cmd: string, args: string[]) => ChildProcess

export interface CloudflaredManagerOptions {
  userDataPath: string
  download: DownloadFn
  spawnChild: SpawnChildFn
  onProgress?: (pct: number) => void
}

export class CloudflaredManager {
  private installedPath: string | null = null
  private child: ChildProcess | null = null

  constructor(private opts: CloudflaredManagerOptions) {}

  private get binDir(): string {
    return path.join(this.opts.userDataPath, 'bin')
  }

  private get binPath(): string {
    return path.join(this.binDir, resolveBinaryName(process.platform))
  }

  private get emptyConfigPath(): string {
    return path.join(this.binDir, 'agentorch-cloudflared.yml')
  }

  private ensureEmptyConfig(): void {
    // Write an empty config file so cloudflared doesn't load the user's
    // existing ~/.cloudflared/config.yml (which may have ingress rules that
    // return 404 or route to other tunnels).
    fs.mkdirSync(this.binDir, { recursive: true })
    if (!fs.existsSync(this.emptyConfigPath)) {
      fs.writeFileSync(this.emptyConfigPath, '# Cog-managed empty config — intentionally blank\n')
    }
  }

  markInstalledForTest(p: string): void {
    this.installedPath = p
  }

  findInstalled(): string | null {
    if (this.installedPath) return this.installedPath
    if (fs.existsSync(this.binPath)) {
      this.installedPath = this.binPath
      return this.installedPath
    }
    return null
  }

  async ensureInstalled(): Promise<void> {
    if (this.findInstalled()) return
    fs.mkdirSync(this.binDir, { recursive: true })
    const url = resolveDownloadUrl(process.platform, process.arch)
    await this.opts.download(url, this.binPath, (pct) => {
      this.opts.onProgress?.(pct)
    })
    if (process.platform !== 'win32') {
      fs.chmodSync(this.binPath, 0o755)
    }
    this.installedPath = this.binPath
  }

  start(localPort: number): Promise<string> {
    if (!this.installedPath) {
      return Promise.reject(new Error('cloudflared not installed — call ensureInstalled() first'))
    }
    this.ensureEmptyConfig()
    return new Promise((resolve, reject) => {
      let buffer = ''
      let resolved = false
      // Use 127.0.0.1 explicitly — on Windows, 'localhost' can resolve to ::1 (IPv6)
      // first, and cloudflared fails to reach the Express server bound to IPv4 only.
      // Also pass an empty --config so we don't inherit the user's existing
      // ~/.cloudflared/config.yml which may route traffic to a different tunnel or 404.
      const args = [
        'tunnel',
        '--config', this.emptyConfigPath,
        '--url', `http://127.0.0.1:${localPort}`
      ]
      const child = this.opts.spawnChild(this.installedPath!, args)
      this.child = child

      const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        buffer += text
        const url = parseTunnelUrl(buffer)
        if (url && !resolved) {
          resolved = true
          resolve(url)
        }
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)

      child.on('exit', (code) => {
        if (!resolved) {
          reject(new Error(`cloudflared exited with code ${code} before tunnel URL was received`))
        } else if (code !== 0 && code !== null) {
          console.log(`[cloudflared] process exited unexpectedly with code ${code}`)
        }
      })
    })
  }

  stop(): void {
    if (this.child) {
      try { this.child.kill('SIGTERM') } catch { /* already dead */ }
      this.child = null
    }
  }
}
