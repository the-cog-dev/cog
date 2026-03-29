import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { StatusDetector } from './status-detector'
import { OutputBuffer } from './output-buffer'
import type { AgentConfig, AgentStatus } from '../../shared/types'

export interface ManagedPty {
  pty: IPty
  config: AgentConfig
  statusDetector: StatusDetector
  outputBuffer: OutputBuffer
  mcpConfigPath: string | null
}

interface SpawnOptions {
  config: AgentConfig
  mcpConfigPath: string | null
  extraEnv?: Record<string, string>
  onData: (data: string) => void
  onExit: (exitCode: number | undefined) => void
  onStatusChange: (status: AgentStatus) => void
}

export function spawnAgentPty(opts: SpawnOptions): ManagedPty {
  const promptRegex = opts.config.promptRegex
    ? new RegExp(opts.config.promptRegex)
    : undefined

  const statusDetector = new StatusDetector({
    promptRegex,
    onChange: opts.onStatusChange
  })

  const outputBuffer = new OutputBuffer(1000)

  const shell = process.platform === 'win32'
    ? (opts.config.shell === 'powershell' ? 'powershell.exe' : 'cmd.exe')
    : 'bash'

  const shellArgs: string[] = []
  if (opts.config.admin && process.platform === 'win32') {
    console.warn(`Agent "${opts.config.name}" requested admin elevation — UAC prompt may appear`)
  }

  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: opts.config.cwd,
    env: { ...process.env, ...opts.extraEnv } as Record<string, string>
  })

  ptyProcess.onData((data: string) => {
    statusDetector.onData(data)
    outputBuffer.pushRaw(data)
    opts.onData(data)
  })

  ptyProcess.onExit(({ exitCode }) => {
    statusDetector.onExit()
    opts.onExit(exitCode)
  })

  return {
    pty: ptyProcess,
    config: opts.config,
    statusDetector,
    outputBuffer,
    mcpConfigPath: opts.mcpConfigPath
  }
}

export function writeToPty(managed: ManagedPty, data: string): void {
  managed.pty.write(data)
}

export function resizePty(managed: ManagedPty, cols: number, rows: number): void {
  managed.pty.resize(cols, rows)
}

export function killPty(managed: ManagedPty): void {
  managed.pty.kill()
}
