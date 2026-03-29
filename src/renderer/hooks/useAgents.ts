import { useState, useEffect, useCallback } from 'react'
import type { AgentConfig, AgentState } from '../../shared/types'
import { v4 as uuid } from 'uuid'

const STATUS_COLORS: Record<string, string> = {
  idle: '#888',
  active: '#4caf50',
  working: '#ffc107',
  disconnected: '#f44336'
}

export function useAgents() {
  const [agents, setAgents] = useState<AgentState[]>([])

  useEffect(() => {
    const cleanup = window.electronAPI.onAgentStateUpdate((updated) => {
      setAgents(updated)
    })
    window.electronAPI.getAgents().then(setAgents)
    return cleanup
  }, [])

  const spawnAgent = useCallback(async (config: Omit<AgentConfig, 'id'>) => {
    const fullConfig: AgentConfig = { ...config, id: uuid() }
    await window.electronAPI.spawnAgent(fullConfig)
    return fullConfig.id
  }, [])

  const killAgent = useCallback(async (agentId: string) => {
    await window.electronAPI.killAgent(agentId)
  }, [])

  const getStatusColor = useCallback((status: string) => {
    return STATUS_COLORS[status] ?? '#888'
  }, [])

  return { agents, spawnAgent, killAgent, getStatusColor }
}
