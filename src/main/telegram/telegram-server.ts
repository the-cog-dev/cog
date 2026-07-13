import { Bot, InlineKeyboard, type Context } from 'grammy'
import type { PairingManager } from './pairing-manager'
import type { OrchestratorBridge, TelegramTarget, IncomingFile, IncomingVoice, ProposalView } from './bridge'
import { ChatRouter } from './chat-router'
import {
  proposalCallback, parseProposalCallback,
  formatProposalMessage, formatProposalDetails, formatProposalResolved
} from './proposal-format'
import {
  answerCallback, parseAnswerCallback, clipChoiceLabel, formatAnswered
} from './question-format'
import { projectPrefix } from './relay-format'
import { TopicRegistry, type TopicEntry } from './topic-registry'

/** Telegram caps a single message at 4096 chars; leave headroom for our prefix. */
const MAX_RELAY_CHARS = 3900

/** Urgency badge prepended to relayed inbox messages (normal → no badge). */
function priorityPrefix(priority?: string): string {
  switch (priority) {
    case 'urgent': return '🔴 URGENT — '
    case 'high': return '🟠 High — '
    case 'low': return '⚪ '
    default: return ''
  }
}

/**
 * The multi-instance federation seam (implemented by GatewayCoordinator). When
 * several Cog instances share one bot, exactly one polls (the gateway) and the
 * rest are followers. This interface lets the bot route a DM turn to whichever
 * Cog the chat is addressing without importing the coordinator directly.
 */
export interface FederationGateway {
  routeInbound(chatId: number, text: string): Promise<{ ok: boolean; project?: string; detail?: string }>
  setActiveByProject(chatId: number, name: string): { project: string; isSelf: boolean } | null
  activeProject(chatId: number): string | null
  isFollowerActive(chatId: number): boolean
  listProjects(): Array<{ project: string; isSelf: boolean }>
  cogCount(): number
  aggregateTargets(): Promise<Array<{ project: string; isSelf: boolean; targets: { name: string; role: string; status: string }[] }>>
}

/**
 * Topics mode's inbound seam: routes a thread reply to that specific
 * workspace's orchestrator (as opposed to `bridge`, which addresses whichever
 * head the chat is currently pointed at). Implemented by the main process
 * against the per-workspace hub; the bot never imports it directly.
 */
export interface WorkspaceRouter {
  /** Route text to the orchestrator of a specific workspace's hub. */
  sendToWorkspace(workspaceId: string, text: string): { ok: boolean; detail?: string }
  /** Orchestrator-status view for one workspace (for thread-scoped /status). */
  workspaceStatus(workspaceId: string): { name: string; role: string; status: string }[]
  /** Save + route an incoming attachment to a specific workspace's orchestrator. */
  sendFileToWorkspace(workspaceId: string, file: IncomingFile): { ok: boolean; relPath?: string; detail?: string }
}

export interface TelegramServerOptions {
  pairing: PairingManager
  /**
   * Bridge into the orchestration hub. Phase 1+ — when present, the trusted
   * command router and the plain-text → orchestrator relay come alive. Omit it
   * (Phase 0) and the bot is pairing-only.
   */
  bridge?: OrchestratorBridge
  /**
   * Topics mode's inbound router. When set and mode==='topics', a thread reply
   * (message_thread_id present) routes to that workspace's orchestrator instead
   * of falling through to `bridge`'s single active-head routing.
   */
  workspaceRouter?: WorkspaceRouter
  /** This Cog's project name — prefixed onto every relayed message so multiple
   *  instances sharing one bot are distinguishable in the DM. */
  project?: string
  /** Multi-instance federation (single-poller gateway). Omit for a lone bot. */
  gateway?: FederationGateway
  /** Optional log sink — wire to the main-process logger. */
  onLog?: (message: string) => void
  /** Fired when connection/pairing state changes so the UI can refresh. */
  onStatusChange?: () => void
  /** Relay-subscribed chat IDs from the last run, so restarts don't drop the relay. */
  initialChats?: number[]
  /** Fired when the subscribed-chat set changes so the caller can persist it. */
  onChatsChange?: (chatIds: number[]) => void
  /** Persisted workspace→thread map from the last run (topics mode). */
  initialTopics?: Record<string, TopicEntry>
  /** Fired when the topic map changes so the caller can persist it. */
  onTopicsChange?: (map: Record<string, TopicEntry>) => void
  /** Relay mode. 'topics' routes per-workspace threads; 'dm' is the classic relay. */
  mode?: 'dm' | 'topics'
  /** The bound supergroup's chat id (topics mode). */
  supergroupChatId?: number
  /** Fired after a successful /bind so the app can open topics for live workspaces. */
  onBind?: (supergroupChatId: number) => Promise<void>
  /** Fired after /unbind so the app can persist mode='dm'. */
  onUnbind?: () => void
}

