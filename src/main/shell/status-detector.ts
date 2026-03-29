import type { AgentStatus } from '../../shared/types'

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

interface StatusDetectorOptions {
  promptRegex?: RegExp
  silenceMs?: number
  onChange?: (status: AgentStatus) => void
}

export class StatusDetector {
  private _status: AgentStatus = 'idle'
  private promptRegex: RegExp
  private silenceMs: number
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private lastLineMatchedPrompt = false
  private onChange?: (status: AgentStatus) => void

  constructor(opts: StatusDetectorOptions = {}) {
    this.promptRegex = opts.promptRegex ?? /[>❯]\s*$/
    this.silenceMs = opts.silenceMs ?? 2000
    this.onChange = opts.onChange
  }

  get status(): AgentStatus {
    return this._status
  }

  onData(data: string): void {
    this.setStatus('working')

    const clean = stripAnsi(data)
    const lines = clean.split('\n').filter(l => l.trim().length > 0)
    const lastLine = lines[lines.length - 1] ?? ''
    this.lastLineMatchedPrompt = this.promptRegex.test(lastLine)

    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = setTimeout(() => {
      if (this.lastLineMatchedPrompt && this._status === 'working') {
        this.setStatus('active')
      }
    }, this.silenceMs)
  }

  onExit(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.setStatus('disconnected')
  }

  private setStatus(status: AgentStatus): void {
    if (this._status !== status) {
      this._status = status
      this.onChange?.(status)
    }
  }
}
