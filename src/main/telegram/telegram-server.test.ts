import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TelegramServer, type TelegramServerOptions, type WorkspaceRouter } from './telegram-server'
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

// Command handlers registered during the last FakeBot construction, keyed by
// name — lets tests fire a fake /bind or /unbind update through the real
// grammY-handler code without a network-backed bot.
let lastCommandHandlers: Record<string, (ctx: any) => unknown> = {}

// Same idea for bot.on(...) handlers (e.g. 'message:text', 'message:document'),
// keyed by event name. grammY's .on() accepts either a single event string or
// an array of them (as the document/photo handler does) — capture under each.
let lastOnHandlers: Record<string, (ctx: any) => unknown> = {}

vi.mock('grammy', () => {
  class FakeBot {
    botInfo = { username: 'test_bot' }
    me = { id: 999 }
    api = fakeBotApi
    command(name: string, handler: (ctx: any) => unknown) { lastCommandHandlers[name] = handler }
    use(..._args: unknown[]) {}
    on(event: string | string[], handler: (ctx: any) => unknown) {
      for (const e of Array.isArray(event) ? event : [event]) lastOnHandlers[e] = handler
    }
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

async function makeTopicsServer(
  bridge: OrchestratorBridge,
  supergroupChatId = -100,
  extra: Partial<TelegramServerOptions> = {}
): Promise<TelegramServer> {
  const server = new TelegramServer({
    pairing: new PairingManager(),
    bridge,
    mode: 'topics',
    supergroupChatId,
    ...extra
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

describe('TelegramServer relayFromWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeBotApi.createForumTopic.mockResolvedValue({ message_thread_id: 7 })
    fakeBotApi.sendMessage.mockResolvedValue({ message_id: 555 })
  })

  it('sends into the workspace thread with no [project] prefix when a thread is mapped', async () => {
    const server = await makeTopicsServer(fakeBridge)
    await server.ensureTopic('ws1', 'Alpha')

    server.relayFromWorkspace('ws1', 'Orc', 'hi')

    expect(fakeBotApi.sendMessage).toHaveBeenCalledWith(-100, expect.any(String), { message_thread_id: 7 })
    const [, text] = fakeBotApi.sendMessage.mock.calls.at(-1)!
    expect(text).not.toMatch(/^\[.*\]/)
    expect(text).toContain('Orc:')
  })

  it('falls back to the DM relay when mode is dm', async () => {
    const pairing = new PairingManager({ initialAllowlist: [111] })
    const server = new TelegramServer({
      pairing,
      bridge: fakeBridge,
      mode: 'dm',
      initialChats: [111]
    })
    await server.start('fake-token')

    server.relayFromWorkspace('ws1', 'Orc', 'hi')

    expect(fakeBotApi.sendMessage).toHaveBeenCalledTimes(1)
    const call = fakeBotApi.sendMessage.mock.calls.at(-1)!
    expect(call[0]).toBe(111)          // subscribed DM chat, not the supergroup
    expect(call[2]).toBeUndefined()    // no message_thread_id on the DM path
  })

  it('falls back to the DM relay when the workspace has no mapped thread', async () => {
    const pairing = new PairingManager({ initialAllowlist: [111] })
    const server = new TelegramServer({
      pairing,
      bridge: fakeBridge,
      mode: 'topics',
      supergroupChatId: -100,
      initialChats: [111]
    })
    await server.start('fake-token')

    server.relayFromWorkspace('ws-unmapped', 'Orc', 'hi')

    expect(fakeBotApi.sendMessage).toHaveBeenCalledWith(111, expect.any(String))
  })

  it('falls back to the DM relay when the thread send fails', async () => {
    const pairing = new PairingManager({ initialAllowlist: [111] })
    const server = new TelegramServer({
      pairing,
      bridge: fakeBridge,
      mode: 'topics',
      supergroupChatId: -100,
      initialChats: [111]
    })
    await server.start('fake-token')
    await server.ensureTopic('ws1', 'Alpha')

    fakeBotApi.sendMessage.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ message_id: 555 })

    server.relayFromWorkspace('ws1', 'Orc', 'hi')
    await new Promise((r) => setTimeout(r, 0)) // let the rejected promise's .catch() fallback run

    expect(fakeBotApi.sendMessage).toHaveBeenCalledTimes(2)
    const lastCall = fakeBotApi.sendMessage.mock.calls.at(-1)!
    expect(lastCall[0]).toBe(111)
  })
})

describe('TelegramServer /bind and /unbind commands', () => {
  const forumSupergroupChat = { id: -200, type: 'supergroup' as const, is_forum: true }

  function makeCtx(overrides: Record<string, unknown> = {}) {
    return {
      chat: forumSupergroupChat,
      from: { id: 111 },
      me: { id: 999 },
      api: { getChatMember: vi.fn().mockResolvedValue({ status: 'administrator', can_manage_topics: true }) },
      reply: vi.fn(),
      ...overrides
    }
  }

  beforeEach(() => {
    lastCommandHandlers = {}
    vi.clearAllMocks()
  })

  async function makeBoundServer(extra: Partial<TelegramServerOptions> = {}) {
    const pairing = new PairingManager({ initialAllowlist: [111] })
    const onBind = vi.fn().mockResolvedValue(undefined)
    const onUnbind = vi.fn()
    const server = new TelegramServer({ pairing, bridge: fakeBridge, onBind, onUnbind, ...extra })
    await server.start('fake-token')
    return { server, onBind, onUnbind }
  }

  it('/bind flips to topics mode, replies, and fires onBind for an allowed user', async () => {
    const { server, onBind } = await makeBoundServer()
    const ctx = makeCtx()

    await lastCommandHandlers['bind'](ctx)

    expect(server.getTopicsMode()).toEqual({ mode: 'topics', supergroupChatId: -200 })
    expect(onBind).toHaveBeenCalledWith(-200)
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Bound'))
  })

  it('/bind refuses a non-supergroup chat without flipping mode', async () => {
    const { server, onBind } = await makeBoundServer()
    const ctx = makeCtx({ chat: { id: 111, type: 'private' } })

    await lastCommandHandlers['bind'](ctx)

    expect(server.getTopicsMode().mode).toBe('dm')
    expect(onBind).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('supergroup'))
  })

  it('/bind is silently dropped for a user not on the allowlist', async () => {
    const { server, onBind } = await makeBoundServer()
    const ctx = makeCtx({ from: { id: 999999 } })

    await lastCommandHandlers['bind'](ctx)

    expect(server.getTopicsMode().mode).toBe('dm')
    expect(onBind).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('/unbind reverts to dm mode and fires onUnbind', async () => {
    const { server, onUnbind } = await makeBoundServer({ mode: 'topics', supergroupChatId: -200 })
    const ctx = makeCtx()

    await lastCommandHandlers['unbind'](ctx)

    expect(server.getTopicsMode()).toEqual({ mode: 'dm', supergroupChatId: undefined })
    expect(onUnbind).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('direct-message'))
  })
})

describe('TelegramServer inbound thread routing (Task 6)', () => {
  const fakeWorkspaceRouter: WorkspaceRouter = {
    sendToWorkspace: vi.fn(() => ({ ok: true })),
    workspaceStatus: vi.fn(() => []),
    sendFileToWorkspace: vi.fn(() => ({ ok: true }))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    lastOnHandlers = {}
    fakeBotApi.createForumTopic.mockResolvedValue({ message_thread_id: 7 })
  })

  it('routes a thread reply to the mapped workspace via workspaceRouter, bypassing bridge', async () => {
    const sendTo = vi.fn(() => ({ ok: true }))
    const bridge: OrchestratorBridge = { ...fakeBridge, sendTo }
    const server = await makeTopicsServer(bridge, -100, { workspaceRouter: fakeWorkspaceRouter })
    await server.ensureTopic('ws1', 'Alpha')  // maps thread 7 -> ws1

    const ctx = { chat: { id: -100 }, message: { text: 'status please', message_thread_id: 7 }, reply: vi.fn() }
    await lastOnHandlers['message:text'](ctx)

    expect(fakeWorkspaceRouter.sendToWorkspace).toHaveBeenCalledWith('ws1', 'status please')
    expect(sendTo).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()  // ok:true → no error reply
  })

  it('replies with a clear message and does not call bridge when the thread is unmapped', async () => {
    const sendTo = vi.fn(() => ({ ok: true }))
    const bridge: OrchestratorBridge = { ...fakeBridge, sendTo }
    const server = await makeTopicsServer(bridge, -100, { workspaceRouter: fakeWorkspaceRouter })
    await server.ensureTopic('ws1', 'Alpha')  // thread 7 mapped; thread 99 is not

    const ctx = { chat: { id: -100 }, message: { text: 'hello', message_thread_id: 99 }, reply: vi.fn() }
    await lastOnHandlers['message:text'](ctx)

    expect(fakeWorkspaceRouter.sendToWorkspace).not.toHaveBeenCalled()
    expect(sendTo).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('isn\'t linked'))
  })

  it('falls through to bridge, unchanged, for a General-topic message (no thread id)', async () => {
    const sendTo = vi.fn(() => ({ ok: true }))
    const bridge: OrchestratorBridge = {
      ...fakeBridge,
      sendTo,
      listTargets: () => [{ name: 'cara', role: 'orchestrator', status: 'active' }]
    }
    const server = await makeTopicsServer(bridge, -100, { workspaceRouter: fakeWorkspaceRouter })
    await server.ensureTopic('ws1', 'Alpha')

    const ctx = { chat: { id: -100 }, message: { text: 'hello', message_thread_id: undefined }, reply: vi.fn() }
    await lastOnHandlers['message:text'](ctx)

    expect(fakeWorkspaceRouter.sendToWorkspace).not.toHaveBeenCalled()
    expect(sendTo).toHaveBeenCalledWith('cara', 'hello')
  })

  it('falls through to bridge, unchanged, in dm mode even with workspaceRouter configured', async () => {
    const sendTo = vi.fn(() => ({ ok: true }))
    const bridge: OrchestratorBridge = {
      ...fakeBridge,
      sendTo,
      listTargets: () => [{ name: 'cara', role: 'orchestrator', status: 'active' }]
    }
    const server = new TelegramServer({
      pairing: new PairingManager(),
      bridge,
      workspaceRouter: fakeWorkspaceRouter,
      mode: 'dm'
    })
    await server.start('fake-token')

    const ctx = { chat: { id: 111 }, message: { text: 'hello', message_thread_id: 7 }, reply: vi.fn() }
    await lastOnHandlers['message:text'](ctx)

    expect(fakeWorkspaceRouter.sendToWorkspace).not.toHaveBeenCalled()
    expect(sendTo).toHaveBeenCalledWith('cara', 'hello')
  })

  it('routes a thread attachment to the mapped workspace via sendFileToWorkspace, bypassing bridge', async () => {
    const sendFile = vi.fn(() => ({ ok: true }))
    const bridge: OrchestratorBridge = { ...fakeBridge, sendFile }
    const server = await makeTopicsServer(bridge, -100, { workspaceRouter: fakeWorkspaceRouter })
    await server.ensureTopic('ws1', 'Alpha')  // maps thread 7 -> ws1

    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
    } as any)

    const ctx = {
      chat: { id: -100 },
      message: { message_thread_id: 7, document: { file_name: 'notes.txt', mime_type: 'text/plain' }, caption: undefined },
      getFile: vi.fn().mockResolvedValue({ file_path: 'docs/notes.txt' }),
      reply: vi.fn()
    }
    await lastOnHandlers['message:document'](ctx)

    expect(fakeWorkspaceRouter.sendFileToWorkspace).toHaveBeenCalledWith(
      'ws1', expect.objectContaining({ filename: 'notes.txt' })
    )
    expect(sendFile).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('📎'))

    fetchSpy.mockRestore()
  })
})
