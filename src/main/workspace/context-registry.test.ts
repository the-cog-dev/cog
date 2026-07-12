import { describe, it, expect } from 'vitest'
import { ContextRegistry, type ContextRegistryHooks } from './context-registry'

/**
 * Smoke suite for the concurrent-workspace state machine. A FakeCtx stands in
 * for a real WorkspaceCtx (its own hub + DB + scheduler + agents); the harness
 * mirrors what index.ts's hooks do — setActiveContext (activeHub pointer),
 * lazy create, per-context teardown — so these assertions encode the Stage 3-5
 * acceptance without needing Electron or a real DB.
 */
interface FakeAgent { id: string; tabId: string }
interface FakeCtx {
  id: string
  projectPath: string
  alive: boolean
  schedulerRunning: boolean
  hubClosed: boolean
  dbClosed: boolean
  agents: FakeAgent[]
}

const DEFAULT = 'tab-default'

interface Harness {
  registry: ContextRegistry<FakeCtx>
  bound: Map<string, string>          // workspaceId -> projectPath (folder-bound)
  createdIds: string[]
  activatedIds: string[]
  closedIds: string[]
  activeHub: { ctx: FakeCtx | null }  // simulates the module-global `hub`
  uiPushes: string[]                  // workspace ids whose UI push was NOT suppressed
  /** Emit a UI push the way the factory's sendToUi does — only if ctx is active. */
  emitUi(id: string): void
  makeBound(id: string, projectPath: string): void
}

function makeHarness(initialActiveId = DEFAULT): Harness {
  const bound = new Map<string, string>()
  const createdIds: string[] = []
  const activatedIds: string[] = []
  const closedIds: string[] = []
  const activeHub: { ctx: FakeCtx | null } = { ctx: null }

  let registry!: ContextRegistry<FakeCtx>

  const hooks: ContextRegistryHooks<FakeCtx> = {
    async create(id, projectPath) {
      createdIds.push(id)
      return {
        id,
        projectPath,
        alive: true,
        schedulerRunning: true,
        hubClosed: false,
        dbClosed: false,
        agents: []
      }
    },
    onActivate(id, ctx) {
      activatedIds.push(id)
      activeHub.ctx = ctx // like setActiveContext repointing the global hub
    },
    projectPathFor(id) {
      return bound.get(id) ?? null
    },
    closeCtx(id, ctx) {
      closedIds.push(id)
      ctx.alive = false
      ctx.schedulerRunning = false
      ctx.hubClosed = true
      ctx.dbClosed = true
    }
  }

  registry = new ContextRegistry<FakeCtx>(hooks, initialActiveId)

  return {
    registry,
    bound,
    createdIds,
    activatedIds,
    closedIds,
    activeHub,
    uiPushes: [],
    emitUi(id) {
      if (registry.isActive(id)) this.uiPushes.push(id)
    },
    makeBound(id, projectPath) {
      bound.set(id, projectPath)
    }
  }
}

/** Adopt a pre-built context the way openProject/boot does. */
async function adoptFresh(h: Harness, id: string, projectPath: string): Promise<FakeCtx> {
  const built: FakeCtx = {
    id, projectPath, alive: true, schedulerRunning: true,
    hubClosed: false, dbClosed: false, agents: []
  }
  h.registry.adopt(id, built)
  return built
}

describe('ContextRegistry — lazy activation', () => {
  it('creates a folder-bound workspace context on first activation', async () => {
    const h = makeHarness()
    h.makeBound('ws2', '/proj/two')

    const ctx = await h.registry.activate('ws2')

    expect(ctx).not.toBeNull()
    expect(h.registry.activeId).toBe('ws2')
    expect(h.registry.has('ws2')).toBe(true)
    expect(h.createdIds).toEqual(['ws2'])
    expect(ctx!.alive).toBe(true)
    expect(h.activeHub.ctx).toBe(ctx)
  })

  it('reuses an existing context on re-activation (no second create)', async () => {
    const h = makeHarness()
    h.makeBound('ws2', '/proj/two')

    const first = await h.registry.activate('ws2')
    const again = await h.registry.activate('ws2')

    expect(again).toBe(first)
    expect(h.createdIds).toEqual(['ws2']) // created once, reused second time
  })

  it('returns null and changes nothing for an unbound, never-created workspace', async () => {
    const h = makeHarness()
    await adoptFresh(h, DEFAULT, '/proj/default')

    const ctx = await h.registry.activate('ghost') // no binding, no context

    expect(ctx).toBeNull()
    expect(h.registry.activeId).toBe(DEFAULT) // previous stays active
    expect(h.createdIds).toEqual([])
    expect(h.registry.has('ghost')).toBe(false)
  })
})

