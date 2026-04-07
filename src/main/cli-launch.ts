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
    // Sanitize: gemini rejects mcp server names with dots/special chars and silently
    // fails registration. Strip everything except alphanumerics and dashes, collapse
    // runs of dashes, trim leading/trailing dashes. Fall back to agent id if empty.
    const sanitizedName = config.name
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    const mcpName = `agentorch-${sanitizedName || config.id}`
    // Pass connection info via `-e` env flags instead of positional args. The MCP
    // server reads these from process.env as a fallback. This eliminates two prior
    // failure modes:
    //   1. Gemini's yargs parser mangling positional args containing spaces.
    //   2. Shell quoting issues when the agent name has spaces (e.g. "Gemini 2.5 Pro")
    //      causing the registered command to lose track of the name boundary.
    // The agent name is URL-encoded to be shell-safe across bash/powershell/cmd
    // without per-shell quoting; the MCP server decodes AGENTORCH_AGENT_NAME_ENC.
    const encodedName = encodeURIComponent(config.name)
    const cmds = [
      buildMcpCleanupCmd('gemini', config.shell),
      `gemini mcp add ${mcpName} -e AGENTORCH_HUB_PORT=${hubPort} -e AGENTORCH_HUB_SECRET=${hubSecret} -e AGENTORCH_AGENT_ID=${config.id} -e AGENTORCH_AGENT_NAME_ENC=${encodedName} node "${mcpServerPath}"`,
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
