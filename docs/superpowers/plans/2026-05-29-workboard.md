# Workboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-project, multi-page visual canvas ("Workboard") with sticky notes, text, photos, and freehand drawing, where agents can view any page as a rendered PNG via MCP.

**Architecture:** DOM elements (notes/text/images via `react-rnd`) on a pan/zoom page + a per-page drawing `<canvas>` overlay; pages persist in `.cog/cog.db`, images/renders as files under `.cog/board/`; pages flatten to PNG via `html-to-image` on edit; two MCP tools (`list_board_pages`, `view_board_page`) serve page renders to agents through hub routes backed by a main-process accessor (same pattern as the schedule bridge).

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React, `react-rnd` (existing dep), `html-to-image` (new, pure-JS), better-sqlite3, `@modelcontextprotocol/sdk`, Zod, Vitest.

**Verification env note:** `better-sqlite3` must be on **Node ABI** for vitest (`rm -rf node_modules/better-sqlite3 && npm install better-sqlite3@12.8.0`); flip back to Electron (`npm install`) before running the app. Always pass `--exclude "**/.claude/worktrees/**"` to vitest. UI tasks verify via `npm run build` + manual checks.

---

## File Structure

**Create:**
- `src/main/db/board-store.ts` — pages CRUD + reorder (SQLite `board_pages`).
- `src/main/board/board-files.ts` — `.cog/board/` path helpers + image/render file writes + page-number→render-path resolution.
- `src/renderer/components/Workboard.tsx` — surface: page navigator + active page host + toolbar state.
- `src/renderer/components/BoardPageCanvas.tsx` — one page: pan/zoom + element layer + drawing overlay.
- `src/renderer/components/BoardElementView.tsx` — renders a note/text/image element (react-rnd wrapper).
- `src/renderer/components/BoardToolbar.tsx` — tool palette.
- `src/renderer/hooks/useBoardDrawing.ts` — stroke capture for the drawing canvas.
- `src/renderer/hooks/useBoardRasterizer.ts` — page DOM+canvas → PNG dataURL.
- Tests: `tests/unit/board-store.test.ts`, `tests/unit/board-files.test.ts`, `tests/unit/board-vision-routes.test.ts`

**Modify:**
- `src/shared/types.ts` — board types + `IPC` channels.
- `src/main/db/database.ts` — `board_pages` migration.
- `src/main/index.ts` — board IPC handlers, image/render writes, board-vision accessor, hub wiring.
- `src/main/hub/routes.ts` + `src/main/hub/server.ts` — board-vision routes + accessor getter.
- `src/mcp-server/index.ts` — `list_board_pages`, `view_board_page` tools.
- `src/preload/index.ts` + `src/renderer/electron.d.ts` — board renderer API.
- `src/renderer/App.tsx` + `src/renderer/components/TopBar.tsx` — Workboard view toggle.
- `package.json` — add `html-to-image`.

---

## Phase 1 — Data model & persistence

### Task 1: Board types

**Files:** Modify `src/shared/types.ts`

- [ ] **Step 1: Add types** (near the other domain types):

```ts
export type BoardTool = 'pen' | 'line' | 'arrow' | 'ellipse'

export interface BoardStroke {
  id: string
  tool: BoardTool
  color: string
  width: number
  points: { x: number; y: number }[]
}

export type BoardElement =
  | { type: 'note';  id: string; x: number; y: number; w: number; h: number; text: string; color: string; z: number }
  | { type: 'text';  id: string; x: number; y: number; w: number; h: number; text: string; fontSize: number; z: number }
  | { type: 'image'; id: string; x: number; y: number; w: number; h: number; file: string; z: number }

export interface BoardPage {
  id: string
  orderIndex: number
  elements: BoardElement[]
  strokes: BoardStroke[]
}
```

- [ ] **Step 2: Add IPC channels** to the `IPC` object:

```ts
  BOARD_LIST_PAGES: 'board:list-pages',
  BOARD_SAVE_PAGE: 'board:save-page',
  BOARD_ADD_PAGE: 'board:add-page',
  BOARD_DELETE_PAGE: 'board:delete-page',
  BOARD_SAVE_IMAGE: 'board:save-image',
  BOARD_SAVE_RENDER: 'board:save-render',
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -iE "Board|error TS" | grep -v "req.params" | head`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(board): board types + IPC channels"
```

---

### Task 2: Board store (SQLite)

**Files:** Create `src/main/db/board-store.ts`; Modify `src/main/db/database.ts`; Test `tests/unit/board-store.test.ts`

- [ ] **Step 1: Migration** in `src/main/db/database.ts` — add to the main `db.exec` CREATE block:

```sql
    CREATE TABLE IF NOT EXISTS board_pages (
      id          TEXT PRIMARY KEY,
      order_index INTEGER NOT NULL,
      elements    TEXT NOT NULL DEFAULT '[]',
      strokes     TEXT NOT NULL DEFAULT '[]'
    );
