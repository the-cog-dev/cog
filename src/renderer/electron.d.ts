import type { AgentConfig, AgentState, AgentTheme, HubInfo, PinboardTask, InfoEntry, WorkspacePreset, Skill, CreateScheduleInput, EditScheduleInput, CommunityTeam, CommunityTeamListItem, CommunityAgent, CommunityCategory } from '../shared/types'

declare global {
  interface Window {
    electronAPI: {
      spawnAgent: (config: AgentConfig) => Promise<{ id: string; mcpConfigPath: string }>
      killAgent: (agentId: string) => Promise<void>
      getAgents: () => Promise<AgentState[]>
      getHubInfo: () => Promise<HubInfo>
      writeToPty: (agentId: string, data: string) => Promise<void>
      resizePty: (agentId: string, cols: number, rows: number) => Promise<void>
      getCwd: () => Promise<string>
      browseDirectory: (defaultPath: string) => Promise<string | null>
      savePreset: (name: string, agents: AgentConfig[], windows: unknown, canvas: unknown) => Promise<{ status: string }>
      loadPreset: (name: string) => Promise<WorkspacePreset>
      listPresets: () => Promise<string[]>
      deletePreset: (name: string) => Promise<{ status: string }>
      getPinboardTasks: (tabId?: string) => Promise<PinboardTask[]>
      onPinboardUpdate: (callback: (tasks: PinboardTask[]) => void) => () => void
      getInfoEntries: (tabId?: string) => Promise<InfoEntry[]>
      onInfoUpdate: (callback: (entries: InfoEntry[]) => void) => () => void
      onPtyOutput: (callback: (agentId: string, data: string) => void) => () => void
      onPtyExit: (callback: (agentId: string, exitCode: number | undefined) => void) => () => void
      onAgentStateUpdate: (callback: (agents: AgentState[]) => void) => () => void
      // Skills
      listSkills: () => Promise<Skill[]>
      getSkill: (id: string) => Promise<Skill>
      createSkill: (input: { name: string; description: string; category: string; prompt: string; tags: string[] }) => Promise<Skill>
      updateSkill: (id: string, updates: unknown) => Promise<Skill>
      deleteSkill: (id: string) => Promise<boolean>
      // Scheduler
      listSchedules: () => Promise<unknown[]>
      createSchedule: (input: CreateScheduleInput) => Promise<unknown>
      pauseSchedule: (id: string) => Promise<unknown>
      resumeSchedule: (id: string) => Promise<unknown>
      stopSchedule: (id: string) => Promise<unknown>
      restartSchedule: (id: string) => Promise<unknown>
      editSchedule: (id: string, updates: EditScheduleInput) => Promise<unknown>
      deleteSchedule: (id: string) => Promise<unknown>
      onSchedulesUpdated: (callback: (list: unknown[]) => void) => () => void
      onSchedulerResumed: (callback: () => void) => () => void
      // Remote View
      enableRemoteView: () => Promise<{ ok: boolean }>
      disableRemoteView: () => Promise<{ ok: boolean }>
      getRemoteViewState: () => Promise<{ enabled: boolean; publicUrl: string | null; connectionCount: number; lastActivity: number | null }>
      killRemoteSessions: () => Promise<{ ok: boolean; newUrl?: string | null }>
      regenerateRemoteToken: () => Promise<{ ok: boolean; newUrl?: string | null }>
      onRemoteStatusUpdate: (cb: (status: { enabled: boolean; publicUrl: string | null; connectionCount: number; lastActivity: number | null }) => void) => () => void
      onRemoteSetupProgress: (cb: (progress: { stage: 'downloading' | 'starting' | 'ready' | 'error'; message?: string }) => void) => () => void
      // Stale task alert snooze
      getStaleAlertSnooze: () => Promise<{ muteUntil: number | null }>
      setStaleAlertSnooze: (durationMs: number | null) => Promise<{ muteUntil: number | null }>
      onStaleAlertUpdate: (cb: (state: { muteUntil: number | null }) => void) => () => void
      // Community Teams
      communityList: (opts?: { force?: boolean }) => Promise<{ success: true; items: CommunityTeamListItem[] } | { success: false; error: string }>
      communityGet: (issueNumber: number) => Promise<{ success: true; team: CommunityTeam; isStarredByMe: boolean } | { success: false; error: string }>
      communityShare: (input: { name: string; description: string; author: string; category: CommunityCategory; agents: CommunityAgent[] }) => Promise<{ success: true; team: CommunityTeam } | { success: false; error: string }>
      communityToggleStar: (issueNumber: number) => Promise<{ success: true; stars: number; isStarredByMe: boolean } | { success: false; error: string }>
      // Workshop passcode
      setWorkshopPasscode: (pin: string) => Promise<{ success: boolean; error?: string }>
      getWorkshopPasscodeSet: () => Promise<{ isSet: boolean }>
      clearWorkshopPasscode: () => Promise<{ success: boolean }>
      // Per-agent theme
      setAgentTheme: (agentId: string, theme: AgentTheme | null) => Promise<{ success: boolean; error?: string }>
    }
  }
}
