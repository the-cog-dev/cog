import type { AgentConfig, RespawnResult } from '../shared/types'

export interface ValidateRespawnInput {
  currentConfig: AgentConfig
  newConfig: Omit<AgentConfig, 'id'>
  /** Names of all live agents — may include the current agent's own name */
  otherAgentNames: string[]
  /** Sync check that cwd exists on disk */
  cwdExists: (path: string) => boolean
}

export function validateRespawnRequest(input: ValidateRespawnInput): RespawnResult {
  const { currentConfig, newConfig, otherAgentNames, cwdExists } = input
  const trimmedName = newConfig.name.trim()

  if (!trimmedName) {
    return { ok: false, error: 'INTERNAL', message: 'Name cannot be empty' }
  }

  if (trimmedName !== currentConfig.name) {
    if (otherAgentNames.includes(trimmedName)) {
      return { ok: false, error: 'NAME_TAKEN' }
    }
  }

  if (!cwdExists(newConfig.cwd)) {
    return { ok: false, error: 'CWD_MISSING' }
  }

  return { ok: true }
}
