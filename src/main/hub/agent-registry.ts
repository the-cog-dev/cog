import type { AgentConfig, AgentState, AgentStatus } from '../../shared/types'

export class AgentRegistry {
  private agents = new Map<string, AgentState>()

  register(config: AgentConfig): AgentState {
    if (this.agents.has(config.name)) {
      throw new Error(`Agent '${config.name}' already exists`)
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
  }
}
