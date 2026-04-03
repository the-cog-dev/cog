// Strip ANSI escape codes from terminal output
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

// Strip box-drawing characters and clean up speech bubble text
function stripBoxChars(str: string): string {
  return str.replace(/[│╭╮╰╯─┤├┐┘┌└┬┴┼╔╗╚╝║═]/g, '').trim()
}

export interface BuddyDetection {
  buddyName: string
  message: string
}

// Jostle's speech bubble format in terminal output:
// │  ╭────────────────────────────────╮  │
// │  │ *spins excitedly* Waiting for  │  │
// │  │ bugs like a turtle waits for   │  │
// │  │ lettuce. Zzzzzzz.              │  │
// │  ╰────────────────────────────────╯  │
//
// Detection strategy:
// 1. Detect "Jostle" name line → mark that a buddy card is active
// 2. Detect speech bubble open (╭──) → start capturing
// 3. Capture lines inside the bubble (between │ markers)
// 4. Detect speech bubble close (╰──) → emit the captured speech

type CaptureState = 'idle' | 'saw_name' | 'capturing'

export class BuddyDetector {
  private state: CaptureState = 'idle'
  private capturedLines: string[] = []
  private currentBuddyName = ''
  private lastDetectionTime = 0
  private cooldownMs = 5000 // Avoid duplicate detections
  private nameTimeout: ReturnType<typeof setTimeout> | null = null

  detectLine(rawLine: string): BuddyDetection | null {
    const stripped = stripAnsi(rawLine)
    const clean = stripBoxChars(stripped)

    // Detect buddy name (e.g., "Jostle", "Buddy", companion names)
    if (this.state === 'idle') {
      const nameMatch = clean.match(/^\s*(Jostle|Turtle|Buddy|Companion)\s*$/i)
      if (nameMatch) {
        this.state = 'saw_name'
        this.currentBuddyName = nameMatch[1]
        // Reset if we don't see a speech bubble within 20 lines
        if (this.nameTimeout) clearTimeout(this.nameTimeout)
        this.nameTimeout = setTimeout(() => {
          if (this.state === 'saw_name') {
            this.state = 'idle'
            this.currentBuddyName = ''
          }
        }, 5000)
        return null
      }
    }

    // After seeing the name, look for "last said" or speech bubble open
    if (this.state === 'saw_name') {
      // Detect speech bubble opening: line contains ╭ followed by ─
      if (stripped.includes('\u256D') && stripped.includes('\u2500')) {
        this.state = 'capturing'
        this.capturedLines = []
        return null
      }
      // Also detect "last said" as a marker
      if (clean.toLowerCase().includes('last said')) {
        // Keep waiting for the bubble
        return null
      }
    }

    // Capturing speech bubble content
    if (this.state === 'capturing') {
      // Detect speech bubble closing: line contains ╰ followed by ─
      if (stripped.includes('\u2570') && stripped.includes('\u2500')) {
        this.state = 'idle'
        if (this.nameTimeout) { clearTimeout(this.nameTimeout); this.nameTimeout = null }

        const speech = this.capturedLines
          .map(l => stripBoxChars(l))
          .filter(l => l.length > 0)
          .join(' ')
          .trim()

        if (!speech) return null

        const now = Date.now()
        if (now - this.lastDetectionTime < this.cooldownMs) return null
        this.lastDetectionTime = now

        return { buddyName: this.currentBuddyName, message: speech }
      }

      // Accumulate content lines (inside the bubble)
      this.capturedLines.push(clean)
      return null
    }

    return null
  }
}
