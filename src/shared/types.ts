export type AgentStatus = 'idle' | 'active' | 'working' | 'disconnected'

// Per-agent visual theme — colors customize the window chrome and terminal.
// Any field can be omitted to fall back to the default. Sharing-safe (no PII).
export interface AgentTheme {
  chrome?: string  // window title bar background color
  border?: string  // window outline color
  bg?: string      // terminal content area background color
  text?: string    // terminal default text color (ANSI sequences still override)
}

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
  tabId?: string  // workspace tab this agent belongs to
  theme?: AgentTheme  // optional per-agent color theme
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
  tabId?: string
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
  targetRole?: string
  targetAgent?: string
  tabId?: string
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
  PINBOARD_CLEAR_COMPLETED: 'pinboard:clear-completed',
  PINBOARD_TASK_UPDATE: 'pinboard:task-update',
  STALE_ALERT_GET: 'stale-alert:get',
  STALE_ALERT_SET: 'stale-alert:set',
  STALE_ALERT_UPDATE: 'stale-alert:update',
  COMMUNITY_LIST: 'community:list',
  COMMUNITY_GET: 'community:get',
  COMMUNITY_SHARE: 'community:share',
  COMMUNITY_TOGGLE_STAR: 'community:toggle-star',
  AGENT_SET_THEME: 'agent:set-theme',
  INFO_GET_ENTRIES: 'info:get-entries',
  INFO_ENTRY_ADDED: 'info:entry-added',
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
  UPDATE_GET_CHANGELOG: 'update:get-changelog',
  APP_RESTART: 'app:restart',
  BUG_REPORT_SUBMIT: 'bug:submit',
  GROUP_GET_ALL: 'group:get-all',
  GROUP_ADD_LINK: 'group:add-link',
  GROUP_REMOVE_LINK: 'group:remove-link',
  GROUP_GET_LINKS: 'group:get-links',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  AGENT_CLEAR_CONTEXT: 'agent:clear-context',
  USAGE_GET_METRICS: 'usage:get-metrics',
  USAGE_REFRESH_LIMITS: 'usage:refresh-limits',
  GIT_STATUS: 'git:status',
  GIT_LOG: 'git:log',
  GIT_DIFF: 'git:diff',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_COMMIT: 'git:commit',
  GIT_PUSH: 'git:push',
  GIT_PULL: 'git:pull',
  GIT_BRANCHES: 'git:branches',
  GIT_CHECKOUT: 'git:checkout',
  GIT_NEW_BRANCH: 'git:new-branch',
  TAB_GET_ALL: 'tab:get-all',
  TAB_CREATE: 'tab:create',
  TAB_CLOSE: 'tab:close',
  TAB_RENAME: 'tab:rename',
  SCHEDULES_LIST: 'schedules:list',
  SCHEDULES_CREATE: 'schedules:create',
  SCHEDULES_PAUSE: 'schedules:pause',
  SCHEDULES_RESUME: 'schedules:resume',
  SCHEDULES_STOP: 'schedules:stop',
  SCHEDULES_RESTART: 'schedules:restart',
  SCHEDULES_EDIT: 'schedules:edit',
  SCHEDULES_DELETE: 'schedules:delete',
  // schedules:* = per-schedule CRUD events; scheduler:* = system-level scheduler events
  SCHEDULES_UPDATED: 'schedules:updated',
  SCHEDULER_RESUMED: 'scheduler:resumed',
  // Remote View
  REMOTE_ENABLE: 'remote:enable',
  REMOTE_DISABLE: 'remote:disable',
  REMOTE_STATE: 'remote:state',
  REMOTE_KILL_SESSIONS: 'remote:kill-sessions',
  REMOTE_REGENERATE: 'remote:regenerate',
  REMOTE_STATUS_UPDATE: 'remote:status-update',
  REMOTE_SETUP_PROGRESS: 'remote:setup-progress',
  // Workshop passcode
  WORKSHOP_SET_PASSCODE: 'workshop:set-passcode',
  WORKSHOP_GET_PASSCODE_SET: 'workshop:get-passcode-set',
  WORKSHOP_CLEAR_PASSCODE: 'workshop:clear-passcode',
  // Workspace state bridge (renderer → main, fire-and-forget)
  WORKSPACE_STATE_PUSH: 'workspace:state-push',
} as const

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

export interface WorkspaceTab {
  id: string
  name: string
}

export interface AgentMetricsData {
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
    unit: string
    raw?: string
  }
}

export interface GitFileStatus {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  staged: boolean
}

export interface GitStatus {
  branch: string
  ahead: number
  behind: number
  staged: GitFileStatus[]
  unstaged: GitFileStatus[]
  isRepo: boolean
}

export interface GitLogEntry {
  sha: string
  message: string
  author: string
  relativeDate: string
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
  tabId?: string
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

// Community Teams — shared with the renderer so the Community tab UI can type-check

export type CommunityCategory = 'research' | 'coding' | 'review' | 'full-stack' | 'decomp' | 'mixed' | 'other'

// Shrunk AgentConfig that's safe to share — no cwd, no ids, no tab/group/provider
export interface CommunityAgent {
  name: string
  cli: string
  role: string
  ceoNotes: string
  shell: 'cmd' | 'powershell' | 'bash' | 'zsh' | 'fish'
  admin: boolean
  autoMode: boolean
  model?: string
  experimental?: boolean
  skills?: string[]
  theme?: AgentTheme
}

export interface CommunityTeam {
  version: 1
  issueNumber?: number       // set by the server response; absent when drafting a new share
  name: string
  description: string
  author: string
  category: CommunityCategory
  agentCount: number
  clis: string[]
  agents: CommunityAgent[]
  stars: number
  starredBy: string[]        // machine-hashes (12 char truncated)
  createdAt: string
}

export interface CommunityTeamListItem {
  issueNumber: number
  name: string
  description: string
  author: string
  category: CommunityCategory
  agentCount: number
  clis: string[]
  stars: number
  createdAt: string
  isStarredByMe: boolean
}

export interface FireHistoryEntry {
  timestamp: number
  outcome: 'fired' | 'skipped_offline'
}

export type ScheduleStatus = 'active' | 'paused' | 'stopped' | 'expired'

export interface ScheduledPrompt {
  id: string
  tabId: string
  agentId: string
  name: string
  promptText: string
  intervalMinutes: number
  durationHours: number | null   // null = infinite
  startedAt: number
  expiresAt: number | null       // null = infinite
  nextFireAt: number
  pausedAt: number | null
  status: ScheduleStatus
  fireHistory: FireHistoryEntry[]
}

export interface CreateScheduleInput {
  tabId: string
  agentId: string
  name?: string
  promptText: string
  intervalMinutes: number
  durationHours: number | null
}

export interface EditScheduleInput {
  name?: string
  promptText?: string
  intervalMinutes?: number
  durationHours?: number | null
}

export interface RemoteViewStatus {
  enabled: boolean
  publicUrl: string | null
  connectionCount: number
  lastActivity: number | null
}

export type RemoteSetupProgress =
  | { stage: 'downloading'; message?: string }
  | { stage: 'starting'; message?: string }
  | { stage: 'ready'; message?: string }
  | { stage: 'error'; message?: string }