describe('ContextRegistry — concurrency (Stage 3 acceptance)', () => {
  it('keeps the first team alive when switching to a second workspace', async () => {
    const h = makeHarness()
    const a = await adoptFresh(h, DEFAULT, '/proj/a')
    h.makeBound('ws2', '/proj/b')

    const b = await h.registry.activate('ws2')

    // Both contexts are live; active is B; A was NOT torn down.
    expect(h.registry.activeId).toBe('ws2')
    expect(h.registry.size).toBe(2)
    expect(a.alive).toBe(true)
    expect(b!.alive).toBe(true)
    expect(h.closedIds).toEqual([]) // nothing closed on a switch
  })

  it('switching back reuses the first team with its state intact', async () => {
    const h = makeHarness()
    const a = await adoptFresh(h, DEFAULT, '/proj/a')
    a.agents.push({ id: 'agent-1', tabId: DEFAULT }) // simulate a running team member
    h.makeBound('ws2', '/proj/b')

    await h.registry.activate('ws2')
    const backToA = await h.registry.activate(DEFAULT)

    expect(backToA).toBe(a)
    expect(a.alive).toBe(true)
    expect(a.agents).toHaveLength(1) // team survived the round trip
    expect(h.createdIds).toEqual(['ws2']) // A never re-created
    expect(h.activeHub.ctx).toBe(a)
  })

  it('suppresses UI pushes from a background context, allows the active one', async () => {
    const h = makeHarness()
    await adoptFresh(h, DEFAULT, '/proj/a')
    h.makeBound('ws2', '/proj/b')
    await h.registry.activate('ws2') // ws2 now active, tab-default backgrounded

    h.emitUi('ws2')        // active — allowed
    h.emitUi(DEFAULT)      // background — suppressed

    expect(h.uiPushes).toEqual(['ws2'])
  })
})

describe('ContextRegistry — spawn routing (Stage 4 primitive)', () => {
  it('routes a spawn to its own workspace context, else the active one', async () => {
    const h = makeHarness()
    const a = await adoptFresh(h, DEFAULT, '/proj/a')
    h.makeBound('ws2', '/proj/b')
    const b = await h.registry.activate('ws2') // active = ws2

    expect(h.registry.resolveForSpawn(DEFAULT)).toBe(a)   // its own live context
    expect(h.registry.resolveForSpawn('ws2')).toBe(b)     // its own live context
    expect(h.registry.resolveForSpawn(undefined)).toBe(b) // no tab -> active
    expect(h.registry.resolveForSpawn('unknown')).toBe(b) // unknown tab -> active
  })
})

describe('ContextRegistry — teardown isolation', () => {
  it('closeOne tears down only that context, leaving others alive', async () => {
    const h = makeHarness()
    const a = await adoptFresh(h, DEFAULT, '/proj/a')
    h.makeBound('ws2', '/proj/b')
    const b = await h.registry.activate('ws2')

    await h.registry.closeOne('ws2')

    expect(h.closedIds).toEqual(['ws2'])
    expect(b!.alive).toBe(false)
    expect(b!.hubClosed).toBe(true)
    expect(b!.dbClosed).toBe(true)
    expect(a.alive).toBe(true)          // the other team is untouched
    expect(h.registry.has('ws2')).toBe(false)
    expect(h.registry.has(DEFAULT)).toBe(true)
  })

  it('closeOne on the active context removes it without auto-activating another', async () => {
    const h = makeHarness()
    await adoptFresh(h, DEFAULT, '/proj/a')
    h.makeBound('ws2', '/proj/b')
    await h.registry.activate('ws2') // active = ws2

    await h.registry.closeOne('ws2')

    // Registry does not pick a successor — that's the caller's job (TAB_CLOSE
    // reactivates the workspaceManager's new active id).
    expect(h.registry.has('ws2')).toBe(false)
    expect(h.registry.getActive()).toBeUndefined()

    const a = await h.registry.activate(DEFAULT) // caller reactivates
    expect(a!.alive).toBe(true)
    expect(h.registry.activeId).toBe(DEFAULT)
  })

  it('closeAll tears down every live context (app quit)', async () => {
    const h = makeHarness()
    await adoptFresh(h, DEFAULT, '/proj/a')
    h.makeBound('ws2', '/proj/b')
    h.makeBound('ws3', '/proj/c')
    await h.registry.activate('ws2')
    await h.registry.activate('ws3')
    expect(h.registry.size).toBe(3)

    await h.registry.closeAll()

    expect(h.registry.size).toBe(0)
    expect(h.closedIds.sort()).toEqual([DEFAULT, 'ws2', 'ws3'])
  })
})