/**
 * Cheap token check without starting a poller: init() calls getMe and throws
 * on a bad token or network failure. Lets callers validate a new token BEFORE
 * persisting it over a known-good one.
 */
export async function validateBotToken(token: string): Promise<void> {
  await new Bot(token).init()
}

/**
 * Phase 1 — pairing gate + command router + orchestrator relay.
 *
 * Wraps a grammY bot in long-polling mode. No tunnel, no public ingress: the
 * bot reaches out to Telegram, so there's nothing to expose. (This is why the
 * Telegram bridge needs no cloudflared, unlike Remote View.)
 *
 * Auth: every update except the public pairing commands is dropped for users
 * not on the allowlist — the bot gives no sign it exists. Past the gate, a
 * trusted user can drive the swarm: /status, /use, /msg, /output, /task, and
 * plain text → the chat's active orchestrator. Agent→user messages are relayed
 * back into every subscribed chat via relayFromAgent(), called from the main
 * process's Message Router tap.
 *
 * Multi-orchestrator ("double-headed dragon") addressing lives in ChatRouter:
 * each chat remembers which head it's talking to; /use switches it.
 */
export class TelegramServer {
  private bot: Bot | null = null
  private ready = false     // bot initialised → can SEND (both gateway & followers)
  private polling = false   // long-poll active → can RECEIVE (gateway only)
  private readonly pairing: PairingManager
  private readonly bridge?: OrchestratorBridge
  private readonly workspaceRouter?: WorkspaceRouter
  private readonly project?: string
  private readonly gateway?: FederationGateway
  private readonly router: ChatRouter
  private readonly topics: TopicRegistry
  private mode: 'dm' | 'topics'
  private supergroupChatId?: number
  private readonly log: (m: string) => void
  private readonly onStatusChange?: () => void
  private readonly onBind?: (supergroupChatId: number) => Promise<void>
  private readonly onUnbind?: () => void
  // proposalId → the chat messages carrying its buttons, so we can edit them to
  // "settled" once it resolves (from Telegram, desktop, or 3DS).
  private readonly proposalMsgs = new Map<string, Array<{ chatId: number; messageId: number }>>()
  // inbox messageId → a pending question awaiting a tap, so the chosen answer can
  // be routed back to the asking agent and every button copy edited to "answered".
  private readonly pendingQuestions = new Map<string, {
    askerName: string
    question: string
    choices: string[]
    sent: Array<{ chatId: number; messageId: number }>
  }>()

  constructor(opts: TelegramServerOptions) {
    this.pairing = opts.pairing
    this.bridge = opts.bridge
    this.workspaceRouter = opts.workspaceRouter
    this.project = opts.project
    this.gateway = opts.gateway
    this.router = new ChatRouter({
      initialSubscribed: opts.initialChats,
      onSubscribedChange: opts.onChatsChange
    })
    this.topics = new TopicRegistry(opts.initialTopics, opts.onTopicsChange)
    this.mode = opts.mode ?? 'dm'
    this.supergroupChatId = opts.supergroupChatId
    this.log = opts.onLog ?? (() => {})
    this.onStatusChange = opts.onStatusChange
    this.onBind = opts.onBind
    this.onUnbind = opts.onUnbind
  }

  isRunning(): boolean {
    // "Running" for the UI = the bot is live (can send). Polling is separate and
    // owned by the gateway; a follower is still a working, connected bot.
    return this.ready
  }

  /**
   * Bring the bot online with the given token: init() (which throws on a bad
   * token so the Settings UI can show it) and register handlers. This does NOT
   * start long-polling — call setPolling(true) to do that. Only the elected
   * gateway polls; followers stay send-only so Telegram doesn't split updates.
   */
  async start(token: string): Promise<void> {
    if (this.bot) return
    const bot = new Bot(token)
    this.bot = bot

    this.registerHandlers(bot)

    bot.catch((err) => {
      const inner = err.error
      this.log(`bot error: ${inner instanceof Error ? inner.message : String(inner)}`)
    })

    // Throws on an invalid token / network failure — let the caller handle it.
    // Clear this.bot on failure so a later start() isn't wedged by the early return.
    try {
      await bot.init()
    } catch (err) {
      this.bot = null
      throw err
    }
    this.ready = true
    this.onStatusChange?.()
    this.log(`bot @${bot.botInfo.username} online (send-ready)`)
  }

  /**
   * Toggle long-polling. The elected gateway calls setPolling(true) to own the
   * single getUpdates; a demoted/follower instance calls setPolling(false) so it
   * never competes for updates. Sending is unaffected either way.
   */
  setPolling(on: boolean): void {
    if (!this.bot) return
    if (on && !this.polling) {
      this.polling = true
      void this.bot.start({ onStart: () => this.onStatusChange?.() })
      this.log('long-poll started (gateway)')
    } else if (!on && this.polling) {
      this.polling = false
      void this.bot.stop().catch(() => {})
      this.log('long-poll stopped (follower)')
    }
  }

