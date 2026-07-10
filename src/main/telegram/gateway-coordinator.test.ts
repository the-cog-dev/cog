import { describe, it, expect, afterEach } from 'vitest'
import { GatewayCoordinator } from './gateway-coordinator'

// A high, unusual port so tests don't collide with a real gateway on 47600.
const TEST_PORT = 47733

const coords: GatewayCoordinator[] = []
function make(id: string, project: string) {
  const c = new GatewayCoordinator({
    followerId: id,
    project,
    port: TEST_PORT
  })
  coords.push(c)
  return c
}

afterEach(async () => {
  await Promise.all(coords.splice(0).map(c => c.stop()))
})

describe('GatewayCoordinator election', () => {
  it('first to bind is gateway, second is follower and registers', async () => {
    const a = make('a', 'PokeMMO')
    expect(await a.start()).toBe('gateway')

    const b = make('b', 'WebApp')
    expect(await b.start()).toBe('follower')

    // Give the follower's register POST a tick to land.
    await new Promise(r => setTimeout(r, 100))

    const projects = a.router.list().map(c => c.project).sort()
    expect(projects).toEqual(['PokeMMO', 'WebApp'])
    // Gateway sees its own project as self, the follower as remote.
    expect(a.router.get('a')?.isSelf).toBe(true)
    expect(a.router.get('b')?.isSelf).toBe(false)
    // Follower registered its ephemeral loopback callback server.
    expect(a.router.get('b')?.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('gateway routes an inbound message to the right follower via its callback', async () => {
    const a = make('a', 'PokeMMO')
    await a.start()
    let delivered: { chatId: number; text: string } | null = null
    const b = new GatewayCoordinator({
      followerId: 'b', project: 'WebApp', port: TEST_PORT,
      hooks: {
        deliverLocal: (chatId, text) => { delivered = { chatId, text }; return { ok: true } },
        listLocalTargets: () => [{ name: 'Max', role: 'orchestrator', status: 'active' }]
      }
    })
    coords.push(b)
    await b.start()
    await new Promise(r => setTimeout(r, 100))

    // From the gateway, address WebApp then route a message to it.
    expect(a.setActiveByProject(1, 'WebApp')?.project).toBe('WebApp')
    const res = await a.routeInbound(1, 'ship it')
    expect(res.ok).toBe(true)
    expect(res.project).toBe('WebApp')
    await new Promise(r => setTimeout(r, 50))
    expect(delivered).toEqual({ chatId: 1, text: 'ship it' })
  })

  it('a lone instance is simply the gateway (single-instance = unchanged)', async () => {
    const a = make('solo', 'OnlyProject')
    expect(await a.start()).toBe('gateway')
    expect(a.router.list().map(c => c.project)).toEqual(['OnlyProject'])
  })
})
