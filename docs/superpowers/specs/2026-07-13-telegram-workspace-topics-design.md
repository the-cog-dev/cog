# Telegram per-workspace routing via supergroup forum topics

_Design spec. Goal: give each workspace its own Telegram thread so N concurrent
orchestrators stop dumping into one flat DM. One bot + one supergroup with
Topics; each workspace ↔ one forum topic; the thread you type in IS the address.
DM relay stays as the default and the failure fallback._

## Problem

Workspaces now run concurrently in one process (each = folder + hub + team). The
Telegram relay is still DM-based: every workspace's orchestrator relays into one
private chat, each line tagged `[Project]`, addressed by `/cog` / `/use`. With
several live orchestrators this is a flat, interleaved soup — the messy stage we
want to avoid.

## Chosen approach (A)

**One bot + one supergroup with forum Topics.** Each workspace auto-gets its own
topic (thread). The orchestrator's conversation lives in that thread; you reply
in-thread and it routes straight to that workspace — no prefixes, no `/cog`.
Rejected alternatives: a bot-per-workspace (N BotFather tokens, DM-only so no
teammates, ongoing friction); staying on prefixed DMs (the current mess).

## Modes

A `telegram.mode` setting:
- **`dm`** (default) — today's behavior. Nothing changes for single-workspace
  users; no supergroup required.
- **`topics`** — the supergroup mode below. Entered by binding a supergroup once.

DM is the fallback in **two** senses: the default until you opt in, AND the
degradation path when a topics-mode operation fails (so a message is never
silently dropped).

## Data model

Persisted in `settings.telegram` (app-global — the supergroup is one, workspaces
are per-app; thread ids are meaningless without the supergroup id, so they live
together):

```
telegram: {
  mode: 'dm' | 'topics',
  supergroupChatId?: number,           // the bound supergroup's chat id
  topics?: { [workspaceId]: { threadId: number, name: string } }
}
```

A pure **`TopicRegistry`** (mirrors `ContextRegistry`'s style — no grammY, no I/O)
owns the map and is the single source of routing truth:
- `threadFor(workspaceId): number | undefined`
- `workspaceFor(threadId): string | undefined`  (reverse map)
- `set(workspaceId, threadId, name)`, `remove(workspaceId)`, `rename(...)`,
  `list()`
Fully unit-tested in isolation.

## Lifecycle — threads follow the CONTEXT, not the active tab

The key modeling decision: a thread is open iff the workspace's **context is
live**, NOT iff its tab is active. Because contexts run concurrently in the
background, every live workspace keeps an open thread simultaneously; you drop
into whichever by tapping it. Threads hook the lifecycle functions already built
in `src/main/index.ts`:

| App event | Telegram action |
|---|---|
| `createWorkspaceContext` (open / restore a workspace) | create topic, or reopen if a stored threadId exists → store threadId |
| tab switch (`activateWorkspace`) | **nothing** — background threads stay open |
| `closeWorkspaceContext` (close a tab) | `closeForumTopic(threadId)` — archive, keep history + mapping |
| workspace rename | `editForumTopic(threadId, newName)` |
| app quit (`closeAllContexts`) | close all topics; boot restore reopens them |

Topic name = workspace name (folder basename). Closing archives (history kept)
so reopen restores the same thread.

Two distinct "close" paths, both routed through `closeWorkspaceContext`:
- **App quit** (`closeAllContexts`) archives every topic; the workspaces persist
  in `workspaceManager`, so boot restore reopens them.
- **Tab close** (user removes the workspace) archives that one topic; the
  workspace is gone from `workspaceManager`, so it won't reopen. Its mapping
  entry is left orphaned (harmless); a follow-up may prune on tab-close.

## Routing

**Outbound (agent → you).** Agent output already flows through the per-context
factory hooks, which know their `workspaceId`. The relay call carries that id;
the Telegram server maps `workspaceId → threadId` and sends to
`supergroupChatId` with `message_thread_id`. No `[Project]` prefix — the thread
is the identity. If no thread resolves or the send fails → DM relay (prefixed)
so nothing is lost.

**Inbound (you → agent).** A reply inside a thread carries `message_thread_id`;
reverse-map `threadId → workspaceId` → hand off to **that workspace's own local
hub/orchestrator** (context is local + live → direct, no `/cog`, no
active-target guessing).

**General topic** (supergroup default, no thread id): the global command/console
lane — `/status` (all workspaces), `/help`, `/bind`, `/unbind`. Not tied to a
workspace.

**Thread-scoped commands.** `/status` inside a workspace thread shows just that
team; `/use <agent>` scopes to that thread's workspace.

## Setup, trust, resilience

**Binding (one-time).** User creates a supergroup, enables Topics, adds the bot
as admin with **Manage Topics**, runs `/bind` in the group. The bot captures
`chat.id`, verifies `chat.is_forum` + admin right, sets `mode = topics`,
persists, and creates topics for every currently-live workspace. `/unbind`
reverts to DM. Settings shows bind status + the step list (extends the existing
supergroup-help section).

**Trust model.** DM mode: the pairing allowlist. Topics mode: **membership in
the bound supergroup** — the user controls who's in the group. Solo now, add
teammates later, zero extra auth code.

**Resilience (DM fallback in action):**
- Bot not admin / lacks Manage Topics → topic op fails → warn once + relay that
  message via DM.
- Group isn't a forum → `/bind` rejects: "enable Topics first."
- A thread is manually deleted → next send hits "thread not found" → auto-recreate
  the topic, update the map, resend.
- Bot kicked / supergroup gone → warn, degrade to DM, prompt re-bind.
- Telegram 429 rate limits → grammY auto-retry (topic creation is infrequent).

**Persistence & boot.** `settings.telegram` survives restart. On boot, after
contexts restore, ensure each live workspace's topic is open (reopen any closed).

## Relationship to the existing gateway / federation

With workspaces in one process, topics routing is entirely **in-process**
(`threadId → local context → local hub`). The cross-process federation and
`/cog` switching go dormant in topics mode; the single-poller gateway election
stays as the safety net for the rare true-multi-process case.

## Components / boundaries

- `TopicRegistry` (new, pure) — workspaceId ↔ threadId map + persistence shape.
  Unit-tested.
- `telegram-server.ts` (extend) — topic create/close/reopen/rename via grammY;
  outbound send with `message_thread_id`; inbound `message_thread_id` →
  workspace resolution; `/bind` / `/unbind`; DM fallback wrapper.
- `index.ts` (wire) — call topic lifecycle from `createWorkspaceContext` /
  `closeWorkspaceContext` / rename / `closeAllContexts` / boot restore, passing
  `workspaceId` into the relay.
- Settings UI — mode/bind status + supergroup setup steps.

## Testing

- `TopicRegistry` smoke suite (map, both-way resolution, naming, add/remove,
  persistence round-trip) — pure, runs without Electron/DB (the better-sqlite3
  ABI blocks DB tests, same constraint as `ContextRegistry`).
- Inbound/outbound resolution is pure → unit-tested.
- Telegram API calls ride the existing `telegram-server.test.ts` mock-bot
  harness (add topic-create/close + thread-routing cases).
- Live verification: bind a supergroup, open 2 workspaces → 2 threads; reply in
  each → routes to the right team; close a tab → thread archives; restart →
  threads reopen.

## Out of scope (YAGNI)

- Per-workspace bot tokens.
- Teammate ACLs beyond "is in the supergroup."
- Migrating existing DM history into topics.
- Auto-detecting the supergroup without an explicit `/bind`.
