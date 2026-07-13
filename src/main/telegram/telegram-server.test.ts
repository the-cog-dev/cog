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

// The most-recently-constructed FakeBot instance, exposing handleUpdate() so
// tests can drive an update through the REAL, ORDERED middleware chain (see
// below) instead of invoking a captured handler directly. Invoking a handler
// directly (as lastCommandHandlers/lastOnHandlers above do) bypasses any
// bot.use(...) gate registered before it — which is exactly what let C1 (the
// topics-mode allowlist gate dropping supergroup updates) slip through Task 6's
// tests undetected. Tests that need to exercise the gate MUST go through
// lastBot.handleUpdate(ctx), not the raw captured handlers.
let lastBot: { handleUpdate(ctx: any): Promise<void> } | null = null

type MiddlewareEntry =
  | { kind: 'use'; handler: (ctx: any, next: () => Promise<void>) => unknown }
  | { kind: 'command'; name: string; handler: (ctx: any) => unknown }
  | { kind: 'on'; events: string[]; handler: (ctx: any) => unknown }

function matchesEvent(ctx: any, events: string[]): boolean {
  for (const e of events) {
    if (e === 'message:text' && typeof ctx.message?.text === 'string') return true
    if (e === 'message:document' && ctx.message?.document) return true
    if (e === 'message:photo' && ctx.message?.photo) return true
    if (e === 'message:voice' && ctx.message?.voice) return true
    if (e === 'callback_query:data' && typeof ctx.callbackQuery?.data === 'string') return true
  }
  return false
}

function matchesCommand(ctx: any, name: string): boolean {
  const text = ctx.message?.text
  return typeof text === 'string' && (text === `/${name}` || text.startsWith(`/${name} `) || text.startsWith(`/${name}@`))
}

// class FakeBot is defined INSIDE the vi.mock factory below (not at module
// top level): vi.mock('grammy', factory) is hoisted above the rest of this
// file's top-level code, and telegram-server.ts's `import { Bot } from
// 'grammy'` triggers the factory while it resolves — before a module-level
// `class FakeBot {}` declared out here would have run. Referencing it from
// inside the (also hoisted) factory throws "Cannot access before
// initialization". lastCommandHandlers/lastOnHandlers/lastBot are plain `let`
// bindings only read/written from inside method bodies, which only run later
// during an actual test — so those are safe to keep at module scope.
vi.mock('grammy', () => {
  class FakeBot {
    botInfo = { username: 'test_bot' }
    me = { id: 999 }
    api = fakeBotApi
    // Ordered registration log — mirrors grammY's single linear Composer
    // chain, where bot.use/bot.command/bot.on all share one middleware array
    // in registration order. A bot.use(...) that returns without calling
    // next() terminates the chain for that update, same as the real thing.
    private entries: MiddlewareEntry[] = []

    constructor() { lastBot = this }

    command(name: string, handler: (ctx: any) => unknown) {
      lastCommandHandlers[name] = handler
      this.entries.push({ kind: 'command', name, handler })
    }

    use(handler: (ctx: any, next: () => Promise<void>) => unknown) {
      this.entries.push({ kind: 'use', handler })
    }

    on(event: string | string[], handler: (ctx: any) => unknown) {
      const events = Array.isArray(event) ? event : [event]
      for (const e of events) lastOnHandlers[e] = handler
      this.entries.push({ kind: 'on', events, handler })
    }

    catch(..._args: unknown[]) {}
    async init() {}
    async start(..._args: unknown[]) {}
    async stop() {}

    /** Dispatch one fake update through the real, ordered middleware chain. */
    async handleUpdate(ctx: any): Promise<void> {
      const runFrom = async (index: number): Promise<void> => {
        if (index >= this.entries.length) return
        const entry = this.entries[index]
        if (entry.kind === 'use') {
          await entry.handler(ctx, () => runFrom(index + 1))
          return
        }
        const matched = entry.kind === 'command' ? matchesCommand(ctx, entry.name) : matchesEvent(ctx, entry.events)
        if (matched) { await entry.handler(ctx); return }
        await runFrom(index + 1)
      }
      await runFrom(0)
    }
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

// C1 regression: the allowlist gate registered via bot.use(...) hard-returns
// on any non-private chat BEFORE the inbound handlers above ever run. Forum
// topics live in a chat of type 'supergroup', so every in-thread update was
// being dropped at the gate — Task 6's tests never caught this because they
// invoke lastOnHandlers[...] directly, bypassing bot.use(...) entirely. These
// tests drive updates through FakeBot.handleUpdate() — the real, ordered
// composer chain — so the gate is actually exercised.
describe('TelegramServer allowlist gate + topics (C1 regression, real middleware chain)', () => {
  const fakeWorkspaceRouter: WorkspaceRouter = {
    sendToWorkspace: vi.fn(() => ({ ok: true })),
    workspaceStatus: vi.fn(() => []),
    sendFileToWorkspace: vi.fn(() => ({ ok: true }))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    lastOnHandlers = {}
    lastBot = null
    fakeBotApi.createForumTopic.mockResolvedValue({ message_thread_id: 7 })
  })

  it('lets a bound supergroup thread reply through the gate to the workspace router', async () => {
    const server = await makeTopicsServer(fakeBridge, -100, { workspaceRouter: fakeWorkspaceRouter })
    await server.ensureTopic('ws1', 'Alpha')  // maps thread 7 -> ws1
    expect(lastBot).not.toBeNull()

    // No pairing at all — trust in topics mode is supergroup membership, not
    // per-user pairing, so this must still get through.
    const ctx = {
      chat: { id: -100, type: 'supergroup' },
      from: { id: 555 },
      message: { text: 'status please', message_thread_id: 7 },
      reply: vi.fn()
    }
    await lastBot!.handleUpdate(ctx)

    expect(fakeWorkspaceRouter.sendToWorkspace).toHaveBeenCalledWith('ws1', 'status please')
  })

  it('drops an update from a non-bound supergroup even for a paired user (clamp holds)', async () => {
    const pairing = new PairingManager({ initialAllowlist: [111] })
    const server = new TelegramServer({
      pairing,
      bridge: fakeBridge,
      workspaceRouter: fakeWorkspaceRouter,
      mode: 'topics',
      supergroupChatId: -100
    })
    await server.start('fake-token')
    await server.ensureTopic('ws1', 'Alpha')
    expect(lastBot).not.toBeNull()

    // Same thread id (7), but a DIFFERENT (non-bound) supergroup chat id —
    // must be dropped, not routed, even though the user is paired.
    const ctx = {
      chat: { id: -999, type: 'supergroup' },
      from: { id: 111 },
      message: { text: 'status please', message_thread_id: 7 },
      reply: vi.fn()
    }
    await lastBot!.handleUpdate(ctx)

    expect(fakeWorkspaceRouter.sendToWorkspace).not.toHaveBeenCalled()
  })
})
