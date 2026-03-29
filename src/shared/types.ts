export type AgentStatus = 'idle' | 'active' | 'working' | 'disconnected'

export interface AgentConfig {
  id: string
  name: string
  cli: string
  cwd: string
  role: string
  ceoNotes: string
  shell: 'cmd' | 'powershell'  // which shell to spawn the agent in
  admin: boolean
  autoMode: boolean    // --dangerously-skip-permissions (Claude), --yolo (Codex), etc.
  promptRegex?: string
}

export interface AgentState extends AgentConfig {
  status: AgentStatus
  createdAt: string
}

export interface Message {
  id: string
  from: string
  to: string
  message: string
  timestamp: string
}

export interface SendMessageResult {
  status: 'delivered' | 'queued' | 'error'
  detail?: string
}

export interface HubInfo {
  port: number
  secret: string
}

export const IPC = {
  SPAWN_AGENT: 'agent:spawn',
  KILL_AGENT: 'agent:kill',
  GET_AGENTS: 'agent:list',
  AGENT_STATE_UPDATE: 'agent:state-update',
  GET_HUB_INFO: 'hub:info',
  WRITE_TO_PTY: 'pty:write',
  PTY_OUTPUT: 'pty:output',
  PTY_EXIT: 'pty:exit'
} as const
