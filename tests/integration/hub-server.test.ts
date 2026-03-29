import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHubServer, HubServer } from '../../src/main/hub/server'

let hub: HubServer

beforeAll(async () => {
  hub = await createHubServer()
})

afterAll(() => {
  hub.close()
})

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${hub.secret}`,
      ...opts.headers
    }
  })
  return { status: res.status, body: await res.json() }
}

describe('Hub HTTP Server', () => {
  it('rejects requests without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${hub.port}/agents`, {
      headers: { 'Content-Type': 'application/json' }
    })
    expect(res.status).toBe(401)
  })

  it('registers an agent and lists it', async () => {
    const reg = await api('/agents/register', {
      method: 'POST',
      body: JSON.stringify({
        id: 'a1', name: 'orchestrator', cli: 'claude',
        cwd: '/tmp', role: 'Coordinator', ceoNotes: 'You lead.', shell: 'powershell', admin: false, autoMode: false
      })
    })
    expect(reg.status).toBe(200)
    expect(reg.body.name).toBe('orchestrator')

    const list = await api('/agents')
    expect(list.body).toHaveLength(1)
    expect(list.body[0].name).toBe('orchestrator')
  })

  it('sends and retrieves messages', async () => {
    await api('/agents/register', {
      method: 'POST',
      body: JSON.stringify({
        id: 'a2', name: 'worker-1', cli: 'claude',
        cwd: '/tmp', role: 'Worker', ceoNotes: 'Do tasks.', shell: 'powershell', admin: false, autoMode: false
      })
    })

    const send = await api('/messages/send', {
      method: 'POST',
      body: JSON.stringify({ from: 'orchestrator', to: 'worker-1', message: 'do the thing' })
    })
    expect(send.body.status).toBe('delivered')

    const get = await api('/messages/worker-1')
    expect(get.body).toHaveLength(1)
    expect(get.body[0].message).toBe('do the thing')

    const get2 = await api('/messages/worker-1')
    expect(get2.body).toHaveLength(0)
  })

  it('returns CEO notes for an agent', async () => {
    const notes = await api('/agents/orchestrator/ceo-notes')
    expect(notes.body.ceoNotes).toBe('You lead.')
  })
})
