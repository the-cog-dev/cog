/**
 * Pure federation routing for the single-poller gateway. When one Cog instance
 * is the Telegram gateway (owns the poll) and others are followers, this tracks
 * every registered Cog and which one each DM chat is currently talking to.
 *
 * No grammY, no HTTP, no clock — timestamps are injected — so the addressing
 * rules stay trivially unit-testable, like ChatRouter and PairingManager.
 *
 * A single DM has no topic to route by, so plain text goes to the chat's
 * *active Cog*; `/use <project>` switches it; replies are project-prefixed so
 * the user can still tell the heads apart.
 */

export interface RegisteredCog {
  /** Unique per instance. The gateway's own process registers as isSelf=true. */
  id: string
  /** Human-facing project name — what the user types after /use and sees in prefixes. */
  project: string
  /** True for the gateway's own process (routed locally, no HTTP hop). */
  isSelf: boolean
  /** Follower's loopback callback base URL, where the gateway delivers inbound
   *  messages and fetches targets (undefined for self). */
  callbackUrl?: string
  /** Last heartbeat, ms epoch. Injected by the coordinator. */
  lastSeen: number
}

export class FederationRouter {
  private cogs = new Map<string, RegisteredCog>()
  private activeByChat = new Map<number, string>() // chatId -> cog id

  /** Register or refresh a Cog (idempotent by id; refreshes lastSeen/fields). */
  register(cog: RegisteredCog): void {
    this.cogs.set(cog.id, { ...cog })
  }

  deregister(id: string): void {
    this.cogs.delete(id)
    // Drop any chat pinned to it so routing falls back to a live default.
    for (const [chatId, cogId] of this.activeByChat) {
      if (cogId === id) this.activeByChat.delete(chatId)
    }
  }

  /** Refresh a follower's heartbeat. Returns false if it isn't registered. */
  touch(id: string, now: number): boolean {
    const c = this.cogs.get(id)
    if (!c) return false
    c.lastSeen = now
    return true
  }

  /** Remove Cogs not seen within ttlMs (self is never pruned). Returns removed ids. */
  prune(now: number, ttlMs: number): string[] {
    const removed: string[] = []
    for (const c of this.cogs.values()) {
      if (c.isSelf) continue
      if (now - c.lastSeen > ttlMs) removed.push(c.id)
    }
    removed.forEach(id => this.deregister(id))
    return removed
  }

  list(): RegisteredCog[] {
    return Array.from(this.cogs.values())
  }

  get(id: string): RegisteredCog | null {
    return this.cogs.get(id) ?? null
  }

  /** Pin a chat's active Cog. Returns false if that Cog isn't registered. */
  setActive(chatId: number, cogId: string): boolean {
    if (!this.cogs.has(cogId)) return false
    this.activeByChat.set(chatId, cogId)
    return true
  }

  /**
   * Default Cog when a chat hasn't chosen one: prefer self (the gateway's own
   * project), then any registered Cog, else null.
   */
  pickDefault(): RegisteredCog | null {
    const cogs = this.list()
    if (cogs.length === 0) return null
    return cogs.find(c => c.isSelf) ?? cogs[0]
  }

  /** The Cog a chat's plain text routes to: its pinned active one, else the default. */
  resolveActive(chatId: number): RegisteredCog | null {
    const id = this.activeByChat.get(chatId)
    if (id) {
      const c = this.cogs.get(id)
      if (c) return c
    }
    return this.pickDefault()
  }

  /**
   * Resolve a user-typed project name against the registered Cogs:
   *   1. exact match (case-insensitive)
   *   2. unique prefix match (case-insensitive)
   * Returns null if nothing matches or a prefix is ambiguous.
   */
  resolveByProject(input: string): RegisteredCog | null {
    const q = input.trim().toLowerCase()
    if (!q) return null
    const exact = this.list().find(c => c.project.toLowerCase() === q)
    if (exact) return exact
    const prefixed = this.list().filter(c => c.project.toLowerCase().startsWith(q))
    return prefixed.length === 1 ? prefixed[0] : null
  }
}
