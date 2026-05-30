import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// Support both CLI args (for codex/kimi) and env vars (for claude).
// CLI args: node index.js <port> <secret> <agent_id> <agent_name...>
// Agent name can contain spaces — everything from arg[3] onward is joined.
// Env var resolution: prefer COG_* (new), fall back to AGENTORCH_* (legacy) so
// in-flight agents spawned before the rebrand keep working.
const env = process.env
const args = process.argv.slice(2)
const HUB_PORT = args[0] || env.COG_HUB_PORT || env.AGENTORCH_HUB_PORT
const HUB_SECRET = args[1] || env.COG_HUB_SECRET || env.AGENTORCH_HUB_SECRET
const AGENT_ID = args[2] || env.COG_AGENT_ID || env.AGENTORCH_AGENT_ID
// Agent name resolution priority:
//   1. Positional args (codex via `mcp add ... -- node script port secret id name...`)
//   2. COG_AGENT_NAME / AGENTORCH_AGENT_NAME env var (claude/openclaude/kimi via mcp-config.json)
//   3. COG_AGENT_NAME_ENC / AGENTORCH_AGENT_NAME_ENC env var, URL-decoded (gemini via `-e` flags
//      — encoding avoids cross-shell quoting issues for names with spaces/dots/special chars)
let resolvedAgentName: string | undefined =
  (args.length > 3 ? args.slice(3).join(' ') : undefined) ||
  env.COG_AGENT_NAME ||
  env.AGENTORCH_AGENT_NAME
const encodedName = env.COG_AGENT_NAME_ENC || env.AGENTORCH_AGENT_NAME_ENC
if (!resolvedAgentName && encodedName) {
  try {
    resolvedAgentName = decodeURIComponent(encodedName)
  } catch {
    resolvedAgentName = encodedName
  }
}
const AGENT_NAME = resolvedAgentName
const TAB_ID = env.COG_TAB_ID || env.AGENTORCH_TAB_ID || undefined

if (!HUB_PORT || !HUB_SECRET || !AGENT_ID || !AGENT_NAME) {
  console.error('Cog MCP server: missing connection info.')
  console.error('Usage: node index.js <port> <secret> <agent_id> <agent_name>')
  console.error('Or set COG_HUB_PORT, COG_HUB_SECRET, COG_AGENT_ID, COG_AGENT_NAME')
  process.exit(1)
}

/**
 * Resolve the host the hub is reachable at.
 *
 * Default: 127.0.0.1 — works for native Windows / macOS / Linux agents that
 * share the host loopback with the Cog app.
 *
 * WSL2 agents are different: inside the Linux VM `127.0.0.1` is the VM's own
 * loopback, not the Windows host's. To reach the hub (which runs on Windows)
 * we have to talk to the Windows host IP, which in WSL2's default NAT mode
 * is the default gateway of the eth0 interface (NOT the DNS nameserver — on
 * newer WSL builds those are different; the nameserver is now a WSL-internal
 * DNS forwarder like 10.255.255.254). We parse /proc/net/route, which lists
 * routes with the Gateway as a little-endian hex IPv4 address.
 *
 * Override: COG_HUB_HOST env var wins over auto-detection if set.
 */
function resolveHubHost(): string {
  const override = process.env.COG_HUB_HOST || process.env.AGENTORCH_HUB_HOST
  if (override) return override
  if (process.platform !== 'linux') return '127.0.0.1'
  try {
    // Lazy require so this stays a no-op cost on non-Linux paths.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    const ver = fs.readFileSync('/proc/version', 'utf8')
    if (!/microsoft|wsl/i.test(ver)) return '127.0.0.1'
    // /proc/net/route columns (tab-separated):
    //   Iface  Destination  Gateway   Flags  RefCnt  Use  Metric  Mask  ...
    // Default route has Destination=00000000. Gateway is the host IP we want,
    // stored as a little-endian uint32 hex string (e.g. 01C01FAC = 172.31.192.1).
    const lines = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)
    for (const line of lines) {
      const cols = line.split(/\s+/)
      if (cols.length >= 3 && cols[1] === '00000000') {
        const hex = cols[2]
        if (hex && /^[0-9A-Fa-f]{8}$/.test(hex)) {
          // Reverse byte order: 01 C0 1F AC -> AC 1F C0 01 -> 172.31.192.1
          const b1 = parseInt(hex.slice(6, 8), 16)
          const b2 = parseInt(hex.slice(4, 6), 16)
          const b3 = parseInt(hex.slice(2, 4), 16)
          const b4 = parseInt(hex.slice(0, 2), 16)
          return `${b1}.${b2}.${b3}.${b4}`
        }
      }
    }
  } catch {
    // Fall through — best-effort detection.
  }
  return '127.0.0.1'
}

