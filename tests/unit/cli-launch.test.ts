import { describe, expect, it } from 'vitest'
import { buildCliLaunchCommands } from '../../src/main/cli-launch'
import type { AgentConfig } from '../../src/shared/types'

const makeConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: 'agent-1',
  name: 'worker-1',
  cli: 'claude',
  cwd: 'C:\\repo',
  role: 'worker',
  ceoNotes: 'notes',
  shell: 'powershell',
  admin: false,
  autoMode: false,
  ...overrides
})

describe('buildCliLaunchCommands', () => {
  it('preserves Claude launch behavior', () => {
    expect(buildCliLaunchCommands(
      makeConfig({ model: 'sonnet', autoMode: true }),
      'C:\\temp\\agentorch-mcp.json',
      'C:\\temp\\mcp-server.js',
      7777,
      'secret'
    )).toEqual([
      'claude --mcp-config "C:\\temp\\agentorch-mcp.json" --model sonnet --dangerously-skip-permissions'
    ])
  })

  it('launches Gemini with full MCP cleanup and model flags', () => {
    expect(buildCliLaunchCommands(
      makeConfig({ cli: 'gemini', model: 'gemini-2.5-pro', autoMode: true }),
      'C:\\temp\\agentorch-mcp.json',
      'C:\\temp\\mcp-server.js',
      7777,
      'secret'
    )).toEqual([
      "gemini mcp list 2>$null | ForEach-Object { if ($_ -match '(agentorch[^\\s:]+)') { gemini mcp remove $Matches[1] 2>$null } }",
      'gemini mcp add agentorch-worker-1 node "C:\\temp\\mcp-server.js" 7777 secret agent-1 worker-1',
      'gemini --model gemini-2.5-pro --yolo'
    ])
  })

  it('omits -- separator from gemini mcp add (gemini yargs parser breaks on --)', () => {
    const cmds = buildCliLaunchCommands(
      makeConfig({ cli: 'gemini', shell: 'bash' }),
      '/tmp/agentorch-mcp.json',
      '/tmp/mcp-server.js',
      7777,
      'secret'
    )!
    const addCmd = cmds.find(c => c.startsWith('gemini mcp add'))!
    expect(addCmd).toContain('gemini mcp add agentorch-worker-1 node ')
    expect(addCmd).not.toContain(' -- node ')
  })

  it('routes Gemini cmd-shell cleanup through PowerShell to avoid Unicode dropout', () => {
    const cmds = buildCliLaunchCommands(
      makeConfig({ cli: 'gemini', shell: 'cmd' }),
      'C:\\temp\\agentorch-mcp.json',
      'C:\\temp\\mcp-server.js',
      7777,
      'secret'
    )!
    // cmd.exe's `for /f` drops Gemini's Unicode-prefixed output entirely, so cleanup
    // must shell out to PowerShell which handles the ✓/✗ icons correctly.
    expect(cmds[0]).toContain('powershell -NoProfile -Command')
    expect(cmds[0]).toContain('gemini mcp remove')
    expect(cmds[0]).not.toContain('for /f')
  })

  it('launches Codex with full MCP cleanup and model flags', () => {
    expect(buildCliLaunchCommands(
      makeConfig({ cli: 'codex', model: 'o3', autoMode: true }),
      'C:\\temp\\agentorch-mcp.json',
      'C:\\temp\\mcp-server.js',
      7777,
      'secret'
    )).toEqual([
      "codex mcp list 2>$null | Where-Object { $_ -match '^agentorch' } | ForEach-Object { codex mcp remove ($_ -split '\\s+')[0] 2>$null }",
      'codex mcp add agentorch-worker-1 -- node "C:\\temp\\mcp-server.js" 7777 secret agent-1 worker-1',
      'codex -m o3 --yolo'
    ])
  })

  it('generates cmd-compatible cleanup for cmd shell', () => {
    const cmds = buildCliLaunchCommands(
      makeConfig({ cli: 'codex', shell: 'cmd', autoMode: false }),
      'C:\\temp\\agentorch-mcp.json',
      'C:\\temp\\mcp-server.js',
      7777,
      'secret'
    )!
    expect(cmds[0]).toContain('findstr /B "agentorch"')
    expect(cmds[0]).toContain('codex mcp remove %i')
  })

  it('generates bash-compatible cleanup for bash shell', () => {
    const cmds = buildCliLaunchCommands(
      makeConfig({ cli: 'gemini', shell: 'bash', autoMode: false }),
      '/tmp/agentorch-mcp.json',
      '/tmp/mcp-server.js',
      7777,
      'secret'
    )!
    expect(cmds[0]).toContain('grep -o')
    expect(cmds[0]).toContain('while read name; do')
    expect(cmds[0]).toContain('2>/dev/null')
  })

  it('generates Gemini cleanup that handles status-prefixed mcp list output', () => {
    // Gemini mcp list outputs: "✓ name: command: ..." — name is NOT the first token
    const cmds = buildCliLaunchCommands(
      makeConfig({ cli: 'gemini', shell: 'bash', autoMode: false }),
      '/tmp/agentorch-mcp.json',
      '/tmp/mcp-server.js',
      7777,
      'secret'
    )!
    // Must NOT anchor grep to start of line (^) since Gemini prefixes with status icon
    expect(cmds[0]).not.toContain("grep '^agentorch'")
    // Must use grep -o to extract just the agentorch name
    expect(cmds[0]).toContain("grep -o 'agentorch[^ :]*'")
  })

  it('launches Copilot with session-scoped MCP config and allow-all mode', () => {
    expect(buildCliLaunchCommands(
      makeConfig({ cli: 'copilot', model: 'gpt-4o', autoMode: true }),
      'C:\\temp\\agentorch-mcp.json',
      'C:\\temp\\mcp-server.js',
      7777,
      'secret'
    )).toEqual([
      'copilot --additional-mcp-config "@C:\\temp\\agentorch-mcp.json" --model=gpt-4o --allow-all'
    ])
  })

  it('keeps Grok as best-effort launch support with optional model', () => {
    expect(buildCliLaunchCommands(
      makeConfig({ cli: 'grok', model: 'grok-3', experimental: true }),
      'C:\\temp\\agentorch-mcp.json',
      'C:\\temp\\mcp-server.js',
      7777,
      'secret'
    )).toEqual([
      'grok --model grok-3'
    ])
  })

  it('passes custom CLI commands through unchanged', () => {
    expect(buildCliLaunchCommands(
      makeConfig({ cli: 'my-agent --flag' }),
      'C:\\temp\\agentorch-mcp.json',
      'C:\\temp\\mcp-server.js',
      7777,
      'secret'
    )).toEqual([
      'my-agent --flag'
    ])
  })
})
