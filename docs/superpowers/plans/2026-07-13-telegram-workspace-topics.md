# Telegram Per-Workspace Supergroup Topics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each workspace its own Telegram forum-topic thread in a bound supergroup, so N concurrent orchestrators stop interleaving in one DM; the thread you type in IS the address.

**Architecture:** A pure `TopicRegistry` owns the `workspaceId ↔ threadId` map. `telegram-server.ts` gains topic lifecycle ops (create/close/reopen/rename via grammY `*ForumTopic` APIs), outbound send with `message_thread_id`, and inbound `message_thread_id → workspaceId` resolution. `index.ts` calls the lifecycle from the context functions we already have (`createWorkspaceContext` / `closeWorkspaceContext` / rename / `closeAllContexts` / boot restore) and routes inbound to a specific workspace's hub via a new `WorkspaceRouter` hook. A `telegram.mode` setting (`dm` default | `topics`) selects behavior; DM is the fallback both as default and on any topics-mode failure.

**Tech Stack:** TypeScript, Electron main process, grammY (Telegram bot), vitest. Spec: `docs/superpowers/specs/2026-07-13-telegram-workspace-topics-design.md`.

## Global Constraints

- Verify each task with `npm run build` (esbuild bundles; exit 0). No tsc gate — use `npx tsc -b --noEmit 2>&1 | grep <yourfile>` to check your own files; ignore pre-existing noise (`getPresets`/RemoteServerDeps, `string | string[]` express, missing electron.d.ts methods like `getLinks`/`racGetSessions`).
- DB-backed vitest fails on this machine (better-sqlite3 ABI 145 vs node 137) — pre-existing. Pure/telegram/workspace tests DO run. Keep new logic pure + unit-tested like `ContextRegistry`.
- grammY forum-topic APIs: `bot.api.createForumTopic(chatId, name) → { message_thread_id }`, `closeForumTopic(chatId, threadId)`, `reopenForumTopic(chatId, threadId)`, `editForumTopic(chatId, threadId, { name })`, and `sendMessage(chatId, text, { message_thread_id })`. Inbound updates expose `ctx.message.message_thread_id` (undefined in the General topic) and `ctx.chat.is_forum`.
- Settings persist via `loadSettings(): Record<string, any>` and `saveSetting(key, value)` in `index.ts` (JSON file). Put all Telegram-topics config under one `telegram` key.
- Commit after each task. Conventional-commit messages.

---

### Task 1: `TopicRegistry` (pure workspace↔thread map)

**Files:**
- Create: `src/main/telegram/topic-registry.ts`
- Test: `src/main/telegram/topic-registry.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface TopicEntry { threadId: number; name: string }`
  - `class TopicRegistry` with:
    - `constructor(initial?: Record<string, TopicEntry>, onChange?: (map: Record<string, TopicEntry>) => void)`
    - `threadFor(workspaceId: string): number | undefined`
    - `workspaceFor(threadId: number): string | undefined`
    - `nameFor(workspaceId: string): string | undefined`
    - `set(workspaceId: string, threadId: number, name: string): void`
    - `rename(workspaceId: string, name: string): boolean`
    - `remove(workspaceId: string): void`
    - `has(workspaceId: string): boolean`
    - `snapshot(): Record<string, TopicEntry>` (for persistence)

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/telegram/topic-registry.test.ts
import { describe, it, expect } from 'vitest'
import { TopicRegistry } from './topic-registry'