const HUB_HOST = resolveHubHost()
const HUB_URL = `http://${HUB_HOST}:${HUB_PORT}`

async function hubFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`${HUB_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${HUB_SECRET}`,
      ...opts.headers
    }
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Hub returned ${res.status}: ${body}`)
  }
  return res.json()
}

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true as const }
}

function toolResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

const server = new McpServer({
  name: 'agentorch',
  version: '1.0.0'
})

// Heartbeat: ping hub every 30s so it knows this MCP server is alive
const HEARTBEAT_INTERVAL_MS = 30_000
setInterval(async () => {
  try {
    await hubFetch(`/agents/${encodeURIComponent(AGENT_NAME)}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({})
    })
  } catch {
    // Hub unreachable — nothing we can do, just keep trying
  }
}, HEARTBEAT_INTERVAL_MS)

// Initial heartbeat on startup
hubFetch(`/agents/${encodeURIComponent(AGENT_NAME)}/heartbeat`, {
  method: 'POST',
  body: JSON.stringify({})
}).catch(() => {})

server.tool(
  'send_message',
  'Send a message to another agent in the workspace. The message will be queued and the target agent will receive it when they call get_messages().',
  {
    to: z.string().describe('Name of the target agent'),
    message: z.string().describe('The message to send')
  },
  async ({ to, message }) => {
    try {
      const result = await hubFetch('/messages/send', {
        method: 'POST',
        body: JSON.stringify({ from: AGENT_NAME, to, message })
      })
      if (result.status === 'error') return toolError(result.detail || 'Send failed')
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to send message: ${err.message}`)
    }
  }
)

server.tool(
  'get_messages',
  'Check for messages sent to you by other agents. By default, messages are returned without clearing the queue (peek mode). Call ack_messages() with the message IDs to remove them after processing. IMPORTANT: Do NOT poll this in a loop — you will be nudged automatically when a message arrives.',
  {
    peek: z.boolean().optional().default(true).describe('If true (default), messages stay in queue. Set to false to clear on read (legacy behavior).')
  },
  async ({ peek }) => {
    try {
      const messages = await hubFetch(`/messages/${encodeURIComponent(AGENT_NAME)}?peek=${peek}`)
      if (messages.length === 0) return toolResult('No new messages. STOP — do NOT call get_messages() again. You will be nudged automatically when a new message arrives. Wait for the nudge.')
      return toolResult(messages)
    } catch (err: any) {
      return toolError(`Failed to get messages: ${err.message}`)
    }
  }
)

server.tool(
  'ack_messages',
  'Acknowledge and remove messages from your queue after processing them. Call this after successfully handling messages from get_messages().',
  {
    message_ids: z.array(z.string()).describe('Array of message IDs to acknowledge')
  },
  async ({ message_ids }) => {
    try {
      const result = await hubFetch(`/messages/${encodeURIComponent(AGENT_NAME)}/ack`, {
        method: 'POST',
        body: JSON.stringify({ messageIds: message_ids })
      })
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to acknowledge messages: ${err.message}`)
    }
  }
)

server.tool(
  'get_agents',
  'List all agents in the workspace with their names, roles, CLI types, CEO notes, and current status.',
  {},
  async () => {
    try {
      const agents = await hubFetch('/agents')
      return toolResult(agents)
    } catch (err: any) {
      return toolError(`Failed to list agents: ${err.message}`)
    }
  }
)

server.tool(
  'read_ceo_notes',
  'Re-read your CEO notes and role description. Useful for re-grounding after /clear or when you need to recall your instructions.',
  {},
  async () => {
    try {
      const notes = await hubFetch(`/agents/${encodeURIComponent(AGENT_NAME)}/ceo-notes`)
      return toolResult(notes)
    } catch (err: any) {
      return toolError(`Failed to read CEO notes: ${err.message}`)
    }
  }
)