  isPolling(): boolean {
    return this.polling
  }

  async stop(): Promise<void> {
    if (!this.bot) return
    try {
      if (this.polling) await this.bot.stop()
    } finally {
      this.bot = null
      this.ready = false
      this.polling = false
      this.onStatusChange?.()
      this.log('bot stopped')
    }
  }

  private registerHandlers(bot: Bot): void {
    // ── Public commands (work before pairing) ──────────────────────────────
    bot.command('start', async (ctx) => {
      if (this.pairing.isAllowed(ctx.from?.id)) {
        // Already paired but /start is handled before the subscribe middleware,
        // so subscribe here too — otherwise the relay silently has no destination.
        if (ctx.chat?.type === 'private') this.router.subscribe(ctx.chat.id)
        await ctx.reply('✅ You\'re linked to The Cog. Try /help to drive the swarm.')
      } else {
        await ctx.reply('👋 To link this chat, open The Cog → Settings → Telegram and send the 6-digit code here as:\n\n/pair 123456')
      }
    })

    bot.command('pair', async (ctx) => {
      const code = (ctx.match ?? '').trim()
      if (!code) {
        await ctx.reply('Usage: /pair <code> — the 6-digit code from The Cog → Settings → Telegram.')
        return
      }
      const userId = ctx.from?.id
      if (typeof userId !== 'number') return
      if (this.pairing.tryPair(userId, code)) {
        // Subscribe the chat now (not just in the gate on the next message) so a
        // relay or proposal that lands right after pairing isn't dropped, and
        // the subscription is persisted immediately. Private chats only.
        if (ctx.chat?.type === 'private') this.router.subscribe(ctx.chat.id)
        this.onStatusChange?.()
        await ctx.reply('✅ Linked! This chat can now talk to your orchestrator. Try /help.')
        this.log(`user ${userId} paired`)
      } else {
        await ctx.reply('❌ Invalid or expired code. Generate a fresh one in The Cog → Settings → Telegram.')
      }
    })

    // Harmless helper — lets a user read their own ID for manual allowlisting.
    bot.command('whoami', async (ctx) => {
      await ctx.reply(`Your Telegram user ID: ${ctx.from?.id ?? 'unknown'}`)
    })

    // ── Group-binding commands (trusted, but must run IN the supergroup) ───
    // These are gated by the same pairing.isAllowed() check as the allowlist
    // gate below, but they can't sit behind that gate: it hard-refuses any
    // non-private chat, and /bind's whole point is to run inside the target
    // supergroup. So they get their own inline trust check here instead.
    bot.command('bind', async (ctx) => {
      if (!this.pairing.isAllowed(ctx.from?.id)) return
      const chat = ctx.chat
      if (!chat || chat.type !== 'supergroup') {
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
      if (!this.pairing.isAllowed(ctx.from?.id)) return
      this.setTopicsMode('dm')
      this.onUnbind?.()
      await ctx.reply('Reverted to direct-message relay. Your topics stay in the group (archived).')
    })

    // ── Allowlist gate ─────────────────────────────────────────────────────
    // Anything past this point requires a trusted user in a PRIVATE chat.
    // Non-allowed updates are dropped silently (no next() call → chain ends).
    // Groups are refused outright: pairing is per-user, but a subscription is
    // per-chat — relaying agent output into a group would hand it to every
    // member, paired or not. The trusted DM is registered here so it receives
    // relayed orchestrator output. (/bind and /unbind are registered above,
    // before this gate, since they must run inside a group chat.)
    bot.use(async (ctx, next) => {
      // Topics mode: the bound supergroup is a trusted surface (trust =
      // membership, not per-user pairing — the user controls who's in the
      // group). Let its updates reach the thread handlers below without
      // subscribing it as a DM relay target or requiring a paired user;
      // clamp strictly to the bound chat id so other groups still can't in.
      if (this.mode === 'topics' && this.supergroupChatId !== undefined && ctx.chat?.id === this.supergroupChatId) {
        await next()
        return
      }
      if (!this.pairing.isAllowed(ctx.from?.id)) return
      if (ctx.chat?.type !== 'private') return
      this.router.subscribe(ctx.chat.id)
      await next()
    })

    // ── Trusted commands ───────────────────────────────────────────────────
    bot.command('help', async (ctx) => {
      await ctx.reply(
        'The Cog — Telegram (Phase 1)\n' +
        '/status — list orchestrators & agents\n' +
        '/use <name> — talk to a specific head (e.g. /use cara)\n' +
        '/msg <name> <text> — one-off message to one agent\n' +
        '/output [name] [n] — last n lines of an agent\'s terminal\n' +
        '/task <title> — post a task to the pinboard\n' +
        '/whoami — show your Telegram ID\n' +
        '/help — this list\n\n' +
        'Plain text goes to this chat\'s active head (see /status).\n' +
        'Send a file or photo (with an optional caption) and it goes there too — ' +
        'text files are read inline, images are saved for the agent to open.\n' +
        'Send a voice note and it\'s transcribed and routed to the active head.'
      )
    })

    bot.command('status', async (ctx) => {
      const bridge = this.bridge
      if (!bridge) { await ctx.reply('Orchestration isn\'t wired up yet.'); return }
      // Multiple Cogs federated → show every project's agents grouped, with the
      // chat's active project marked. Solo → the classic single-Cog view.
      if (this.gateway && this.gateway.cogCount() > 1) {
        const groups = await this.gateway.aggregateTargets()
        const activeProj = this.gateway.activeProject(ctx.chat!.id)
        await ctx.reply(this.formatFederatedStatus(groups, activeProj))
        return
      }
      const targets = bridge.listTargets()
      if (targets.length === 0) { await ctx.reply('No agents are running right now.'); return }
      const active = this.router.effectiveTarget(ctx.chat!.id, targets)
      await ctx.reply(this.formatStatus(targets, active))
    })

    // Switch which Cog instance this chat is talking to (multi-instance only).
    bot.command('cog', async (ctx) => {
      if (!this.gateway) { await ctx.reply('Only one Cog is connected — /cog needs multiple instances.'); return }
      const name = (ctx.match ?? '').trim()
      const projects = this.gateway.listProjects()
      if (!name) {
        const active = this.gateway.activeProject(ctx.chat!.id)
        const lines = projects.map(p => `${p.project === active ? '👉' : '•'} ${p.project}${p.isSelf ? ' (this window)' : ''}`)
        await ctx.reply(`Connected Cogs:\n${lines.join('\n')}\n\nSwitch with /cog <project>.`)
        return
      }
      const cog = this.gateway.setActiveByProject(ctx.chat!.id, name)
      if (!cog) { await ctx.reply(`No Cog matches "${name}". Try /cog to list them.`); return }
      await ctx.reply(`👉 Now talking to *${cog.project}*. Plain text routes there. Use /status to see its agents.`,
        { parse_mode: 'Markdown' }).catch(() => ctx.reply(`👉 Now talking to ${cog.project}.`))
    })

    bot.command('use', async (ctx) => {
      const bridge = this.bridge
      if (!bridge) { await ctx.reply('Orchestration isn\'t wired up yet.'); return }
      const name = (ctx.match ?? '').trim()
      if (!name) { await ctx.reply('Usage: /use <name> — pick an agent from /status.'); return }
      const target = this.router.resolveTarget(name, bridge.listTargets())
      if (!target) { await ctx.reply(`No agent matches "${name}". Try /status.`); return }
      this.router.setActive(ctx.chat!.id, target.name)
      await ctx.reply(`👉 Now talking to ${target.name} (${target.role}). Plain text routes here.`)
    })

    bot.command('msg', async (ctx) => {
      const bridge = this.bridge
      if (!bridge) { await ctx.reply('Orchestration isn\'t wired up yet.'); return }
      const raw = (ctx.match ?? '').trim()
      const sep = raw.search(/\s/)
      if (sep === -1) { await ctx.reply('Usage: /msg <name> <text>'); return }
      const name = raw.slice(0, sep)
      const text = raw.slice(sep + 1).trim()
      if (!text) { await ctx.reply('Usage: /msg <name> <text>'); return }
      const target = this.router.resolveTarget(name, bridge.listTargets())
      if (!target) { await ctx.reply(`No agent matches "${name}". Try /status.`); return }
      const res = bridge.sendTo(target.name, text)
      await ctx.reply(res.ok ? `📨 Sent to ${target.name}.` : `❌ ${res.detail ?? 'Send failed.'}`)
    })

    bot.command('output', async (ctx) => {
      const bridge = this.bridge
      if (!bridge) { await ctx.reply('Orchestration isn\'t wired up yet.'); return }
      const parts = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean)
      // Trailing number is the line count; the rest (if any) is the agent name.
      let lines = 20
      if (parts.length && /^\d+$/.test(parts[parts.length - 1])) {
        lines = Math.min(100, Math.max(1, parseInt(parts.pop()!, 10)))
      }
      const targets = bridge.listTargets()
      const target = parts.length
        ? this.router.resolveTarget(parts.join(' '), targets)
        : this.router.effectiveTarget(ctx.chat!.id, targets)
      if (!target) { await ctx.reply('No matching agent. Try /status.'); return }
      const out = bridge.getOutput(target.name, lines)
      if (out.length === 0) { await ctx.reply(`No recent output from ${target.name}.`); return }
      await ctx.reply(this.clip(`🖥 ${target.name} (last ${out.length}):\n\n${out.join('\n')}`))
    })

    bot.command('task', async (ctx) => {
      const bridge = this.bridge
      if (!bridge) { await ctx.reply('Orchestration isn\'t wired up yet.'); return }
      const title = (ctx.match ?? '').trim()
      if (!title) { await ctx.reply('Usage: /task <title>'); return }
      const res = bridge.postTask(title)
      await ctx.reply(res.ok ? `✅ Task posted${res.id ? ` (${res.id})` : ''}.` : `❌ ${res.detail ?? 'Failed.'}`)
    })

    // ── Plain text → the chat's active head (or active Cog, if federated) ───
    bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) return  // unmatched command — ignore