```

- [ ] **Step 2: Failing test** `tests/unit/board-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/main/db/database'
import { BoardStore } from '../../src/main/db/board-store'

const store = () => new BoardStore(createDatabase(':memory:'))

describe('BoardStore', () => {
  it('starts empty', () => {
    expect(store().listPages()).toEqual([])
  })
  it('adds pages with incrementing orderIndex and round-trips content', () => {
    const s = store()
    const p1 = s.addPage()
    expect(p1.orderIndex).toBe(1)
    s.savePage({ ...p1, elements: [{ type: 'note', id: 'n1', x: 0, y: 0, w: 100, h: 80, text: 'hi', color: '#ff0', z: 0 }], strokes: [] })
    const reloaded = s.listPages()
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0].elements[0].type).toBe('note')
  })
  it('numbers the second page 2 and deletes + renumbers', () => {
    const s = store()
    const a = s.addPage(); const b = s.addPage()
    expect(b.orderIndex).toBe(2)
    s.deletePage(a.id)
    const pages = s.listPages()
    expect(pages).toHaveLength(1)
    expect(pages[0].orderIndex).toBe(1)   // renumbered
    expect(pages[0].id).toBe(b.id)
  })
})
```

- [ ] **Step 3: Run — expect FAIL**

Run: `npx vitest run tests/unit/board-store.test.ts --exclude "**/.claude/worktrees/**"`

- [ ] **Step 4: Implement** `src/main/db/board-store.ts`:

```ts
import type Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import type { BoardPage, BoardElement, BoardStroke } from '../../shared/types'

interface Row { id: string; order_index: number; elements: string; strokes: string }

export class BoardStore {
  private listStmt: Database.Statement
  private upsertStmt: Database.Statement
  private deleteStmt: Database.Statement
  private maxOrderStmt: Database.Statement

  constructor(private db: Database.Database) {
    this.listStmt = db.prepare('SELECT * FROM board_pages ORDER BY order_index ASC')
    this.upsertStmt = db.prepare(
      `INSERT INTO board_pages (id, order_index, elements, strokes) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET order_index = excluded.order_index, elements = excluded.elements, strokes = excluded.strokes`
    )
    this.deleteStmt = db.prepare('DELETE FROM board_pages WHERE id = ?')
    this.maxOrderStmt = db.prepare('SELECT COALESCE(MAX(order_index), 0) AS m FROM board_pages')
  }

  listPages(): BoardPage[] {
    return (this.listStmt.all() as Row[]).map(r => ({
      id: r.id,
      orderIndex: r.order_index,
      elements: JSON.parse(r.elements) as BoardElement[],
      strokes: JSON.parse(r.strokes) as BoardStroke[]
    }))
  }

  addPage(): BoardPage {
    const next = (this.maxOrderStmt.get() as { m: number }).m + 1
    const page: BoardPage = { id: uuid(), orderIndex: next, elements: [], strokes: [] }
    this.savePage(page)
    return page
  }

  savePage(page: BoardPage): void {
    this.upsertStmt.run(page.id, page.orderIndex, JSON.stringify(page.elements), JSON.stringify(page.strokes))
  }

