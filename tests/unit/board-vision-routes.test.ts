import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createRoutes, type BoardBridge } from '../../src/main/hub/routes'

// Build an Express app by calling createRoutes directly with minimal fakes for
// all positional params. These routes only touch the board bridge getter, so
// everything else can be a stub.
function makeApp(bridge: BoardBridge | null) {
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
      undefined, // proposalsChannel
      undefined, // getScheduleBridge
      bridge ? () => bridge : undefined // getBoardBridge
    )
  )
  return app
}

function makeBridge(overrides?: Partial<BoardBridge>): BoardBridge {
  return {
    listPages: vi.fn(() => [
      { page: 1, elementCount: 3, strokeCount: 2 },
      { page: 2, elementCount: 5, strokeCount: 0 }
    ]),
    renderPath: vi.fn((_n: number) => null),
    ...overrides
  }
}

describe('GET /board/pages', () => {
  it('returns the bridge listPages() output when bridge is present', async () => {
    const bridge = makeBridge()
    const app = makeApp(bridge)

    const res = await request(app).get('/board/pages')

    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { page: 1, elementCount: 3, strokeCount: 2 },
      { page: 2, elementCount: 5, strokeCount: 0 }
    ])
    expect(bridge.listPages).toHaveBeenCalledTimes(1)
  })

  it('returns [] when no bridge is wired', async () => {
    const app = makeApp(null)

    const res = await request(app).get('/board/pages')

    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})

describe('GET /board/pages/:n/render', () => {
  it('returns 200 with path and page when render exists', async () => {
    const bridge = makeBridge({
      renderPath: vi.fn((n: number) => n === 2 ? '/abs/page-bbb.png' : null)
    })
    const app = makeApp(bridge)

    const res = await request(app).get('/board/pages/2/render')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ path: '/abs/page-bbb.png', page: 2 })
    expect(bridge.renderPath).toHaveBeenCalledWith(2)
  })

  it('returns 404 when page does not exist (renderPath returns null)', async () => {
    const bridge = makeBridge({
      renderPath: vi.fn((_n: number) => null)
    })
    const app = makeApp(bridge)

    const res = await request(app).get('/board/pages/9/render')

    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/No page 9/)
  })

  it('returns 409 when page has no render yet (renderPath returns empty string)', async () => {
    const bridge = makeBridge({
      renderPath: vi.fn((n: number) => n === 2 ? '' : null)
    })
    const app = makeApp(bridge)

    const res = await request(app).get('/board/pages/2/render')

    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/no render yet/)
  })

  it('returns 400 when page number is 0 (invalid)', async () => {
    const bridge = makeBridge()
    const app = makeApp(bridge)

    const res = await request(app).get('/board/pages/0/render')

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid page number')
  })

  it('returns 503 when no bridge is wired', async () => {
    const app = makeApp(null)

    const res = await request(app).get('/board/pages/1/render')

    expect(res.status).toBe(503)
    expect(res.body.error).toBe('Board unavailable')
  })
})
