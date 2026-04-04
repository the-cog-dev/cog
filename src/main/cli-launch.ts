import type { AgentConfig } from '../shared/types'

export function buildCliLaunchCommands(
  config: AgentConfig,
  mcpConfigPath: string,
  mcpServerPath: string,
  hubPort: number,
  hubSecret: string
): string[] | null {
  const cliBase = config.cli

  if (cliBase === 'terminal') return null

  if (cliBase === 'claude') {
    const parts = [`claude --mcp-config "${mcpConfigPath}"`]
    if (config.model) parts[0] += ` --model ${config.model}`
    if (config.autoMode) parts[0] += ' --dangerously-skip-permissions'
    return parts
  }

  if (cliBase === 'openclaude') {
    const parts = [`openclaude --mcp-config "${mcpConfigPath}"`]
    if (config.model) parts[0] += ` --model ${config.model}`
    if (config.autoMode) parts[0] += ' --dangerously-skip-permissions'
    return parts
  }

  if (cliBase === 'codex') {
    const mcpName = `agentorch-${config.name.replace(/\s+/g, '-')}`
    const nullDev = config.shell === 'cmd' ? 'nul' : '$null'
    const cmds = [
      `codex mcp remove ${mcpName} 2>${nullDev}`,
      `codex mcp add ${mcpName} -- node "${mcpServerPath}" ${hubPort} ${hubSecret} ${config.id} ${config.name}`,
    ]
    let codexCmd = 'codex'
    if (config.model) codexCmd += ` -m ${config.model}`
    if (config.autoMode) codexCmd += ' --yolo'
    cmds.push(codexCmd)
    return cmds
  }

  if (cliBase === 'kimi') {
    let cmd = `kimi --mcp-config-file "${mcpConfigPath}"`
    if (config.model) cmd += ` --model ${config.model}`
    if (config.autoMode) cmd += ' --yolo'
    return [cmd]
  }

  if (cliBase === 'gemini') {
    const mcpName = `agentorch-${config.name.replace(/\s+/g, '-')}`
    const nullDev = config.shell === 'cmd' ? 'nul' : '$null'
    const cmds = [
      `gemini mcp remove ${mcpName} 2>${nullDev}`,
      `gemini mcp add ${mcpName} node "${mcpServerPath}" ${hubPort} ${hubSecret} ${config.id} ${config.name}`,
    ]
    let geminiCmd = 'gemini'
    if (config.model) geminiCmd += ` --model ${config.model}`
    if (config.autoMode) geminiCmd += ' --yolo'
    cmds.push(geminiCmd)
    return cmds
  }

  if (cliBase === 'copilot') {
    let cmd = `copilot --additional-mcp-config "@${mcpConfigPath}"`
    if (config.model) cmd += ` --model=${config.model}`
    if (config.autoMode) cmd += ' --allow-all'
    return [cmd]
  }

  if (cliBase === 'grok') {
    let cmd = 'grok'
    if (config.model) cmd += ` --model ${config.model}`
    return [cmd]
  }

  return [cliBase]
}