server.tool(
  'update_status',
  'Update your status in the hub. Use to signal whether you are idle, active (at prompt), or working (processing a task).',
  {
    status: z.enum(['idle', 'active', 'working']).describe('Your current status')
  },
  async ({ status }) => {
    try {
      const result = await hubFetch(`/agents/${encodeURIComponent(AGENT_NAME)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status })
      })
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to update status: ${err.message}`)
    }
  }
)

server.tool(
  'get_agent_output',
  'Peek at another agent\'s recent terminal output. Useful for checking what an agent is doing without messaging them.',
  {
    agent: z.string().describe('Name of the target agent'),
    lines: z.number().optional().default(50).describe('Number of lines to retrieve (default 50, max 1000)')
  },
  async ({ agent, lines }) => {
    try {
      const result = await hubFetch(`/agents/${encodeURIComponent(agent)}/output?lines=${lines}`)
      return toolResult(result.lines.join('\n'))
    } catch (err: any) {
      return toolError(`Failed to get agent output: ${err.message}`)
    }
  }
)

server.tool(
  'post_task',
  'Post a task to the shared pinboard. Use target_role to only nudge agents with a specific role (e.g., "reviewer", "worker", "researcher"). Use target_agent to nudge a specific agent by name (overrides target_role if both are set). If neither is provided, all non-orchestrator agents are nudged.',
  {
    title: z.string().describe('Short title for the task'),
    description: z.string().describe('Detailed description of what needs to be done'),
    priority: z.enum(['low', 'medium', 'high']).optional().default('medium').describe('Task priority (default: medium)'),
    target_role: z.string().optional().describe('Only nudge agents with this role (e.g., "reviewer", "worker"). Omit to nudge all.'),
    target_agent: z.string().optional().describe('Name of specific agent to nudge (overrides target_role if both set).')
  },
  async ({ title, description, priority, target_role, target_agent }) => {
    try {
      const result = await hubFetch('/pinboard/tasks', {
        method: 'POST',
        body: JSON.stringify({ title, description, priority, from: AGENT_NAME, targetRole: target_role, tabId: TAB_ID, targetAgent: target_agent })
      })
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to post task: ${err.message}`)
    }
  }
)

server.tool(
  'read_tasks',
  'List all tasks on the shared Pinboard — the task / to-do board (NOT the visual Sketchpad drawing canvas; for sketches/notes pages use list_sketchpad_pages / view_sketchpad_page). Shows id, title, description, priority, status, claimedBy, result, and createdAt. IMPORTANT: Do NOT poll this in a loop — you will be nudged automatically when a new task is posted.',
  {},
  async () => {
    try {
      const tabQuery = TAB_ID ? `?tabId=${encodeURIComponent(TAB_ID)}` : ''
      const tasks = await hubFetch(`/pinboard/tasks${tabQuery}`)
      if (tasks.length === 0) return toolResult('No tasks on the pinboard. STOP — do NOT poll read_tasks() again. You will be nudged automatically when a new task is posted. Wait for the nudge.')

      // Sort: open first, then in_progress, then completed — so claimable tasks are immediately visible
      const statusOrder: Record<string, number> = { open: 0, in_progress: 1, completed: 2 }
      const sorted = [...tasks].sort((a: any, b: any) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9))

      const openTasks = sorted.filter((t: any) => t.status === 'open')
      const inProgress = sorted.filter((t: any) => t.status === 'in_progress')

      // Build a summary header so the agent knows exactly what's actionable
      const summary = openTasks.length > 0
        ? `${openTasks.length} OPEN task(s) ready to claim (call claim_task with the task id). ${inProgress.length} in progress. Claim one NOW.`
        : `No open tasks to claim. ${inProgress.length} in progress. STOP — wait for a nudge.`

      return toolResult({ summary, tasks: sorted })
    } catch (err: any) {
      return toolError(`Failed to read tasks: ${err.message}`)
    }
  }
)

server.tool(
  'claim_task',
  'Claim an open task from the pinboard. Prevents double-pickup — fails if already claimed by another agent.',
  {
    task_id: z.string().describe('ID of the task to claim')
  },
  async ({ task_id }) => {
    try {
      const result = await hubFetch(`/pinboard/tasks/${task_id}/claim`, {
        method: 'POST',
        body: JSON.stringify({ from: AGENT_NAME })
      })
      if (result.status === 'error') return toolError(result.detail || 'Claim failed')
      // Include task details so the agent knows exactly what to work on
      if (result.task) {
        return toolResult({
          ...result,
          task_title: result.task.title,
          task_description: result.task.description
        })
      }
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to claim task: ${err.message}`)
    }
  }
)

