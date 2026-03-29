# Infinite Canvas Workspace — Design Spec

**Date:** 2026-03-29
**Status:** Draft
**Depends on:** AgentOrch MVP (complete)

## Problem

The workspace clips floating windows to the Electron window edges. Users can't place agents outside the visible area or zoom out for a bird's eye view. More agents = more crowding, no way to organize spatially.

## Solution

Transform the workspace into an infinite canvas with zoom and pan. Windows live in unbounded canvas space. A CSS `transform: translate() scale()` on the canvas container handles the viewport. FloatingWindow must be refactored from uncontrolled to controlled positioning (a prerequisite for this feature and for zoomToFit).

## Architecture

```
┌─ Workspace (viewport, clips to screen edge) ──────────┐
│                                                         │
│  ┌─ Canvas div (transform: scale + translate) ───────┐ │
│  │                                                     │ │
│  │   [FloatingWindow]       [FloatingWindow]          │ │
│  │                                                     │ │
│  │            [FloatingWindow]                        │ │
│  │                                                     │ │
│  │                  ... infinite space ...             │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                         │
│                        [- 75% + Reset] ← zoom control  │
└─────────────────────────────────────────────────────────┘
```

The Workspace div is the viewport (same size as the Electron window minus the TopBar). It has `overflow: hidden`. Inside it, a canvas div holds all FloatingWindows and is transformed via CSS `transform: translate(panX, panY) scale(zoom)` with `transform-origin: 0 0`.

Windows store their positions in canvas space (unaffected by zoom/pan). The CSS transform is view-only — it doesn't change the underlying data.

## Canvas Transform

**CSS on the canvas div:**
```css
transform: translate(panXpx, panYpx) scale(zoom);
transform-origin: 0 0;
```

CSS transforms apply right-to-left: scale happens first (in canvas space), then translate (in screen space). This means **pan is stored in screen-space pixels** — panning feels consistent regardless of zoom level.

**Zoom range:** 0.25 (25%) to 2.0 (200%). Default: 1.0 (100%).

**Pan:** Stored as `{x: number, y: number}` in **screen-space pixels**. Default: `{x: 0, y: 0}`.

**No boundaries:** The canvas div has no fixed width/height. Windows can be at negative coordinates, thousands of pixels from origin — the canvas is conceptually infinite.

## Coordinate Translation

When the canvas is scaled, mouse events from react-rnd are in screen space but window positions are in canvas space. Translation is needed for drag and resize.

**Drag:** react-rnd `onDrag` reports position in screen pixels relative to the parent. Divide by zoom to convert to canvas space. At 50% zoom, moving 100 screen pixels = 200 canvas pixels.

**Resize:** Same principle — delta values from `onResize` are divided by zoom.

**Click targets (buttons, focus):** No translation needed. CSS transform scales hit areas naturally — a button at 50% zoom is visually smaller but still clickable at its rendered position.

**Implementation:** FloatingWindow receives a `zoom` prop. Its `onDrag` and `onResize` callbacks divide position/size deltas by zoom before updating state.

## Controls

### Zoom
- **Ctrl+Scroll** on workspace: zoom in/out, centered on the cursor position
- **Zoom control** in bottom-right corner: `[-] 75% [+] [Reset]` buttons
- **Ctrl+0**: reset to 100% zoom, center on origin
- **Ctrl+Shift+0**: auto-zoom to fit all windows in the viewport

### Pan
- **Middle-click drag** on empty canvas: pan
- **Ctrl+drag** on empty canvas: pan (trackpad-friendly alternative)
- **Scroll wheel** on empty canvas (no Ctrl): pan vertically

### Scroll inside terminals
- **Scroll wheel over a terminal window**: scrolls the terminal content (xterm.js scrollback), NOT the canvas zoom. This is critical — the event must not propagate to the workspace zoom handler when the cursor is over a terminal.

## Zoom-to-Cursor

When zooming with Ctrl+Scroll, the zoom should be centered on the cursor position (like Figma). This means the point under the cursor stays fixed while everything scales around it.

**Math:**
```
// Before zoom: cursor is at screen position (screenX, screenY)
// Convert to canvas space:
canvasX = (screenX - panX) / oldZoom
canvasY = (screenY - panY) / oldZoom

// After zoom: adjust pan so (canvasX, canvasY) stays at (screenX, screenY)
newPanX = screenX - canvasX * newZoom
newPanY = screenY - canvasY * newZoom
```

## Zoom-to-Fit

Calculates a bounding box around all windows, then sets zoom and pan to fit the entire bounding box in the viewport with some padding.

