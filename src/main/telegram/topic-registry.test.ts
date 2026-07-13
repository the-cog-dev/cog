import { describe, it, expect } from 'vitest'
import { TopicRegistry } from './topic-registry'

describe('TopicRegistry', () => {
  it('maps a workspace to a thread and back', () => {
    const r = new TopicRegistry()
    r.set('ws1', 42, 'Alpha')
    expect(r.threadFor('ws1')).toBe(42)
    expect(r.workspaceFor(42)).toBe('ws1')
    expect(r.nameFor('ws1')).toBe('Alpha')
    expect(r.has('ws1')).toBe(true)
  })

  it('returns undefined for unknown ids', () => {
    const r = new TopicRegistry()
    expect(r.threadFor('nope')).toBeUndefined()
    expect(r.workspaceFor(999)).toBeUndefined()
  })

  it('rename updates the name, keeps the thread', () => {
    const r = new TopicRegistry()
    r.set('ws1', 42, 'Alpha')
    expect(r.rename('ws1', 'Beta')).toBe(true)
    expect(r.nameFor('ws1')).toBe('Beta')
    expect(r.threadFor('ws1')).toBe(42)
    expect(r.rename('ghost', 'X')).toBe(false)
  })

  it('remove drops both directions', () => {
    const r = new TopicRegistry()
    r.set('ws1', 42, 'Alpha')
    r.remove('ws1')
    expect(r.threadFor('ws1')).toBeUndefined()
    expect(r.workspaceFor(42)).toBeUndefined()
  })

  it('hydrates from an initial snapshot and round-trips', () => {
    const initial = { ws1: { threadId: 42, name: 'Alpha' } }
    const r = new TopicRegistry(initial)
    expect(r.threadFor('ws1')).toBe(42)
    expect(r.snapshot()).toEqual(initial)
  })

  it('fires onChange with the full snapshot on every mutation', () => {
    const seen: Record<string, unknown>[] = []
    const r = new TopicRegistry({}, (m) => seen.push(m))
    r.set('ws1', 42, 'Alpha')
    r.rename('ws1', 'Beta')
    r.remove('ws1')
    expect(seen).toHaveLength(3)
    expect(seen[0]).toEqual({ ws1: { threadId: 42, name: 'Alpha' } })
    expect(seen[2]).toEqual({})
  })
})
