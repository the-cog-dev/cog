import type { AgentConfig, AgentState, HubInfo, PinboardTask, InfoEntry, WorkspacePreset, Skill, CreateScheduleInput, EditScheduleInput } from '../shared/types'

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
    }
  }
}
