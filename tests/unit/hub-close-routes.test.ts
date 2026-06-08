import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRoutes, type AgentBridge } from '../../src/main/hub/routes'

function makeApp(opts: {
  requester: any
  session: boolean
  agentBridge?: AgentBridge
  inbox?: any
}) {
  const registry = { get: (name: string) => (name === 'MainGuy' ? opts.requester : null) }
  const app = express()
  app.use(express.json())
  app.use(createRoutes(
    registry as any,            // registry
    {} as any,                  // messages
    { accessor: null },         // outputRef
    {} as any,                  // pinboard
    {} as any,                  // infoChannel
    { store: null },            // messageStoreRef
    { path: null },             // projectPathRef
    undefined,                  // groupManager
    (opts.inbox ?? { postMessage: vi.fn() }) as any, // inboxChannel
    undefined,                  // proposalsChannel
    () => ({ autonomyEnabled: () => opts.session } as any), // getScheduleBridge
    undefined,                  // getBoardBridge
    () => opts.agentBridge      // getAgentBridge
  ))
  return app
}

const ORCH = { id: 'o1', name: 'MainGuy', role: 'orchestrator', tabId: 'tab-default' }

describe('POST /agents/close', () => {
  it('403 when requester is not an orchestrator', async () => {
    const app = makeApp({ requester: { ...ORCH, role: 'worker' }, session: true, agentBridge: { close: vi.fn(() => ({ ok: true })) } })
    const res = await request(app).post('/agents/close').send({ requestedBy: 'MainGuy', targets: ['W1'] })
    expect(res.status).toBe(403)
  })

  it('403 when no autonomous session is active', async () => {
    const close = vi.fn(() => ({ ok: true }))
    const app = makeApp({ requester: ORCH, session: false, agentBridge: { close } })
    const res = await request(app).post('/agents/close').send({ requestedBy: 'MainGuy', targets: ['W1'] })
    expect(res.status).toBe(403)
    expect(close).not.toHaveBeenCalled()
  })

  it('blocks self, closes others, posts one urgent inbox summary', async () => {
    const close = vi.fn((n: string) => ({ ok: n !== 'Ghost' }))
    const inbox = { postMessage: vi.fn() }
    const app = makeApp({ requester: ORCH, session: true, agentBridge: { close }, inbox })
    const res = await request(app).post('/agents/close')
      .send({ requestedBy: 'MainGuy', targets: ['MainGuy', 'Worker', 'Ghost'] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ closed: ['Worker'], blocked: ['MainGuy'], notFound: ['Ghost'] })
    expect(close).toHaveBeenCalledWith('Worker')
    expect(close).not.toHaveBeenCalledWith('MainGuy')
    expect(inbox.postMessage).toHaveBeenCalledTimes(1)
    expect(inbox.postMessage.mock.calls[0][3]).toBe('urgent')
  })

  it('400 when targets is empty', async () => {
    const app = makeApp({ requester: ORCH, session: true, agentBridge: { close: vi.fn() } })
    const res = await request(app).post('/agents/close').send({ requestedBy: 'MainGuy', targets: [] })
    expect(res.status).toBe(400)
  })

  it('400 when requestedBy is missing', async () => {
    const app = makeApp({ requester: ORCH, session: true, agentBridge: { close: vi.fn() } })
    const res = await request(app).post('/agents/close').send({ targets: ['W1'] })
    expect(res.status).toBe(400)
  })

  it('503 when no agent bridge is wired', async () => {
    const app = makeApp({ requester: ORCH, session: true, agentBridge: undefined })
    const res = await request(app).post('/agents/close').send({ requestedBy: 'MainGuy', targets: ['W1'] })
    expect(res.status).toBe(503)
  })
})
