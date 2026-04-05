// Strip ANSI escape codes and terminal control sequences from output
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // CSI sequences (including ?2026h/l)
    .replace(/\x1b\][^\x07]*\x07/g, '')         // OSC sequences
    .replace(/\x1b\[[\d;]*m/g, '')              // SGR color codes
    .replace(/\x1b[()][A-Z0-9]/g, '')           // Character set selection
    .replace(/[\x00-\x08\x0e-\x1f]/g, '')       // Control characters
    .replace(/[✢✶✻✽·⏵]/g, '')                    // Claude spinner characters
}

// Strip box-drawing characters
function stripBox(str: string): string {
  return str.replace(/[│╭╮╰╯─┤├┐┘┌└┬┴┼╔╗╚╝║═★░▓█]/g, ' ')
}

// Clean up extracted speech text
function cleanSpeech(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')  // collapse whitespace
    .replace(/^\s+|\s+$/g, '')  // trim
}

export interface BuddyDetection {
  buddyName: string
  message: string
}

// Known buddy names to search for
const BUDDY_NAMES = ['Jostle', 'Turtle', 'Buddy', 'Companion']

/**
 * BuddyDetector works on raw PTY data chunks (not lines).
 *
 * It accumulates a rolling buffer and searches for buddy speech patterns.
 * The buddy card renders with ANSI cursor positioning, so line-by-line
 * parsing is unreliable. Instead we search the stripped buffer for:
 *
 * 1. "last said" marker followed by speech in a box-drawing bubble
 * 2. Inline speech pattern: *action text* followed by speech
 * 3. Any text near a known buddy name that looks like speech
 */
export class BuddyDetector {
  private buffer = ''
  private lastDetectionTime = 0
  private cooldownMs = 8000 // Avoid duplicate detections
  private lastMessage = '' // Dedup identical messages

  /**
   * Feed a raw PTY data chunk. Returns a detection if buddy speech is found.
   */
  detect(rawData: string): BuddyDetection | null {
    this.buffer += rawData

    // Keep buffer from growing unbounded (keep last 5KB)
    if (this.buffer.length > 5000) {
      this.buffer = this.buffer.slice(-3000)
    }

    // Strip ANSI codes and box-drawing for pattern matching
    const stripped = stripAnsi(this.buffer)
    const clean = stripBox(stripped)

    // Strategy 1: Find "last said" pattern from /buddy card
    // The speech is between the inner bubble markers after "last said"
    const lastSaidIdx = clean.lastIndexOf('last said')
    if (lastSaidIdx !== -1) {
      const afterLastSaid = clean.slice(lastSaidIdx)

      // Look for *action* speech pattern after "last said"
      const speechMatch = afterLastSaid.match(/\*([^*]+)\*\s*(.{5,}?)(?:\s{3,}|$)/)
      if (speechMatch) {
        const action = speechMatch[1].trim()
        const speech = speechMatch[2].trim()
        const fullMessage = `*${action}* ${speech}`
        return this.emitIfNew(fullMessage)
      }

      // Fallback: just grab substantial text after "last said"
      const textMatch = afterLastSaid.match(/last said\s+(.{10,}?)(?:\s{4,}|$)/)
      if (textMatch) {
        const speech = cleanSpeech(textMatch[1])
        if (speech.length > 10) {
          return this.emitIfNew(speech)
        }
      }
    }

    // Strategy 2: Inline speech — *action* pattern near a buddy name
    for (const name of BUDDY_NAMES) {
      const nameIdx = clean.lastIndexOf(name)
      if (nameIdx === -1) continue

      // Look for *action* speech within 500 chars after the name
      const vicinity = clean.slice(nameIdx, nameIdx + 500)
      const inlineMatch = vicinity.match(/\*([^*]+)\*\s*(.{5,}?)(?:\s{3,}|$)/)
      if (inlineMatch) {
        const action = inlineMatch[1].trim()
        const speech = inlineMatch[2].trim()
        const fullMessage = `*${action}* ${speech}`
        return this.emitIfNew(fullMessage, name)
      }
    }

    return null
  }

  private emitIfNew(message: string, buddyName = 'Jostle'): BuddyDetection | null {
    const now = Date.now()

    // Cooldown check
    if (now - this.lastDetectionTime < this.cooldownMs) return null

    // Dedup: don't re-emit the exact same message
    if (message === this.lastMessage) return null

    // Sanity: ignore very short or garbage messages
    if (message.length < 8) return null

    // Reject messages that are mostly non-alphabetic (ANSI garbage that slipped through)
    const alphaChars = message.replace(/[^a-zA-Z\s]/g, '').trim()
    if (alphaChars.length < 5) return null

    // Reject if it contains terminal control leftovers
    if (message.includes('[?') || message.includes('2026') || message.includes('esc to')) return null

    this.lastDetectionTime = now
    this.lastMessage = message
    this.buffer = '' // Clear buffer after successful detection

    return { buddyName, message }
  }
}
