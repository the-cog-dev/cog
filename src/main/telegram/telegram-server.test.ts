import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TelegramServer } from './telegram-server'
import { PairingManager } from './pairing-manager'
import type { OrchestratorBridge } from './bridge'

// Minimal fake grammY surface so tests can drive TelegramServer.start() without
// hitting the network, and assert on the forum-topic API calls it makes. The
// existing tests below never call start(), so this mock doesn't touch them.
const fakeBotApi = {
  createForumTopic: vi.fn(),
  reopenForumTopic: vi.fn(),
  closeForumTopic: vi.fn(),
  editForumTopic: vi.fn(),
  sendMessage: vi.fn(),
  editMessageText: vi.fn()
}

vi.mock('grammy', () => {
  class FakeBot {
    botInfo = { username: 'test_bot' }
    api = fakeBotApi
    command(..._args: unknown[]) {}
    use(..._args: unknown[]) {}
    on(..._args: unknown[]) {}
    catch(..._args: unknown[]) {}
    async init() {}
    async start(..._args: unknown[]) {}
    async stop() {}
  }
  class FakeInlineKeyboard {
    text() { return this }
    row() { return this }
  }
  return { Bot: FakeBot, InlineKeyboard: FakeInlineKeyboard }
})

async function makeTopicsServer(bridge: OrchestratorBridge, supergroupChatId = -100): Promise<TelegramServer> {
  const server = new TelegramServer({
    pairing: new PairingManager(),
    bridge,
    mode: 'topics',
    supergroupChatId
  })
  await server.start('fake-token')
  return server
}

const fakeBridge: OrchestratorBridge = {
  listTargets: () => [],
  sendTo: () => ({ ok: true }),
  sendFile: () => ({ ok: true }),
  sendVoice: async () => ({ ok: true }),
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

describe('TelegramServer topic lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeBotApi.createForumTopic.mockResolvedValue({ message_thread_id: 7 })
    fakeBotApi.reopenForumTopic.mockResolvedValue(true)
    fakeBotApi.closeForumTopic.mockResolvedValue(true)
    fakeBotApi.editForumTopic.mockResolvedValue(true)
  })

  it('ensureTopic creates a forum topic and remembers the thread', async () => {
    const server = await makeTopicsServer(fakeBridge)

    const id = await server.ensureTopic('ws1', 'Alpha')
    expect(id).toBe(7)
    expect(fakeBotApi.createForumTopic).toHaveBeenCalledTimes(1)
    expect(fakeBotApi.createForumTopic).toHaveBeenCalledWith(-100, 'Alpha')

    // second call reuses the stored thread (reopen, not create)
    const again = await server.ensureTopic('ws1', 'Alpha')
    expect(again).toBe(7)
    expect(fakeBotApi.createForumTopic).toHaveBeenCalledTimes(1)
    expect(fakeBotApi.reopenForumTopic).toHaveBeenCalledWith(-100, 7)
  })

  it('ensureTopic is a no-op returning null when not in topics mode', async () => {
    const server = new TelegramServer({ pairing: new PairingManager(), bridge: fakeBridge })
    await server.start('fake-token')

    const id = await server.ensureTopic('ws1', 'Alpha')
    expect(id).toBeNull()
    expect(fakeBotApi.createForumTopic).not.toHaveBeenCalled()
  })

  it('closeTopic closes the stored thread for the workspace', async () => {
    const server = await makeTopicsServer(fakeBridge)
    await server.ensureTopic('ws1', 'Alpha')

    await server.closeTopic('ws1')
    expect(fakeBotApi.closeForumTopic).toHaveBeenCalledWith(-100, 7)
  })

  it('renameTopic updates the registry and edits the Telegram topic', async () => {
    const server = await makeTopicsServer(fakeBridge)
    await server.ensureTopic('ws1', 'Alpha')

    await server.renameTopic('ws1', 'Beta')
    expect(fakeBotApi.editForumTopic).toHaveBeenCalledWith(-100, 7, { name: 'Beta' })
  })

  it('closeTopic no-ops (no grammY call) when not in topics mode', async () => {
    const server = await makeTopicsServer(fakeBridge)
    await server.ensureTopic('ws1', 'Alpha')   // thread stored while in topics mode
    server.setTopicsMode('dm')                  // flip out of topics mode

    await server.closeTopic('ws1')
    expect(fakeBotApi.closeForumTopic).not.toHaveBeenCalled()
  })

  it('renameTopic no-ops (no grammY call) when not in topics mode', async () => {
    const server = await makeTopicsServer(fakeBridge)
    await server.ensureTopic('ws1', 'Alpha')
    server.setTopicsMode('dm')

    await server.renameTopic('ws1', 'Beta')
    expect(fakeBotApi.editForumTopic).not.toHaveBeenCalled()
  })

  it('setTopicsMode/getTopicsMode round-trip', () => {
    const server = new TelegramServer({ pairing: new PairingManager(), bridge: fakeBridge })
    expect(server.getTopicsMode()).toEqual({ mode: 'dm', supergroupChatId: undefined })
    server.setTopicsMode('topics', -100)
    expect(server.getTopicsMode()).toEqual({ mode: 'topics', supergroupChatId: -100 })
  })
})
