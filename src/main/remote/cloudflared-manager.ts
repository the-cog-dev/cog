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
    return new Promise((resolve, reject) => {
      let buffer = ''
      let resolved = false
      // Use 127.0.0.1 explicitly — on Windows, 'localhost' can resolve to ::1 (IPv6)
      // first, and cloudflared fails to reach the Express server bound to IPv4 only.
      const args = ['tunnel', '--url', `http://127.0.0.1:${localPort}`, '--loglevel', 'debug']
      console.log(`[cloudflared] spawning: ${this.installedPath} ${args.join(' ')}`)
      const child = this.opts.spawnChild(this.installedPath!, args)
      this.child = child

      const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        // Log EVERY line of cloudflared output so we can see tunnel behavior
        text.split('\n').forEach(line => {
          if (line.trim()) console.log(`[cloudflared] ${line.trim()}`)
        })
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
        console.log(`[cloudflared] process exited with code ${code}`)
        if (!resolved) {
          reject(new Error(`cloudflared exited with code ${code} before tunnel URL was received`))
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
