import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// Support both CLI args (for codex/kimi) and env vars (for claude).
// CLI args: node index.js <port> <secret> <agent_id> <agent_name>
const args = process.argv.slice(2)
const HUB_PORT = args[0] || process.env.AGENTORCH_HUB_PORT
const HUB_SECRET = args[1] || process.env.AGENTORCH_HUB_SECRET
const AGENT_ID = args[2] || process.env.AGENTORCH_AGENT_ID
const AGENT_NAME = args[3] || process.env.AGENTORCH_AGENT_NAME

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
  return res.json()
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
    const result = await hubFetch('/messages/send', {
      method: 'POST',
      body: JSON.stringify({ from: AGENT_NAME, to, message })
    })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'get_messages',
  'Check for messages sent to you by other agents. Returns all queued messages and clears the queue. Call this after completing each task to check for new work.',
  {},
  async () => {
    const messages = await hubFetch(`/messages/${AGENT_NAME}`)
    if (messages.length === 0) {
      return { content: [{ type: 'text', text: 'No new messages.' }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }] }
  }
)

server.tool(
  'get_agents',
  'List all agents in the workspace with their names, roles, CLI types, CEO notes, and current status.',
  {},
  async () => {
    const agents = await hubFetch('/agents')
    return { content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }] }
  }
)

server.tool(
  'read_ceo_notes',
  'Re-read your CEO notes and role description. Useful for re-grounding after /clear or when you need to recall your instructions.',
  {},
  async () => {
    const notes = await hubFetch(`/agents/${AGENT_NAME}/ceo-notes`)
    return { content: [{ type: 'text', text: JSON.stringify(notes, null, 2) }] }
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