server.tool(
  'complete_task',
  'Mark a claimed task as completed. Only the agent who claimed the task can complete it.',
  {
    task_id: z.string().describe('ID of the task to complete'),
    result: z.string().optional().describe('Optional result or summary of the work done')
  },
  async ({ task_id, result }) => {
    try {
      const res = await hubFetch(`/pinboard/tasks/${task_id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ from: AGENT_NAME, result })
      })
      if (res.status === 'error') return toolError(res.detail || 'Complete failed')
      return toolResult(res)
    } catch (err: any) {
      return toolError(`Failed to complete task: ${err.message}`)
    }
  }
)

server.tool(
  'broadcast',
  'Send a message to ALL other agents in the workspace at once (except yourself).',
  {
    message: z.string().describe('The message to broadcast')
  },
  async ({ message }) => {
    try {
      const result = await hubFetch('/messages/broadcast', {
        method: 'POST',
        body: JSON.stringify({ from: AGENT_NAME, message })
      })
      if (result.error) return toolError(result.error)
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to broadcast: ${err.message}`)
    }
  }
)

server.tool(
  'post_info',
  'Post a research note or finding to the shared info channel. Other agents can read it with read_info().',
  {
    note: z.string().describe('The research note or finding to post'),
    tags: z.array(z.string()).optional().describe('Optional tags to categorize the note')
  },
  async ({ note, tags }) => {
    try {
      const result = await hubFetch('/info', {
        method: 'POST',
        body: JSON.stringify({ from: AGENT_NAME, note, tags, tabId: TAB_ID })
      })
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to post info: ${err.message}`)
    }
  }
)

server.tool(
  'read_info',
  'Read all notes from the shared info channel, optionally filtered by tags. Use this to access research findings and shared knowledge.',
  {
    tags: z.array(z.string()).optional().describe('Optional tags to filter by (matches ANY tag)')
  },
  async ({ tags }) => {
    try {
      const queryParams = tags && tags.length > 0 ? `?tags=${encodeURIComponent(tags.join(','))}` : ''
      const result = await hubFetch(`/info${queryParams}`)
      if (result.length === 0) return toolResult('No info entries found.')
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to read info: ${err.message}`)
    }
  }
)

server.tool(
  'abandon_task',
  'Abandon a claimed task, returning it to open status so another agent can pick it up. Use when you cannot complete a task.',
  {
    task_id: z.string().describe('ID of the task to abandon')
  },
  async ({ task_id }) => {
    try {
      const result = await hubFetch(`/pinboard/tasks/${task_id}/abandon`, {
        method: 'POST',
        body: JSON.stringify({})
      })
      if (result.status === 'error') return toolError(result.detail || 'Abandon failed')
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to abandon task: ${err.message}`)
    }
  }
)

server.tool(
  'clear_completed_tasks',
  'Remove all completed tasks from the pinboard. Keeps open and in-progress tasks.',
  {},
  async () => {
    try {
      const result = await hubFetch('/pinboard/clear-completed', {
        method: 'POST',
        body: JSON.stringify({ tabId: TAB_ID })
      })
      return toolResult(`Cleared ${result.cleared} completed task(s) from the pinboard.`)
    } catch (err: any) {
      return toolError(`Failed to clear tasks: ${err.message}`)
    }
  }
)

server.tool(
  'get_task',
  'Get a single task by ID. More efficient than read_tasks when you only need one task\'s status.',
  {
    task_id: z.string().describe('ID of the task to retrieve')
  },
  async ({ task_id }) => {
    try {
      const result = await hubFetch(`/pinboard/tasks/${task_id}`)
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to get task: ${err.message}`)
    }
  }
)

