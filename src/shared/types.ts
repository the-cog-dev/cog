export type AgentStatus = 'idle' | 'active' | 'working' | 'disconnected'

export interface AgentConfig {
  id: string
  name: string
  cli: string
  cwd: string
  role: string
  ceoNotes: string
  shell: 'cmd' | 'powershell' | 'bash' | 'zsh' | 'fish'  // which shell to spawn the agent in
  admin: boolean
  autoMode: boolean    // --dangerously-skip-permissions (Claude), --yolo (Codex), etc.
  promptRegex?: string
  model?: string  // e.g. 'sonnet', 'opus', 'haiku', 'o4-mini', 'gpt-4.1'
  experimental?: boolean
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

export interface BroadcastResult {
  delivered: number
  failed: string[]
  error?: string
}

export interface HubInfo {
  port: number
  secret: string
}

export interface PinboardTask {
  id: string
  title: string
  description: string
  priority: 'low' | 'medium' | 'high'
  status: 'open' | 'in_progress' | 'completed'
  createdBy: string | null
  claimedBy: string | null
  result: string | null
  createdAt: string
}

export const IPC = {
  SPAWN_AGENT: 'agent:spawn',
  KILL_AGENT: 'agent:kill',
  GET_AGENTS: 'agent:list',
  AGENT_STATE_UPDATE: 'agent:state-update',
  GET_HUB_INFO: 'hub:info',
  WRITE_TO_PTY: 'pty:write',
  PTY_OUTPUT: 'pty:output',
  PTY_EXIT: 'pty:exit',
  SAVE_PRESET: 'preset:save',
  LOAD_PRESET: 'preset:load',
  LIST_PRESETS: 'preset:list',
  DELETE_PRESET: 'preset:delete',
  PINBOARD_GET_TASKS: 'pinboard:get-tasks',
  PINBOARD_TASK_UPDATE: 'pinboard:task-update',
  INFO_GET_ENTRIES: 'info:get-entries',
  INFO_ENTRY_ADDED: 'info:entry-added',
  PROJECT_GET_CURRENT: 'project:get-current',
  PROJECT_SWITCH: 'project:switch',
  PROJECT_LIST_RECENT: 'project:list-recent',
  PROJECT_OPEN_FOLDER: 'project:open-folder',
  PROJECT_CHANGED: 'project:changed',
} as const

export interface InfoEntry {
  id: string
  from: string
  note: string
  tags: string[]
  createdAt: string
}

export interface RecentProject {
  path: string
  name: string
  lastOpened: string
}

export interface WindowPosition {
  agentName: string
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasState {
  zoom: number
  panX: number
  panY: number
}

export interface WorkspacePreset {
  name: string
  agents: AgentConfig[]
  windows: WindowPosition[]
  canvas: CanvasState
  savedAt: string
}
