import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRoutes, type ScheduleBridge } from '../../src/main/hub/routes'

// Build an Express app by calling createRoutes directly with minimal fakes for
// the positional params. These routes only touch proposalsChannel + the
// schedule bridge getter, so everything else can be a stub.
function makeApp(bridge: ScheduleBridge, proposalsChannel: any) {
  const app = express()
  app.use(express.json())
  app.use(
    createRoutes(
      {} as any, // registry
      {} as any, // messages
      { accessor: null }, // outputRef
      {} as any, // pinboard
      {} as any, // infoChannel
      { store: null }, // messageStoreRef
      { path: null }, // projectPathRef
      undefined, // groupManager
      undefined, // inboxChannel
      proposalsChannel, // proposalsChannel
      () => bridge // getScheduleBridge
    )
  )
  return app
}

function makeBridge(autonomy: boolean): ScheduleBridge {
  return {
    autonomyEnabled: () => autonomy,
    resolveTarget: () => ({ agentId: 'a1', tabId: 'tab-default', name: 'sonnetworker2' }),
    create: vi.fn(() => ({ id: 'sch1', nextFireAt: 123, expiresAt: 456 })),
    list: () => [],
    cancel: () => ({ ok: true })
  }
}

function makeProposalsChannel() {
  return {
    createScheduleProposal: vi.fn(() => ({ id: 'prop1' }))
  }
}

const validBody = {
  proposedBy: 'orchestrator',
  targetAgent: 'sonnetworker2',
  promptText: 'check the build',
  intervalMinutes: 30,
  durationHours: 4,
  name: 'build watch'
}

describe('POST /schedules', () => {
  it('autonomy ON: creates the schedule immediately and returns status:scheduled', async () => {
    const bridge = makeBridge(true)
    const proposals = makeProposalsChannel()
    const app = makeApp(bridge, proposals)

    const res = await request(app).post('/schedules').send(validBody)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'scheduled', scheduleId: 'sch1', nextFireAt: 123, expiresAt: 456 })
    expect(bridge.create).toHaveBeenCalledTimes(1)
    expect(proposals.createScheduleProposal).not.toHaveBeenCalled()
  })

  it('autonomy OFF: creates a proposal and returns status:proposed', async () => {
    const bridge = makeBridge(false)
    const proposals = makeProposalsChannel()
    const app = makeApp(bridge, proposals)

    const res = await request(app).post('/schedules').send(validBody)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'proposed', proposalId: 'prop1' })
    expect(proposals.createScheduleProposal).toHaveBeenCalledTimes(1)
    expect(bridge.create).not.toHaveBeenCalled()
  })

  it('rejects a sub-floor interval with 400', async () => {
    const bridge = makeBridge(true)
    const proposals = makeProposalsChannel()
    const app = makeApp(bridge, proposals)

    const res = await request(app)
      .post('/schedules')
      .send({ ...validBody, intervalMinutes: 1 })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/intervalMinutes/)
    expect(bridge.create).not.toHaveBeenCalled()
    expect(proposals.createScheduleProposal).not.toHaveBeenCalled()
  })

  it('returns 503 when no schedule bridge is wired', async () => {
    const app = express()
    app.use(express.json())
    app.use(createRoutes({} as any, {} as any, { accessor: null }, {} as any, {} as any, { store: null }, { path: null }, undefined, undefined, makeProposalsChannel() as any, () => undefined))

    const res = await request(app).post('/schedules').send(validBody)
    expect(res.status).toBe(503)
  })

  it('returns 404 when target agent cannot be resolved', async () => {
    const bridge = { ...makeBridge(true), resolveTarget: () => null }
    const app = makeApp(bridge, makeProposalsChannel())

    const res = await request(app).post('/schedules').send(validBody)
    expect(res.status).toBe(404)
  })
})

describe('GET /schedules', () => {
  it('returns the bridge list', async () => {
    const bridge: ScheduleBridge = {
      ...makeBridge(true),
      list: () => [
        {
          id: 'sch1', name: 'build watch', agentId: 'a1', agentName: 'sonnetworker2',
          intervalMinutes: 30, durationHours: 4, nextFireAt: 1, expiresAt: 2,
          status: 'active', createdBy: 'orchestrator'
        }
      ]
    }
    const app = makeApp(bridge, makeProposalsChannel())

    const res = await request(app).get('/schedules')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].id).toBe('sch1')
  })

  it('returns [] when no bridge is wired', async () => {
    const app = express()
    app.use(express.json())
    app.use(createRoutes({} as any, {} as any, { accessor: null }, {} as any, {} as any, { store: null }, { path: null }, undefined, undefined, undefined, () => undefined))

    const res = await request(app).get('/schedules')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})

describe('POST /schedules/:id/cancel', () => {
  it('cancels via the bridge', async () => {
    const bridge: ScheduleBridge = { ...makeBridge(true), cancel: vi.fn(() => ({ ok: true })) }
    const app = makeApp(bridge, makeProposalsChannel())

    const res = await request(app).post('/schedules/sch1/cancel').send({ requestedBy: 'orchestrator' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(bridge.cancel).toHaveBeenCalledWith('sch1', 'orchestrator')
  })

  it('returns 403 when the bridge refuses', async () => {
    const bridge: ScheduleBridge = { ...makeBridge(true), cancel: () => ({ ok: false, error: 'nope' }) }
    const app = makeApp(bridge, makeProposalsChannel())

    const res = await request(app).post('/schedules/sch1/cancel').send({ requestedBy: 'someoneelse' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('nope')
  })

  it('returns 400 when requestedBy is missing from body', async () => {
    const bridge = makeBridge(true)
    const app = makeApp(bridge, makeProposalsChannel())

    const res = await request(app).post('/schedules/sch1/cancel').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('requestedBy required')
  })
})

describe('POST /schedules — bridge.create throws', () => {
  it('returns 500 with error message when bridge.create throws', async () => {
    const bridge: ScheduleBridge = {
      ...makeBridge(true),
      create: () => { throw new Error('Scheduler unavailable') }
    }
    const app = makeApp(bridge, makeProposalsChannel())

    const res = await request(app).post('/schedules').send(validBody)
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Scheduler unavailable')
  })
})
