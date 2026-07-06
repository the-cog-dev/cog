import { describe, it, expect, vi } from 'vitest'
import { TelegramServer } from './telegram-server'
import { PairingManager } from './pairing-manager'
import type { OrchestratorBridge } from './bridge'

const fakeBridge: OrchestratorBridge = {
  listTargets: () => [],
  sendTo: () => ({ ok: true }),
  sendFile: () => ({ ok: true }),
  approveProposal: async () => ({ ok: true }),
  rejectProposal: async () => ({ ok: true }),
  getProposal: () => null,
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

  it('revokeUser cuts both command access and the relay subscription', () => {
    const pairing = new PairingManager({ initialAllowlist: [111] })
    const onChatsChange = vi.fn()
    const s = new TelegramServer({
      pairing,
      bridge: fakeBridge,
      initialChats: [111],   // private chat ID === user ID
      onChatsChange
    })
    expect(s.revokeUser(111)).toBe(true)
    expect(pairing.isAllowed(111)).toBe(false)
    expect(onChatsChange).toHaveBeenLastCalledWith([])  // subscription persisted away
    expect(s.revokeUser(111)).toBe(false)               // already gone
  })
})
