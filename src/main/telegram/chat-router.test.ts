import { describe, it, expect } from 'vitest'
import { ChatRouter } from './chat-router'
import type { TelegramTarget } from './bridge'

const t = (name: string, role = 'worker', status = 'idle'): TelegramTarget => ({ name, role, status })

describe('ChatRouter', () => {
  it('subscribes chats idempotently and lists them', () => {
    const r = new ChatRouter()
    expect(r.isSubscribed(1)).toBe(false)
    r.subscribe(1)
    r.subscribe(1)
    r.subscribe(2)
    expect(r.isSubscribed(1)).toBe(true)
    expect(r.subscribedChats().sort()).toEqual([1, 2])
  })

  it('forgets a chat completely', () => {
    const r = new ChatRouter()
    r.subscribe(1)
    r.setActive(1, 'cara')
    r.forget(1)
    expect(r.isSubscribed(1)).toBe(false)
    expect(r.getActive(1)).toBeNull()
  })

  it('resolves an exact name case-insensitively', () => {
    const r = new ChatRouter()
    const targets = [t('Cara', 'orchestrator'), t('Dax', 'orchestrator')]
    expect(r.resolveTarget('cara', targets)?.name).toBe('Cara')
    expect(r.resolveTarget('DAX', targets)?.name).toBe('Dax')
  })

  it('resolves a unique prefix but rejects an ambiguous one', () => {
    const r = new ChatRouter()
    const targets = [t('Cara', 'orchestrator'), t('Carl', 'worker'), t('Dax', 'orchestrator')]
    expect(r.resolveTarget('d', targets)?.name).toBe('Dax')   // unique prefix
    expect(r.resolveTarget('car', targets)).toBeNull()         // Cara vs Carl — ambiguous
    expect(r.resolveTarget('zzz', targets)).toBeNull()         // no match
  })

  it('prefers a live orchestrator as the default target', () => {
    const r = new ChatRouter()
    const targets = [
      t('Wendy', 'worker', 'active'),
      t('Cara', 'orchestrator', 'disconnected'),
      t('Dax', 'orchestrator', 'idle')
    ]
    expect(r.pickDefault(targets)?.name).toBe('Dax')
  })

  it('falls back to any orchestrator, then any live agent', () => {
    const r = new ChatRouter()
    expect(r.pickDefault([t('Cara', 'orchestrator', 'disconnected'), t('Wendy', 'worker', 'active')])?.name)
      .toBe('Cara')  // disconnected orchestrator still beats a worker
    expect(r.pickDefault([t('A', 'worker', 'disconnected'), t('B', 'worker', 'idle')])?.name)
      .toBe('B')     // no orchestrator → first live agent
    expect(r.pickDefault([])).toBeNull()
  })

  it('uses the remembered active target when it is still present', () => {
    const r = new ChatRouter()
    const targets = [t('Cara', 'orchestrator'), t('Dax', 'orchestrator')]
    r.setActive(99, 'Dax')
    expect(r.effectiveTarget(99, targets)?.name).toBe('Dax')
  })

  it('falls back to the default when the remembered target vanished', () => {
    const r = new ChatRouter()
    r.setActive(99, 'Ghost')
    const targets = [t('Cara', 'orchestrator', 'idle')]
    expect(r.effectiveTarget(99, targets)?.name).toBe('Cara')
  })

  it('returns null effective target when there are no targets', () => {
    const r = new ChatRouter()
    expect(r.effectiveTarget(1, [])).toBeNull()
  })
})
