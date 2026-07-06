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

/** A file or photo forwarded from Telegram, already downloaded to memory. */
export interface IncomingFile {
  filename: string
  bytes: Uint8Array
  mimeType?: string
  caption?: string
}

/** A team/schedule proposal, flattened for the bot (decoupled from shared types). */
export interface ProposalView {
  id: string
  proposedBy: string
  summary: string
  kind: 'team' | 'schedule'
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  agents: { name: string; role: string; cli: string; model?: string; notes?: string }[]
}

export interface OrchestratorBridge {
  /** Live addressable agents (the registry minus the 'user' pseudo-agent). */
  listTargets(): TelegramTarget[]
  /** Route text into a named agent's inbox. Mirrors a user→agent hub message. */
  sendTo(name: string, text: string): { ok: boolean; detail?: string }
  /**
   * Save an incoming attachment into the project and route it to a named agent:
   * text files are inlined, images/binaries are handed over as a path the agent
   * can open. Returns the saved path (relative to the project) on success.
   */
  sendFile(name: string, file: IncomingFile): { ok: boolean; relPath?: string; detail?: string }
  /** Recent terminal output lines for a named agent (newest last). */
  getOutput(name: string, lines: number): string[]
  /** Post a task to the shared pinboard. */
  postTask(title: string): { ok: boolean; id?: string; detail?: string }
  /** Approve a pending team/schedule proposal (spawns agents / creates schedule). */
  approveProposal(id: string): Promise<{ ok: boolean; detail?: string }>
  /** Reject a pending proposal. */
  rejectProposal(id: string): Promise<{ ok: boolean; detail?: string }>
  /** Fetch a proposal's current view, or null if it's gone. */
  getProposal(id: string): ProposalView | null
}
