import { describe, it, expect } from 'vitest'
import { validateRespawnRequest } from './respawn-validation'
import type { AgentConfig } from '../shared/types'

const baseConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: 'agent-1',
  name: 'worker',
  cli: 'claude',
  cwd: 'C:/projects/foo',
  role: 'worker',
  ceoNotes: '',
  shell: 'powershell',
  admin: false,
  autoMode: false,
  ...overrides,
})

describe('validateRespawnRequest', () => {
  it('accepts when name is unchanged and cwd exists', () => {
    const current = baseConfig()
    const next = { ...current, model: 'opus' }
    const result = validateRespawnRequest({
      currentConfig: current,
      newConfig: next,
      otherAgentNames: ['orchestrator'],
      cwdExists: () => true,
    })
    expect(result).toEqual({ ok: true })
  })

  it('accepts when name changes to a free name', () => {
    const current = baseConfig({ name: 'worker' })
    const next = { ...current, name: 'researcher' }
    const result = validateRespawnRequest({
      currentConfig: current,
      newConfig: next,
      otherAgentNames: ['orchestrator'],
      cwdExists: () => true,
    })
    expect(result).toEqual({ ok: true })
  })

  it('rejects when new name belongs to another live agent', () => {
    const current = baseConfig({ name: 'worker' })
    const next = { ...current, name: 'orchestrator' }
    const result = validateRespawnRequest({
      currentConfig: current,
      newConfig: next,
      otherAgentNames: ['orchestrator'],
      cwdExists: () => true,
    })
    expect(result).toEqual({ ok: false, error: 'NAME_TAKEN' })
  })

  it('does NOT reject when keeping the same name (it would appear in otherAgentNames if naive)', () => {
    const current = baseConfig({ name: 'worker' })
    const next = { ...current }
    const result = validateRespawnRequest({
      currentConfig: current,
      newConfig: next,
      otherAgentNames: ['worker', 'orchestrator'],  // includes self
      cwdExists: () => true,
    })
    expect(result).toEqual({ ok: true })
  })

  it('rejects when cwd does not exist', () => {
    const current = baseConfig()
    const next = { ...current, cwd: 'C:/missing' }
    const result = validateRespawnRequest({
      currentConfig: current,
      newConfig: next,
      otherAgentNames: [],
      cwdExists: () => false,
    })
    expect(result).toEqual({ ok: false, error: 'CWD_MISSING' })
  })

  it('rejects empty name', () => {
    const current = baseConfig()
    const next = { ...current, name: '   ' }
    const result = validateRespawnRequest({
      currentConfig: current,
      newConfig: next,
      otherAgentNames: [],
      cwdExists: () => true,
    })
    expect(result).toEqual({ ok: false, error: 'INTERNAL', message: 'Name cannot be empty' })
  })
})