server.tool(
  'get_message_history',
  'Retrieve past message history from the database. Unlike get_messages (which shows unread queue), this shows all historical messages.',
  {
    agent: z.string().optional().describe('Filter by agent name (shows messages to/from this agent). Omit for all messages.'),
    limit: z.number().optional().default(50).describe('Max messages to return (default 50, max 500)')
  },
  async ({ agent, limit }) => {
    try {
      const params = new URLSearchParams()
      if (agent) params.set('agent', agent)
      if (limit) params.set('limit', String(limit))
      const query = params.toString() ? `?${params.toString()}` : ''
      const result = await hubFetch(`/messages/history${query}`)
      if (result.length === 0) return toolResult('No message history found.')
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to get message history: ${err.message}`)
    }
  }
)

server.tool(
  'delete_info',
  'Delete an info channel entry by ID. Use to remove stale or incorrect information.',
  {
    id: z.string().describe('ID of the info entry to delete')
  },
  async ({ id }) => {
    try {
      const result = await hubFetch(`/info/${id}`, { method: 'DELETE' })
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to delete info: ${err.message}`)
    }
  }
)

server.tool(
  'update_info',
  'Update the note text of an existing info channel entry.',
  {
    id: z.string().describe('ID of the info entry to update'),
    note: z.string().describe('The updated note text')
  },
  async ({ id, note }) => {
    try {
      const result = await hubFetch(`/info/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ note })
      })
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to update info: ${err.message}`)
    }
  }
)

server.tool(
  'read_file',
  'Read the contents of a file in the project directory. Path is relative to the project root.',
  {
    path: z.string().describe('Relative path to the file (e.g., "src/index.ts", "package.json")')
  },
  async ({ path }) => {
    try {
      const result = await hubFetch(`/files/read?path=${encodeURIComponent(path)}`)
      return toolResult(result.content)
    } catch (err: any) {
      return toolError(`Failed to read file: ${err.message}`)
    }
  }
)

server.tool(
  'write_file',
  'Write content to a file in the project directory. Creates parent directories if needed. Path is relative to project root.',
  {
    path: z.string().describe('Relative path for the file (e.g., "src/new-file.ts")'),
    content: z.string().describe('The full file content to write')
  },
  async ({ path, content }) => {
    try {
      const result = await hubFetch('/files/write', {
        method: 'POST',
        body: JSON.stringify({ path, content })
      })
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to write file: ${err.message}`)
    }
  }
)

server.tool(
  'list_directory',
  'List files and subdirectories in a project directory. Path is relative to project root. Defaults to root if no path given.',
  {
    path: z.string().optional().default('.').describe('Relative directory path (default: project root)')
  },
  async ({ path }) => {
    try {
      const result = await hubFetch(`/files/list?path=${encodeURIComponent(path)}`)
      if (result.items.length === 0) return toolResult('Directory is empty.')
      // Format as a readable listing
      const listing = result.items.map((item: any) =>
        `${item.type === 'directory' ? '[DIR]' : '     '} ${item.name}`
      ).join('\n')
      return toolResult(`${result.path}/\n${listing}`)
    } catch (err: any) {
      return toolError(`Failed to list directory: ${err.message}`)
    }
  }
)

server.tool(
  'get_my_group',
  'Get information about your communication group — who you can talk to, group name, and members. Returns null if you are unlinked (global access).',
  {},
  async () => {
    try {
      const agents = await hubFetch('/agents')
      const me = agents.find((a: any) => a.name === AGENT_NAME)
      if (!me || !me.groupId) return toolResult('You are unlinked — you have global access to all agents, tasks, and info.')
      const groups = await hubFetch('/groups')
      const myGroup = groups.find((g: any) => g.members.includes(AGENT_NAME))
      if (!myGroup) return toolResult('You are unlinked — global access.')
      return toolResult(myGroup)
    } catch (err: any) {
      return toolError(`Failed to get group info: ${err.message}`)
    }
  }
)

// ── Orchestrator-only tools ──────────────────────────────────────────────────
// These are gated server-side: the hub checks `agent.role === 'orchestrator'`
// before accepting the call. Workers/reviewers/researchers will get a clear
// 403 if they try to use them, so this is a guardrail not a hard secret.

server.tool(
  'notify_user',
  'ORCHESTRATOR ONLY. Post a message to the user-facing inbox panel. Use this for messages targeted at the human (questions, status digests, decisions needed) so they do not get buried in agent crosstalk during long unattended runs. Set priority urgent only when something genuinely needs human action soon.',
  {
    message: z.string().describe('The message body for the user. Plain text or markdown.'),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).describe('Importance level. low=FYI, normal=worth reading, high=should read soon, urgent=needs action now.'),
    tags: z.array(z.string()).optional().describe('Optional tags to categorize the message (e.g. ["build", "blocker"]).')
  },
  async ({ message, priority, tags }) => {
    try {
      const result = await hubFetch('/inbox', {
        method: 'POST',
        body: JSON.stringify({
          agentId: AGENT_ID,
          agentName: AGENT_NAME,
          message,
          priority,
          tags: tags || [],
          tabId: TAB_ID
        })
      })
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to post to inbox: ${err.message}`)
    }
  }
)

