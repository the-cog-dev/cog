import { Bot } from 'grammy'
import type { PairingManager } from './pairing-manager'

export interface TelegramServerOptions {
  pairing: PairingManager
  /** Optional log sink — wire to the main-process logger. */
  onLog?: (message: string) => void
  /** Fired when connection/pairing state changes so the UI can refresh. */
  onStatusChange?: () => void
}

/**
 * Phase 0 — scaffold + pairing only.
 *
 * Wraps a grammY bot in long-polling mode. No tunnel, no public ingress: the
 * bot reaches out to Telegram, so there's nothing to expose. (This is why the
 * Telegram bridge needs no cloudflared, unlike Remote View.)
 *
 * Auth: every update except the public pairing commands is dropped for users
 * not on the allowlist — the bot gives no sign it exists. The swarm relay
 * (Message Router tap) and command router (/status, /output, /task, …) attach
 * in Phase 1+ at the marked seam below, after the gate, so they're
 * trusted-only by default.
 */
export class TelegramServer {
  private bot: Bot | null = null
  private running = false
  private readonly pairing: PairingManager
  private readonly log: (m: string) => void
  private readonly onStatusChange?: () => void

  constructor(opts: TelegramServerOptions) {
    this.pairing = opts.pairing
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
    // are dropped silently (no next() call → chain ends).
    bot.use(async (ctx, next) => {
      if (this.pairing.isAllowed(ctx.from?.id)) await next()
    })

    // ── Trusted commands ───────────────────────────────────────────────────
    bot.command('help', async (ctx) => {
      await ctx.reply(
        'The Cog — Telegram (Phase 0)\n' +
        '/start — link status\n' +
        '/whoami — show your Telegram ID\n' +
        '/help — this list\n\n' +
        'Coming next: /status, /output, /task, and plain text → orchestrator.'
      )
    })

    // ───────────────────────────────────────────────────────────────────────
    // PHASE 1+ SEAM
    // Relay forwarder (Message Router tap → chat) and the command router
    // (/status, /output, /msg, /task, schedules, plain text → orchestrator)
    // attach here. They sit after the gate, so trusted-only by default.
    // ───────────────────────────────────────────────────────────────────────
  }
}
