/**
 * Pure encode/parse for Telegram inline-answer buttons. No grammY, no hub — just
 * the callback-data round-trip so the button wiring is unit-testable (mirrors
 * proposal-format.ts). The keyboard itself is built in telegram-server.ts.
 *
 * An "answerable" inbox message carries a `choices[]`; each choice becomes a
 * button whose callback payload is  ask:<messageId>:<choiceIndex>. Only the index
 * travels in the payload, so choice text can be anything (no escaping needed) and
 * we stay well under Telegram's 64-byte callback_data limit.
 */

/** Telegram inline-button labels are capped at 64 chars; clip with an ellipsis. */
export function clipChoiceLabel(choice: string): string {
  const c = choice.trim()
  return c.length > 60 ? c.slice(0, 59) + '…' : c
}

/** Encode a choice button's callback payload: ask:<messageId>:<choiceIndex>. */
export function answerCallback(messageId: string, choiceIndex: number): string {
  return `ask:${messageId}:${choiceIndex}`
}

/** Parse a callback payload back into (messageId, choiceIndex), or null if not ours. */
export function parseAnswerCallback(data: string): { messageId: string; choiceIndex: number } | null {
  // messageId is a UUID (no colons); the trailing group is the numeric index.
  const m = /^ask:(.+):(\d+)$/.exec(data)
  if (!m) return null
  const choiceIndex = parseInt(m[2], 10)
  return Number.isNaN(choiceIndex) ? null : { messageId: m[1], choiceIndex }
}

/** The message body once a choice is tapped — buttons removed, selection shown. */
export function formatAnswered(question: string, choice: string): string {
  const q = question.length > 300 ? question.slice(0, 299) + '…' : question
  return `❓ ${q}\n\n✅ You chose: ${choice}`
}
