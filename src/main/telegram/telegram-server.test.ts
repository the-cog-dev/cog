import { describe, it, expect } from 'vitest'
import { TelegramServer } from './telegram-server'
import { PairingManager } from './pairing-manager'
import type { OrchestratorBridge } from './bridge'

const fakeBridge: OrchestratorBridge = {
  listTargets: () => [],
  sendTo: () => ({ ok: true }),
  getOutput: () => [],
  postTask: () => ({ ok: true })
}

describe('TelegramServer', () => {
  it('constructs and reports not running before start', () => {
    const s = new TelegramServer({ pairing: new PairingManager(), bridge: fakeBridge })
    expect(s.isRunning()).toBe(false)
  })

  it('relayFromAgent is a safe no-op before the bot starts', () => {
    const s = new TelegramServer({ pairing: new PairingManager(), bridge: fakeBridge })
    expect(() => s.relayFromAgent('cara', 'hello from the swarm')).not.toThrow()
  })
})
