import React, { useState, useMemo } from 'react'

// MCP Tools Reference — keep this in sync with src/mcp-server/index.ts.
// Roles indicate TYPICAL usage; in practice every agent has access to every
// tool regardless of its declared role.

type ToolRole = 'orchestrator' | 'worker' | 'researcher' | 'reviewer' | 'all'

interface ToolEntry {
  name: string
  description: string
  args: Array<{ name: string; type: string; required?: boolean; description: string }>
  example?: string
  roles: ToolRole[]
}

interface ToolCategory {
  id: string
  label: string
  description: string
  tools: ToolEntry[]
}

const CATEGORIES: ToolCategory[] = [
  {
    id: 'messaging',
    label: 'Messaging',
    description: 'Direct agent-to-agent communication. Messages are queued and delivered via nudges.',
    tools: [
      {
        name: 'send_message',
        description: 'Send a direct message to another agent. Queued until they call get_messages().',
        args: [
          { name: 'to', type: 'string', required: true, description: 'Target agent name' },
          { name: 'message', type: 'string', required: true, description: 'The message body' },
        ],
        example: 'send_message(to="reviewer-1", message="PR ready for review at branch feat/auth")',
        roles: ['all'],
      },
      {
        name: 'get_messages',
        description: 'Check your inbox. Defaults to peek mode (does not clear queue). Do NOT poll — wait for nudges.',
        args: [
          { name: 'peek', type: 'boolean', description: 'true (default) keeps messages in queue; false clears them on read' },
        ],
        example: 'get_messages()',
        roles: ['all'],
      },
      {
        name: 'ack_messages',
        description: 'Remove processed messages from your queue after handling them.',
        args: [
          { name: 'message_ids', type: 'string[]', required: true, description: 'IDs of messages to acknowledge' },
        ],
        example: 'ack_messages(message_ids=["msg-abc", "msg-def"])',
        roles: ['all'],
      },
      {
        name: 'broadcast',
        description: 'Send a message to ALL other agents at once.',
        args: [
          { name: 'message', type: 'string', required: true, description: 'The message body' },
        ],
        example: 'broadcast(message="Database migration starting in 5 minutes")',
        roles: ['orchestrator'],
      },
      {
        name: 'get_message_history',
        description: 'Retrieve historical messages from the database (vs get_messages which only shows the unread queue).',
        args: [
          { name: 'agent', type: 'string', description: 'Filter by agent name (to/from this agent)' },
          { name: 'limit', type: 'number', description: 'Max messages to return (default 50, max 500)' },
        ],
        example: 'get_message_history(agent="worker-1", limit=20)',
        roles: ['orchestrator', 'reviewer'],
      },
    ],
  },
  {
    id: 'tasks',
    label: 'Pinboard / Tasks',
    description: 'Shared task board. Orchestrators post, workers claim and complete.',
    tools: [
      {
        name: 'post_task',
        description: 'Post a task to the shared pinboard. Optionally target a specific role to nudge.',
        args: [
          { name: 'title', type: 'string', required: true, description: 'Short title' },
          { name: 'description', type: 'string', required: true, description: 'Detailed description of the work' },
          { name: 'priority', type: '"low" | "medium" | "high"', description: 'Priority (default medium)' },
          { name: 'target_role', type: 'string', description: 'Only nudge agents with this role (e.g. "worker", "reviewer")' },
        ],
        example: 'post_task(title="Fix login bug", description="Stack trace in #15", priority="high", target_role="worker")',
        roles: ['orchestrator'],
      },
      {
        name: 'read_tasks',
        description: 'List all tasks on the pinboard. Sorted with open tasks first. Do NOT poll — wait for nudges.',
        args: [],
        example: 'read_tasks()',
        roles: ['worker', 'reviewer'],
      },
      {
        name: 'get_task',
        description: 'Fetch a single task by ID. More efficient than read_tasks when you only need one.',
        args: [
          { name: 'task_id', type: 'string', required: true, description: 'ID of the task' },
        ],
        example: 'get_task(task_id="task-abc-123")',
        roles: ['all'],
      },
      {
        name: 'claim_task',
        description: 'Claim an open task. Fails if already claimed by someone else.',
        args: [
          { name: 'task_id', type: 'string', required: true, description: 'ID of the task to claim' },
        ],
        example: 'claim_task(task_id="task-abc-123")',
        roles: ['worker', 'reviewer'],
      },
      {
        name: 'complete_task',
        description: 'Mark a claimed task as done. Only the claiming agent can complete it.',
        args: [
          { name: 'task_id', type: 'string', required: true, description: 'ID of the task' },
          { name: 'result', type: 'string', description: 'Optional summary of the work done' },
        ],
        example: 'complete_task(task_id="task-abc-123", result="Patched in commit a1b2c3d")',
        roles: ['worker', 'reviewer'],
      },
      {
        name: 'abandon_task',
        description: 'Release a claimed task back to open status (use when blocked).',
        args: [
          { name: 'task_id', type: 'string', required: true, description: 'ID of the task to abandon' },
        ],
        example: 'abandon_task(task_id="task-abc-123")',
        roles: ['worker', 'reviewer'],
      },
      {
        name: 'clear_completed_tasks',
        description: 'Remove all completed tasks from the pinboard. Keeps open and in-progress tasks.',
        args: [],
        example: 'clear_completed_tasks()',
        roles: ['orchestrator'],
      },
    ],
  },
  {
    id: 'knowledge',
    label: 'Shared Knowledge',
    description: 'Info channel for research findings, status notes, and shared context.',
    tools: [
      {
        name: 'post_info',
        description: 'Post a research note or finding to the shared info channel.',
        args: [
          { name: 'note', type: 'string', required: true, description: 'The note text' },
          { name: 'tags', type: 'string[]', description: 'Optional tags to categorize the note' },
        ],
        example: 'post_info(note="Auth uses JWT with 1h expiry", tags=["auth", "research"])',
        roles: ['researcher', 'worker'],
      },
      {
        name: 'read_info',
        description: 'Read all info entries, optionally filtered by tags.',
        args: [
          { name: 'tags', type: 'string[]', description: 'Filter to entries matching ANY of these tags' },
        ],
        example: 'read_info(tags=["auth"])',
        roles: ['all'],
      },
      {
        name: 'update_info',
        description: 'Update the text of an existing info entry.',
        args: [
          { name: 'id', type: 'string', required: true, description: 'ID of the entry to update' },
          { name: 'note', type: 'string', required: true, description: 'The updated note text' },
        ],
        example: 'update_info(id="info-abc", note="Auth uses JWT with 24h expiry (corrected)")',
        roles: ['researcher'],
      },
      {
        name: 'delete_info',
        description: 'Delete an info entry by ID. Use to remove stale or incorrect notes.',
        args: [
          { name: 'id', type: 'string', required: true, description: 'ID of the entry to delete' },
        ],
        example: 'delete_info(id="info-abc")',
        roles: ['researcher'],
      },
    ],
  },
  {
    id: 'agents',
    label: 'Agents & Discovery',
    description: 'Inspect the team — who else is in the workspace and what they are doing.',
    tools: [
      {
        name: 'get_agents',
        description: 'List all agents in the workspace with name, role, CLI, status, and CEO notes.',
        args: [],
        example: 'get_agents()',
        roles: ['all'],
      },
      {
        name: 'read_ceo_notes',
        description: 'Re-read your own CEO notes and role description. Useful after /clear.',
        args: [],
        example: 'read_ceo_notes()',
        roles: ['all'],
      },
      {
        name: 'update_status',
        description: 'Self-report your current status. Helps the team see what you are doing.',
        args: [
          { name: 'status', type: '"idle" | "active" | "working"', required: true, description: 'Current status' },
        ],
        example: 'update_status(status="working")',
        roles: ['all'],
      },
      {
        name: 'get_agent_output',
        description: 'Peek at another agent\u2019s recent terminal output without messaging them.',
        args: [
          { name: 'agent', type: 'string', required: true, description: 'Target agent name' },
          { name: 'lines', type: 'number', description: 'Lines to retrieve (default 50, max 1000)' },
        ],
        example: 'get_agent_output(agent="worker-1", lines=100)',
        roles: ['orchestrator', 'reviewer'],
      },
      {
        name: 'get_my_group',
        description: 'Get info about your communication group (linked agents only). Returns null if unlinked / global access.',
        args: [],
        example: 'get_my_group()',
        roles: ['all'],
      },
    ],
  },
  {
    id: 'files',
    label: 'Project Files',
    description: 'Read and write files within the current project directory. Sandboxed — paths cannot escape the project root.',
    tools: [
      {
        name: 'read_file',
        description: 'Read a file from the project directory. 1MB size limit.',
        args: [
          { name: 'path', type: 'string', required: true, description: 'Relative path (e.g. "src/index.ts")' },
        ],
        example: 'read_file(path="package.json")',
        roles: ['all'],
      },
      {
        name: 'write_file',
        description: 'Write content to a file. Creates parent directories if needed.',
        args: [
          { name: 'path', type: 'string', required: true, description: 'Relative path' },
          { name: 'content', type: 'string', required: true, description: 'Full file content' },
        ],
        example: 'write_file(path="src/new-file.ts", content="export const x = 1")',
        roles: ['worker'],
      },
      {
        name: 'list_directory',
        description: 'List files and subdirectories in a project directory.',
        args: [
          { name: 'path', type: 'string', description: 'Relative directory (default: project root)' },
        ],
        example: 'list_directory(path="src")',
        roles: ['all'],
      },
    ],
  },
  {
    id: 'companion',
    label: 'Companion / Buddy',
    description: 'The buddy room collects companion speech detected in agent terminals.',
    tools: [
      {
        name: 'read_buddy_room',
        description: 'Read recent companion/buddy speech from all agent terminals.',
        args: [
          { name: 'count', type: 'number', description: 'Number of recent messages (default 20, max 200)' },
        ],
        example: 'read_buddy_room(count=50)',
        roles: ['all'],
      },
    ],
  },
]

