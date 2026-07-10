import { describe, it, expect } from 'vitest'
import {
  answerCallback,
  parseAnswerCallback,
  clipChoiceLabel,
  formatAnswered
} from './question-format'

describe('question-format', () => {
  it('round-trips a callback payload', () => {
    const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    const data = answerCallback(id, 2)
    expect(data).toBe(`ask:${id}:2`)
    expect(parseAnswerCallback(data)).toEqual({ messageId: id, choiceIndex: 2 })
  })

  it('stays under the 64-byte callback_data limit for a UUID id', () => {
    const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' // 36 chars
    expect(answerCallback(id, 9).length).toBeLessThanOrEqual(64)
  })

  it('rejects payloads that are not ours', () => {
    expect(parseAnswerCallback('prop:approve:xyz')).toBeNull()
    expect(parseAnswerCallback('ask:missing-index')).toBeNull()
    expect(parseAnswerCallback('ask:id:notanumber')).toBeNull()
  })

  it('clips long choice labels', () => {
    expect(clipChoiceLabel('short')).toBe('short')
    const long = 'x'.repeat(80)
    const clipped = clipChoiceLabel(long)
    expect(clipped.length).toBeLessThanOrEqual(60)
    expect(clipped.endsWith('…')).toBe(true)
  })

  it('formats the answered state without buttons', () => {
    expect(formatAnswered('Deploy now?', 'Yes')).toContain('✅ You chose: Yes')
    expect(formatAnswered('Deploy now?', 'Yes')).toContain('❓ Deploy now?')
  })
})
