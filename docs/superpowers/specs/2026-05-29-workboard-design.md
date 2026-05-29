# Workboard — Visual Canvas Book with Agent Vision — Design

**Date:** 2026-05-29
**Status:** Approved (brainstorm) — ready for implementation plan
**Scope:** V1 = full board (pages, notes, text, photos, freehand drawing, per-project save) + agent-vision via rendered PNG (approach "A"). Structured-content serialization ("B"/"C") is a deferred follow-up.

---

## Overview

A dedicated **Workboard** surface inside The Cog: a per-project, multi-page visual canvas — a "book on your desk" — for sketching designs, dropping reference photos, sticky notes, text, and freehand drawing (markers, lines, arrows, circles) on top of it all. Pages persist with the project (e.g. the Sims 2 workspace).

The defining feature: agents can **see** a page. Each page is flattened to a PNG on edit; two MCP tools let an agent list pages and view any page as an image — so "check page 3" means the agent literally sees your photo, your circled kitchen, and your notes.

## Goals

- A toggled, full-surface Workboard separate from the agent canvas.
- Ordered pages (`1..N`): add, delete, navigate, jump.
- Elements: sticky notes, text blocks, pasted/dropped photos — all move/resize.
- Freehand drawing layer **above** elements: pen + line/arrow/ellipse shapes + eraser, with color/width and undo/redo.
- Per-project persistence in `.cog/` (structure in DB, images + renders as files).
- Agent vision (approach A): `view_board_page(n)` returns a rendered PNG path; `list_board_pages()` summarizes.

## Non-Goals (V1)

- Structured/text serialization of page content for agents (approach B/C) — deferred.
- Mobile/remote *editing* of the board (agent-vision works remotely regardless).
- Real-time multi-cursor collaboration.
- Per-element rich text / fonts beyond a size; arbitrary shape library beyond line/arrow/ellipse.

## Chosen approach

**DOM elements + a per-page drawing `<canvas>` layer, rasterized with an html-to-image library** (approach 1 of 3 considered; full-canvas-engine and manual-canvas-compositing were the alternatives). This maximizes reuse of the Cog's existing `Workspace` pan/zoom and `FloatingWindow` drag/resize, keeps text editing ergonomic, and gives drawing a true canvas. Fallback if the lib mishandles the canvas overlay: composite the drawing canvas onto the snapshot manually.

---

## Architecture

Four units, each with one job:

1. **Workboard surface (renderer)** — the toggled view: page navigator + active page canvas (reuses `Workspace` pan/zoom). One component tree, isolated from the agent workspace.
2. **Board store (main)** — per-project SQLite persistence of pages/elements/strokes; image + render file management under `.cog/board/`.
3. **Rasterizer (renderer)** — flattens a page (DOM element layer + drawing canvas) to a PNG on edit/navigate/close; ships bytes to main to save.
4. **Agent-vision MCP tools** — `list_board_pages`, `view_board_page(n)`, backed by hub routes that resolve page-number → render file path.

### Data model (`src/shared/types.ts`)

```ts
export type BoardTool = 'pen' | 'line' | 'arrow' | 'ellipse'

export interface BoardStroke {
  id: string
  tool: BoardTool
  color: string
  width: number
  points: { x: number; y: number }[]   // pen: many points; shapes: [start, end]
}

export type BoardElement =
  | { type: 'note';  id: string; x: number; y: number; w: number; h: number; text: string; color: string; z: number }
  | { type: 'text';  id: string; x: number; y: number; w: number; h: number; text: string; fontSize: number; z: number }
  | { type: 'image'; id: string; x: number; y: number; w: number; h: number; file: string; z: number }  // file = name under .cog/board/images/

export interface BoardPage {
  id: string            // stable uuid; render file is page-<id>.png
  orderIndex: number    // 1-based position in the book (what the user/agent calls "page N")
  elements: BoardElement[]
  strokes: BoardStroke[]
}
```

### Storage (per project, under `.cog/`)