describe('TopicRegistry', () => {
  it('maps a workspace to a thread and back', () => {
    const r = new TopicRegistry()
    r.set('ws1', 42, 'Alpha')
    expect(r.threadFor('ws1')).toBe(42)
    expect(r.workspaceFor(42)).toBe('ws1')
    expect(r.nameFor('ws1')).toBe('Alpha')
    expect(r.has('ws1')).toBe(true)
  })

  it('returns undefined for unknown ids', () => {
    const r = new TopicRegistry()
    expect(r.threadFor('nope')).toBeUndefined()
    expect(r.workspaceFor(999)).toBeUndefined()
  })

  it('rename updates the name, keeps the thread', () => {
    const r = new TopicRegistry()
    r.set('ws1', 42, 'Alpha')
    expect(r.rename('ws1', 'Beta')).toBe(true)
    expect(r.nameFor('ws1')).toBe('Beta')
    expect(r.threadFor('ws1')).toBe(42)
    expect(r.rename('ghost', 'X')).toBe(false)
  })

  it('remove drops both directions', () => {
    const r = new TopicRegistry()
    r.set('ws1', 42, 'Alpha')
    r.remove('ws1')
    expect(r.threadFor('ws1')).toBeUndefined()
    expect(r.workspaceFor(42)).toBeUndefined()
  })

  it('hydrates from an initial snapshot and round-trips', () => {
    const initial = { ws1: { threadId: 42, name: 'Alpha' } }
    const r = new TopicRegistry(initial)
    expect(r.threadFor('ws1')).toBe(42)
    expect(r.snapshot()).toEqual(initial)
  })

  it('fires onChange with the full snapshot on every mutation', () => {
    const seen: Record<string, unknown>[] = []
    const r = new TopicRegistry({}, (m) => seen.push(m))
    r.set('ws1', 42, 'Alpha')
    r.rename('ws1', 'Beta')
    r.remove('ws1')
    expect(seen).toHaveLength(3)
    expect(seen[0]).toEqual({ ws1: { threadId: 42, name: 'Alpha' } })
    expect(seen[2]).toEqual({})
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/telegram/topic-registry.test.ts`
Expected: FAIL — cannot find module `./topic-registry`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/main/telegram/topic-registry.ts
/**
 * Pure workspace ↔ Telegram forum-topic map. No grammY, no I/O — the routing
 * source of truth, unit-tested in isolation (mirrors ContextRegistry). Persisted
 * by the caller via the onChange callback into settings.telegram.topics.
 */
export interface TopicEntry {
  threadId: number
  name: string
}

export class TopicRegistry {
  private byWorkspace = new Map<string, TopicEntry>()
  private byThread = new Map<number, string>()
  private readonly onChange?: (map: Record<string, TopicEntry>) => void

  constructor(initial: Record<string, TopicEntry> = {}, onChange?: (map: Record<string, TopicEntry>) => void) {
    for (const [ws, entry] of Object.entries(initial)) {
      this.byWorkspace.set(ws, entry)
      this.byThread.set(entry.threadId, ws)
    }
    this.onChange = onChange
  }

  threadFor(workspaceId: string): number | undefined {
    return this.byWorkspace.get(workspaceId)?.threadId
  }

  workspaceFor(threadId: number): string | undefined {
    return this.byThread.get(threadId)
  }

  nameFor(workspaceId: string): string | undefined {
    return this.byWorkspace.get(workspaceId)?.name
  }

  has(workspaceId: string): boolean {
    return this.byWorkspace.has(workspaceId)
  }

  set(workspaceId: string, threadId: number, name: string): void {
    const prev = this.byWorkspace.get(workspaceId)
    if (prev) this.byThread.delete(prev.threadId)
    this.byWorkspace.set(workspaceId, { threadId, name })
    this.byThread.set(threadId, workspaceId)
    this.emit()
  }

  rename(workspaceId: string, name: string): boolean {
    const entry = this.byWorkspace.get(workspaceId)
    if (!entry) return false
    entry.name = name
    this.emit()
    return true
  }

  remove(workspaceId: string): void {
    const entry = this.byWorkspace.get(workspaceId)
    if (!entry) return
    this.byWorkspace.delete(workspaceId)
    this.byThread.delete(entry.threadId)
    this.emit()
  }

  snapshot(): Record<string, TopicEntry> {
    return Object.fromEntries(this.byWorkspace.entries())
  }

  private emit(): void {
    this.onChange?.(this.snapshot())
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/telegram/topic-registry.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/telegram/topic-registry.ts src/main/telegram/topic-registry.test.ts
git commit -m "feat(telegram): pure TopicRegistry (workspace <-> thread map)"
```

---

### Task 2: Telegram settings shape + accessors

**Files:**
- Modify: `src/main/index.ts` (add near `loadSettings`/`saveSetting`, ~line 271-284)

**Interfaces:**
- Consumes: `loadSettings()`, `saveSetting(key, value)`, `TopicEntry` (Task 1).
- Produces:
  - `interface TelegramTopicsConfig { mode: 'dm' | 'topics'; supergroupChatId?: number; topics?: Record<string, TopicEntry> }`
  - `function telegramConfig(): TelegramTopicsConfig` — reads `settings.telegram`, defaulting `mode:'dm'`.
  - `function saveTelegramConfig(patch: Partial<TelegramTopicsConfig>): void` — shallow-merge + persist under `telegram`.

- [ ] **Step 1: Implement the accessors** (no separate unit test — thin wrappers over the JSON settings already covered by the app; verified via build + downstream tasks)

```typescript
// src/main/index.ts — after saveSetting(...)
import type { TopicEntry } from './telegram/topic-registry' // add to the telegram imports block

interface TelegramTopicsConfig {
  mode: 'dm' | 'topics'
  supergroupChatId?: number
  topics?: Record<string, TopicEntry>
}

function telegramConfig(): TelegramTopicsConfig {
  const t = (loadSettings().telegram ?? {}) as Partial<TelegramTopicsConfig>
  return {
    mode: t.mode === 'topics' ? 'topics' : 'dm',
    supergroupChatId: typeof t.supergroupChatId === 'number' ? t.supergroupChatId : undefined,
    topics: t.topics ?? {}
  }
}

function saveTelegramConfig(patch: Partial<TelegramTopicsConfig>): void {
  saveSetting('telegram', { ...telegramConfig(), ...patch })
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: `✓ built` (3 bundles).

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(telegram): settings shape + accessors for topics mode"
```

---

### Task 3: Topic lifecycle ops on `TelegramServer`

**Files:**
- Modify: `src/main/telegram/telegram-server.ts` (imports; `TelegramServerOptions`; constructor; add methods)
- Test: `src/main/telegram/telegram-server.test.ts` (add cases using the existing mock-bot harness)

**Interfaces:**
- Consumes: `TopicRegistry` (Task 1).
- Produces (on `TelegramServer`):
  - Options gain: `initialTopics?: Record<string, TopicEntry>`, `onTopicsChange?: (map: Record<string, TopicEntry>) => void`, `mode?: 'dm' | 'topics'`, `supergroupChatId?: number`.
  - `async ensureTopic(workspaceId: string, name: string): Promise<number | null>` — returns threadId (creates or reopens); null + DM-fallback signal on failure.
  - `async closeTopic(workspaceId: string): Promise<void>`
  - `async renameTopic(workspaceId: string, name: string): Promise<void>`
  - `setTopicsMode(mode: 'dm' | 'topics', supergroupChatId?: number): void`
  - `getTopicsMode(): { mode: 'dm' | 'topics'; supergroupChatId?: number }`

- [ ] **Step 1: Wire the registry + fields into the class**

In the imports block add:
```typescript
import { TopicRegistry, type TopicEntry } from './topic-registry'
```
Add to `TelegramServerOptions`:
```typescript
  /** Persisted workspace→thread map from the last run (topics mode). */
  initialTopics?: Record<string, TopicEntry>
  /** Fired when the topic map changes so the caller can persist it. */
  onTopicsChange?: (map: Record<string, TopicEntry>) => void
  /** Relay mode. 'topics' routes per-workspace threads; 'dm' is the classic relay. */
  mode?: 'dm' | 'topics'
  /** The bound supergroup's chat id (topics mode). */
  supergroupChatId?: number
```
Add fields + constructor wiring (next to the existing `this.router = ...`):
```typescript
  private readonly topics: TopicRegistry
  private mode: 'dm' | 'topics'
  private supergroupChatId?: number
  // in constructor:
  this.topics = new TopicRegistry(opts.initialTopics, opts.onTopicsChange)
  this.mode = opts.mode ?? 'dm'
  this.supergroupChatId = opts.supergroupChatId
```

- [ ] **Step 2: Add the topic lifecycle methods** (place after `relayFromAgent`)

```typescript
  setTopicsMode(mode: 'dm' | 'topics', supergroupChatId?: number): void {
    this.mode = mode
    this.supergroupChatId = supergroupChatId
    this.onStatusChange?.()
  }

  getTopicsMode(): { mode: 'dm' | 'topics'; supergroupChatId?: number } {
    return { mode: this.mode, supergroupChatId: this.supergroupChatId }
  }

  /**
   * Ensure a workspace has an OPEN topic. Creates one (first time) or reopens a
   * stored one; stores + persists the threadId. Returns the threadId, or null if
   * topics mode is off / the op failed (caller falls back to DM).
   */
  async ensureTopic(workspaceId: string, name: string): Promise<number | null> {
    if (this.mode !== 'topics' || !this.supergroupChatId || !this.bot || !this.ready) return null
    const chatId = this.supergroupChatId
    try {
      const existing = this.topics.threadFor(workspaceId)
      if (existing !== undefined) {
        await this.bot.api.reopenForumTopic(chatId, existing).catch(() => { /* already open */ })
        return existing
      }
      const topic = await this.bot.api.createForumTopic(chatId, name)
      this.topics.set(workspaceId, topic.message_thread_id, name)
      return topic.message_thread_id
    } catch (err) {
      this.log(`ensureTopic(${workspaceId}) failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  async closeTopic(workspaceId: string): Promise<void> {
    const threadId = this.topics.threadFor(workspaceId)
    if (this.mode !== 'topics' || !this.supergroupChatId || !this.bot || threadId === undefined) return
    await this.bot.api.closeForumTopic(this.supergroupChatId, threadId).catch((err) => {
      this.log(`closeTopic(${workspaceId}) failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  async renameTopic(workspaceId: string, name: string): Promise<void> {
    const threadId = this.topics.threadFor(workspaceId)
    if (this.mode !== 'topics' || !this.supergroupChatId || !this.bot || threadId === undefined) return
    if (!this.topics.rename(workspaceId, name)) return
    await this.bot.api.editForumTopic(this.supergroupChatId, threadId, { name }).catch((err) => {
      this.log(`renameTopic(${workspaceId}) failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
```

- [ ] **Step 3: Add a mock-bot test** (follow the existing harness in `telegram-server.test.ts` — it stubs `bot.api`; mirror how current tests assert `sendMessage` calls)

```typescript
// Add inside telegram-server.test.ts. Adapt to the file's existing harness
// (how it constructs a server + stubs bot.api). Pattern:
it('ensureTopic creates a forum topic and remembers the thread', async () => {
  const created: any[] = []
  const server = makeServer({ mode: 'topics', supergroupChatId: -100 }) // helper from the file
  stubBotApi(server, {
    createForumTopic: async (_chat: number, name: string) => { created.push(name); return { message_thread_id: 7 } }
  })
  const id = await server.ensureTopic('ws1', 'Alpha')
  expect(id).toBe(7)
  expect(created).toEqual(['Alpha'])
  // second call reuses the stored thread (reopen, not create)
  const again = await server.ensureTopic('ws1', 'Alpha')
  expect(again).toBe(7)
  expect(created).toHaveLength(1)
})
```

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/main/telegram/telegram-server.test.ts` → PASS
Run: `npm run build` → `✓ built`

- [ ] **Step 5: Commit**

```bash
git add src/main/telegram/telegram-server.ts src/main/telegram/telegram-server.test.ts
git commit -m "feat(telegram): topic create/close/reopen/rename lifecycle ops"
```

---

### Task 4: `/bind` and `/unbind` commands

**Files:**
- Modify: `src/main/telegram/telegram-server.ts` (register commands where other `bot.command(...)` handlers live — near `/status`, ~line 274-310)

**Interfaces:**
- Consumes: `setTopicsMode`, `ensureTopic` (Task 3).
- Produces: a `onBind?: (supergroupChatId: number) => Promise<void>` option so `index.ts` can create topics for all live workspaces right after binding; a `onUnbind?: () => void` option.

- [ ] **Step 1: Add the options**

```typescript
// TelegramServerOptions
  /** Fired after a successful /bind so the app can open topics for live workspaces. */
  onBind?: (supergroupChatId: number) => Promise<void>
  /** Fired after /unbind so the app can persist mode='dm'. */
  onUnbind?: () => void
```
Store them: `private readonly onBind?...; private readonly onUnbind?...;` + assign in constructor.

- [ ] **Step 2: Register the commands** (with the other `bot.command` handlers; reuse the existing allowlist guard the file applies to trusted commands)

```typescript
bot.command('bind', async (ctx) => {
  const chat = ctx.chat
  if (!chat || (chat.type !== 'supergroup')) {
    await ctx.reply('Run /bind inside your supergroup (not a DM).')
    return
  }
  if (!('is_forum' in chat) || !chat.is_forum) {
    await ctx.reply('Enable *Topics* on this group first (Group Settings → Topics), then run /bind again.', { parse_mode: 'Markdown' })
    return
  }
  // Require the bot to be an admin that can manage topics.
  try {
    const me = await ctx.api.getChatMember(chat.id, ctx.me.id)
    const canManage = me.status === 'administrator' && (me as any).can_manage_topics
    if (!canManage) { await ctx.reply('Make me an admin with the "Manage Topics" permission, then run /bind again.'); return }
  } catch { /* fall through — createForumTopic will surface the real error */ }
  this.setTopicsMode('topics', chat.id)
  await ctx.reply('✅ Bound. Each workspace now gets its own topic. Closing a workspace archives its thread.')
  await this.onBind?.(chat.id)
})

bot.command('unbind', async (ctx) => {
  this.setTopicsMode('dm')
  this.onUnbind?.()
  await ctx.reply('Reverted to direct-message relay. Your topics stay in the group (archived).')
})
```

- [ ] **Step 3: Build + commit**

Run: `npm run build` → `✓ built`
```bash
git add src/main/telegram/telegram-server.ts
git commit -m "feat(telegram): /bind + /unbind supergroup topics commands"
```

---

### Task 5: Outbound — relay a workspace's message to its thread

**Files:**
- Modify: `src/main/telegram/telegram-server.ts` (add `relayFromWorkspace`, reusing the existing `relayFromAgent` body for DM fallback)

**Interfaces:**
- Consumes: `TopicRegistry`, `mode`, `supergroupChatId`, existing `clip()` / `priorityPrefix()` / `relayQuestion()`.
- Produces: `relayFromWorkspace(workspaceId: string | undefined, fromName: string, message: string, priority?: string, opts?: { id?: string; choices?: string[] }): void`.

- [ ] **Step 1: Add the method**

```typescript
  /**
   * Topics mode: send an agent→user message into the workspace's thread (no
   * [Project] prefix — the thread is the identity). Falls back to the classic
   * DM relay when topics mode is off, the workspace has no thread, or the send
   * fails, so a message is never dropped.
   */
  relayFromWorkspace(
    workspaceId: string | undefined,
    fromName: string,
    message: string,
    priority?: string,
    opts?: { id?: string; choices?: string[] }
  ): void {
    const threadId = workspaceId !== undefined ? this.topics.threadFor(workspaceId) : undefined
    if (this.mode !== 'topics' || !this.supergroupChatId || threadId === undefined || !this.bot || !this.ready) {
      this.relayFromAgent(fromName, message, priority, opts) // DM fallback (prefixed)
      return
    }
    const chatId = this.supergroupChatId
    // Questions with choices still render buttons — send into the thread.
    if (opts?.id && opts.choices && opts.choices.length) {
      void this.relayQuestionToThread(chatId, threadId, fromName, message, priority, opts.id, opts.choices)
      return
    }
    const text = this.clip(`${priorityPrefix(priority)}💬 ${fromName}:\n${message}`)
    this.bot.api.sendMessage(chatId, text, { message_thread_id: threadId }).catch((err) => {
      this.log(`thread relay (${workspaceId}) failed, falling back to DM: ${err instanceof Error ? err.message : String(err)}`)
      this.relayFromAgent(fromName, message, priority, opts)
    })
  }
```

- [ ] **Step 2: Add `relayQuestionToThread`** — a thin variant of the existing `relayQuestion` that targets one `(chatId, threadId)` instead of the subscribed-chats loop, passing `{ reply_markup: keyboard, message_thread_id: threadId }` to `sendMessage`, and recording the sent message under `pendingQuestions` exactly as `relayQuestion` does (so taps still route back). Reuse the existing `answerCallback` keyboard-building code from `relayQuestion`.

- [ ] **Step 3: Add a mock-bot test** asserting a topics-mode `relayFromWorkspace('ws1', 'Orc', 'hi')` calls `sendMessage(-100, <text>, { message_thread_id: 7 })` (after an `ensureTopic('ws1','Alpha')` set thread 7), and that with `mode:'dm'` it falls through to the DM path.

- [ ] **Step 4: Build + test + commit**

Run: `npx vitest run src/main/telegram/telegram-server.test.ts` → PASS; `npm run build` → `✓ built`
```bash
git add src/main/telegram/telegram-server.ts src/main/telegram/telegram-server.test.ts
git commit -m "feat(telegram): relay a workspace's messages into its thread"
```

---

### Task 6: Inbound — route a thread reply to that workspace's orchestrator

**Files:**
- Modify: `src/main/telegram/telegram-server.ts` (`TelegramServerOptions` + `message:text` handler ~line 360; also `message:document`/`photo` ~385)

**Interfaces:**
- Consumes: `TopicRegistry`.
- Produces: a `workspaceRouter?: WorkspaceRouter` option:
  ```typescript
  export interface WorkspaceRouter {
    /** Route text to the orchestrator of a specific workspace's hub. */
    sendToWorkspace(workspaceId: string, text: string): { ok: boolean; detail?: string }
    /** Orchestrator-status view for one workspace (for thread-scoped /status). */
    workspaceStatus(workspaceId: string): { name: string; role: string; status: string }[]
  }
  ```

- [ ] **Step 1: Add the option + field** (`workspaceRouter?: WorkspaceRouter` in options; `private readonly workspaceRouter?: WorkspaceRouter` assigned in constructor).

- [ ] **Step 2: Branch the text handler on thread id** — at the top of the `bot.on('message:text', …)` body, before the gateway/bridge fallthrough:

```typescript
      const threadId = ctx.message.message_thread_id
      if (this.mode === 'topics' && threadId !== undefined && this.workspaceRouter) {
        const workspaceId = this.topics.workspaceFor(threadId)
        if (!workspaceId) { await ctx.reply('This thread isn\'t linked to a live workspace.'); return }
        const res = this.workspaceRouter.sendToWorkspace(workspaceId, ctx.message.text)
        if (!res.ok) await ctx.reply(`❌ ${res.detail ?? 'Couldn\'t reach that workspace\'s orchestrator.'}`)
        return
      }
      // ...existing gateway/bridge routing unchanged (General topic + DM mode)...
```

- [ ] **Step 3: Mirror it for attachments** — in the `message:document`/`message:photo` handler, when `this.mode==='topics'` and `ctx.message.message_thread_id` resolves a workspace, route the downloaded file via a `workspaceRouter.sendFileToWorkspace(...)` (add that method to `WorkspaceRouter` mirroring `sendToWorkspace`). Keep the existing path for DM/General.

- [ ] **Step 4: Add a mock-bot test** feeding an inbound text update carrying `message_thread_id: 7` and asserting `workspaceRouter.sendToWorkspace('ws1', text)` was called (thread 7 mapped to ws1).

- [ ] **Step 5: Build + test + commit**

```bash
git add src/main/telegram/telegram-server.ts src/main/telegram/telegram-server.test.ts
git commit -m "feat(telegram): route thread replies to the workspace orchestrator"
```

---

### Task 7: Wire lifecycle + routing into `index.ts`

**Files:**
- Modify: `src/main/index.ts` — `startTelegram` (~829), `telegramBridge` neighbourhood (~718), `createWorkspaceContext` relay call sites (~1772, ~2064), `closeCtxResources` (~2311 region), `renameTab`/`TAB_RENAME` handler, `restoreBackgroundWorkspaces`, and the `WorkspaceRouter`/`onBind`/`onTopics` hooks.

**Interfaces:**
- Consumes: `telegramConfig`/`saveTelegramConfig` (Task 2); `TelegramServer.ensureTopic/closeTopic/renameTopic/relayFromWorkspace/setTopicsMode` (Tasks 3-5); `WorkspaceRouter` (Task 6); `contextRegistry` (existing).
- Produces: topics wired to the context lifecycle.

- [ ] **Step 1: Pass topics config + hooks when constructing the server** — in `startTelegram`, extend the `new TelegramServer({...})` options:

```typescript
    const cfg = telegramConfig()
    // ...existing options...
    initialTopics: cfg.topics,
    onTopicsChange: (map) => saveTelegramConfig({ topics: map }),
    mode: cfg.mode,
    supergroupChatId: cfg.supergroupChatId,
    onBind: async (supergroupChatId) => {
      saveTelegramConfig({ mode: 'topics', supergroupChatId })
      // open a topic for every live workspace
      for (const id of contextRegistry.ids()) {
        const name = workspaceManager?.get(id)?.name ?? id
        await telegramServer?.ensureTopic(id, name)
      }
    },
    onUnbind: () => saveTelegramConfig({ mode: 'dm' }),
    workspaceRouter: {
      sendToWorkspace: (workspaceId, text) => {
        const ctx = contextRegistry.get(workspaceId)
        if (!ctx) return { ok: false, detail: 'workspace not live' }
        const orch = ctx.hub.registry.list().find(a => a.role === 'orchestrator')
        if (!orch) return { ok: false, detail: 'no orchestrator in that workspace' }
        try { ctx.hub.messages.send('user', orch.name, text); return { ok: true } }
        catch (e: any) { return { ok: false, detail: e?.message } }
      },
      workspaceStatus: (workspaceId) => {
        const ctx = contextRegistry.get(workspaceId)
        return ctx ? ctx.hub.registry.list().filter(a => a.name !== 'user').map(a => ({ name: a.name, role: a.role, status: a.status })) : []
      }
    },
```
(If `sendFileToWorkspace` was added in Task 6, implement it here analogously via the existing file-save path used by `telegramBridge().sendFile`.)

- [ ] **Step 2: Open/close/rename topics from the context lifecycle**

In `createWorkspaceContext`, after the context is fully built (end of the factory, before `return`), fire-and-forget a topic ensure:
```typescript
  void telegramServer?.ensureTopic(workspaceId, path.basename(projectPath))
```
In `closeCtxResources(id, ctx)`, after closing hub/db:
```typescript
  void telegramServer?.closeTopic(id)
```
In the `TAB_RENAME` handler, after `workspaceManager.rename(...)`:
```typescript
  void telegramServer?.renameTopic(tabId, name)
```

- [ ] **Step 3: Relay through the workspace-aware path** — change the two relay call sites to pass the workspace id. `onMessageAdded` is in the factory (has `workspaceId` in scope):
```typescript
      telegramServer?.relayFromWorkspace(workspaceId, msg.agentName, msg.message, msg.priority, { id: msg.id, choices: msg.choices })
```
`setupMessageNudge(hub)` relays conversational replies; give it the workspace id — pass it in when the factory calls `setupMessageNudge`. Change the signature to `setupMessageNudge(hub: HubServer, workspaceId: string)` and inside use `telegramServer?.relayFromWorkspace(workspaceId, msg.from, msg.message)`. Update the factory call to `setupMessageNudge(hub, workspaceId)`.

- [ ] **Step 4: Sync topics on boot** — at the end of `restoreBackgroundWorkspaces` (and it already runs after `openProject`), ensure the active + restored workspaces have open topics. Add, after the loop:
```typescript
  if (telegramConfig().mode === 'topics') {
    for (const id of contextRegistry.ids()) {
      const name = workspaceManager?.get(id)?.name ?? id
      void telegramServer?.ensureTopic(id, name)
    }
  }
```
(Guard: `startTelegram` runs at boot only if `telegramEnabled`; if telegram starts later, its `mode/supergroupChatId` come from `cfg`, and the next `createWorkspaceContext`/manual re-open re-syncs. Acceptable for v1.)

- [ ] **Step 5: Build + smoke tests + commit**

Run: `npm run build` → `✓ built`
Run: `npx vitest run src/main/telegram src/main/workspace` → PASS
```bash
git add src/main/index.ts
git commit -m "feat(telegram): wire topic lifecycle + workspace routing into the app"
```

---

### Task 8: Settings UI — mode + bind status + setup steps

**Files:**
- Modify: `src/renderer/components/SettingsDialog.tsx` (extend the existing "Running multiple Cogs?" supergroup-help section)
- Modify: `src/preload/index.ts` + `src/renderer/electron.d.ts` (expose `getTelegramTopicsStatus()` if a live status readout is wanted)

**Interfaces:**
- Consumes: existing `getSettings`/`setSetting`; optional new IPC `TELEGRAM_TOPICS_STATUS` returning `{ mode, supergroupChatId }` from `telegramConfig()`.
- Produces: a read-only status line ("Topics mode: bound to supergroup ✓" / "DM mode") + the numbered setup steps.

- [ ] **Step 1: Add the status + steps block** into the Telegram/supergroup section:

```tsx
{/* Telegram — per-workspace threads */}
<div style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>Telegram — per-workspace threads</div>
<div style={{ fontSize: 11, color: '#aaa', lineHeight: 1.6 }}>
  Give each workspace its own thread in one Telegram group instead of one shared DM:
  <ol style={{ margin: '6px 0 0 16px', padding: 0 }}>
    <li>Create a Telegram <b>supergroup</b> and turn on <b>Topics</b> (Group Settings → Topics).</li>
    <li>Add your Cog bot as an <b>admin</b> with the <b>Manage Topics</b> permission.</li>
    <li>In the group, send <code>/bind</code>. Each workspace then gets its own topic; closing a workspace archives its thread.</li>
    <li>Send <code>/unbind</code> anytime to go back to direct messages.</li>
  </ol>
</div>
```

- [ ] **Step 2 (optional): live status readout** — add IPC `TELEGRAM_TOPICS_STATUS` in `index.ts` returning `telegramConfig()`; expose in preload as `getTelegramTopicsStatus()`; render "Bound ✓ (group <id>)" or "DM mode" above the steps.

- [ ] **Step 3: Build + commit**

Run: `npm run build` → `✓ built`
```bash
git add src/renderer/components/SettingsDialog.tsx src/preload/index.ts src/renderer/electron.d.ts
git commit -m "feat(telegram): settings help + status for supergroup topics"
```

---

## Live verification (after Task 7; UI polish after Task 8)

1. In Telegram, create a supergroup, enable Topics, add the bot as admin (Manage Topics), send `/bind`.
2. In The Cog, have ≥2 workspaces open → confirm 2 topics appear, named after the folders.
3. In workspace A's thread, type a message → its orchestrator (only A's) receives it. Same for B.
4. An agent in A sends you a message → it lands in A's thread (no `[Project]` prefix).
5. Close a tab → its thread archives (still visible, greyed). Reopen the workspace → thread reopens.
6. Rename a workspace → the thread renames.
7. Quit + relaunch → threads reopen for restored workspaces; `settings.telegram.topics` persisted.
8. `/unbind` → back to DM relay; agent messages resume in the DM with `[Project]` prefixes.

## Self-review notes (coverage)

- Spec "modes" → Task 2 (config) + Task 3 (`setTopicsMode`) + Task 4 (`/bind`/`/unbind`).
- Spec "TopicRegistry" → Task 1 (pure + tests).
- Spec "lifecycle table" → Task 7 Step 2 (create/close/rename) + Step 4 (boot).
- Spec "outbound routing" → Task 5; "inbound routing / General lane" → Task 6 (thread branch; General falls through to existing command/DM path).
- Spec "setup/trust/resilience" → Task 4 (`/bind` admin+forum checks) + Tasks 3/5 (DM fallback on failure).
- Spec "testing" → Tasks 1/3/5/6 unit + mock-bot cases; live steps above.
