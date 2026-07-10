import { describe, it, expect } from 'vitest'
import { FederationRouter, type RegisteredCog } from './federation-router'

const cog = (id: string, project: string, isSelf = false, lastSeen = 0): RegisteredCog =>
  ({ id, project, isSelf, lastSeen, callbackUrl: isSelf ? undefined : `http://127.0.0.1/${id}` })

describe('FederationRouter', () => {
  it('registers and lists cogs idempotently', () => {
    const r = new FederationRouter()
    r.register(cog('self', 'PokeMMO', true))
    r.register(cog('f1', 'WebApp'))
    r.register(cog('f1', 'WebApp')) // idempotent by id
    expect(r.list().map(c => c.project).sort()).toEqual(['PokeMMO', 'WebApp'])
  })

  it('defaults to self, then falls back when self is gone', () => {
    const r = new FederationRouter()
    r.register(cog('f1', 'WebApp'))
    r.register(cog('self', 'PokeMMO', true))
    expect(r.resolveActive(1)?.project).toBe('PokeMMO') // self preferred
    r.deregister('self')
    expect(r.resolveActive(1)?.project).toBe('WebApp')  // fallback
  })

  it('pins an active cog per chat and only if it exists', () => {
    const r = new FederationRouter()
    r.register(cog('self', 'PokeMMO', true))
    r.register(cog('f1', 'WebApp'))
    expect(r.setActive(1, 'f1')).toBe(true)
    expect(r.resolveActive(1)?.project).toBe('WebApp')
    expect(r.resolveActive(2)?.project).toBe('PokeMMO') // other chat still default
    expect(r.setActive(1, 'ghost')).toBe(false)         // unknown cog rejected
  })

  it('drops the pin when its cog deregisters', () => {
    const r = new FederationRouter()
    r.register(cog('self', 'PokeMMO', true))
    r.register(cog('f1', 'WebApp'))
    r.setActive(1, 'f1')
    r.deregister('f1')
    expect(r.resolveActive(1)?.project).toBe('PokeMMO') // fell back to default
  })

  it('resolves a project by exact or unique-prefix, rejecting ambiguity', () => {
    const r = new FederationRouter()
    r.register(cog('self', 'PokeMMO', true))
    r.register(cog('f1', 'WebApp'))
    r.register(cog('f2', 'WebSocketSvc'))
    expect(r.resolveByProject('pokemmo')?.id).toBe('self')   // exact, case-insensitive
    expect(r.resolveByProject('WebA')?.id).toBe('f1')        // unique prefix
    expect(r.resolveByProject('Web')).toBeNull()             // ambiguous prefix
    expect(r.resolveByProject('nope')).toBeNull()
  })

  it('prunes stale followers by heartbeat but never self', () => {
    const r = new FederationRouter()
    r.register(cog('self', 'PokeMMO', true, 0))
    r.register(cog('f1', 'WebApp', false, 1000))
    r.touch('f1', 5000)
    expect(r.prune(6000, 2000)).toEqual([]) // f1 fresh (seen at 5000)
    expect(r.prune(8000, 2000)).toEqual(['f1']) // f1 stale (>2s since 5000)
    expect(r.list().map(c => c.id)).toEqual(['self']) // self survives
  })
})