server.tool(
  'propose_team',
  'ORCHESTRATOR ONLY. Submit a proposed team of agents for the user to approve before any agent spawns. The user sees a confirmation modal listing every agent and can deselect any before approving. Use this when the user asks to spin up a team, or when you decide more agents are needed for a task. The agents do NOT spawn from this call alone — wait for the user.',
  {
    summary: z.string().describe('Short human-readable description of the team\'s purpose (1-3 sentences).'),
    agents: z.array(z.object({
      name: z.string().describe('Unique agent name within this proposal (e.g. "Claude-Backend").'),
      cli: z.string().describe('CLI tool: claude, codex, kimi, gemini, openclaude, copilot, grok.'),
      model: z.string().optional().describe(
        'Model name appropriate for the cli. Valid values:\n' +
        '  claude: "sonnet" | "opus" | "haiku" | "opus[1m]" — NEVER use "sonnet[1m]". sonnet[1m] is billed against the paid Anthropic API (real money per token), NOT the user\'s Claude Max subscription. Plain "sonnet" is the right pick almost always; only use "opus[1m]" if 1M context is genuinely needed.\n' +
        '  codex: "gpt-5.5" | "gpt-5.4" | "gpt-5" | "o3" | "o3-pro" | "gpt-4.1" | "gpt-4.1-mini" | "" (empty = o4-mini default)\n' +
        '  kimi: ALWAYS leave empty (omit this field). kimi-cli\'s --model flag is broken and resets auth — Cog passes no model flag and lets kimi use its cached choice. The user can switch models from inside kimi via /model.\n' +
        '  gemini: "gemini-2.5-pro" | "gemini-2.5-flash" | "gemini-2.0-flash" | "gemini-2.0-flash-thinking"\n' +
        '  copilot: "gpt-5.5" | "gpt-5.4" | "gpt-5" | "gpt-4o" | "o3" | "o4-mini"\n' +
        '  grok: "grok-3" | "grok-3-mini" | "grok-2"\n' +
        '  openclaude: any OpenAI-compatible model name (e.g. "deepseek-chat", "llama3.3").\n' +
        'If unsure, omit this field — the CLI will pick its default.'
      ),
      role: z.string().describe('Role: orchestrator, worker, reviewer, researcher, or custom.'),
      ceoNotes: z.string().describe('Per-agent system instructions defining its job. Empty string if none.'),
      autoMode: z.boolean().describe('Auto-approve / yolo / bypass-permissions mode. Recommend true for trusted teams.'),
      shell: z.enum(['cmd', 'powershell', 'wsl', 'bash', 'zsh', 'fish']).optional().describe('Shell to launch in. On Windows recommend "wsl" for codex agents.'),
      skills: z.array(z.string()).optional().describe('Skill IDs to attach.'),
      providerUrl: z.string().optional().describe('OpenAI-compatible base URL (only for openclaude with custom providers).')
    })).describe('The proposed agents. First agent should typically be the orchestrator if including one.')
  },
  async ({ summary, agents }) => {
    try {
      const result = await hubFetch('/proposals', {
        method: 'POST',
        body: JSON.stringify({
          proposedBy: AGENT_NAME,
          summary,
          agents,
          tabId: TAB_ID
        })
      })
      return toolResult({
        ...result,
        next: 'Awaiting user approval in the confirmation modal. Continue other work; you will be notified when they decide.'
      })
    } catch (err: any) {
      return toolError(`Failed to submit team proposal: ${err.message}`)
    }
  }
)

