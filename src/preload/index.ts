import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'

contextBridge.exposeInMainWorld('electronAPI', {
  spawnAgent: (config: unknown) => ipcRenderer.invoke(IPC.SPAWN_AGENT, config),
  killAgent: (agentId: string) => ipcRenderer.invoke(IPC.KILL_AGENT, agentId),
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
  getPinboardTasks: () => ipcRenderer.invoke(IPC.PINBOARD_GET_TASKS),
  onPinboardUpdate: (callback: (tasks: unknown[]) => void) => {
    const handler = (_event: unknown, tasks: unknown[]) => callback(tasks)
    ipcRenderer.on(IPC.PINBOARD_TASK_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC.PINBOARD_TASK_UPDATE, handler)
  },
  getInfoEntries: () => ipcRenderer.invoke(IPC.INFO_GET_ENTRIES),
  onInfoUpdate: (callback: (entries: unknown[]) => void) => {
    const handler = (_event: unknown, entries: unknown[]) => callback(entries)
    ipcRenderer.on(IPC.INFO_ENTRY_ADDED, handler)
    return () => ipcRenderer.removeListener(IPC.INFO_ENTRY_ADDED, handler)
  },
  // Project management
  getProject: () => ipcRenderer.invoke(IPC.PROJECT_GET_CURRENT),
  switchProject: (path: string) => ipcRenderer.invoke(IPC.PROJECT_SWITCH, path),
  listRecentProjects: () => ipcRenderer.invoke(IPC.PROJECT_LIST_RECENT),
  openFolderDialog: () => ipcRenderer.invoke(IPC.PROJECT_OPEN_FOLDER),
  onProjectChanged: (callback: (project: unknown) => void) => {
    const handler = (_event: unknown, project: unknown) => callback(project)
    ipcRenderer.on(IPC.PROJECT_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.PROJECT_CHANGED, handler)
  }
})
