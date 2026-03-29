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
  }
})
