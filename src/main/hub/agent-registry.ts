import type { AgentConfig, AgentState, AgentStatus } from '../../shared/types'

export class AgentRegistry {
  private agents = new Map<string, AgentState>()
  private lastHeartbeat = new Map<string, number>() // name → timestamp ms

  register(config: AgentConfig): AgentState {
    const existing = this.agents.get(config.name)
    if (existing) {
      // Upsert: update config fields but preserve runtime state
      Object.assign(existing, config)
      existing.status = 'idle'
      return existing
    }
    const state: AgentState = {
      ...config,
      status: 'idle',
      createdAt: new Date().toISOString()
    }
    this.agents.set(config.name, state)
    return state
  }

  get(name: string): AgentState | undefined {
    return this.agents.get(name)
  }

  list(): AgentState[] {
    return Array.from(this.agents.values())
  }

  updateStatus(name: string, status: AgentStatus): void {
    const agent = this.agents.get(name)
    if (agent) {
      agent.status = status
    }
  }

  remove(name: string): void {
    this.agents.delete(name)
    this.lastHeartbeat.delete(name)
  }

  recordHeartbeat(name: string): void {
    this.lastHeartbeat.set(name, Date.now())
  }

  getLastHeartbeat(name: string): number | null {
    return this.lastHeartbeat.get(name) ?? null
  }

  isHealthy(name: string, maxAge = 60000): boolean {
    const last = this.lastHeartbeat.get(name)
    if (!last) return true // No heartbeats expected yet
    return Date.now() - last < maxAge
  }
}
