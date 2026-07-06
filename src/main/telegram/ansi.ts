/**
 * Strip ANSI/VT escape sequences and cursor-control noise from raw PTY output
 * so it reads as plain text in a Telegram message. The OutputBuffer stores
 * terminal bytes verbatim (CLI agents like Claude Code emit heavy CSI/OSC
 * traffic); every display surface strips before rendering — Remote View does
 * this in the browser, this is the main-process equivalent for the bot.
 */

// CSI: ESC [ params… intermediates… final   (colors, cursor moves, erases)
const CSI = /\x1b\[[0-9:;<=>?]*[ !"#$%&'()*+,\-./]*[@-~]/g
// OSC: ESC ] … BEL | ESC \                  (window titles, hyperlinks)
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
// Charset designation and other two-byte escapes: ESC ( B, ESC = , ESC 7 …
const TWO_BYTE = /\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_=><~]/g
// Remaining C0 control chars except \n and \t (kills \r, backspace, BEL…)
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

export function stripAnsi(text: string): string {
  return text.replace(CSI, '').replace(OSC, '').replace(TWO_BYTE, '').replace(CONTROL, '')
}
