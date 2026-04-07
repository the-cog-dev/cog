import type { AgentConfig } from '../shared/types'

/**
 * Build a shell command that removes ALL agentorch-* MCP registrations
 * for a given CLI tool. Prevents stale registrations from accumulating
 * when agent names change between sessions.
 *
 * Gemini `mcp list` prefixes lines with a status icon (✓/✗) so the name
 * is NOT the first token — we use grep -o / regex extraction to pull out
 * the agentorch-* name regardless of surrounding text.
 *
 * Codex `mcp list` prints the name as the first token, so we keep the
 * simpler start-anchored match there to avoid changing what already works.
 */
function buildMcpCleanupCmd(
  cli: 'codex' | 'gemini',
  shell: AgentConfig['shell']
): string {
  if (cli === 'gemini') return buildGeminiCleanupCmd(shell)
  return buildCodexCleanupCmd(shell)
}

function buildCodexCleanupCmd(shell: AgentConfig['shell']): string {
  if (shell === 'cmd') {
    return `for /f "tokens=1" %i in ('codex mcp list 2^>nul ^| findstr /B "agentorch"') do @codex mcp remove %i 2>nul`
  }
  if (shell === 'powershell') {
    return `codex mcp list 2>$null | Where-Object { $_ -match '^agentorch' } | ForEach-Object { codex mcp remove ($_ -split '\\s+')[0] 2>$null }`
  }
  if (shell === 'fish') {
    return `codex mcp list 2>/dev/null | grep '^agentorch' | awk '{print $1}' | while read name; codex mcp remove $name 2>/dev/null; end`
  }
  // bash, zsh
  return `codex mcp list 2>/dev/null | grep '^agentorch' | awk '{print $1}' | while read name; do codex mcp remove "$name" 2>/dev/null; done`
}

function buildGeminiCleanupCmd(shell: AgentConfig['shell']): string {
  if (shell === 'cmd') {
    // Gemini `mcp list` emits Unicode status icons (✓/✗) that cause cmd.exe to drop the entire
    // output stream when piped through `for /f`, so the loop receives nothing and cleanup
    // silently fails. Shell out to PowerShell which handles the Unicode output correctly.
    return `powershell -NoProfile -Command "gemini mcp list 2>$null | ForEach-Object { if ($_ -match '(agentorch[^\\s:]+)') { gemini mcp remove $Matches[1] 2>$null } }"`
  }
  if (shell === 'powershell') {
    return `gemini mcp list 2>$null | ForEach-Object { if ($_ -match '(agentorch[^\\s:]+)') { gemini mcp remove $Matches[1] 2>$null } }`
  }
  if (shell === 'fish') {
    return `gemini mcp list 2>/dev/null | grep -o 'agentorch[^ :]*' | while read name; gemini mcp remove $name 2>/dev/null; end`
  }
  // bash, zsh
  return `gemini mcp list 2>/dev/null | grep -o 'agentorch[^ :]*' | while read name; do gemini mcp remove "$name" 2>/dev/null; done`
}

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
    const cmds = [
      buildMcpCleanupCmd('codex', config.shell),
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
    // NOTE: Gemini CLI's yargs parser does NOT pass positional args through `--` correctly.
    // `gemini mcp add <name> -- node ...` fails with "Not enough non-option arguments".
    // Codex CLI handles -- fine, but Gemini does not. Keep `--` out of this command.
    const cmds = [
      buildMcpCleanupCmd('gemini', config.shell),
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
