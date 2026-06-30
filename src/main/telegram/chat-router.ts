import type { TelegramTarget } from './bridge'

/**
 * Per-chat routing state — the "sub-groups" / multi-dragon addressing layer.
 *
 * The Cog can run more than one orchestrator (the "double-headed dragon"), plus
 * workers and MCP-backed agents. A single Telegram chat needs to know *which*
 * head it's currently talking to, and which chats want orchestrator output
 * pushed back to them.
 *
 * This class is pure routing bookkeeping — no grammY, no hub, no I/O — so the
 * addressing rules (resolution, default selection, active-target memory) are
 * trivially unit-testable, exactly like PairingManager.
 *
 * Model:
 *  - A chat becomes *subscribed* the first time a trusted user interacts with
 *    it; subscribed chats receive relayed agent output.
 *  - Each chat remembers an *active target*. Plain text routes there. `/use`
 *    switches it. If the remembered target is gone (agent disconnected/renamed),
 *    we fall back to a sensible default (prefer a live orchestrator).
 */
export class ChatRouter {
  private subscribed = new Set<number>()
  private activeByChat = new Map<number, string>()

  /** Mark a chat as a relay destination (idempotent). */
  subscribe(chatId: number): void {
    this.subscribed.add(chatId)
  }

  isSubscribed(chatId: number): boolean {
    return this.subscribed.has(chatId)
  }

  subscribedChats(): number[] {
    return Array.from(this.subscribed)
  }

  forget(chatId: number): void {
    this.subscribed.delete(chatId)
    this.activeByChat.delete(chatId)
  }

  /** Pin this chat's active target by exact agent name. */
  setActive(chatId: number, name: string): void {
    this.activeByChat.set(chatId, name)
  }

  /** Raw remembered target name, if any (may be stale). */
  getActive(chatId: number): string | null {
    return this.activeByChat.get(chatId) ?? null
  }

  /**
   * Resolve a user-typed target name against the live target list:
   *   1. exact match (case-insensitive)
   *   2. unique prefix match (case-insensitive) — lets you type `/use ca` for "Cara"
   * Returns null if nothing matches or a prefix is ambiguous.
   */
  resolveTarget(input: string, targets: TelegramTarget[]): TelegramTarget | null {
    const q = input.trim().toLowerCase()
    if (!q) return null

    const exact = targets.find(t => t.name.toLowerCase() === q)
    if (exact) return exact

    const prefixed = targets.filter(t => t.name.toLowerCase().startsWith(q))
    return prefixed.length === 1 ? prefixed[0] : null
  }

  /**
   * Default target when a chat hasn't chosen one: prefer a non-disconnected
   * orchestrator, then any orchestrator, then any live agent, then anything.
   */
  pickDefault(targets: TelegramTarget[]): TelegramTarget | null {
    if (targets.length === 0) return null
    const liveOrch = targets.find(t => t.role === 'orchestrator' && t.status !== 'disconnected')
    if (liveOrch) return liveOrch
    const anyOrch = targets.find(t => t.role === 'orchestrator')
    if (anyOrch) return anyOrch
    const live = targets.find(t => t.status !== 'disconnected')
    return live ?? targets[0]
  }

  /**
   * The target plain text should route to for this chat: the remembered active
   * target if it's still present, otherwise the default. Returns null only when
   * there are no targets at all.
   */
  effectiveTarget(chatId: number, targets: TelegramTarget[]): TelegramTarget | null {
    const activeName = this.activeByChat.get(chatId)
    if (activeName) {
      const match = targets.find(t => t.name === activeName)
      if (match) return match
    }
    return this.pickDefault(targets)
  }
}