const ROLE_COLORS: Record<ToolRole, string> = {
  orchestrator: '#d0a85c',
  worker: '#4caf50',
  researcher: '#8cc4ff',
  reviewer: '#c586c0',
  all: '#888',
}

const ROLE_LABELS: Record<ToolRole, string> = {
  orchestrator: 'Orchestrator',
  worker: 'Worker',
  researcher: 'Researcher',
  reviewer: 'Reviewer',
  all: 'Any role',
}

const ALL_ROLES: ToolRole[] = ['all', 'orchestrator', 'worker', 'researcher', 'reviewer']

interface HelpDialogProps {
  onClose: () => void
}

export function HelpDialog({ onClose }: HelpDialogProps): React.ReactElement {
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<ToolRole | 'any'>('any')

  const filteredCategories = useMemo(() => {
    const q = search.trim().toLowerCase()
    return CATEGORIES.map(cat => {
      const tools = cat.tools.filter(tool => {
        if (roleFilter !== 'any' && !tool.roles.includes(roleFilter) && !tool.roles.includes('all')) {
          return false
        }
        if (!q) return true
        return (
          tool.name.toLowerCase().includes(q) ||
          tool.description.toLowerCase().includes(q) ||
          tool.args.some(a => a.name.toLowerCase().includes(q))
        )
      })
      return { ...cat, tools }
    }).filter(cat => cat.tools.length > 0)
  }, [search, roleFilter])

  const totalTools = CATEGORIES.reduce((sum, c) => sum + c.tools.length, 0)
  const visibleTools = filteredCategories.reduce((sum, c) => sum + c.tools.length, 0)

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100002,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          backgroundColor: '#1e1e1e',
          border: '1px solid #333',
          borderRadius: '8px',
          width: '760px',
          maxWidth: '92vw',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
        }}>
          <h2 style={{ margin: 0, fontSize: '16px', color: '#e0e0e0', flex: 1 }}>
            MCP Tools Reference
            <span style={{ marginLeft: '10px', color: '#666', fontSize: '11px', fontWeight: 'normal' }}>
              {visibleTools} of {totalTools} tools
            </span>
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: '#888',
              fontSize: '20px', cursor: 'pointer', padding: '0 4px',
            }}
            aria-label="Close"
          >{'\u00D7'}</button>
        </div>

        {/* Filter bar */}
        <div style={{
          padding: '12px 20px',
          borderBottom: '1px solid #2a2a2a',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          flexWrap: 'wrap',
        }}>
          <input
            type="text"
            placeholder="Search tools by name, description, or arg..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              flex: 1, minWidth: '200px',
              backgroundColor: '#2a2a2a', border: '1px solid #444',
              borderRadius: '4px', padding: '6px 10px',
              color: '#e0e0e0', fontSize: '12px',
            }}
          />
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <span style={{ color: '#666', fontSize: '11px', marginRight: '4px' }}>Role:</span>
            <button
              onClick={() => setRoleFilter('any')}
              style={chipStyle(roleFilter === 'any', '#888')}
            >Any</button>
            {ALL_ROLES.filter(r => r !== 'all').map(r => (
              <button
                key={r}
                onClick={() => setRoleFilter(r)}
                style={chipStyle(roleFilter === r, ROLE_COLORS[r])}
              >{ROLE_LABELS[r]}</button>
            ))}
          </div>
        </div>

        {/* Tool list */}
        <div style={{ overflow: 'auto', padding: '16px 20px', flex: 1 }}>
          {filteredCategories.length === 0 && (
            <div style={{ color: '#666', fontSize: '13px', textAlign: 'center', padding: '40px 0' }}>
              No tools match the current filter.
            </div>
          )}
          {filteredCategories.map(cat => (
            <div key={cat.id} style={{ marginBottom: '24px' }}>
              <div style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: '10px',
                marginBottom: '4px',
              }}>
                <h3 style={{ margin: 0, fontSize: '13px', color: '#8cc4ff', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {cat.label}
                </h3>
                <span style={{ color: '#555', fontSize: '11px' }}>{cat.tools.length} tool(s)</span>
              </div>
              <div style={{ color: '#777', fontSize: '11px', marginBottom: '10px' }}>{cat.description}</div>
              {cat.tools.map(tool => (
                <div key={tool.name} style={{
                  marginBottom: '10px',
                  padding: '10px 12px',
                  backgroundColor: '#252525',
                  border: '1px solid #2f2f2f',
                  borderRadius: '5px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                    <code style={{
                      color: '#4caf50',
                      fontSize: '13px',
                      fontFamily: 'Consolas, Monaco, monospace',
                      fontWeight: 'bold',
                    }}>{tool.name}</code>
                    {tool.roles.map(r => (
                      <span key={r} style={{
                        fontSize: '10px',
                        padding: '1px 7px',
                        borderRadius: '10px',
                        backgroundColor: '#1a1a1a',
                        border: `1px solid ${ROLE_COLORS[r]}`,
                        color: ROLE_COLORS[r],
                      }}>{ROLE_LABELS[r]}</span>
                    ))}
                  </div>
                  <div style={{ color: '#bbb', fontSize: '12px', lineHeight: '1.5', marginBottom: tool.args.length || tool.example ? '6px' : 0 }}>
                    {tool.description}
                  </div>
                  {tool.args.length > 0 && (
                    <div style={{ marginTop: '6px' }}>
                      {tool.args.map(arg => (
                        <div key={arg.name} style={{
                          fontSize: '11px',
                          color: '#888',
                          fontFamily: 'Consolas, Monaco, monospace',
                          marginLeft: '8px',
                        }}>
                          <span style={{ color: '#d0a85c' }}>{arg.name}</span>
                          <span style={{ color: '#666' }}>: {arg.type}</span>
                          {arg.required && <span style={{ color: '#f44336', marginLeft: '4px' }}>*</span>}
                          <span style={{ color: '#666', fontFamily: 'inherit', marginLeft: '8px' }}>{arg.description}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {tool.example && (
                    <div style={{
                      marginTop: '6px',
                      padding: '6px 8px',
                      backgroundColor: '#1a1a1a',
                      border: '1px solid #2a2a2a',
                      borderRadius: '3px',
                      fontFamily: 'Consolas, Monaco, monospace',
                      fontSize: '11px',
                      color: '#8cc4ff',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}>{tool.example}</div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 20px',
          borderTop: '1px solid #333',
          fontSize: '11px',
          color: '#666',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span>
            All tools are accessible to every agent. Role badges indicate <em>typical</em> usage.
          </span>
          <span style={{ color: '#555' }}>Source: src/mcp-server/index.ts</span>
        </div>
      </div>
    </div>
  )
}

function chipStyle(active: boolean, color: string): React.CSSProperties {
  return {
    padding: '3px 10px',
    fontSize: '11px',
    borderRadius: '12px',
    border: `1px solid ${active ? color : '#444'}`,
    backgroundColor: active ? '#2a2a2a' : 'transparent',
    color: active ? color : '#888',
    cursor: 'pointer',
  }
}
