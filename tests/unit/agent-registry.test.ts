import { describe, it, expect, beforeEach } from 'vitest'
import { AgentRegistry } from '../../src/main/hub/agent-registry'
import type { AgentConfig } from '../../src/shared/types'

const makeConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: 'test-1',
  name: 'worker-1',
  cli: 'claude',
  cwd: '/tmp',
  role: 'Tester',
  ceoNotes: 'Test agent',
  shell: 'powershell' as const,
  admin: false,
  autoMode: false,
  ...overrides
})

describe('AgentRegistry', () => {
  let registry: AgentRegistry

  beforeEach(() => {
    registry = new AgentRegistry()
  })

  it('registers an agent and returns its state', () => {
    const config = makeConfig()
    const state = registry.register(config)
    expect(state.name).toBe('worker-1')
    expect(state.status).toBe('idle')
  })

  it('rejects duplicate names', () => {
    registry.register(makeConfig())
    expect(() => registry.register(makeConfig({ id: 'test-2' }))).toThrow('already exists')
  })

  it('lists all agents', () => {
    registry.register(makeConfig({ id: '1', name: 'a' }))
    registry.register(makeConfig({ id: '2', name: 'b' }))
    expect(registry.list()).toHaveLength(2)
  })

  it('gets agent by name', () => {
    registry.register(makeConfig())
    expect(registry.get('worker-1')).toBeDefined()
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('updates agent status', () => {
    registry.register(makeConfig())
    registry.updateStatus('worker-1', 'working')
    expect(registry.get('worker-1')!.status).toBe('working')
  })

  it('removes an agent', () => {
    registry.register(makeConfig())
    registry.remove('worker-1')
    expect(registry.get('worker-1')).toBeUndefined()
    expect(registry.list()).toHaveLength(0)
  })
})
