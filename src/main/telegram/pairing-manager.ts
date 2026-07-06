import { randomInt, timingSafeEqual } from 'crypto'

const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000   // pairing codes expire after 10 min
const DEFAULT_MAX_ATTEMPTS = 5               // failed guesses before the code burns

export interface PairingManagerOptions {
  /** Telegram user IDs already trusted (loaded from settings on boot). */
  initialAllowlist?: number[]
  /** Fired whenever the allowlist changes so the caller can persist it. */
  onAllowlistChange?: (ids: number[]) => void
  /** Injectable clock for testing. */
  clock?: () => number
  /** How long a freshly generated pairing code stays valid. */
  codeTtlMs?: number
  /** Failed pair attempts allowed before the pending code is invalidated. */
  maxAttempts?: number
}

/**
 * Owns Telegram auth for The Cog: a one-time pairing code (the ownership
 * proof — same mental model as the Remote View passcode) and the allowlist of
 * trusted Telegram user IDs. The bot answers nobody until they pair.
 *
 * Mirrors remote/token-manager.ts: in-memory state, timing-safe compares,
 * clock DI. Persistence is delegated to the caller via onAllowlistChange so
 * this file stays free of fs/electron concerns and is trivially unit-testable.
 */
export class PairingManager {
  private allowlist: Set<number>
  private pendingCode: string | null = null
  private codeExpiresAt: number | null = null
  private failedAttempts = 0
  private readonly onChange?: (ids: number[]) => void
  private readonly clock: () => number
  private readonly codeTtlMs: number
  private readonly maxAttempts: number

  constructor(opts: PairingManagerOptions = {}) {
    this.allowlist = new Set(opts.initialAllowlist ?? [])
    this.onChange = opts.onAllowlistChange
    this.clock = opts.clock ?? Date.now
    this.codeTtlMs = opts.codeTtlMs ?? DEFAULT_CODE_TTL_MS
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  }

  /** Generate a fresh 6-digit pairing code, replacing any previous one. */
  generateCode(): string {
    const n = randomInt(0, 1_000_000)
    this.pendingCode = n.toString().padStart(6, '0')
    this.codeExpiresAt = this.clock() + this.codeTtlMs
    this.failedAttempts = 0
    return this.pendingCode
  }

  /** The active code if one exists and hasn't expired, else null. */
  getActiveCode(): string | null {
    if (this.pendingCode === null || this.codeExpiresAt === null) return null
    if (this.clock() > this.codeExpiresAt) {
      this.pendingCode = null
      this.codeExpiresAt = null
      return null
    }
    return this.pendingCode
  }

  /**
   * Attempt to pair a Telegram user with the given code. On success the user
   * is added to the allowlist and the code is consumed (single-use).
   */
  tryPair(userId: number, code: string): boolean {
    const active = this.getActiveCode()
    if (active === null) return false
    if (typeof code !== 'string') return false
    // Constant-time compare so the bot can't be used as a timing oracle.
    const a = Buffer.from(code)
    const b = Buffer.from(active)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      // Anti-brute-force: a 6-digit code can't survive open-ended guessing,
      // so burn it after maxAttempts misses. The owner just generates a new one.
      this.failedAttempts++
      if (this.failedAttempts >= this.maxAttempts) {
        this.pendingCode = null
        this.codeExpiresAt = null
      }
      return false
    }
    // Consume the code so it can't be replayed, then trust the user.
    this.pendingCode = null
    this.codeExpiresAt = null
    if (!this.allowlist.has(userId)) {
      this.allowlist.add(userId)
      this.onChange?.(this.list())
    }
    return true
  }

  isAllowed(userId: number | undefined): boolean {
    if (typeof userId !== 'number') return false
    return this.allowlist.has(userId)
  }

  /** Remove a user from the allowlist. Returns true if they were present. */
  revoke(userId: number): boolean {
    const had = this.allowlist.delete(userId)
    if (had) this.onChange?.(this.list())
    return had
  }

  /** Drop every trusted user and any pending code (panic / reset). */
  revokeAll(): void {
    const had = this.allowlist.size > 0
    this.allowlist.clear()
    this.pendingCode = null
    this.codeExpiresAt = null
    if (had) this.onChange?.(this.list())
  }

  list(): number[] {
    return Array.from(this.allowlist)
  }

  get size(): number {
    return this.allowlist.size
  }
}