  deletePage(id: string): void {
    this.deleteStmt.run(id)
    // Renumber remaining pages to keep orderIndex contiguous (1-based).
    const pages = this.listPages()
    pages.forEach((p, i) => {
      const want = i + 1
      if (p.orderIndex !== want) this.savePage({ ...p, orderIndex: want })
    })
  }
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx vitest run tests/unit/board-store.test.ts --exclude "**/.claude/worktrees/**"`

- [ ] **Step 6: Commit**

```bash
git add src/main/db/board-store.ts src/main/db/database.ts tests/unit/board-store.test.ts
git commit -m "feat(board): board_pages store with reorder-on-delete"
```

---

### Task 3: Board file helpers (.cog/board) + render-path resolution

**Files:** Create `src/main/board/board-files.ts`; Test `tests/unit/board-files.test.ts`

- [ ] **Step 1: Failing test** `tests/unit/board-files.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { boardDir, imagesDir, rendersDir, renderPathForPage, saveImageBytes } from '../../src/main/board/board-files'
import type { BoardPage } from '../../src/shared/types'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogboard-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const page = (id: string, orderIndex: number): BoardPage => ({ id, orderIndex, elements: [], strokes: [] })

describe('board-files', () => {
  it('builds .cog/board subdirs under the project root', () => {
    expect(boardDir(root)).toBe(path.join(root, '.cog', 'board'))
    expect(imagesDir(root)).toBe(path.join(root, '.cog', 'board', 'images'))
    expect(rendersDir(root)).toBe(path.join(root, '.cog', 'board', 'renders'))
  })
  it('resolves a render path by 1-based page number', () => {
    const pages = [page('aaa', 1), page('bbb', 2)]
    expect(renderPathForPage(root, pages, 2)).toBe(path.join(rendersDir(root), 'page-bbb.png'))
    expect(renderPathForPage(root, pages, 3)).toBeNull()   // out of range
    expect(renderPathForPage(root, pages, 0)).toBeNull()
  })
  it('saves image bytes and returns the filename', () => {
    const name = saveImageBytes(root, 'iVBORw0KGgo=', 'png')   // base64 (no data: prefix)
    expect(name).toMatch(/\.png$/)
    expect(fs.existsSync(path.join(imagesDir(root), name))).toBe(true)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run tests/unit/board-files.test.ts --exclude "**/.claude/worktrees/**"`

- [ ] **Step 3: Implement** `src/main/board/board-files.ts`:

```ts
import * as fs from 'fs'
import * as path from 'path'
import { v4 as uuid } from 'uuid'
import type { BoardPage } from '../../shared/types'

export function boardDir(projectRoot: string): string { return path.join(projectRoot, '.cog', 'board') }
export function imagesDir(projectRoot: string): string { return path.join(boardDir(projectRoot), 'images') }
export function rendersDir(projectRoot: string): string { return path.join(boardDir(projectRoot), 'renders') }

function ensure(dir: string): void { fs.mkdirSync(dir, { recursive: true }) }

/** Absolute path to the render PNG for the 1-based page number, or null if out of range. */
export function renderPathForPage(projectRoot: string, pages: BoardPage[], pageNumber: number): string | null {
  const page = pages.find(p => p.orderIndex === pageNumber)
  if (!page) return null
  return path.join(rendersDir(projectRoot), `page-${page.id}.png`)
}

/** Persist base64 image bytes (no data: prefix) under images/, returns the filename. */
export function saveImageBytes(projectRoot: string, base64: string, ext: string): string {
  ensure(imagesDir(projectRoot))
  const name = `${uuid()}.${ext.replace(/[^a-z0-9]/gi, '') || 'png'}`
  fs.writeFileSync(path.join(imagesDir(projectRoot), name), Buffer.from(base64, 'base64'))
  return name
}

/** Persist a rendered page PNG (base64, no data: prefix). */
export function saveRenderBytes(projectRoot: string, pageId: string, base64: string): string {
  ensure(rendersDir(projectRoot))
  const file = path.join(rendersDir(projectRoot), `page-${pageId}.png`)
  fs.writeFileSync(file, Buffer.from(base64, 'base64'))
  return file
}
```

- [ ] **Step 4: Run — expect PASS** (same command as Step 2)

- [ ] **Step 5: Commit**

```bash
git add src/main/board/board-files.ts tests/unit/board-files.test.ts
git commit -m "feat(board): .cog/board file helpers + render-path resolution"
```

---

### Task 4: Board IPC (main + preload + typings)

**Files:** Modify `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/electron.d.ts`

- [ ] **Step 1: Main handlers** in `src/main/index.ts`. Add a module-level `let boardStore: BoardStore | null = null` and instantiate it where the other project stores are created (after `currentSchedulesStore = new SchedulesStore(db)`): `boardStore = new BoardStore(db)`. Import `BoardStore` and the board-files helpers + `ProjectAutonomy`-style types as needed. Register handlers near the other `ipcMain.handle` calls:

```ts
  ipcMain.handle(IPC.BOARD_LIST_PAGES, () => boardStore?.listPages() ?? [])
  ipcMain.handle(IPC.BOARD_ADD_PAGE, () => boardStore?.addPage() ?? null)
  ipcMain.handle(IPC.BOARD_SAVE_PAGE, (_e, page) => { boardStore?.savePage(page); return true })
  ipcMain.handle(IPC.BOARD_DELETE_PAGE, (_e, id: string) => { boardStore?.deletePage(id); return true })
  ipcMain.handle(IPC.BOARD_SAVE_IMAGE, (_e, base64: string, ext: string) => {
    const root = projectManager.currentProject?.path
    if (!root) return null
    return saveImageBytes(root, base64, ext)   // returns filename
  })
  ipcMain.handle(IPC.BOARD_SAVE_RENDER, (_e, pageId: string, base64: string) => {
    const root = projectManager.currentProject?.path
    if (!root) return null
    return saveRenderBytes(root, pageId, base64)
  })
```

- [ ] **Step 2: Preload** (`src/preload/index.ts`), in the `electronAPI` object:

```ts
  boardListPages: () => ipcRenderer.invoke(IPC.BOARD_LIST_PAGES),
  boardAddPage: () => ipcRenderer.invoke(IPC.BOARD_ADD_PAGE),
  boardSavePage: (page: unknown) => ipcRenderer.invoke(IPC.BOARD_SAVE_PAGE, page),
  boardDeletePage: (id: string) => ipcRenderer.invoke(IPC.BOARD_DELETE_PAGE, id),
  boardSaveImage: (base64: string, ext: string) => ipcRenderer.invoke(IPC.BOARD_SAVE_IMAGE, base64, ext),
  boardSaveRender: (pageId: string, base64: string) => ipcRenderer.invoke(IPC.BOARD_SAVE_RENDER, pageId, base64),
```

- [ ] **Step 3: Typings** (`src/renderer/electron.d.ts`), in the `electronAPI` interface:

```ts
      boardListPages: () => Promise<import('../shared/types').BoardPage[]>
      boardAddPage: () => Promise<import('../shared/types').BoardPage | null>
      boardSavePage: (page: import('../shared/types').BoardPage) => Promise<boolean>
      boardDeletePage: (id: string) => Promise<boolean>
      boardSaveImage: (base64: string, ext: string) => Promise<string | null>
      boardSaveRender: (pageId: string, base64: string) => Promise<string | null>
```

- [ ] **Step 4: Verify** `npm run build 2>&1 | tail -5` → `✓ built`; fix any new TS errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/preload/index.ts src/renderer/electron.d.ts
git commit -m "feat(board): IPC for pages CRUD + image/render file writes"
```

---

## Phase 2 — Agent vision (MCP)

### Task 5: Board-vision hub routes + accessor

**Files:** Modify `src/main/hub/routes.ts`, `src/main/hub/server.ts`, `src/main/index.ts`; Test `tests/unit/board-vision-routes.test.ts`

Mirror the existing `ScheduleBridge` getter pattern (added in the agent-scheduling feature). Define + export in `routes.ts`:
```ts
export interface BoardBridge {
  listPages: () => { page: number; elementCount: number; strokeCount: number }[]
  renderPath: (pageNumber: number) => string | null   // absolute path; null if out-of-range; '' if no render yet
}
```

- [ ] **Step 1: Failing test** `tests/unit/board-vision-routes.test.ts` — build an Express app calling `createRoutes(...)` with minimal fakes (copy the arg order from `tests/integration/hub-server.test.ts`, appending the new trailing `getBoardBridge` param after `getScheduleBridge`). Cover:

```ts
// GET /board/pages → returns bridge.listPages()
// GET /board/pages/2/render → 200 { path } when renderPath returns a path
// GET /board/pages/9/render → 404 when renderPath returns null (out of range)
// GET /board/pages/2/render → 409 { error } when renderPath returns '' (no render yet)
```
Use a fake bridge with `vi.fn()`s and assert status + body for each case.

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run tests/unit/board-vision-routes.test.ts --exclude "**/.claude/worktrees/**"`

- [ ] **Step 3: routes.ts** — add trailing param `getBoardBridge?: () => BoardBridge | undefined` and routes:

```ts
  router.get('/board/pages', (_req: Request, res: Response) => {
    const b = getBoardBridge?.()
    res.json(b ? b.listPages() : [])
  })
  router.get('/board/pages/:n/render', (req: Request, res: Response) => {
    const b = getBoardBridge?.()
    if (!b) { res.status(503).json({ error: 'Board unavailable' }); return }
    const n = parseInt(req.params.n, 10)
    if (!Number.isInteger(n) || n <= 0) { res.status(400).json({ error: 'invalid page number' }); return }
    const p = b.renderPath(n)
    if (p === null) { res.status(404).json({ error: `No page ${n}` }); return }
    if (p === '') { res.status(409).json({ error: `Page ${n} has no render yet — open it in the Workboard first` }); return }
    res.json({ path: p, page: n })
  })
```

- [ ] **Step 4: server.ts** — add `getBoardBridge` param to `createHubServer` (after `getScheduleBridge`), forward to `createRoutes(...)` as the new trailing arg.

- [ ] **Step 5: index.ts** — build the bridge (module-level `let boardBridge`, assigned near `scheduleBridge`), pass `() => boardBridge ?? undefined` to `createHubServer`:

```ts
  boardBridge = {
    listPages: () => (boardStore?.listPages() ?? []).map(p => ({
      page: p.orderIndex, elementCount: p.elements.length, strokeCount: p.strokes.length
    })),
    renderPath: (n) => {
      const root = projectManager.currentProject?.path
      if (!root || !boardStore) return null
      const path = renderPathForPage(root, boardStore.listPages(), n)
      if (path === null) return null
      return fs.existsSync(path) ? path : ''   // '' signals "no render yet"
    }
  }
```

- [ ] **Step 6: Run — expect PASS** (route test + `tests/integration/hub-server.test.ts` stay green)

Run: `npx vitest run tests/unit/board-vision-routes.test.ts tests/integration/hub-server.test.ts --exclude "**/.claude/worktrees/**"`

- [ ] **Step 7: Commit**

```bash
git add src/main/hub/routes.ts src/main/hub/server.ts src/main/index.ts tests/unit/board-vision-routes.test.ts
git commit -m "feat(board): hub routes + bridge for page list/render path"
```

---

### Task 6: MCP board-vision tools

**Files:** Modify `src/mcp-server/index.ts`

- [ ] **Step 1: Add tools** after the scheduling tools:

```ts
server.tool(
  'list_board_pages',
  'List the pages of the project Workboard (a visual canvas the user draws/notes on), with element/stroke counts per page. Use before view_board_page to see what exists.',
  {},
  async () => {
    try { return toolResult(await hubFetch('/board/pages')) }
    catch (err: any) { return toolError(`Failed to list board pages: ${err.message}`) }
  }
)

server.tool(
  'view_board_page',
  'Get the rendered image of a Workboard page so you can SEE it (photos, sticky notes, text, and the user\\'s freehand drawing/arrows/circles). Returns a PNG file path — open it with your image/vision read. Page numbers are 1-based, as the user sees them.',
  { page: z.number().int().describe('1-based page number (e.g. the "3" in "look at page 3").') },
  async ({ page }) => {
    try {
      const r = await hubFetch(`/board/pages/${page}/render`)
      return toolResult({ ...r, next: `Open the image at "${r.path}" with your file/vision read to see page ${page}.` })
    } catch (err: any) {
      return toolError(`Failed to view board page ${page}: ${err.message}`)
    }
  }
)
```

- [ ] **Step 2: Build** `npm run build:mcp 2>&1 | tail -5` → succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/mcp-server/index.ts
git commit -m "feat(mcp): list_board_pages + view_board_page tools"
```

---

## Phase 3 — Workboard UI shell

### Task 7: Workboard view toggle in App

**Files:** Modify `src/renderer/App.tsx`, `src/renderer/components/TopBar.tsx`; Create stub `src/renderer/components/Workboard.tsx`

- [ ] **Step 1: Stub** `src/renderer/components/Workboard.tsx`:

```tsx
export function Workboard() {
  return <div style={{ position: 'absolute', inset: 0, background: '#141414', color: '#888',
    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Workboard (coming together)</div>
}
```

- [ ] **Step 2: App toggle** — in `App.tsx` add `const [showBoard, setShowBoard] = useState(false)`. Where `<Workspace .../>` renders, render `<Workboard/>` instead when `showBoard` (keep Workspace mounted but hidden, OR conditionally render — conditional is fine for V1). Pass `onToggleBoard={() => setShowBoard(v => !v)}` and `boardActive={showBoard}` to `<TopBar/>`.

- [ ] **Step 3: TopBar button** — add a button (e.g. "📖 Board") that calls `onToggleBoard`, visually active when `boardActive`. Match TopBar's existing button styling.

- [ ] **Step 4: Verify** `npm run build` → `✓ built`. Manual: toggling shows the stub and back.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx src/renderer/components/TopBar.tsx src/renderer/components/Workboard.tsx
git commit -m "feat(board): Workboard view toggle + stub surface"
```

---

### Task 8: Page navigator + page state wiring

**Files:** Modify `src/renderer/components/Workboard.tsx`; Create `src/renderer/components/BoardPageCanvas.tsx` (stub here, filled in Task 9)

- [ ] **Step 1: Workboard loads pages + navigator.** On mount, `window.electronAPI.boardListPages()`; if empty, `boardAddPage()`. Track `pages: BoardPage[]` and `currentIndex` (0-based). Render the navigator:
```
◀  Page {currentIndex+1} / {pages.length}  ▶   ＋ Add   🗑 Delete
```
Wire: `▶/◀` change `currentIndex`; `＋` → `boardAddPage()` then refresh + jump to it; `🗑` → `boardDeletePage(currentPage.id)` then refresh (clamp index). Below the navigator, render `<BoardPageCanvas page={pages[currentIndex]} onChange={savePageDebounced} />` (stub `BoardPageCanvas` returning a `<div>` for now). `savePageDebounced` calls `window.electronAPI.boardSavePage(page)` debounced ~600ms.

- [ ] **Step 2: Verify** `npm run build` → `✓ built`. Manual: add/delete/navigate pages; reload app → pages persist (DB).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Workboard.tsx src/renderer/components/BoardPageCanvas.tsx
git commit -m "feat(board): page navigator + persistent page state"
```

---

## Phase 4 — Page canvas & elements

### Task 9: BoardPageCanvas pan/zoom + element layer

**Files:** Modify `src/renderer/components/BoardPageCanvas.tsx`; Create `src/renderer/components/BoardElementView.tsx`

- [ ] **Step 1: Pan/zoom canvas.** In `BoardPageCanvas`, port the pan/zoom approach from `Workspace.tsx` (local `zoom`, `pan`, native non-passive `wheel` handler for Ctrl+scroll zoom-at-cursor, drag-empty-space to pan when in Select mode). Render a transformed inner div (`transform: translate(panX,panY) scale(zoom)`) that hosts elements. Props: `{ page: BoardPage; tool: ToolState; onChange: (page: BoardPage) => void }`.

- [ ] **Step 2: Element rendering** via `BoardElementView` using `react-rnd` (already a dep — see `FloatingWindow.tsx` for usage). Each element: `<Rnd>` positioned at `x,y,w,h`, `scale={zoom}` so drag/resize math matches the canvas zoom, `onDragStop`/`onResizeStop` → update that element in `page.elements` and call `onChange`. Render by type: note (colored box + editable text on double-click via `contentEditable` or a textarea), text (transparent, editable), image (`<img src={imageSrc(element.file)} />` where `imageSrc` builds the `.cog/board/images/<file>` URL — use a `file://` path from the project root exposed via a preload getter, or an existing static route).

  **Image src note:** confirm how the renderer can load a `.cog/board/images/<file>` file. Two options: (a) a tiny preload helper returning the absolute path → `file://` URL; (b) reuse any existing static-serve. Pick (a) for V1: add `boardImagePath(file)` to preload returning `path.join(projectRoot, '.cog/board/images', file)` and load as `file://`.

- [ ] **Step 3: Add-element interactions** (driven by `tool` from the toolbar, Task 11): in Note/Text mode, click empty canvas → push a new element at the click point (canvas coords = `(screen - pan)/zoom`) → `onChange`. Selection state highlights the active element; `Delete` removes it.

- [ ] **Step 4: Verify** `npm run build` → `✓ built`. Manual: drop notes/text, type, drag, resize, zoom/pan, delete; reload → persists.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/BoardPageCanvas.tsx src/renderer/components/BoardElementView.tsx
git commit -m "feat(board): page canvas pan/zoom + note/text/image elements"
```

---

### Task 10: Paste & drop images

**Files:** Modify `src/renderer/components/BoardPageCanvas.tsx`; add `boardImagePath` to preload + typings

- [ ] **Step 1: Paste handler** on the page canvas — `onPaste` reads `e.clipboardData.items`, finds an `image/*` item, `getAsFile()` → read as base64 (FileReader) → `const file = await window.electronAPI.boardSaveImage(base64, ext)` → push an `image` element at canvas center (or last cursor pos) sized to natural dims (capped) → `onChange`.

- [ ] **Step 2: Drop handler** — `onDrop` for dragged image files: same path (read file → base64 → boardSaveImage → element).

- [ ] **Step 3: `boardImagePath`** — add to preload `boardImagePath: (file: string) => ipcRenderer.invoke(IPC.BOARD_IMAGE_PATH, file)` + an `IPC.BOARD_IMAGE_PATH` channel + main handler returning `path.join(projectRoot, '.cog/board/images', file)`; `BoardElementView` loads images via `file://${path}`. (Add the typing in electron.d.ts.)

- [ ] **Step 4: Verify** `npm run build` → `✓ built`. Manual: Ctrl+V a screenshot and drag-drop an image file → both appear, persist, and the file lands in `.cog/board/images/`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/BoardPageCanvas.tsx src/preload/index.ts src/renderer/electron.d.ts src/main/index.ts src/shared/types.ts
git commit -m "feat(board): paste + drop images into the page"
```

---

## Phase 5 — Drawing layer

### Task 11: Toolbar + tool state

**Files:** Create `src/renderer/components/BoardToolbar.tsx`; Modify `src/renderer/components/Workboard.tsx`

- [ ] **Step 1: Tool state** in `Workboard`: `const [tool, setTool] = useState<ToolState>({ kind: 'select', color: '#ffd400', width: 4 })` where `ToolState = { kind: 'select'|'note'|'text'|'image'|'pen'|'line'|'arrow'|'ellipse'|'eraser'; color: string; width: number }`. Pass `tool`/`setTool` to `BoardToolbar` and `tool` to `BoardPageCanvas`.

- [ ] **Step 2: `BoardToolbar`** — a floating palette of buttons that set `tool.kind`, plus a color input and a width selector. Highlight the active tool. Match the app's button styling.

- [ ] **Step 3: Verify** `npm run build` → `✓ built`. Manual: clicking tools updates active state; Note/Text/Image modes still drop elements (from Task 9/10).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/BoardToolbar.tsx src/renderer/components/Workboard.tsx
git commit -m "feat(board): tool palette + tool state"
```

---

### Task 12: Drawing canvas overlay + strokes

**Files:** Create `src/renderer/hooks/useBoardDrawing.ts`; Modify `src/renderer/components/BoardPageCanvas.tsx`

- [ ] **Step 1: Drawing overlay.** Add a `<canvas>` absolutely positioned over the element layer, same logical size, inside the zoom/pan transform (so strokes pan/zoom with content). `pointer-events: none` when `tool.kind === 'select'|'note'|'text'|'image'`; `auto` when a draw tool/eraser is active (so it captures input above elements — matches the spec's "draw on top of photos").

- [ ] **Step 2: `useBoardDrawing` hook** — given the canvas ref, current `tool`, and `page.strokes`: on pointer-down/move/up, build a stroke. Pen = accumulate points; Line/Arrow/Ellipse = `[start, current]`, redraw preview each move; Eraser = hit-test strokes near the pointer and remove. On pointer-up, append/remove from strokes and call `onChange(page with new strokes)`. Redraw all strokes whenever `page.strokes` or `zoom`/`pan` change: clear, then for each stroke draw per its `tool` (pen = polyline through points; line = segment; arrow = segment + arrowhead; ellipse = bounding-box ellipse). Convert screen↔canvas coords using the same `(screen - pan)/zoom` math as elements.

- [ ] **Step 3: Verify** `npm run build` → `✓ built`. Manual: with Select, you can grab notes under strokes; with Pen/Line/Arrow/Ellipse you draw on top of photos; Eraser removes; strokes persist + pan/zoom with the page.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/hooks/useBoardDrawing.ts src/renderer/components/BoardPageCanvas.tsx
git commit -m "feat(board): freehand + shape drawing layer above elements"
```

---

### Task 13: Undo/redo

**Files:** Modify `src/renderer/components/BoardPageCanvas.tsx` (or a `useBoardHistory.ts` hook)

- [ ] **Step 1: History stack** — keep `past: BoardPage[]` and `future: BoardPage[]` for the current page. Every committed change (element add/move/resize/delete, stroke add/erase) pushes the prior page snapshot to `past` and clears `future`. `Ctrl+Z` pops `past` → current → `future`; `Ctrl+Y`/`Ctrl+Shift+Z` reverses. Each undo/redo also calls `onChange` to persist. Cap history at ~50 entries.

- [ ] **Step 2: Verify** `npm run build` → `✓ built`. Manual: draw/add/move, Ctrl+Z reverts step-by-step, Ctrl+Y re-applies.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/BoardPageCanvas.tsx
git commit -m "feat(board): per-page undo/redo"
```

---

## Phase 6 — Rasterization (agent vision wiring)

### Task 14: Page rasterizer → render PNG

**Files:** add `html-to-image` dep; Create `src/renderer/hooks/useBoardRasterizer.ts`; Modify `src/renderer/components/BoardPageCanvas.tsx`

- [ ] **Step 1: Dependency** — `npm install html-to-image` (pure JS, no native build). Confirm it appears in `package.json` dependencies and `npm run build` still succeeds.

- [ ] **Step 2: `useBoardRasterizer`** — given a ref to the page's content wrapper (the div containing the element layer + drawing canvas, at scale 1 for export — render to an offscreen clone or temporarily reset transform), use `htmlToImage.toPng(node)` to get a dataURL. Strip the `data:image/png;base64,` prefix → base64.

  **Drawing-layer caveat (from the spec's Approach 1 fallback):** if `html-to-image` doesn't capture the `<canvas>` overlay, composite manually: `toPng` the element layer, then draw the page's strokes onto that image via an offscreen 2D canvas (reuse the stroke-draw routine from `useBoardDrawing`), then export. Implement the straightforward `toPng(wholePage)` first; only add compositing if the canvas is missing from the output.

- [ ] **Step 3: Render-on-edit** — in `BoardPageCanvas`, after `onChange` settles (debounce ~1.5s after the last edit) and on unmount (page navigate-away/close), rasterize the current page and call `window.electronAPI.boardSaveRender(page.id, base64)`.

- [ ] **Step 4: Verify** `npm run build` → `✓ built`. Manual: edit a page, wait ~2s, confirm `.cog/board/renders/page-<id>.png` exists and visually matches (notes + photo + drawing).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/renderer/hooks/useBoardRasterizer.ts src/renderer/components/BoardPageCanvas.tsx
git commit -m "feat(board): rasterize pages to .cog/board/renders on edit"
```

---

## Final verification

- [ ] **Full suite (Node ABI):** `npx vitest run --exclude "**/.claude/worktrees/**" 2>&1 | tail -6` — board tests green; only the known pre-existing `remote-server*` fixture failures remain (8).
- [ ] **Builds:** `npm run build` → `✓ built`; `npm run build:mcp` → succeeds.
- [ ] **Flip ABI back for the app:** `npm install` (electron-rebuild) so `npm run dev` runs.
- [ ] **Manual end-to-end** (`npm run dev`):
  1. Toggle into Workboard; add pages; navigate.
  2. Add notes/text; paste + drop photos; move/resize all.
  3. Pen + line + arrow + ellipse on top of a photo; eraser; undo/redo.
  4. Confirm `.cog/board/renders/page-*.png` appears after edits.
  5. From an agent: `list_board_pages` shows the pages; `view_board_page(N)` returns the PNG path and the agent can open + describe what you drew.
  6. Out-of-range page → clean error; never-rendered page → "open it first" message.

---

## Self-Review notes (author)

- **Spec coverage:** surface/pages (Tasks 7–8) ✓; element schema + notes/text/images (Tasks 1, 9) ✓; paste/drop (10) ✓; drawing layer above elements + tools (11–12) ✓; undo/redo (13) ✓; `.cog` storage split — DB structure (2), images+renders files (3,4,14) ✓; render-on-edit (14) ✓; page-number→render resolution (3,5) ✓; MCP `list_board_pages`/`view_board_page` (5,6) ✓; deferred B/C explicitly out of scope ✓.
- **Type consistency:** `BoardPage`/`BoardElement`/`BoardStroke`/`BoardTool` defined once (Task 1), used identically in store (2), files (3), bridge (5), MCP (6), and UI. `renderPathForPage` returns `string|null`; the bridge maps `null`→404 and `''`→409 (no render yet) consistently across Tasks 3/5. IPC channel names match between Task 1, preload, and handlers.
- **Verify-at-implementation callouts (not placeholders):** image-loading approach (`file://` via `boardImagePath`), `createRoutes` arg order for the route-test harness, TopBar button styling, and whether `html-to-image` captures the `<canvas>` (with a defined compositing fallback). Each is flagged in-task with how to resolve.
- **Scale:** large but single cohesive feature; phases are independently testable. If executing subagent-driven, Phases 1–2 are TDD-heavy (cheap/standard model); Phases 3–6 are UI integration (standard model, manual verification per task).
