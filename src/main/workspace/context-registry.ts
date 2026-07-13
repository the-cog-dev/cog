/**
 * ContextRegistry — the pure state machine behind concurrent per-workspace
 * project contexts. It owns the `Map<workspaceId, Ctx>` and the single
 * `activeId`, and encodes the lifecycle rules that make the "N teams running at
 * once, UI follows the active one" feature correct:
 *
 *   - activate(id): bring a workspace live (lazy-create on first activation via
 *     the injected `create` hook) and make it active, WITHOUT tearing down any
 *     other context. Switching back to a still-live context reuses it.
 *   - closeOne(id): tear down exactly one context; every other stays alive.
 *   - resolveForSpawn(tabId): pick which context an agent spawned in `tabId`
 *     should attach to (its own if live, else the active one) — the Stage 4
 *     routing primitive.
 *
 * It is deliberately dependency-free (no Electron, no DB, no hub) and generic
 * over the concrete context type, so the whole state machine is unit-testable
 * with fake contexts — see context-registry.test.ts. All Electron/DB/hub side
 * effects live in the injected hooks, which the real app supplies from index.ts.
 */
export interface ContextRegistryHooks<Ctx> {
  /**
   * Build a brand-new context for a first-time activation. `projectPath` is
   * guaranteed non-null (activate() bails before calling this when a workspace
   * is unbound). The real impl opens the folder's DB + hub + stores.
   */
  create(id: string, projectPath: string): Promise<Ctx>
  /**
   * Point the app's active globals + UI at `ctx`. Called on EVERY activation
   * (both freshly-created and reused), after `activeId` is updated — so the
   * hook and anything it triggers can rely on `registry.activeId === id`.
   */
  onActivate(id: string, ctx: Ctx): void
  /** Resolve a workspace's bound project folder, or null/undefined if unbound. */
  projectPathFor(id: string): string | null | undefined
  /** Tear down ONE context's own resources (its agents, scheduler, hub, DB). */
  closeCtx(id: string, ctx: Ctx): Promise<void> | void
}

export class ContextRegistry<Ctx> {
  private readonly map = new Map<string, Ctx>()
  private _activeId: string

  constructor(
    private readonly hooks: ContextRegistryHooks<Ctx>,
    initialActiveId: string
  ) {
    this._activeId = initialActiveId
  }

  /** The workspace id whose context currently drives the globals + UI. */
  get activeId(): string {
    return this._activeId
  }

  /** True when `id` is the active workspace — the UI-push guard predicate. */
  isActive(id: string): boolean {
    return id === this._activeId
  }

  has(id: string): boolean {
    return this.map.has(id)
  }

  get(id: string): Ctx | undefined {
    return this.map.get(id)
  }

  /** The currently-active context, or undefined if none is live yet. */
  getActive(): Ctx | undefined {
    return this.map.get(this._activeId)
  }

  ids(): string[] {
    return [...this.map.keys()]
  }

  get size(): number {
    return this.map.size
  }

  /**
   * Register a pre-built context WITHOUT activating it. Used by boot restore to
   * bring background workspaces live so their agents can reconnect immediately.
   */
  register(id: string, ctx: Ctx): void {
    this.map.set(id, ctx)
  }

  /**
   * Register a pre-built context AND make it active (running its onActivate
   * side effects). Used by openProject / boot for the context the caller built
   * itself (it did initProject + createWorkspaceContext up front).
   */
  adopt(id: string, ctx: Ctx): void {
    this.map.set(id, ctx)
    this._activeId = id
    this.hooks.onActivate(id, ctx)
  }

  /**
   * Make `id` the active workspace. Lazy-creates its context on first
   * activation (via `create`); reuses the live one otherwise. Never tears down
   * any other context. Returns the now-active context, or null when the
   * workspace is unbound AND has no existing context (nothing to show — the
   * caller should leave the previous context active).
   */
  async activate(id: string): Promise<Ctx | null> {
    let ctx = this.map.get(id)
    if (!ctx) {
      const projectPath = this.hooks.projectPathFor(id)
      if (!projectPath) return null
      ctx = await this.hooks.create(id, projectPath)
      this.map.set(id, ctx)
    }
    this._activeId = id
    this.hooks.onActivate(id, ctx)
    return ctx
  }

  /**
   * Which context an agent spawned in `tabId` should attach to: its own live
   * context if present, else the active context (Stage 4 spawn routing). Falls
   * back to the active context when `tabId` is absent/unknown.
   */
  resolveForSpawn(tabId?: string | null): Ctx | undefined {
    if (tabId && this.map.has(tabId)) return this.map.get(tabId)
    return this.map.get(this._activeId)
  }

  /**
   * From a workspace list, the ids whose context should be brought live at boot
   * (Stage 5 restore): folder-bound (has a projectPath), not the active one
   * (already open), and not already live. Preserves list order.
   */
  pendingRestore(workspaces: Array<{ id: string; projectPath?: string | null }>): string[] {
    return workspaces
      .filter((w) => !!w.projectPath && w.id !== this._activeId && !this.map.has(w.id))
      .map((w) => w.id)
  }

  /**
   * Which live contexts should respawn their agent roster right now, given the
   * user's mode and which contexts have already been respawned this session
   * (Stage: agent auto-respawn). Pure — the caller does the actual spawning.
   *   - 'none'   → nothing.
   *   - 'active' → the active context only (background ones respawn lazily on
   *     first switch, handled by calling this again with a single-id list).
   *   - 'all'    → every live context not yet respawned.
   * `contextIds` are the currently-live context ids; `alreadyDone` is the set
   * already respawned (so repeated calls / switches don't double-spawn).
   */
  resolveRespawnTargets(
    mode: 'all' | 'active' | 'none',
    contextIds: string[],
    alreadyDone: ReadonlySet<string>
  ): string[] {
    if (mode === 'none') return []
    const live = contextIds.filter((id) => !alreadyDone.has(id))
    if (mode === 'active') {
      return live.includes(this._activeId) ? [this._activeId] : []
    }
    return live // 'all'
  }

  /**
   * Tear down exactly ONE context and drop it from the registry. Leaves every
   * other context and the `activeId` pointer untouched — the caller decides
   * what to activate next if it closed the active one.
   */
  async closeOne(id: string): Promise<void> {
    const ctx = this.map.get(id)
    if (!ctx) return
    await this.hooks.closeCtx(id, ctx)
    this.map.delete(id)
  }

  /** Tear down every live context (app quit / restart). */
  async closeAll(): Promise<void> {
    for (const id of [...this.map.keys()]) {
      const ctx = this.map.get(id)
      if (ctx !== undefined) await this.hooks.closeCtx(id, ctx)
      this.map.delete(id)
    }
  }
}
