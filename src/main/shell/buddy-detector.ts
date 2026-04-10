// Strip ANSI escape codes and terminal control sequences from output
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // CSI sequences (including ?2026h/l)
    .replace(/\x1b\][^\x07]*\x07/g, '')         // OSC sequences
    .replace(/\x1b\[[\d;]*m/g, '')              // SGR color codes
    .replace(/\x1b[()][A-Z0-9]/g, '')           // Character set selection
    .replace(/[\x00-\x08\x0e-\x1f]/g, '')       // Control characters
    .replace(/[✢✶✻✽·⏵●↑↓⎿▸▹◆◇⬡⬢⧫⟐]/g, '')     // Claude spinner/UI characters
}

// Strip box-drawing characters
function stripBox(str: string): string {
  return str.replace(/[│╭╮╰╯─┤├┐┘┌└┬┴┼╔╗╚╝║═★░▓█]/g, ' ')
}

export interface BuddyDetection {
  buddyName: string
  message: string
}

// Known buddy names to search for
const BUDDY_NAMES = ['Jostle', 'Turtle', 'Buddy', 'Companion']

// Patterns that should NEVER appear in buddy messages — these are TUI noise
const REJECT_PATTERNS = [
  'thinking with',          // Claude thinking indicator
  'high effort',            // thinking effort level
  'low effort',
  'medium effort',
  'MCP',                    // MCP tool output
  'agentorch',              // AgentOrch tool names
  'Claude Code has',        // CLI system messages
  'weekly limit',           // Usage stats
  'installer',              // Update messages
  'npm to native',          // Migration prompts
  'resets ',                // "resets 3pm" usage messages
  'tokens)',                // "(960 tokens)" counter
  'Running…',               // MCP tool "Running..." status
  'esc to',                 // Terminal hints
  '[?',                     // ANSI leftovers
  '2026',                   // Year or ANSI mode sequences
]

/**
 * BuddyDetector works on raw PTY data chunks.
 *
 * It accumulates a rolling buffer and searches for buddy speech patterns.
 * The buddy card renders with ANSI cursor positioning, so line-by-line
 * parsing is unreliable. Instead we search the stripped buffer for the
 * "last said" marker followed by speech in a box-drawing bubble.
 *
 * AGGRESSIVE FILTERING: Claude Code's TUI now includes many elements
 * that look like text (thinking indicators, spinner frames, MCP status,
 * token counters) but are NOT buddy speech. We reject anything matching
 * known noise patterns and deduplicate repeated spinner words.
 */
export class BuddyDetector {
  private buffer = ''
  private lastDetectionTime = 0
  private cooldownMs = 3000  // Reduced from 8s — buddy messages change frequently
  private lastMessage = ''

  detect(rawData: string): BuddyDetection | null {
    this.buffer += rawData

    // Keep buffer bounded (last 5KB)
    if (this.buffer.length > 5000) {
      this.buffer = this.buffer.slice(-3000)
    }

    const stripped = stripAnsi(this.buffer)
    const clean = stripBox(stripped)

    // Find buddy name anywhere in the buffer
    let detectedName = 'Jostle'
    for (const name of BUDDY_NAMES) {
      if (clean.includes(name)) {
        detectedName = name
        break
      }
    }

    // Strategy 1: Find "last said" pattern (most reliable)
    const lastSaidIdx = clean.lastIndexOf('last said')
    if (lastSaidIdx !== -1) {
      const result = this.extractFromLastSaid(clean, lastSaidIdx, detectedName)
      if (result) return result
    }

    // Strategy 2: Find *ActionWord…* pattern near a buddy name (fallback)
    // This catches buddy speech even when "last said" has been overwritten
    for (const name of BUDDY_NAMES) {
      const nameIdx = clean.lastIndexOf(name)
      if (nameIdx === -1) continue
      const vicinity = clean.slice(nameIdx, nameIdx + 600)
      const result = this.extractActionSpeech(vicinity, name)
      if (result) return result
    }

    return null
  }

