import { Bot } from 'grammy'
import type { PairingManager } from './pairing-manager'
import type { OrchestratorBridge, TelegramTarget } from './bridge'
import { ChatRouter } from './chat-router'

/** Telegram caps a single message at 4096 chars; leave headroom for our prefix. */
const MAX_RELAY_CHARS = 3900

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
  private readonly router = new ChatRouter()
  private readonly log: (m: string) => void
  private readonly onStatusChange?: () => void

  constructor(opts: TelegramServerOptions) {
    this.pairing = opts.pairing
    this.bridge = opts.bridge
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
    await bot.init()
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
        await ctx.reply('✅ You\'re linked to The Cog. Phase 0 is live — orchestration commands land in the next update. Try /help.')
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
    // Anything past this point requires a trusted user. Non-allowed updates
    // are dropped silently (no next() call → chain ends). A trusted chat is
    // also registered here so it receives relayed orchestrator output.
    bot.use(async (ctx, next) => {
      if (!this.pairing.isAllowed(ctx.from?.id)) return
      if (ctx.chat) this.router.subscribe(ctx.chat.id)
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
        'Plain text goes to this chat\'s active head (see /status).'
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
  }

  /**
   * Push an agent→user message into every subscribed chat. Called from the main
   * process's Message Router tap (onMessageQueued, to === 'user'). Tagged with
   * the sender so you can tell the dragon's heads apart.
   */
  relayFromAgent(fromName: string, message: string): void {
    if (!this.bot || !this.running) return
    const chats = this.router.subscribedChats()
    if (chats.length === 0) return
    const text = this.clip(`💬 ${fromName}:\n${message}`)
    for (const chatId of chats) {
      this.bot.api.sendMessage(chatId, text).catch((err) => {
        this.log(`relay to ${chatId} failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
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
