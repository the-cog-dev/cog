# Agent Communication Graph

**Date:** 2026-04-04
**Status:** Approved

## Problem

All agents share a single global message/task/info space. Loading multiple presets or teams creates chaos — everyone sees everyone's tasks and messages. No way to isolate teams working on different concerns.

## Solution

A visual node graph system (Blender-inspired) where users drag links between agent windows to create communication groups. Connected clusters auto-form named groups with scoped messaging, tasks, and info. Unlinked agents retain global access for backward compatibility.

## Link Ports + Drag-to-Connect

Each FloatingWindow gets a **link port** — a small colored dot on its right edge (8px circle). Interaction:

1. User clicks and drags from an agent's link port
2. A line follows the cursor across the canvas
3. User drops on another agent's window
4. Link is created — a persistent SVG line connects the two agents on the canvas
5. Connected cluster is auto-detected and assigned a group

Link ports only appear on agent windows (not panels like Pinboard, Files, etc.).

### Link Management

- **Create:** Drag from port to agent window
- **Delete:** Right-click a link line → "Remove Link"
- **Visual:** Lines colored by group (each group gets a unique color from a palette)
- **Persistence:** Links saved to `.agentorch/links.json` per-project

## Groups

### Auto-Detection

When links change, groups are recalculated by graph traversal (connected components). Each connected component = one group.

```
A ── B ── C     → Group 1 (A, B, C)
D ── E          → Group 2 (D, E)
F               → Unlinked (global)
```

### Group Properties

```ts
interface AgentGroup {
  id: string           // auto-generated UUID
  name: string         // auto: "Group 1", user can rename
  color: string        // from palette, for link lines
  members: string[]    // agent names
}
```

### Group Naming

- Auto-named: "Group 1", "Group 2", etc.
- User can rename by clicking the group label (future enhancement)

## Scoping Rules

### Instant Isolation (on link creation)

When agents are linked into a group, new messages/tasks/info are scoped. Old unscoped content remains visible.

### Message Scoping

- `send_message(to, message)` — if sender has a groupId:
  - Target must be in the same group OR unlinked. Otherwise returns error: "Agent not in your group"
  - Message tagged with sender's groupId
- `get_messages()` — returns messages where:
  - message.groupId matches agent's groupId, OR
  - message.groupId is null (unscoped/global), OR
  - message is specifically addressed to this agent
- `broadcast(message)` — scoped to group members only (if in a group). Unlinked agents broadcast to everyone.

### Task Scoping

- `post_task()` — tagged with poster's groupId
- `read_tasks()` — returns tasks where:
  - task.groupId matches agent's groupId, OR
  - task.groupId is null (unscoped)
- `claim_task()` / `complete_task()` / `abandon_task()` — only if task is in your group or unscoped

### Info Scoping

- `post_info()` — tagged with poster's groupId
- `read_info()` — filtered by agent's groupId (or unscoped)

### Unlinked Agents = Global

An agent with no links has no groupId. It:
- Sees ALL messages, tasks, and info (all groups + unscoped)
- Can message ANY agent regardless of group
- Posts unscoped content (visible to everyone)

This is the default behavior and backward compatible.

## Data Model Changes

### New Fields

```ts
// On AgentConfig / AgentState
groupId?: string    // set by link system, null = global

// On Message
groupId?: string    // scoped to this group, null = global

// On PinboardTask
groupId?: string

// On InfoEntry
groupId?: string
```

### Link State (persisted per-project)

```ts
// .agentorch/links.json
interface LinkState {
  links: Array<{ from: string; to: string }>  // agent name pairs
  groups: AgentGroup[]                          // computed from links
}
```

## Hub Changes

### MessageRouter

- `send()` — check group membership before delivery. Reject cross-group messages (unless sender or target is unlinked).
- Tag outgoing messages with sender's groupId.
- `getMessages()` — filter by agent's groupId.

### Pinboard

- `postTask()` — accept optional groupId, default to poster's groupId.
- `readTasks()` — accept optional groupId filter. Default to caller's groupId.
- `claimTask()` — only allow if task is in agent's group or unscoped.

### InfoChannel

- `postInfo()` — tag with poster's groupId.
- `readInfo()` — filter by groupId.

### Routes

- All existing routes continue to work (groupId filtering happens in the business logic, not routes)
- New route: `GET /groups` — returns current group structure
- New route: `POST /agents/:name/group` — set agent's groupId (called by main process when links change)

## MCP Tool Changes

- `send_message()` — cross-group sends return error with `isError: true`
- `get_agents()` — includes `groupId` field on each agent
- `read_tasks()` / `read_info()` — auto-filtered by caller's group
- New tool: `get_my_group()` — returns group name, members, and your role in it

## Visual Layer (Workspace)

### SVG Overlay

An SVG layer sits on top of the workspace canvas (below floating windows, above the background). It renders:
- Persistent link lines between connected agents
- Lines follow window positions (update on drag via the existing `onDragStop` callback)
- Lines colored by group color
- Curved bezier paths (not straight lines) for Blender aesthetic

### Link Port Rendering

In FloatingWindow, add a link port element:
- 8px circle on the right edge, vertically centered
- Colored matching the agent's group color (white if unlinked)
- Cursor changes to crosshair on hover
- On mousedown: start drag → render temporary line to cursor
- On mouseup over another agent's window: create link

### Link Drawing State

```ts
interface LinkDrawState {
  drawing: boolean
  fromAgent: string      // agent name being dragged from
  fromX: number          // port position
  fromY: number
  mouseX: number         // current cursor position
  mouseY: number
}
```

### Interaction Flow

1. Hover over link port → port grows slightly, cursor: crosshair
2. Mousedown on port → enter link-drawing mode
3. Mousemove → SVG temp line follows cursor
4. Mouseup over another agent's window → create link, recalculate groups
5. Mouseup over empty space → cancel

## What Doesn't Change

- Agent spawn flow
- CLI launch
- MCP server process
- Presets/templates (links are separate from presets for now)
- R.A.C. integration (R.A.C. agents start unlinked, can be linked)
- Skills system
- File operations
- Buddy Room

## Decomposition

This feature has two independent pieces that should be built separately:

**Phase A: Backend (hub scoping)** — Add groupId to data models, filtering in MessageRouter/Pinboard/InfoChannel, new MCP tool. Testable without UI.

**Phase B: Frontend (visual links)** — Link ports, SVG overlay, drag interaction, link persistence, group color palette. Depends on Phase A.
