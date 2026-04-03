import type { AgentConfig, AgentState, HubInfo, PinboardTask, InfoEntry, WorkspacePreset, Skill } from '../shared/types'

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
      getPinboardTasks: () => Promise<PinboardTask[]>
      onPinboardUpdate: (callback: (tasks: PinboardTask[]) => void) => () => void
      getInfoEntries: () => Promise<InfoEntry[]>
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
    }
  }
}
