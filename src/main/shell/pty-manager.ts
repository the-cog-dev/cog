import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { StatusDetector } from './status-detector'
import { OutputBuffer } from './output-buffer'
import { BuddyDetector, type BuddyDetection } from './buddy-detector'
import type { AgentConfig, AgentStatus } from '../../shared/types'

export interface ManagedPty {
  pty: IPty
  config: AgentConfig
  statusDetector: StatusDetector
  outputBuffer: OutputBuffer
  mcpConfigPath: string | null
  buddyDetector: BuddyDetector
}

interface SpawnOptions {
  config: AgentConfig
  mcpConfigPath: string | null
  extraEnv?: Record<string, string>
  onData: (data: string) => void
  onExit: (exitCode: number | undefined) => void
  onStatusChange: (status: AgentStatus) => void
  onClearDetected?: () => void
  onBuddyDetected?: (detection: BuddyDetection) => void
}

function resolveShell(config: AgentConfig): string {
  if (process.platform === 'win32') {
    return config.shell === 'cmd' ? 'cmd.exe' : 'powershell.exe'
  }

  const shellMap: Partial<Record<AgentConfig['shell'], string>> = {
    bash: '/bin/bash',
    zsh: '/bin/zsh',
    fish: '/usr/bin/fish'
  }

  return shellMap[config.shell] ?? process.env.SHELL ?? '/bin/bash'
}

export function spawnAgentPty(opts: SpawnOptions): ManagedPty {
  let promptRegex: RegExp | undefined
  if (opts.config.promptRegex) {
    try {
      // Validate and test regex with a timeout-safe approach
      const testRegex = new RegExp(opts.config.promptRegex)
      // Quick sanity check — if it takes too long on a test string, reject it
      const start = Date.now()
      testRegex.test('a'.repeat(100))
      if (Date.now() - start > 50) {
        console.warn(`Agent "${opts.config.name}": promptRegex too slow, using default`)
      } else {
        promptRegex = testRegex
      }
    } catch {
      console.warn(`Agent "${opts.config.name}": invalid promptRegex, using default`)
    }
  }

  const statusDetector = new StatusDetector({
    promptRegex,
    onChange: opts.onStatusChange,
    onClearDetected: opts.onClearDetected
  })

  const buddyDetector = new BuddyDetector()
  const outputBuffer = new OutputBuffer(1000)
  const shell = resolveShell(opts.config)
  const shellArgs: string[] = []

  if (opts.config.admin) {
    if (process.platform === 'win32') {
      console.warn(`Agent "${opts.config.name}" requested admin elevation - UAC prompt may appear`)
    } else {
      console.warn(`Agent "${opts.config.name}" requested admin elevation. Automatic sudo shell launch is not implemented; use a privileged shell if needed.`)
    }
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

    // Scan for buddy/companion speech in the raw chunk
    const detection = buddyDetector.detect(data)
    if (detection) {
      opts.onBuddyDetected?.(detection)
    }
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
    mcpConfigPath: opts.mcpConfigPath,
    buddyDetector
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
