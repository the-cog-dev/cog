import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { TokenManager } from '../../src/main/remote/token-manager'
import { RemoteServer, type RemoteServerDeps } from '../../src/main/remote/remote-server'

function makeDeps(overrides: Partial<RemoteServerDeps> = {}): RemoteServerDeps {
  return {
    tokenManager: new TokenManager(() => 1_000_000),
    getProjectName: () => 'TestProject',
    getAgents: () => [],
    getSchedules: () => [],
    getPinboardTasks: () => [],
    getBuddyRoom: () => [],
    getAgentOutput: () => [],
    sendMessage: vi.fn(),
    pauseSchedule: vi.fn(),
    resumeSchedule: vi.fn(),
    restartSchedule: vi.fn(),
    postTask: vi.fn(),
    ...overrides
  }
}

describe('RemoteServer auth middleware', () => {
  it('returns 404 when token is missing or invalid', async () => {
    const deps = makeDeps()
    const server = new RemoteServer(deps)
    const app = server.getApp()

    await request(app).get('/r/wrong-token/state').expect(404)
    await request(app).get('/r//state').expect(404)
  })

  it('returns 200 when token is valid', async () => {
    const deps = makeDeps()
    const token = deps.tokenManager.generate()
    const server = new RemoteServer(deps)
    const app = server.getApp()

    const res = await request(app).get(`/r/${token}/state`)
    expect(res.status).toBe(200)
  })

  it('returns 404 when token has expired', async () => {
    let now = 1_000_000
    const tm = new TokenManager(() => now)
    const token = tm.generate()
    const deps = makeDeps({ tokenManager: tm })
    const server = new RemoteServer(deps)
    const app = server.getApp()

    now += 9 * 60 * 60 * 1000  // 9 hours
    await request(app).get(`/r/${token}/state`).expect(404)
  })

  it('valid request bumps token activity', async () => {
    const deps = makeDeps()
    const token = deps.tokenManager.generate()
    const server = new RemoteServer(deps)
    const bumpSpy = vi.spyOn(deps.tokenManager, 'bumpActivity')
    await request(server.getApp()).get(`/r/${token}/state`).expect(200)
    expect(bumpSpy).toHaveBeenCalled()
  })

  it('valid request tracks the session by IP', async () => {
    const deps = makeDeps()
    const token = deps.tokenManager.generate()
    const server = new RemoteServer(deps)
    const trackSpy = vi.spyOn(deps.tokenManager, 'trackSession')
    await request(server.getApp()).get(`/r/${token}/state`).expect(200)
    expect(trackSpy).toHaveBeenCalled()
  })
})

describe('RemoteServer GET /r/:token/', () => {
  it('serves the static index.html with the token embedded', async () => {
    const deps = makeDeps()
    const token = deps.tokenManager.generate()
    const server = new RemoteServer(deps)
    const res = await request(server.getApp()).get(`/r/${token}/`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.text).toContain('AgentOrch Remote')
    expect(res.text).toContain(token)
  })
})

describe('RemoteServer GET /state', () => {
  it('returns project name and lists from injected getters', async () => {
    const deps = makeDeps({
      getProjectName: () => 'MyDecomp',
      getAgents: () => [
        { id: 'a1', name: 'Orchestrator', cli: 'claude', model: 'sonnet', role: 'orchestrator', status: 'working' }
      ],
      getSchedules: () => [
        { id: 's1', name: 'Keep going', agentName: 'Orchestrator', intervalMinutes: 45, durationHours: 8, nextFireAt: 2_000_000, expiresAt: 30_000_000, status: 'active' }
      ],
      getPinboardTasks: () => [
        { id: 't1', title: 'Fix bug', priority: 'high', status: 'open', claimedBy: null }
      ],
      getBuddyRoom: () => [
        { timestamp: '2026-04-08T12:00:00Z', agentName: 'Worker1', message: 'Done' }
      ]
    })
    const token = deps.tokenManager.generate()
    const server = new RemoteServer(deps)
    const res = await request(server.getApp()).get(`/r/${token}/state`).expect(200)

    expect(res.body.projectName).toBe('MyDecomp')
    expect(res.body.agents).toHaveLength(1)
    expect(res.body.agents[0].name).toBe('Orchestrator')
    expect(res.body.schedules).toHaveLength(1)
    expect(res.body.pinboardTasks).toHaveLength(1)
    expect(res.body.buddyRoom).toHaveLength(1)
    expect(typeof res.body.connectionCount).toBe('number')
    expect(typeof res.body.serverTime).toBe('number')
  })

  it('connectionCount reflects active sessions', async () => {
    const deps = makeDeps()
    const token = deps.tokenManager.generate()
    const server = new RemoteServer(deps)
    await request(server.getApp()).get(`/r/${token}/state`).expect(200)
    const res = await request(server.getApp()).get(`/r/${token}/state`).expect(200)
    expect(res.body.connectionCount).toBeGreaterThanOrEqual(1)
  })
})

describe('RemoteServer GET /agent/:id/output', () => {
  it('returns the last 50 lines of an agent output', async () => {
    const deps = makeDeps({
      getAgentOutput: (id: string) => {
        if (id === 'a1') return ['line1', 'line2', 'line3']
        return []
      }
    })
    const token = deps.tokenManager.generate()
    const server = new RemoteServer(deps)
    const res = await request(server.getApp()).get(`/r/${token}/agent/a1/output`).expect(200)
    expect(res.body.lines).toEqual(['line1', 'line2', 'line3'])
  })

  it('returns empty array for unknown agent', async () => {
    const deps = makeDeps({ getAgentOutput: () => [] })
    const token = deps.tokenManager.generate()
    const server = new RemoteServer(deps)
    const res = await request(server.getApp()).get(`/r/${token}/agent/unknown/output`).expect(200)
    expect(res.body.lines).toEqual([])
  })
})

describe('RemoteServer POST /message', () => {
  it('calls deps.sendMessage with to and text', async () => {
    const sendMessage = vi.fn()
    const deps = makeDeps({ sendMessage })
    const token = deps.tokenManager.generate()
    const server = new RemoteServer(deps)
    const res = await request(server.getApp())
      .post(`/r/${token}/message`)
      .send({ to: 'Orchestrator', text: 'keep going' })
      .expect(200)
    expect(res.body).toEqual({ ok: true })
    expect(sendMessage).toHaveBeenCalledWith('Orchestrator', 'keep going')
  })

  it('returns 400 on missing fields', async () => {
    const deps = makeDeps()
    const token = deps.tokenManager.generate()
    const server = new RemoteServer(deps)
    await request(server.getApp())
      .post(`/r/${token}/message`)
      .send({ to: 'Orchestrator' })
      .expect(400)
    await request(server.getApp())
      .post(`/r/${token}/message`)
      .send({ text: 'hi' })
      .expect(400)
  })

  it('returns 400 on empty text', async () => {
    const deps = makeDeps()
    const token = deps.tokenManager.generate()
    const server = new RemoteServer(deps)
    await request(server.getApp())
      .post(`/r/${token}/message`)
      .send({ to: 'X', text: '   ' })
      .expect(400)
  })

  it('returns 500 if sendMessage throws', async () => {
    const sendMessage = vi.fn(() => { throw new Error('agent dead') })
    const deps = makeDeps({ sendMessage })
    const token = deps.tokenManager.generate()
    const server = new RemoteServer(deps)
    const res = await request(server.getApp())
      .post(`/r/${token}/message`)
      .send({ to: 'X', text: 'hi' })
      .expect(500)
    expect(res.body.error).toContain('agent dead')
  })
})
