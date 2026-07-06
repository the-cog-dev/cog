import { Bot, InlineKeyboard, type Context } from 'grammy'
import type { PairingManager } from './pairing-manager'
import type { OrchestratorBridge, TelegramTarget, IncomingFile, ProposalView } from './bridge'
import { ChatRouter } from './chat-router'
import {
  proposalCallback, parseProposalCallback,
  formatProposalMessage, formatProposalDetails, formatProposalResolved
} from './proposal-format'

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

export interface TelegramServerOptions {
  pairing: PairingManager
  /**
   * Bridge into the orchestration hub. Phase 1+ — when present, the trusted
   * command router and the plain-text → orchestrator relay come alive. Omit it
   * (Phase 0) and the bot is pairing-only.
   */
  bridge?: OrchestratorBridge
  /** Optional log sink — wire to the main-process logger. */
  onLog?: (message: string) => void
  /** Fired when connection/pairing state changes so the UI can refresh. */
  onStatusChange?: () => void
  /** Relay-subscribed chat IDs from the last run, so restarts don't drop the relay. */
  initialChats?: number[]
  /** Fired when the subscribed-chat set changes so the caller can persist it. */
  onChatsChange?: (chatIds: number[]) => void
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
  private running = false
  private readonly pairing: PairingManager
  private readonly bridge?: OrchestratorBridge
  private readonly router: ChatRouter
  private readonly log: (m: string) => void
  private readonly onStatusChange?: () => void
  // proposalId → the chat messages carrying its buttons, so we can edit them to
  // "settled" once it resolves (from Telegram, desktop, or 3DS).
  private readonly proposalMsgs = new Map<string, Array<{ chatId: number; messageId: number }>>()

  constructor(opts: TelegramServerOptions) {
    this.pairing = opts.pairing
    this.bridge = opts.bridge
    this.router = new ChatRouter({
      initialSubscribed: opts.initialChats,
      onSubscribedChange: opts.onChatsChange
    })
    this.log = opts.onLog ?? (() => {})
    this.onStatusChange = opts.onStatusChange
  }

  isRunning(): boolean {
    return this.running
  }

  /**
   * Start long-polling with the given bot token. Awaits init() so a bad token
   * surfaces as a thrown error the Settings UI can show, then kicks off polling
   * in the background (grammY's start() only resolves when the bot stops, so we
   * deliberately don't await it). Call stop() before starting a new token.
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
    void bot.start({
      onStart: () => {
        this.running = true
        this.onStatusChange?.()
      }
    })
    this.log(`bot @${bot.botInfo.username} started (long-poll)`)
  }

  async stop(): Promise<void> {
    if (!this.bot) return
    try {
      await this.bot.stop()
    } finally {
      this.bot = null
      this.running = false
      this.onStatusChange?.()
      this.log('bot stopped')
    }
  }

  private registerHandlers(bot: Bot): void {
    // ── Public commands (work before pairing) ──────────────────────────────
    bot.command('start', async (ctx) => {
      if (this.pairing.isAllowed(ctx.from?.id)) {
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

    // ── Allowlist gate ─────────────────────────────────────────────────────
    // Anything past this point requires a trusted user in a PRIVATE chat.
    // Non-allowed updates are dropped silently (no next() call → chain ends).
    // Groups are refused outright: pairing is per-user, but a subscription is
    // per-chat — relaying agent output into a group would hand it to every
    // member, paired or not. The trusted DM is registered here so it receives
    // relayed orchestrator output.
    bot.use(async (ctx, next) => {
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
        'text files are read inline, images are saved for the agent to open.'
      )
    })

    bot.command('status', async (ctx) => {
      const bridge = this.bridge
      if (!bridge) { await ctx.reply('Orchestration isn\'t wired up yet.'); return }
      const targets = bridge.listTargets()
      if (targets.length === 0) { await ctx.reply('No agents are running right now.'); return }
      const active = this.router.effectiveTarget(ctx.chat!.id, targets)
      await ctx.reply(this.formatStatus(targets, active))
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

    // ── Plain text → the chat's active head ────────────────────────────────
    bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) return  // unmatched command — ignore
      const bridge = this.bridge
      if (!bridge) { await ctx.reply('Orchestration isn\'t wired up yet.'); return }
      const targets = bridge.listTargets()
      const target = this.router.effectiveTarget(ctx.chat!.id, targets)
      if (!target) { await ctx.reply('No agents are running. Start one in The Cog, then try again.'); return }
      const res = bridge.sendTo(target.name, ctx.message.text)
      if (!res.ok) await ctx.reply(`❌ ${res.detail ?? `Couldn't reach ${target.name}.`}`)
    })

    // ── Attachments (documents + photos) → the chat's active head ───────────
    // Download the bytes here (we have the bot token), then let the bridge save
    // them into the project and route them to the agent.
    bot.on(['message:document', 'message:photo'], async (ctx) => {
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

    // ── Proposal buttons (Approve / Reject / Details) ──────────────────────
    bot.on('callback_query:data', async (ctx) => {
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

  /**
   * Pull the document/photo out of an update and download its bytes via the
   * Telegram file API. Photos have no filename, so we synthesise one.
   */
  private async downloadAttachment(ctx: Context): Promise<IncomingFile> {
    const doc = ctx.message?.document
    const photo = ctx.message?.photo?.at(-1)  // last entry = highest resolution
    const fileInfo = await ctx.getFile()      // resolves file_path for doc or largest photo
    if (!fileInfo.file_path) throw new Error('no file_path (file too large or unavailable)')

    const token = this.bot!.token
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`)
    if (!res.ok) throw new Error(`download HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())

    const filename = doc?.file_name
      ?? (photo ? `telegram-photo-${fileInfo.file_unique_id}.jpg` : `telegram-file-${fileInfo.file_unique_id}`)
    const mimeType = doc?.mime_type ?? (photo ? 'image/jpeg' : undefined)
    return { filename, bytes, mimeType, caption: ctx.message?.caption }
  }

  /**
   * Push an agent→user message into every subscribed chat. Called from the main
   * process's Message Router tap (onMessageQueued, to === 'user'). Tagged with
   * the sender so you can tell the dragon's heads apart.
   */
  relayFromAgent(fromName: string, message: string, priority?: string): void {
    if (!this.bot || !this.running) return
    // Recheck the allowlist at send time: only private chats subscribe, and a
    // private chat's ID equals its user's ID, so a revoked user is filtered
    // out here even if their chat somehow lingers in the router.
    const chats = this.subscribedAllowedChats()
    if (chats.length === 0) return
    const text = this.clip(`${priorityPrefix(priority)}💬 ${fromName}:\n${message}`)
    for (const chatId of chats) {
      this.bot.api.sendMessage(chatId, text).catch((err) => {
        this.log(`relay to ${chatId} failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

  /** Push a pending proposal to every linked chat with Approve/Reject/Details buttons. */
  async relayProposal(p: ProposalView): Promise<void> {
    if (!this.bot || !this.running) return
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
    if (sent.length) this.proposalMsgs.set(p.id, sent)
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

  /** Trim to Telegram's message ceiling, keeping the tail (newest output). */
  private clip(text: string): string {
    if (text.length <= MAX_RELAY_CHARS) return text
    return '…' + text.slice(text.length - MAX_RELAY_CHARS)
  }
}
