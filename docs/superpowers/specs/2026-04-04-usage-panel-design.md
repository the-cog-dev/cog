# Usage Panel

**Date:** 2026-04-04
**Status:** Approved

## Problem

Users running multiple agents across different CLIs/providers have no visibility into their usage limits or session activity. They have to check each provider's dashboard individually.

## Solution

A "Usage" panel that shows per-agent activity tracking (free, always available) and on-demand provider limit checks (sends `/usage` to agent PTY only when user clicks Refresh).

## Two Data Sources

### Approach C: Hub Activity Tracking (free, automatic)

Track counters in the hub as messages/tasks flow through — zero extra cost since we already process this data.

Per-agent counters:
- `messagesSent` — incremented on each `send_message` from this agent
- `messagesReceived` — incremented on each message delivered to this agent
- `tasksPosted` — tasks created by this agent
- `tasksClaimed` — tasks claimed
- `tasksCompleted` — tasks completed
- `infoPosted` — info entries posted
- `toolCalls` — total MCP tool invocations
- `spawnedAt` — timestamp when agent was spawned (for "active time" calculation)

Stored in a new `AgentMetrics` map in the hub, keyed by agent name. Reset on project switch.

### Approach B: Provider Limits (on-demand)

Only fetched when user clicks "Refresh" in the Usage panel:

1. For each active agent, send `/usage\r` to their PTY
2. Wait ~3 seconds for response to appear in OutputBuffer
3. Scan the new output lines for usage data
4. Parse with CLI-specific regex patterns
5. Display parsed results

CLI-specific parsing:
- **Claude:** Look for lines containing remaining messages, token counts
- **Codex:** Look for request/token usage lines
- **Gemini:** Look for RPD/TPM remaining
- **Kimi:** Look for usage data
- **OpenClaude:** Depends on underlying provider
- **Unknown format:** Show raw output, let user interpret

Parsing is best-effort — if we can't parse, show "Unable to parse usage data" with the raw text.

## UI Component

### UsagePanel.tsx

New panel, toggled from TopBar like other panels.

```
┌────────────────────────────────────────┐
│ Usage                       [Refresh]  │
├────────────────────────────────────────┤
│                                        │
│ orchestrator (claude opus)             │
│ ┌────────────────────────────────────┐ │
│ │ Provider: 3,247 / 45,000 msgs     │ │
│ │ ████████████████░░░░  72% used    │ │
│ │                                    │ │
│ │ Session Activity:                  │ │
│ │ 14 sent · 8 received · 3 tasks    │ │
│ │ 2 info · 22m active               │ │
│ └────────────────────────────────────┘ │
│                                        │
│ worker-1 (claude sonnet)               │
│ ┌────────────────────────────────────┐ │
│ │ Provider: 8,102 / 45,000 msgs     │ │
│ │ ██████░░░░░░░░░░░░░░  18% used    │ │
│ │                                    │ │
│ │ Session Activity:                  │ │
│ │ 47 sent · 12 received · 5 tasks   │ │
│ │ 0 info · 18m active               │ │
│ └────────────────────────────────────┘ │
│                                        │
│ researcher (gemini 2.5 pro)            │
│ ┌────────────────────────────────────┐ │
│ │ Provider: Click Refresh to check   │ │
│ │                                    │ │
│ │ Session Activity:                  │ │
│ │ 12 sent · 3 received · 0 tasks    │ │
│ │ 8 info · 31m active               │ │
│ └────────────────────────────────────┘ │
│                                        │
│ Last refreshed: 4:15 AM               │
└────────────────────────────────────────┘
```

## Implementation

### New Files
- `src/main/hub/agent-metrics.ts` — AgentMetrics class (counter tracking)
- `src/renderer/components/UsagePanel.tsx` — Usage panel component

### Modified Files
- `src/shared/types.ts` — Add IPC channels, metrics interface
- `src/main/hub/server.ts` — Add AgentMetrics to hub
- `src/main/hub/message-router.ts` — Increment message counters
- `src/main/hub/pinboard.ts` — Increment task counters
- `src/main/hub/info-channel.ts` — Increment info counters
- `src/main/index.ts` — Add usage IPC handlers (get metrics, trigger /usage)
- `src/preload/index.ts` — Expose usage IPC
- `src/renderer/components/TopBar.tsx` — Add Usage toggle
- `src/renderer/components/Workspace.tsx` — Add UsagePanel rendering
- `src/renderer/App.tsx` — Add Usage panel state

### IPC Channels

```ts
USAGE_GET_METRICS: 'usage:get-metrics'      // → AgentMetrics[]
USAGE_REFRESH_LIMITS: 'usage:refresh-limits' // → triggers /usage on all agents, returns parsed results
```

### AgentMetrics Interface

```ts
interface AgentMetrics {
  agentName: string
  cli: string
  model: string
  messagesSent: number
  messagesReceived: number
  tasksPosted: number
  tasksClaimed: number
  tasksCompleted: number
  infoPosted: number
  spawnedAt: string
  providerUsage?: {
    used: number
    total: number
    unit: string      // "messages", "requests", "tokens"
    raw?: string      // raw output if parsing failed
  }
}
```

### /usage Output Capture

When "Refresh" is clicked:
1. Main process sends `/usage\r` to each agent's PTY
2. Records current OutputBuffer line count
3. After 3 seconds, reads new lines from OutputBuffer
4. Passes new lines to CLI-specific parser
5. Returns parsed data (or raw text if unparseable)

### What Doesn't Change

- MCP tools — no new tools
- Hub routes — no new routes (metrics are internal)
- Agent behavior — agents don't know about usage tracking
- Nudge system — unaffected
