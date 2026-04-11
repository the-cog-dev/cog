import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'

contextBridge.exposeInMainWorld('electronAPI', {
  spawnAgent: (config: unknown) => ipcRenderer.invoke(IPC.SPAWN_AGENT, config),
  killAgent: (agentId: string) => ipcRenderer.invoke(IPC.KILL_AGENT, agentId),
  clearAgentContext: (agentId: string) => ipcRenderer.invoke(IPC.AGENT_CLEAR_CONTEXT, agentId),
  getAgents: () => ipcRenderer.invoke(IPC.GET_AGENTS),
  getHubInfo: () => ipcRenderer.invoke(IPC.GET_HUB_INFO),
  writeToPty: (agentId: string, data: string) => ipcRenderer.invoke(IPC.WRITE_TO_PTY, agentId, data),
  resizePty: (agentId: string, cols: number, rows: number) => ipcRenderer.invoke('pty:resize', agentId, cols, rows),
  getCwd: () => ipcRenderer.invoke('app:cwd'),
  browseDirectory: (defaultPath: string) => ipcRenderer.invoke('dialog:browse-directory', defaultPath),
  savePreset: (name: string, agents: unknown, windows: unknown, canvas: unknown) => 
    ipcRenderer.invoke(IPC.SAVE_PRESET, name, agents, windows, canvas),
  loadPreset: (name: string) => ipcRenderer.invoke(IPC.LOAD_PRESET, name),
  listPresets: () => ipcRenderer.invoke(IPC.LIST_PRESETS),
  deletePreset: (name: string) => ipcRenderer.invoke(IPC.DELETE_PRESET, name),
  onPtyOutput: (callback: (agentId: string, data: string) => void) => {
    const handler = (_event: unknown, agentId: string, data: string) => callback(agentId, data)
    ipcRenderer.on(IPC.PTY_OUTPUT, handler)
    return () => ipcRenderer.removeListener(IPC.PTY_OUTPUT, handler)
  },
  onPtyExit: (callback: (agentId: string, exitCode: number | undefined) => void) => {
    const handler = (_event: unknown, agentId: string, exitCode: number | undefined) => callback(agentId, exitCode)
    ipcRenderer.on(IPC.PTY_EXIT, handler)
    return () => ipcRenderer.removeListener(IPC.PTY_EXIT, handler)
  },
  onAgentStateUpdate: (callback: (agents: unknown[]) => void) => {
    const handler = (_event: unknown, agents: unknown[]) => callback(agents)
    ipcRenderer.on(IPC.AGENT_STATE_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_STATE_UPDATE, handler)
  },
  getPinboardTasks: (tabId?: string) => ipcRenderer.invoke(IPC.PINBOARD_GET_TASKS, tabId),
  clearCompletedTasks: () => ipcRenderer.invoke(IPC.PINBOARD_CLEAR_COMPLETED),
  onPinboardUpdate: (callback: (tasks: unknown[]) => void) => {
    const handler = (_event: unknown, tasks: unknown[]) => callback(tasks)
    ipcRenderer.on(IPC.PINBOARD_TASK_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC.PINBOARD_TASK_UPDATE, handler)
  },
  getStaleAlertSnooze: () => ipcRenderer.invoke(IPC.STALE_ALERT_GET),
  setStaleAlertSnooze: (durationMs: number | null) => ipcRenderer.invoke(IPC.STALE_ALERT_SET, durationMs),
  onStaleAlertUpdate: (callback: (state: { muteUntil: number | null }) => void) => {
    const handler = (_event: unknown, state: { muteUntil: number | null }) => callback(state)
    ipcRenderer.on(IPC.STALE_ALERT_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC.STALE_ALERT_UPDATE, handler)
  },
  // Community Teams
  communityList: (opts?: { force?: boolean }) => ipcRenderer.invoke(IPC.COMMUNITY_LIST, opts),
  communityGet: (issueNumber: number) => ipcRenderer.invoke(IPC.COMMUNITY_GET, issueNumber),
  communityShare: (input: unknown) => ipcRenderer.invoke(IPC.COMMUNITY_SHARE, input),
  communityToggleStar: (issueNumber: number) => ipcRenderer.invoke(IPC.COMMUNITY_TOGGLE_STAR, issueNumber),
  getInfoEntries: (tabId?: string) => ipcRenderer.invoke(IPC.INFO_GET_ENTRIES, tabId),
  onInfoUpdate: (callback: (entries: unknown[]) => void) => {
    const handler = (_event: unknown, entries: unknown[]) => callback(entries)
    ipcRenderer.on(IPC.INFO_ENTRY_ADDED, handler)
    return () => ipcRenderer.removeListener(IPC.INFO_ENTRY_ADDED, handler)
  },
  // Groups
  getGroups: () => ipcRenderer.invoke(IPC.GROUP_GET_ALL),
  getLinks: () => ipcRenderer.invoke(IPC.GROUP_GET_LINKS),
  addLink: (from: string, to: string) => ipcRenderer.invoke(IPC.GROUP_ADD_LINK, from, to),
  removeLink: (from: string, to: string) => ipcRenderer.invoke(IPC.GROUP_REMOVE_LINK, from, to),
  // Project management
  getProject: () => ipcRenderer.invoke(IPC.PROJECT_GET_CURRENT),
  switchProject: (path: string) => ipcRenderer.invoke(IPC.PROJECT_SWITCH, path),
  listRecentProjects: () => ipcRenderer.invoke(IPC.PROJECT_LIST_RECENT),
  openFolderDialog: () => ipcRenderer.invoke(IPC.PROJECT_OPEN_FOLDER),
  onProjectChanged: (callback: (project: unknown) => void) => {
    const handler = (_event: unknown, project: unknown) => callback(project)
    ipcRenderer.on(IPC.PROJECT_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.PROJECT_CHANGED, handler)
  },
  // File operations
  listFiles: (dirPath?: string) => ipcRenderer.invoke(IPC.FILE_LIST, dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke(IPC.FILE_READ, filePath),
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke(IPC.FILE_WRITE, filePath, content),
  // Skills
  listSkills: () => ipcRenderer.invoke(IPC.SKILL_LIST),
  getSkill: (id: string) => ipcRenderer.invoke(IPC.SKILL_GET, id),
  createSkill: (input: unknown) => ipcRenderer.invoke(IPC.SKILL_CREATE, input),
  updateSkill: (id: string, updates: unknown) => ipcRenderer.invoke(IPC.SKILL_UPDATE, id, updates),
  deleteSkill: (id: string) => ipcRenderer.invoke(IPC.SKILL_DELETE, id),
  // R.A.C.
  racGetServer: () => ipcRenderer.invoke(IPC.RAC_GET_SERVER),
  racSetServer: (url: string) => ipcRenderer.invoke(IPC.RAC_SET_SERVER, url),
  racGetAvailable: () => ipcRenderer.invoke(IPC.RAC_GET_AVAILABLE),
  racRent: (slotId: string, renterName: string) => ipcRenderer.invoke(IPC.RAC_RENT, slotId, renterName),
  racRelease: (sessionId: string) => ipcRenderer.invoke(IPC.RAC_RELEASE, sessionId),
  racGetSessions: () => ipcRenderer.invoke(IPC.RAC_GET_SESSIONS),
  // Hub messaging (for R.A.C. chat panel)
  hubSendMessage: (from: string, to: string, message: string) => ipcRenderer.invoke(IPC.HUB_SEND_MESSAGE, from, to, message),
  hubGetMessageHistory: (agent?: string, limit?: number) => ipcRenderer.invoke(IPC.HUB_GET_MESSAGE_HISTORY, agent, limit),
  // Updates
  checkForUpdate: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
  performUpdate: () => ipcRenderer.invoke(IPC.UPDATE_PERFORM),
  getUpdateChangelog: () => ipcRenderer.invoke(IPC.UPDATE_GET_CHANGELOG),
  onUpdateAvailable: (callback: (info: unknown) => void) => {
    const handler = (_event: unknown, info: unknown) => callback(info)
    ipcRenderer.on(IPC.UPDATE_AVAILABLE, handler)
    return () => ipcRenderer.removeListener(IPC.UPDATE_AVAILABLE, handler)
  },
  restartApp: () => ipcRenderer.invoke(IPC.APP_RESTART),
  submitBugReport: (title: string, body: string) => ipcRenderer.invoke(IPC.BUG_REPORT_SUBMIT, { title, body }),
  // Usage
  getUsageMetrics: () => ipcRenderer.invoke(IPC.USAGE_GET_METRICS),
  refreshUsageLimits: () => ipcRenderer.invoke(IPC.USAGE_REFRESH_LIMITS),
  // Settings
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke(IPC.SETTINGS_SET, key, value),
  // Tabs
  getTabs: () => ipcRenderer.invoke(IPC.TAB_GET_ALL),
  createTab: (name?: string) => ipcRenderer.invoke(IPC.TAB_CREATE, name),
  closeTab: (tabId: string) => ipcRenderer.invoke(IPC.TAB_CLOSE, tabId),
  renameTab: (tabId: string, name: string) => ipcRenderer.invoke(IPC.TAB_RENAME, tabId, name),
  // Scheduled prompts
  listSchedules: () => ipcRenderer.invoke(IPC.SCHEDULES_LIST),
  createSchedule: (input: unknown) => ipcRenderer.invoke(IPC.SCHEDULES_CREATE, input),
  pauseSchedule: (id: string) => ipcRenderer.invoke(IPC.SCHEDULES_PAUSE, id),
  resumeSchedule: (id: string) => ipcRenderer.invoke(IPC.SCHEDULES_RESUME, id),
  stopSchedule: (id: string) => ipcRenderer.invoke(IPC.SCHEDULES_STOP, id),
  restartSchedule: (id: string) => ipcRenderer.invoke(IPC.SCHEDULES_RESTART, id),
  editSchedule: (id: string, updates: unknown) => ipcRenderer.invoke(IPC.SCHEDULES_EDIT, id, updates),
  deleteSchedule: (id: string) => ipcRenderer.invoke(IPC.SCHEDULES_DELETE, id),
  onSchedulesUpdated: (callback: (schedules: unknown[]) => void) => {
    const handler = (_event: unknown, schedules: unknown[]) => callback(schedules)
    ipcRenderer.on(IPC.SCHEDULES_UPDATED, handler)
    return () => ipcRenderer.removeListener(IPC.SCHEDULES_UPDATED, handler)
  },
  onSchedulerResumed: (callback: (info: { count: number }) => void) => {
    const handler = (_event: unknown, info: { count: number }) => callback(info)
    ipcRenderer.on(IPC.SCHEDULER_RESUMED, handler)
    return () => ipcRenderer.removeListener(IPC.SCHEDULER_RESUMED, handler)
  },
  // Remote View
  enableRemoteView: () => ipcRenderer.invoke(IPC.REMOTE_ENABLE),
  disableRemoteView: () => ipcRenderer.invoke(IPC.REMOTE_DISABLE),
  getRemoteViewState: () => ipcRenderer.invoke(IPC.REMOTE_STATE),
  killRemoteSessions: () => ipcRenderer.invoke(IPC.REMOTE_KILL_SESSIONS),
  regenerateRemoteToken: () => ipcRenderer.invoke(IPC.REMOTE_REGENERATE),
  onRemoteStatusUpdate: (callback: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => callback(status)
    ipcRenderer.on(IPC.REMOTE_STATUS_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC.REMOTE_STATUS_UPDATE, handler)
  },
  onRemoteSetupProgress: (callback: (progress: unknown) => void) => {
    const handler = (_event: unknown, progress: unknown) => callback(progress)
    ipcRenderer.on(IPC.REMOTE_SETUP_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC.REMOTE_SETUP_PROGRESS, handler)
  },
  // Git
  gitStatus: () => ipcRenderer.invoke(IPC.GIT_STATUS),
  gitLog: (count?: number) => ipcRenderer.invoke(IPC.GIT_LOG, count),
  gitDiff: (file: string, staged: boolean) => ipcRenderer.invoke(IPC.GIT_DIFF, file, staged),
  gitStage: (file: string) => ipcRenderer.invoke(IPC.GIT_STAGE, file),
  gitUnstage: (file: string) => ipcRenderer.invoke(IPC.GIT_UNSTAGE, file),
  gitCommit: (message: string) => ipcRenderer.invoke(IPC.GIT_COMMIT, message),
  gitPush: () => ipcRenderer.invoke(IPC.GIT_PUSH),
  gitPull: () => ipcRenderer.invoke(IPC.GIT_PULL),
  gitBranches: () => ipcRenderer.invoke(IPC.GIT_BRANCHES),
  gitCheckout: (branch: string) => ipcRenderer.invoke(IPC.GIT_CHECKOUT, branch),
  gitNewBranch: (name: string) => ipcRenderer.invoke(IPC.GIT_NEW_BRANCH, name),
})
