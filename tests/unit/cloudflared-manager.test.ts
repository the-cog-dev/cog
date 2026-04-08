import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parseTunnelUrl,
  resolveBinaryName,
  resolveDownloadUrl
} from '../../src/main/remote/cloudflared-manager'
import { CloudflaredManager } from '../../src/main/remote/cloudflared-manager'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

describe('parseTunnelUrl', () => {
  it('extracts a trycloudflare.com URL from a typical cloudflared log line', () => {
    const line = '2026-04-08T12:34:56Z INF |  https://random-words-here.trycloudflare.com  |'
    expect(parseTunnelUrl(line)).toBe('https://random-words-here.trycloudflare.com')
  })

  it('handles a multi-line buffer and finds the URL', () => {
    const buffer = `
      2026-04-08T12:34:55Z INF Starting tunnel
      2026-04-08T12:34:56Z INF Your quick Tunnel has been created! Visit it at:
      2026-04-08T12:34:56Z INF |  https://abc-def-ghi.trycloudflare.com  |
      2026-04-08T12:34:56Z INF Connection ready
    `
    expect(parseTunnelUrl(buffer)).toBe('https://abc-def-ghi.trycloudflare.com')
  })

  it('returns null when no URL is present', () => {
    expect(parseTunnelUrl('starting up...')).toBeNull()
    expect(parseTunnelUrl('')).toBeNull()
  })

  it('does not match a partial cloudflare.com URL', () => {
    expect(parseTunnelUrl('https://www.cloudflare.com')).toBeNull()
  })
})

describe('resolveBinaryName', () => {
  it('returns cloudflared.exe on Windows', () => {
    expect(resolveBinaryName('win32')).toBe('cloudflared.exe')
  })

  it('returns cloudflared on Mac', () => {
    expect(resolveBinaryName('darwin')).toBe('cloudflared')
  })

  it('returns cloudflared on Linux', () => {
    expect(resolveBinaryName('linux')).toBe('cloudflared')
  })
})

describe('resolveDownloadUrl', () => {
  it('Windows x64', () => {
    expect(resolveDownloadUrl('win32', 'x64'))
      .toBe('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe')
  })

  it('Mac x64', () => {
    expect(resolveDownloadUrl('darwin', 'x64'))
      .toBe('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz')
  })

  it('Mac arm64', () => {
    expect(resolveDownloadUrl('darwin', 'arm64'))
      .toBe('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz')
  })

  it('Linux x64', () => {
    expect(resolveDownloadUrl('linux', 'x64'))
      .toBe('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64')
  })

  it('throws on unsupported platforms', () => {
    expect(() => resolveDownloadUrl('aix', 'x64')).toThrow(/unsupported/i)
  })
})

describe('CloudflaredManager.findInstalled', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns the userData/bin path when the binary exists there', () => {
    const binDir = path.join(tempDir, 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
    const binPath = path.join(binDir, binName)
    fs.writeFileSync(binPath, 'fake')

    const mgr = new CloudflaredManager({
      userDataPath: tempDir,
      download: vi.fn(),
      spawnChild: vi.fn()
    })

    expect(mgr.findInstalled()).toBe(binPath)
  })

  it('returns null when not installed in userData/bin', () => {
    const mgr = new CloudflaredManager({
      userDataPath: tempDir,
      download: vi.fn(),
      spawnChild: vi.fn()
    })
    expect(mgr.findInstalled()).toBeNull()
  })
})

describe('CloudflaredManager.ensureInstalled', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('skips download when binary already exists', async () => {
    const binDir = path.join(tempDir, 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
    fs.writeFileSync(path.join(binDir, binName), 'fake')

    const download = vi.fn()
    const mgr = new CloudflaredManager({
      userDataPath: tempDir,
      download,
      spawnChild: vi.fn()
    })

    await mgr.ensureInstalled()
    expect(download).not.toHaveBeenCalled()
  })

  it('downloads when binary is missing and reports progress', async () => {
    const download = vi.fn(async (_url: string, dest: string, onProgress: (pct: number) => void) => {
      onProgress(50)
      onProgress(100)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, 'fake-binary')
    })
    const onProgress = vi.fn()
    const mgr = new CloudflaredManager({
      userDataPath: tempDir,
      download,
      spawnChild: vi.fn(),
      onProgress
    })

    await mgr.ensureInstalled()
    expect(download).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(50)
    expect(onProgress).toHaveBeenCalledWith(100)

    const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
    expect(fs.existsSync(path.join(tempDir, 'bin', binName))).toBe(true)
  })
})

describe('CloudflaredManager.start', () => {
  it('spawns cloudflared and resolves with the parsed URL', async () => {
    const fakeStdoutHandlers: Array<(chunk: string) => void> = []
    const fakeProcess = {
      stdout: { on: (_e: string, h: (chunk: string) => void) => { fakeStdoutHandlers.push(h) } },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn()
    }
    const spawnChild = vi.fn(() => fakeProcess as any)

    const mgr = new CloudflaredManager({
      userDataPath: '/tmp',
      download: vi.fn(),
      spawnChild
    })

    mgr.markInstalledForTest('/fake/cloudflared')

    const startPromise = mgr.start(7700)

    setTimeout(() => {
      fakeStdoutHandlers.forEach(h => h('2026-04-08T12:00:00Z INF |  https://random-words.trycloudflare.com  |\n'))
    }, 5)

    const url = await startPromise
    expect(url).toBe('https://random-words.trycloudflare.com')
    expect(spawnChild).toHaveBeenCalledWith(
      '/fake/cloudflared',
      ['tunnel', '--url', 'http://127.0.0.1:7700', '--loglevel', 'debug']
    )
  })

  it('rejects if cloudflared exits before printing a URL', async () => {
    const exitHandlers: Array<(code: number) => void> = []
    const fakeProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: (event: string, handler: (code: number) => void) => {
        if (event === 'exit') exitHandlers.push(handler)
      },
      kill: vi.fn()
    }
    const spawnChild = vi.fn(() => fakeProcess as any)

    const mgr = new CloudflaredManager({
      userDataPath: '/tmp',
      download: vi.fn(),
      spawnChild
    })
    mgr.markInstalledForTest('/fake/cloudflared')

    const startPromise = mgr.start(7700)
    setTimeout(() => exitHandlers.forEach(h => h(1)), 5)
    await expect(startPromise).rejects.toThrow(/cloudflared exited/)
  })
})

describe('CloudflaredManager.stop', () => {
  it('kills the spawned child', async () => {
    const kill = vi.fn()
    const stdoutHandlers: Array<(chunk: string) => void> = []
    const fakeProcess = {
      stdout: { on: (_e: string, h: (chunk: string) => void) => stdoutHandlers.push(h) },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill
    }
    const spawnChild = vi.fn(() => fakeProcess as any)

    const mgr = new CloudflaredManager({
      userDataPath: '/tmp',
      download: vi.fn(),
      spawnChild
    })
    mgr.markInstalledForTest('/fake/cloudflared')

    const p = mgr.start(7700)
    setTimeout(() => stdoutHandlers.forEach(h => h('| https://x.trycloudflare.com |')), 5)
    await p

    mgr.stop()
    expect(kill).toHaveBeenCalled()
  })
})
