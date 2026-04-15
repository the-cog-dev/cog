import type { AgentConfig, AgentState, AgentStatus } from '../../shared/types'

// Fields copied from an incoming AgentConfig onto the live AgentState.
// Explicit allowlist so runtime-only fields (status, createdAt, etc.) can
// never be overwritten by a registrant — including special keys like
// __proto__ or constructor.
const ALLOWED_CONFIG_KEYS = [
  'id', 'name', 'cli', 'role', 'model', 'shell', 'cwd',
  'ceoNotes', 'admin', 'autoMode', 'tabId', 'groupId',
  'promptRegex', 'providerUrl', 'experimental', 'skills', 'theme'
] as const

function copyConfigFields(src: AgentConfig, dst: AgentState): void {
  for (const key of ALLOWED_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      // @ts-expect-error — structural copy, keys are validated against the allowlist above.
      dst[key] = (src as Record<string, unknown>)[key]
    }
  }
}

export class AgentRegistry {
  private agents = new Map<string, AgentState>()
  private lastHeartbeat = new Map<string, number>() // name → timestamp ms

  register(config: AgentConfig): AgentState {
    const existing = this.agents.get(config.name)
    if (existing) {
      // Upsert via explicit field allowlist. A bare Object.assign let a registrant
      // pick any key present on AgentState (status, createdAt, __proto__, etc.)
      // and clobber server-managed runtime state.
      copyConfigFields(config, existing)
      existing.status = 'idle'
      return existing
    }
    const state: AgentState = {
      status: 'idle',
      createdAt: new Date().toISOString()
    } as AgentState
    copyConfigFields(config, state)
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