server.tool(
  'schedule_prompt',
  'Schedule a recurring prompt to be injected into an agent in this workspace (yourself or another agent). Use for self-directed check-ins or to drive a worker (e.g. "post a sitrep every 40 minutes for 6 hours"). If the project has Scheduling autonomy enabled, the schedule starts immediately; otherwise it is PROPOSED for the user to approve in their inbox. Minimum interval is 5 minutes; duration_hours is required (no infinite schedules).',
  {
    target_agent: z.string().describe('Name (or id) of the agent the prompt fires at. Use your own name to self-schedule.'),
    prompt_text: z.string().describe('The text injected into the target agent on each fire.'),
    interval_minutes: z.number().int().describe('Minutes between fires. Minimum 5.'),
    duration_hours: z.number().int().describe('How many hours the schedule runs before auto-expiring. Required.'),
    name: z.string().optional().describe('Optional human-readable label.')
  },
  async ({ target_agent, prompt_text, interval_minutes, duration_hours, name }) => {
    try {
      const result = await hubFetch('/schedules', {
        method: 'POST',
        body: JSON.stringify({
          proposedBy: AGENT_NAME, targetAgent: target_agent, promptText: prompt_text,
          intervalMinutes: interval_minutes, durationHours: duration_hours, name
        })
      })
      if (result.status === 'proposed') {
        return toolResult({ ...result, next: 'Awaiting user approval in their inbox. Continue other work; you will be notified when they decide.' })
      }
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to schedule prompt: ${err.message}`)
    }
  }
)

server.tool(
  'list_schedules',
  'List active scheduled prompts in this workspace, including who created each one. Use to avoid creating duplicate schedules and to find the ids of schedules you created (so you can cancel them).',
  {},
  async () => {
    try { return toolResult(await hubFetch('/schedules')) }
    catch (err: any) { return toolError(`Failed to list schedules: ${err.message}`) }
  }
)

server.tool(
  'cancel_schedule',
  'Cancel a scheduled prompt by id. You may only cancel schedules YOU created (not the user\'s or another agent\'s). Get ids from list_schedules().',
  { schedule_id: z.string().describe('The id of the schedule to cancel.') },
  async ({ schedule_id }) => {
    try {
      const result = await hubFetch(`/schedules/${encodeURIComponent(schedule_id)}/cancel`, {
        method: 'POST', body: JSON.stringify({ requestedBy: AGENT_NAME })
      })
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to cancel schedule: ${err.message}`)
    }
  }
)

server.tool(
  'list_sketchpad_pages',
  'List the pages of the SKETCHPAD — the user\'s visual drawing canvas / whiteboard (freehand sketches, sticky notes, text, placed photos). This is NOT the Pinboard: the Pinboard is the task / to-do list (use read_tasks for that). Returns element + stroke counts per page; use before view_sketchpad_page.',
  {},
  async () => {
    try { return toolResult(await hubFetch('/board/pages')) }
    catch (err: any) { return toolError(`Failed to list sketchpad pages: ${err.message}`) }
  }
)

server.tool(
  'view_sketchpad_page',
  'Get the rendered image of a SKETCHPAD page so you can SEE it — the user\'s freehand drawing (sketches, arrows, circles), photos, sticky notes, and text. The Sketchpad is a visual drawing canvas, NOT the Pinboard (the Pinboard is the task list — use read_tasks). Returns a PNG file path; open it with your image/vision read. Page numbers are 1-based, exactly as the user refers to them ("page 3").',
  { page: z.number().int().describe('1-based page number, e.g. the 3 in "look at page 3".') },
  async ({ page }) => {
    try {
      const r = await hubFetch(`/board/pages/${page}/render`)
      return toolResult({ ...r, next: `Open the image at "${r.path}" with your file/vision read to see page ${page}.` })
    } catch (err: any) {
      return toolError(`Failed to view sketchpad page ${page}: ${err.message}`)
    }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('MCP server failed to start:', err)
  process.exit(1)
})
