import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// Support both CLI args (for codex/kimi) and env vars (for claude).
// CLI args: node index.js <port> <secret> <agent_id> <agent_name...>
// Agent name can contain spaces — everything from arg[3] onward is joined.
const args = process.argv.slice(2)
const HUB_PORT = args[0] || process.env.AGENTORCH_HUB_PORT
const HUB_SECRET = args[1] || process.env.AGENTORCH_HUB_SECRET
const AGENT_ID = args[2] || process.env.AGENTORCH_AGENT_ID
const AGENT_NAME = (args.length > 3 ? args.slice(3).join(' ') : undefined) || process.env.AGENTORCH_AGENT_NAME

if (!HUB_PORT || !HUB_SECRET || !AGENT_ID || !AGENT_NAME) {
  console.error('AgentOrch MCP server: missing connection info.')
  console.error('Usage: node index.js <port> <secret> <agent_id> <agent_name>')
  console.error('Or set AGENTORCH_HUB_PORT, AGENTORCH_HUB_SECRET, AGENTORCH_AGENT_ID, AGENTORCH_AGENT_NAME')
  process.exit(1)
}

const HUB_URL = `http://127.0.0.1:${HUB_PORT}`

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
  'Check for messages sent to you by other agents. By default, messages are returned without clearing the queue (peek mode). Call ack_messages() with the message IDs to remove them after processing.',
  {
    peek: z.boolean().optional().default(true).describe('If true (default), messages stay in queue. Set to false to clear on read (legacy behavior).')
  },
  async ({ peek }) => {
    try {
      const messages = await hubFetch(`/messages/${encodeURIComponent(AGENT_NAME)}?peek=${peek}`)
      if (messages.length === 0) return toolResult('No new messages.')
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
  'Post a task to the shared pinboard for other agents to pick up.',
  {
    title: z.string().describe('Short title for the task'),
    description: z.string().describe('Detailed description of what needs to be done'),
    priority: z.enum(['low', 'medium', 'high']).optional().default('medium').describe('Task priority (default: medium)')
  },
  async ({ title, description, priority }) => {
    try {
      const result = await hubFetch('/pinboard/tasks', {
        method: 'POST',
        body: JSON.stringify({ title, description, priority, from: AGENT_NAME })
      })
      return toolResult(result)
    } catch (err: any) {
      return toolError(`Failed to post task: ${err.message}`)
    }
  }
)

server.tool(
  'read_tasks',
  'List all tasks on the shared pinboard. Shows id, title, description, priority, status, claimedBy, result, and createdAt.',
  {},
  async () => {
    try {
      const tasks = await hubFetch('/pinboard/tasks')
      if (tasks.length === 0) return toolResult('No tasks on the pinboard.')
      return toolResult(tasks)
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
        body: JSON.stringify({ from: AGENT_NAME, note, tags })
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

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('MCP server failed to start:', err)
  process.exit(1)
})