      // Topics mode: a reply inside a workspace's thread routes straight to
      // that workspace's orchestrator, bypassing the chat's active-head
      // routing below entirely. The General topic (no thread id) and DM mode
      // fall through unchanged.
      const threadId = ctx.message.message_thread_id
      if (this.mode === 'topics' && threadId !== undefined && this.workspaceRouter) {
        const workspaceId = this.topics.workspaceFor(threadId)
        if (!workspaceId) { await ctx.reply('This thread isn\'t linked to a live workspace.'); return }
        const res = this.workspaceRouter.sendToWorkspace(workspaceId, ctx.message.text)
        if (!res.ok) await ctx.reply(`❌ ${res.detail ?? 'Couldn\'t reach that workspace\'s orchestrator.'}`)
        return
      }

      const chatId = ctx.chat!.id

      // Multi-instance: if the chat is addressing a *different* Cog, forward the
      // message to it over loopback. When addressing this Cog (or running solo),
      // fall through to the local active-head routing below — unchanged.
      if (this.gateway?.isFollowerActive(chatId)) {
        const res = await this.gateway.routeInbound(chatId, ctx.message.text)
        if (!res.ok) await ctx.reply(`❌ Couldn't reach ${res.project ?? 'that project'}${res.detail ? ` — ${res.detail}` : ''}.`)
        return
      }