- **Structure** → new `board_pages` table in `.cog/cog.db`: `(id TEXT PK, order_index INTEGER, elements TEXT json, strokes TEXT json)`. One row per page. Migration is additive (`CREATE TABLE IF NOT EXISTS`), consistent with existing stores.
- **Pasted photos** → `.cog/board/images/<uuid>.png` (clipboard/drop image bytes written via IPC). Elements reference by filename only — keeps the DB lean and gives the rasterizer/MCP real paths.
- **Rendered snapshots** → `.cog/board/renders/page-<id>.png`, regenerated on edit (debounced), on navigate-away, and on Workboard close.

### Components / files (informs the plan; exact wiring decided there)

- Create: `src/renderer/components/Workboard.tsx` (surface + navigator), `BoardPageCanvas.tsx` (one page: element layer + drawing canvas + pan/zoom), `BoardToolbar.tsx`, `BoardElement` renderers (note/text/image), `useBoardDrawing.ts` (stroke capture), `useBoardRasterizer.ts` (page → PNG).
- Create: `src/main/db/board-store.ts` (pages CRUD), board file helpers under `.cog/board/`.
- Modify: `src/shared/types.ts` (types + IPC channels), `src/main/index.ts` (board IPC handlers, image/render file writes, page-render-path resolution), `src/preload/index.ts` + `src/renderer/electron.d.ts` (board API), `src/main/db/database.ts` (migration), `src/main/hub/routes.ts` + `src/main/hub/server.ts` (board-vision routes via an injected accessor, mirroring the schedule-bridge pattern), `src/mcp-server/index.ts` (two tools), `src/renderer/App.tsx` (Workboard toggle/view).

---

## Interactions

- **Tool palette:** Select · Note · Text · Image · | Pen · Line · Arrow · Ellipse · Eraser · | color · width · | undo · redo.
- **Elements:** select/drag/resize (FloatingWindow handles), double-click to edit text, `Delete` removes, basic z-order.
- **Images:** Ctrl+V paste or drag-drop → bytes saved to `.cog/board/images/` → placed as resizable image element.
- **Drawing layer is above elements.** In **Select** mode the drawing canvas is `pointer-events:none` (so you can grab elements beneath); selecting any draw tool makes it capture input. Pen = freehand points; Line/Arrow/Ellipse = drag-to-draw; Eraser removes strokes.
- **Canvas:** Select mode → drag-empty pans, Ctrl+scroll zooms (existing mechanics). Draw tool active → drag draws (zoom still works).
- **Undo/redo:** per-page history stack of element + stroke actions.

## Rasterization & agent vision

- **Render-on-edit (renderer):** debounce ~1.5s after the last change (and on navigate-away / board close) → flatten the active page = html-to-image snapshot of the element layer + composite the drawing canvas on top → PNG → IPC → main saves `.cog/board/renders/page-<id>.png`.
- **Page-number resolution:** `view_board_page(n)` maps `n` (1-based `order_index`) → page `id` → render file. Correct across add/delete/reorder because `order_index` is the source of truth.
- **MCP tools** (added to the per-project `agentorch` server, backed by hub routes + a main-process accessor like the schedule bridge):
  - `list_board_pages()` → `{ count, pages: [{ page, elementCount, noteSnippets? }] }`.
  - `view_board_page(page)` → absolute path to the render PNG; the agent opens it with its own image/vision read. If the page exists but has no render yet → a clear message ("open page N in the Workboard to render it").

## Testing

- **Unit (main):** `board-store` round-trip (pages/elements/strokes persist + reorder); page-number→render-path resolution (incl. out-of-range and never-rendered cases); MCP/route responses for `list_board_pages` and `view_board_page` (valid, out-of-range, no-render-yet) using a fake accessor.
- **Manual (renderer/UI):** add/move/resize notes/text/photos; paste + drop images; pen + line/arrow/ellipse + eraser; undo/redo; page add/delete/navigate; confirm a rendered PNG appears under `.cog/board/renders/`; end-to-end agent `view_board_page` actually shows the page. Captured in the testing-notes file.

## Out of scope / deferred

- **B/C structured content** — return per-element text + stroke descriptions alongside the PNG so non-vision CLIs get full content and vision agents get both. Natural next phase; the MCP tool shape already accommodates adding fields.
- Mobile board editing; collaboration; richer typography/shape library.