**Algorithm:**
1. Find min/max x, y across all window positions and sizes (canvas space)
2. Calculate bounding box width and height
3. Set zoom to `min(viewportWidth / (bboxWidth + padding), viewportHeight / (bboxHeight + padding))`
4. Clamp zoom to [0.25, 2.0]
5. Set pan to center the bounding box in the viewport

## State Changes

### useWindowManager hook additions

New state:
- `zoom: number` — current zoom level (default 1.0)
- `pan: {x: number, y: number}` — current pan offset (default {0, 0})

New functions:
- `setZoom(level: number)` — set zoom, clamped to [0.25, 2.0]
- `setPan(x: number, y: number)` — set pan offset (screen-space pixels)
- `zoomToFit(viewportWidth: number, viewportHeight: number)` — auto-fit all windows
- `updateWindowPosition(id: string, x: number, y: number)` — update a window's canvas-space position (called by onDragStop)
- `updateWindowSize(id: string, width: number, height: number)` — update a window's size (called by onResizeStop)

Modified functions:
- `addWindow` — place new windows near the center of the current viewport, converting viewport center to canvas space: `canvasX = (viewportWidth/2 - pan.x) / zoom`

### WindowState — no changes

Windows still store `x, y, width, height` in canvas space. The transform is a view concern, not a data concern.

## Component Changes

### Workspace.tsx
- Add inner canvas div with CSS transform
- Add zoom/pan event handlers (Ctrl+scroll, middle-click drag, Ctrl+drag)
- Add zoom control UI in bottom-right corner (positioned absolute, outside canvas transform)
- Pass `zoom` prop to FloatingWindow
- Scroll event handling: the Workspace's `onWheel` handler checks `event.ctrlKey` — if Ctrl is held, zoom; otherwise ignore (let xterm.js handle terminal scroll). TerminalWindow adds `stopPropagation()` on wheel events to prevent zoom when scrolling terminal content with Ctrl held.
- Zoom/pan transitions: `zoomToFit` and `Ctrl+0 reset` use a CSS transition (`transition: transform 0.2s ease`) for smooth animation. Real-time `Ctrl+Scroll` zooming disables the transition (set `transition: none` during active scroll, re-enable after 150ms idle). Disable Electron's default `Ctrl+0` zoom-reset behavior.

### FloatingWindow.tsx (refactor from uncontrolled to controlled)

Currently FloatingWindow uses `default` prop on Rnd (uncontrolled — react-rnd manages position internally). This must be refactored to **controlled positioning** using `position` and `size` props with `onDragStop`/`onResizeStop` callbacks that update `useWindowManager` state. This is a prerequisite for zoom coordinate correction and for zoomToFit (which needs to know actual window positions).

Changes:
- Switch from `default` to `position`/`size` props on Rnd (controlled mode)
- Accept `zoom: number` prop
- Remove `bounds="parent"` — windows are no longer constrained
- `onDragStop`: report new position to parent, dividing by zoom to convert screen → canvas space
- `onResizeStop`: report new size/position to parent, dividing by zoom
- When maximized: use a **React portal** to render the window directly in the Workspace viewport div (outside the transformed canvas). This ensures maximize fills the viewport regardless of zoom/pan, without complex inverse-transform math.

### useWindowManager.ts
- Add zoom/pan state and functions
- Add zoomToFit calculation

### App.tsx
- Pass zoom/pan state to Workspace
- Add Ctrl+0 and Ctrl+Shift+0 keyboard shortcuts

## What Doesn't Change

- **FloatingWindow** internal structure (title bar, buttons, content area) — unchanged, but positioning refactored to controlled mode
- **TerminalWindow / xterm.js** — scales naturally via CSS transform (add `stopPropagation` on wheel events)
- **TopBar** — stays outside the canvas, unaffected by zoom
- **SpawnDialog** — modal overlay, unaffected
- **AgentPill** — in TopBar, unaffected
- **All backend code** — hub, MCP, PTY, message routing — completely unaffected
- **Shared types** — no changes

## Edge Cases

- **New window spawn position:** When spawning a new agent, place the window near the center of the current viewport (not at canvas origin). Convert viewport center to canvas space using current zoom/pan.
- **Maximized window at non-100% zoom:** Maximize renders the window via a React portal directly in the Workspace viewport div (outside the canvas transform), filling the viewport regardless of zoom/pan. Un-maximizing moves it back into the canvas.
- **xterm.js rendering at low zoom:** xterm.js text becomes very small at 25% zoom. This is expected and matches the Figma model — zoom in to read, zoom out for overview.
- **Performance:** CSS transforms are GPU-accelerated. No per-frame JavaScript. Even with 10+ terminal windows, performance should be fine.
