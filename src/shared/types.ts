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
  providerUrl?: string  // OpenAI-compatible base URL (for OpenClaude)
  experimental?: boolean
  skills?: string[]  // skill IDs attached to this agent
  groupId?: string
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
  groupId?: string
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
  groupId?: string
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
  BUDDY_GET_MESSAGES: 'buddy:get-messages',
  BUDDY_MESSAGE_ADDED: 'buddy:message-added',
  PROJECT_GET_CURRENT: 'project:get-current',
  PROJECT_SWITCH: 'project:switch',
  PROJECT_LIST_RECENT: 'project:list-recent',
  PROJECT_OPEN_FOLDER: 'project:open-folder',
  PROJECT_CHANGED: 'project:changed',
  FILE_LIST: 'file:list',
  FILE_READ: 'file:read',
  FILE_WRITE: 'file:write',
  SKILL_LIST: 'skill:list',
  SKILL_GET: 'skill:get',
  SKILL_CREATE: 'skill:create',
  SKILL_UPDATE: 'skill:update',
  SKILL_DELETE: 'skill:delete',
  SKILL_SEARCH_COMMUNITY: 'skill:search-community',
  SKILL_INSTALL_COMMUNITY: 'skill:install-community',
  RAC_GET_AVAILABLE: 'rac:get-available',
  RAC_RENT: 'rac:rent',
  RAC_RELEASE: 'rac:release',
  RAC_GET_SESSIONS: 'rac:get-sessions',
  RAC_SET_SERVER: 'rac:set-server',
  RAC_GET_SERVER: 'rac:get-server',
  HUB_SEND_MESSAGE: 'hub:send-message',
  HUB_GET_MESSAGE_HISTORY: 'hub:get-message-history',
  UPDATE_CHECK: 'update:check',
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_PERFORM: 'update:perform',
  APP_RESTART: 'app:restart',
  GROUP_GET_ALL: 'group:get-all',
  GROUP_ADD_LINK: 'group:add-link',
  GROUP_REMOVE_LINK: 'group:remove-link',
  GROUP_GET_LINKS: 'group:get-links',
} as const

export interface BuddyMessage {
  id: string
  agentName: string
  buddyName: string
  message: string
  timestamp: string
}

export interface Skill {
  id: string
  name: string
  description: string
  category: string
  source: 'built-in' | 'user' | 'community'
  prompt: string
  tags: string[]
}

export interface AgentGroup {
  id: string
  name: string
  color: string
  members: string[]
}

export interface LinkState {
  links: Array<{ from: string; to: string }>
  groups: AgentGroup[]
}

export interface RacSlot {
  slot_id: string
  parker_name: string
  tier: string
  note: string
  expires_at: number | null
  time_left_ms: number | null
  created_at: number
}

export interface RacSession {
  session_id: string
  slot_id: string
  parker: string
  renter: string
  agentorch_agent: string
  status: string
}

export interface InfoEntry {
  id: string
  from: string
  note: string
  tags: string[]
  createdAt: string
  groupId?: string
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