describe('ContextRegistry — boot restore (Stage 5)', () => {
  it('registers background contexts without activating, then adopts the default', async () => {
    const h = makeHarness()

    // Boot: eagerly bring every folder-bound workspace live in the background...
    const bg2: FakeCtx = { id: 'ws2', projectPath: '/p2', alive: true, schedulerRunning: true, hubClosed: false, dbClosed: false, agents: [] }
    const bg3: FakeCtx = { id: 'ws3', projectPath: '/p3', alive: true, schedulerRunning: true, hubClosed: false, dbClosed: false, agents: [] }
    h.registry.register('ws2', bg2)
    h.registry.register('ws3', bg3)
    // ...then adopt the default project as the active one.
    await adoptFresh(h, DEFAULT, '/p1')

    expect(h.registry.size).toBe(3)
    expect(h.registry.activeId).toBe(DEFAULT)
    expect(bg2.alive).toBe(true)
    expect(bg3.alive).toBe(true)
    // register() must NOT have run onActivate for the background ones.
    expect(h.activatedIds).toEqual([DEFAULT])

    // Switching to a pre-registered background workspace reuses it (no create).
    const switched = await h.registry.activate('ws2')
    expect(switched).toBe(bg2)
    expect(h.createdIds).toEqual([])
  })

  it('pendingRestore selects bound, non-active, not-yet-live workspaces', async () => {
    const h = makeHarness()
    await adoptFresh(h, DEFAULT, '/p1') // active
    const bg2: FakeCtx = { id: 'ws2', projectPath: '/p2', alive: true, schedulerRunning: true, hubClosed: false, dbClosed: false, agents: [] }
    h.registry.register('ws2', bg2) // already live

    const list = [
      { id: DEFAULT, projectPath: '/p1' }, // active -> skip
      { id: 'ws2', projectPath: '/p2' },   // already live -> skip
      { id: 'ws3', projectPath: '/p3' },   // bound, not live -> restore
      { id: 'ws4', projectPath: undefined },        // unbound -> skip (lazy on switch)
      { id: 'ws5', projectPath: null }              // unbound -> skip
    ]

    expect(h.registry.pendingRestore(list)).toEqual(['ws3'])
  })

  it('pendingRestore returns empty when everything is active or already live', async () => {
    const h = makeHarness()
    await adoptFresh(h, DEFAULT, '/p1')
    expect(h.registry.pendingRestore([{ id: DEFAULT, projectPath: '/p1' }])).toEqual([])
    expect(h.registry.pendingRestore([])).toEqual([])
  })
})

describe('ContextRegistry — end-to-end narrative', () => {
  it('runs the full multi-team lifecycle', async () => {
    const h = makeHarness()

    // 1. Boot the default team.
    const teamA = await adoptFresh(h, DEFAULT, '/work/alpha')
    teamA.agents.push({ id: 'a1', tabId: DEFAULT })
    expect(h.registry.activeId).toBe(DEFAULT)

    // 2. Add + switch to a second folder-bound workspace.
    h.makeBound('beta', '/work/beta')
    const teamB = await h.registry.activate('beta')
    teamB!.agents.push({ id: 'b1', tabId: 'beta' })
    expect(h.registry.size).toBe(2)

    // 3. Background team A keeps running; UI only reflects B.
    h.emitUi(DEFAULT)
    h.emitUi('beta')
    expect(h.uiPushes).toEqual(['beta'])
    expect(teamA.alive).toBe(true)

    // 4. A new agent spawned under 'beta' routes to team B.
    expect(h.registry.resolveForSpawn('beta')).toBe(teamB)

    // 5. Switch back — team A intact.
    const back = await h.registry.activate(DEFAULT)
    expect(back).toBe(teamA)
    expect(teamA.agents).toHaveLength(1)

    // 6. Close team B only.
    await h.registry.closeOne('beta')
    expect(teamB!.alive).toBe(false)
    expect(teamA.alive).toBe(true)
    expect(h.registry.size).toBe(1)

    // 7. Quit — everything torn down.
    await h.registry.closeAll()
    expect(h.registry.size).toBe(0)
    expect(teamA.alive).toBe(false)
  })
})