      const bridge = this.bridge
      if (!bridge) { await ctx.reply('Orchestration isn\'t wired up yet.'); return }
      const targets = bridge.listTargets()
      const target = this.router.effectiveTarget(chatId, targets)
      if (!target) { await ctx.reply('No agents are running. Start one in The Cog, then try again.'); return }
      const res = bridge.sendTo(target.name, ctx.message.text)
      if (!res.ok) await ctx.reply(`❌ ${res.detail ?? `Couldn't reach ${target.name}.`}`)
    })

    // ── Attachments (documents + photos) → the chat's active head ───────────
    // Download the bytes here (we have the bot token), then let the bridge save
    // them into the project and route them to the agent.
    bot.on(['message:document', 'message:photo'], async (ctx) => {
      // Topics mode: same thread-scoped routing as message:text, but for the
      // downloaded attachment. General topic / DM mode fall through unchanged.
      const threadId = ctx.message.message_thread_id
      if (this.mode === 'topics' && threadId !== undefined && this.workspaceRouter) {
        const workspaceRouter = this.workspaceRouter
        const workspaceId = this.topics.workspaceFor(threadId)
        if (!workspaceId) { await ctx.reply('This thread isn\'t linked to a live workspace.'); return }

        let file: IncomingFile
        try {
          file = await this.downloadAttachment(ctx)
        } catch (err) {
          this.log(`attachment download failed: ${err instanceof Error ? err.message : String(err)}`)
          await ctx.reply('❌ Couldn\'t download that file from Telegram (it may be too large — the bot limit is 20 MB).')
          return
        }

        const res = workspaceRouter.sendFileToWorkspace(workspaceId, file)
        await ctx.reply(res.ok
          ? `📎 Sent ${file.filename} to the workspace.`
          : `❌ ${res.detail ?? 'Couldn\'t hand that file to the workspace\'s orchestrator.'}`)
        return
      }

      const bridge = this.bridge
      if (!bridge) { await ctx.reply('Orchestration isn\'t wired up yet.'); return }
      const target = this.router.effectiveTarget(ctx.chat!.id, bridge.listTargets())
      if (!target) { await ctx.reply('No agents are running. Start one in The Cog, then try again.'); return }

      let file: IncomingFile
      try {
        file = await this.downloadAttachment(ctx)
      } catch (err) {
        this.log(`attachment download failed: ${err instanceof Error ? err.message : String(err)}`)
        await ctx.reply('❌ Couldn\'t download that file from Telegram (it may be too large — the bot limit is 20 MB).')
        return
      }

      const res = bridge.sendFile(target.name, file)
      await ctx.reply(res.ok
        ? `📎 Sent ${file.filename} to ${target.name}.`
        : `❌ ${res.detail ?? 'Couldn\'t hand that file to the agent.'}`)
    })

    // ── Voice notes → transcribe → the chat's active head ──────────────────
    bot.on('message:voice', async (ctx) => {
      const bridge = this.bridge
      if (!bridge) { await ctx.reply('Orchestration isn\'t wired up yet.'); return }
      const target = this.router.effectiveTarget(ctx.chat!.id, bridge.listTargets())
      if (!target) { await ctx.reply('No agents are running. Start one in The Cog, then try again.'); return }

      let bytes: Uint8Array
      try {
        bytes = await this.downloadCurrentFile(ctx)
      } catch (err) {
        this.log(`voice download failed: ${err instanceof Error ? err.message : String(err)}`)
        await ctx.reply('❌ Couldn\'t download that voice note.')
        return
      }

      // Transcription can take a moment — show the "typing…" indicator.
      await ctx.replyWithChatAction('typing').catch(() => {})
      const voice: IncomingVoice = { bytes, mimeType: ctx.message.voice.mime_type, caption: ctx.message.caption }
      const res = await bridge.sendVoice(target.name, voice)
      if (!res.ok) { await ctx.reply(`❌ ${res.detail ?? 'Couldn\'t process that voice note.'}`); return }
      await ctx.reply(res.transcript
        ? `🎙️ "${res.transcript}"\n→ sent to ${target.name}.`
        : `🎙️ Voice saved for ${target.name}${res.detail ? ` — ${res.detail}` : ''}.`)
    })

    // ── Inline buttons: answer choices, then proposal actions ──────────────
    bot.on('callback_query:data', async (ctx) => {
      const answer = parseAnswerCallback(ctx.callbackQuery.data)
      if (answer) { await this.handleAnswer(ctx, answer); return }

      const parsed = parseProposalCallback(ctx.callbackQuery.data)
      if (!parsed) { await ctx.answerCallbackQuery(); return }
      const bridge = this.bridge
      if (!bridge) { await ctx.answerCallbackQuery('Orchestration isn\'t wired up.'); return }
      const { action, id } = parsed

      if (action === 'info') {
        const p = bridge.getProposal(id)
        await ctx.answerCallbackQuery()
        await ctx.reply(p ? formatProposalDetails(p) : 'That proposal is no longer available.')
        return
      }

      // approve / reject — resolving fires onProposalResolved in the main
      // process, which calls relayProposalResolved() to edit the card. So we
      // just trigger the action and acknowledge the tap here.
      const result = action === 'approve'
        ? await bridge.approveProposal(id)
        : await bridge.rejectProposal(id)
      await ctx.answerCallbackQuery(result.ok
        ? (action === 'approve' ? '✅ Approved' : '❌ Rejected')
        : (result.detail ?? 'Could not update the proposal.'))
    })
  }

  /** Download the file referenced by the current update via the Telegram file API. */
  private async downloadCurrentFile(ctx: Context): Promise<Uint8Array> {
    const fileInfo = await ctx.getFile()  // resolves file_path for the update's file
    if (!fileInfo.file_path) throw new Error('no file_path (file too large or unavailable)')
    const res = await fetch(`https://api.telegram.org/file/bot${this.bot!.token}/${fileInfo.file_path}`)
    if (!res.ok) throw new Error(`download HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  /**
   * Pull the document/photo out of an update and download its bytes. Photos have
   * no filename, so we synthesise one from the file's unique id.
   */
  private async downloadAttachment(ctx: Context): Promise<IncomingFile> {
    const doc = ctx.message?.document
    const photo = ctx.message?.photo?.at(-1)  // last entry = highest resolution
    const bytes = await this.downloadCurrentFile(ctx)
    const uniqueId = photo?.file_unique_id ?? doc?.file_unique_id ?? 'file'
    const filename = doc?.file_name
      ?? (photo ? `telegram-photo-${uniqueId}.jpg` : `telegram-file-${uniqueId}`)
    const mimeType = doc?.mime_type ?? (photo ? 'image/jpeg' : undefined)
    return { filename, bytes, mimeType, caption: ctx.message?.caption }
  }

  /**
   * Push an agent→user message into every subscribed chat. Called from the main
   * process's Message Router tap (onMessageQueued, to === 'user'). Tagged with
   * the sender so you can tell the dragon's heads apart.
   */
  relayFromAgent(
    fromName: string,
    message: string,
    priority?: string,
    opts?: { id?: string; choices?: string[] }
  ): void {
    if (!this.bot || !this.ready) {
      this.log(`relay skipped (bot not ready) — "${fromName}" message not sent`)
      return
    }
    // Recheck the allowlist at send time: only private chats subscribe, and a
    // private chat's ID equals its user's ID, so a revoked user is filtered
    // out here even if their chat somehow lingers in the router.
    const chats = this.subscribedAllowedChats()
    if (chats.length === 0) {
      this.log(`relay skipped (no subscribed+allowed chats) — "${fromName}" message not sent`)
      return
    }

    // A question carries answer choices → render tappable buttons and remember
    // it so the tapped answer routes back to the asker. Fire-and-forget: the
    // answer arrives later as a normal user→agent message.
    if (opts?.id && opts.choices && opts.choices.length) {
      void this.relayQuestion(chats, fromName, message, priority, opts.id, opts.choices)
      return
    }

    const text = this.clip(`${projectPrefix(this.project)}${priorityPrefix(priority)}💬 ${fromName}:\n${message}`)
    for (const chatId of chats) {
      this.bot.api.sendMessage(chatId, text).catch((err) => {
        this.log(`relay to ${chatId} failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

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
        await this.bot.api.reopenForumTopic(chatId, existing).catch((err) =>
          this.log(`ensureTopic reopen(${workspaceId}) failed: ${err instanceof Error ? err.message : String(err)}`))
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
    if (this.mode !== 'topics' || !this.supergroupChatId || !this.bot || !this.ready || threadId === undefined) return
    await this.bot.api.closeForumTopic(this.supergroupChatId, threadId).catch((err) => {
      this.log(`closeTopic(${workspaceId}) failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  async renameTopic(workspaceId: string, name: string): Promise<void> {
    const threadId = this.topics.threadFor(workspaceId)
    if (this.mode !== 'topics' || !this.supergroupChatId || !this.bot || !this.ready || threadId === undefined) return
    if (!this.topics.rename(workspaceId, name)) return
    await this.bot.api.editForumTopic(this.supergroupChatId, threadId, { name }).catch((err) => {
      this.log(`renameTopic(${workspaceId}) failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /** One tappable button per choice, wired to answerCallback so a tap round-trips to handleAnswer. */
  private buildChoiceKeyboard(messageId: string, choices: string[]): InlineKeyboard {
    const keyboard = new InlineKeyboard()
    choices.forEach((c, i) => { keyboard.text(clipChoiceLabel(c), answerCallback(messageId, i)).row() })
    return keyboard
  }

  /**
   * Send a question with one inline button per choice, and register it so the
   * tapped answer can be routed back to the asking agent (see handleAnswer).
   * We await each send to capture message ids for editing to "answered" later.
   */
  private async relayQuestion(
    chats: number[], fromName: string, question: string, priority: string | undefined,
    messageId: string, choices: string[]
  ): Promise<void> {
    if (!this.bot) return
    const text = this.clip(`${projectPrefix(this.project)}${priorityPrefix(priority)}❓ ${fromName} asks:\n${question}`)
    const keyboard = this.buildChoiceKeyboard(messageId, choices)

    const sent: Array<{ chatId: number; messageId: number }> = []
    for (const chatId of chats) {
      try {
        const msg = await this.bot.api.sendMessage(chatId, text, { reply_markup: keyboard })
        sent.push({ chatId, messageId: msg.message_id })
      } catch (err) {
        this.log(`question push to ${chatId} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (sent.length) {
      this.pendingQuestions.set(messageId, { askerName: fromName, question, choices, sent })
    }
  }

  /**
   * Thread variant of relayQuestion: targets one (chatId, threadId) instead of
   * looping the subscribed chats, and has no [Project] prefix (the thread is the
   * identity). Falls back to the classic DM question relay if the send fails, so
   * the question is never silently dropped.
   */
  private async relayQuestionToThread(
    chatId: number, threadId: number, fromName: string, question: string, priority: string | undefined,
    messageId: string, choices: string[]
  ): Promise<void> {
    if (!this.bot) return
    const text = this.clip(`${priorityPrefix(priority)}❓ ${fromName} asks:\n${question}`)
    const keyboard = this.buildChoiceKeyboard(messageId, choices)
    try {
      const msg = await this.bot.api.sendMessage(chatId, text, { reply_markup: keyboard, message_thread_id: threadId })
      this.pendingQuestions.set(messageId, { askerName: fromName, question, choices, sent: [{ chatId, messageId: msg.message_id }] })
    } catch (err) {
      this.log(`thread question (${chatId}/${threadId}) failed, falling back to DM: ${err instanceof Error ? err.message : String(err)}`)
      this.relayFromAgent(fromName, question, priority, { id: messageId, choices })
    }
  }

  /** Route a tapped choice back to the asking agent and settle the button cards. */
  private async handleAnswer(ctx: Context, answer: { messageId: string; choiceIndex: number }): Promise<void> {
    const q = this.pendingQuestions.get(answer.messageId)
    if (!q) { await ctx.answerCallbackQuery('This question was already answered or has expired.'); return }
    const choice = q.choices[answer.choiceIndex]
    if (choice === undefined) { await ctx.answerCallbackQuery('That choice is no longer available.'); return }

    this.pendingQuestions.delete(answer.messageId)

    // Deliver the answer to the asking agent as a user→agent message so it lands
    // in that agent's inbox exactly like a typed reply would.
    const bridge = this.bridge
    if (bridge) {
      const snippet = q.question.length > 120 ? q.question.slice(0, 119) + '…' : q.question
      const res = bridge.sendTo(q.askerName, `[Answer to your question "${snippet}"]: ${choice}`)
      if (!res.ok) this.log(`answer route to ${q.askerName} failed: ${res.detail ?? 'unknown'}`)
    }

    // Strip buttons on every copy and show the chosen answer.
    const answered = formatAnswered(q.question, choice)
    for (const { chatId, messageId } of q.sent) {
      this.bot?.api.editMessageText(chatId, messageId, answered).catch((err) => {
        this.log(`answered edit ${chatId}/${messageId} failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
    await ctx.answerCallbackQuery(`✅ ${choice}`)
  }

  /** Push a pending proposal to every linked chat with Approve/Reject/Details buttons. */
  async relayProposal(p: ProposalView): Promise<void> {
    if (!this.bot || !this.ready) return
    const chats = this.subscribedAllowedChats()
    if (chats.length === 0) return
    const keyboard = new InlineKeyboard()
      .text('✅ Approve', proposalCallback('approve', p.id))
      .text('❌ Reject', proposalCallback('reject', p.id)).row()
      .text('📋 Details', proposalCallback('info', p.id))
    const text = this.clip(formatProposalMessage(p))
    const sent: Array<{ chatId: number; messageId: number }> = []
    for (const chatId of chats) {
      try {
        const msg = await this.bot.api.sendMessage(chatId, text, { reply_markup: keyboard })
        sent.push({ chatId, messageId: msg.message_id })
      } catch (err) {
        this.log(`proposal push to ${chatId} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (!sent.length) return
    this.proposalMsgs.set(p.id, sent)
    // Race guard: the proposal may have been resolved (desktop/3DS/expiry) while
    // this push was in flight — relayProposalResolved would have found no map
    // entry yet and bailed. Re-check the authoritative status and settle the
    // freshly-sent cards now so they never keep live buttons on a done proposal.
    const current = this.bridge?.getProposal(p.id)
    if (current && current.status !== 'pending') this.relayProposalResolved(current)
  }

  /** Edit a proposal's cards to their settled state and strip the buttons. */
  relayProposalResolved(p: ProposalView): void {
    if (!this.bot) return
    const msgs = this.proposalMsgs.get(p.id)
    if (!msgs) return
    this.proposalMsgs.delete(p.id)
    const text = formatProposalResolved(p)
    for (const { chatId, messageId } of msgs) {
      // Drop the keyboard by omitting reply_markup on the edit.
      this.bot.api.editMessageText(chatId, messageId, text).catch((err) => {
        this.log(`proposal edit ${chatId}/${messageId} failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

  /** Subscribed chats that still map to a trusted user (private chat ID === user ID). */
  private subscribedAllowedChats(): number[] {
    return this.router.subscribedChats().filter((id) => this.pairing.isAllowed(id))
  }

  /**
   * Fully revoke a Telegram user: drop them from the allowlist AND cut their
   * relay subscription (private chat ID === user ID). Both changes persist via
   * the managers' change callbacks. Returns true if they were paired.
   */
  revokeUser(userId: number): boolean {
    const had = this.pairing.revoke(userId)
    this.router.forget(userId)
    return had
  }

  private formatStatus(targets: TelegramTarget[], active: TelegramTarget | null): string {
    const dot = (s: string) => (s === 'disconnected' ? '⚪' : s === 'active' ? '🟢' : '🟡')
    const lines = targets.map((t) => {
      const here = active && t.name === active.name ? '👉' : dot(t.status)
      return `${here} ${t.name} · ${t.role} · ${t.status}`
    })
    const footer = active
      ? `\nPlain text → ${active.name}. Switch with /use <name>.`
      : '\nNo active head — /use <name> to pick one.'
    return `The Cog — agents\n${lines.join('\n')}\n${footer}`
  }

  /** Aggregated status across every federated Cog, grouped by project. */
  private formatFederatedStatus(
    groups: Array<{ project: string; isSelf: boolean; targets: { name: string; role: string; status: string }[] }>,
    activeProject: string | null
  ): string {
    const dot = (s: string) => (s === 'disconnected' ? '⚪' : s === 'active' ? '🟢' : '🟡')
    const blocks = groups.map((g) => {
      const head = `${g.project === activeProject ? '👉' : '📁'} ${g.project}`
      const rows = g.targets.length
        ? g.targets.map(t => `   ${dot(t.status)} ${t.name} · ${t.role}`).join('\n')
        : '   (no agents)'
      return `${head}\n${rows}`
    })
    return `The Cog — ${groups.length} instances\n\n${blocks.join('\n\n')}\n\nPlain text → ${activeProject ?? 'active project'}. Switch with /cog <project>.`
  }

  /** Trim to Telegram's message ceiling, keeping the tail (newest output). */
  private clip(text: string): string {
    if (text.length <= MAX_RELAY_CHARS) return text
    return '…' + text.slice(text.length - MAX_RELAY_CHARS)
  }
}