  private extractFromLastSaid(clean: string, lastSaidIdx: number, detectedName: string): BuddyDetection | null {
    const afterLastSaid = clean.slice(lastSaidIdx + 9)

    // Extract the action word (gerund ending in … or ...)
    // Buddy actions are single words like: *Scurrying…* *Unfurling…* *Zesting…* *Leavening…*
    const actionMatch = afterLastSaid.match(/\*([A-Z][a-z]+(?:ing|ling|ning|ring)(?:…|\.\.\.))\*/)
    if (!actionMatch) return null

    const actionWord = actionMatch[1]
    const afterAction = afterLastSaid.slice(afterLastSaid.indexOf(actionMatch[0]) + actionMatch[0].length)

    // Extract the speech text after the action
    // Take text until we hit 3+ spaces, end of content, or another * marker
    const speechMatch = afterAction.match(/\s*([^*]{5,}?)(?:\s{3,}|$)/)
    if (!speechMatch) {
      // Just the action word, no speech text — still valid
      return this.emitIfNew(`*${actionWord}*`, detectedName)
    }

    let speech = speechMatch[1].trim()

    // Clean up the speech: remove repeated spinner words that leaked in
    speech = deduplicateSpinnerWords(speech, actionWord)

    // Remove isolated numbers (counter artifacts: "51", "40", etc.)
    speech = speech.replace(/\b\d{1,4}\b/g, '').replace(/\s+/g, ' ').trim()

    // If speech is empty after cleanup, just use the action word
    if (speech.length < 3) {
      return this.emitIfNew(`*${actionWord}*`, detectedName)
    }

    const fullMessage = `*${actionWord}* ${speech}`
    return this.emitIfNew(fullMessage, detectedName)
  }

  /**
   * Fallback: extract buddy speech from *ActionWord…* pattern near a buddy name.
   * Used when "last said" marker has been overwritten by TUI cursor positioning.
   */
  private extractActionSpeech(vicinity: string, buddyName: string): BuddyDetection | null {
    const actionMatch = vicinity.match(/\*([A-Z][a-z]+(?:ing|ling|ning|ring)(?:…|\.\.\.))\*/)
    if (!actionMatch) return null

    const actionWord = actionMatch[1]
    const afterAction = vicinity.slice(vicinity.indexOf(actionMatch[0]) + actionMatch[0].length)

    const speechMatch = afterAction.match(/\s*([^*]{5,}?)(?:\s{3,}|$)/)
    if (!speechMatch) {
      return this.emitIfNew(`*${actionWord}*`, buddyName)
    }

    let speech = speechMatch[1].trim()
    speech = deduplicateSpinnerWords(speech, actionWord)
    speech = speech.replace(/\b\d{1,4}\b/g, '').replace(/\s+/g, ' ').trim()

    if (speech.length < 3) {
      return this.emitIfNew(`*${actionWord}*`, buddyName)
    }

    return this.emitIfNew(`*${actionWord}* ${speech}`, buddyName)
  }

  private emitIfNew(message: string, buddyName: string): BuddyDetection | null {
    const now = Date.now()

    // Cooldown
    if (now - this.lastDetectionTime < this.cooldownMs) return null

    // Dedup exact match
    if (message === this.lastMessage) return null

    // Minimum length
    if (message.length < 8) return null

    // Reject messages containing known noise patterns
    const lower = message.toLowerCase()
    for (const pattern of REJECT_PATTERNS) {
      if (lower.includes(pattern.toLowerCase())) return null
    }

    // Reject if mostly non-alphabetic (ANSI garbage)
    const alphaChars = message.replace(/[^a-zA-Z\s]/g, '').trim()
    if (alphaChars.length < 5) return null

    // Reject if the message is just the action word repeated
    const actionMatch = message.match(/\*([^*]+)\*\s*(.*)/)
    if (actionMatch) {
      const actionBase = actionMatch[1].replace(/…|\.{3}/g, '').trim()
      const speechPart = actionMatch[2] || ''
      // If speech is just the action word again (or fragments of it), reject
      const speechWithout = speechPart.replace(new RegExp(actionBase, 'gi'), '').replace(/…|\.{3}/g, '').trim()
      if (speechPart.length > 0 && speechWithout.length < 3) return null
    }

    this.lastDetectionTime = now
    this.lastMessage = message
    this.buffer = ''

    return { buddyName, message }
  }
}

/**
 * Remove repeated spinner/action words from speech text.
 * The PTY buffer accumulates multiple animation frames, so
 * "Unfurling…Unfurling…Unfurling… actual speech" needs to become
 * just "actual speech".
 */
function deduplicateSpinnerWords(speech: string, actionWord: string): string {
  // Remove all instances of the action word (with or without ellipsis)
  const baseWord = actionWord.replace(/…|\.{3}/g, '')
  const cleaned = speech
    .replace(new RegExp(`${baseWord}(?:…|\\.{3})?`, 'gi'), '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned
}
