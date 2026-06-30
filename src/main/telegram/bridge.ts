/**
 * The seam between the Telegram bot and The Cog's orchestration hub.
 *
 * telegram-server.ts speaks only this interface — it never imports the hub,
 * the registry, or electron. index.ts supplies a concrete implementation
 * backed by hub.messages / hub.registry / hub.pinboard / the PTY buffers.
 * Same decoupling philosophy as PairingManager: the bot stays unit-testable
 * and the hub stays the single source of truth.
 */

/** An agent the bot can address — one "head" of the dragon. */
export interface TelegramTarget {
  name: string
  role: string    // 'orchestrator' | 'worker' | 'researcher' | …
  status: string  // 'active' | 'idle' | 'thinking' | 'disconnected' | …
}

export interface OrchestratorBridge {
  /** Live addressable agents (the registry minus the 'user' pseudo-agent). */
  listTargets(): TelegramTarget[]
  /** Route text into a named agent's inbox. Mirrors a user→agent hub message. */
  sendTo(name: string, text: string): { ok: boolean; detail?: string }
  /** Recent terminal output lines for a named agent (newest last). */
  getOutput(name: string, lines: number): string[]
  /** Post a task to the shared pinboard. */
  postTask(title: string): { ok: boolean; id?: string; detail?: string }
}
