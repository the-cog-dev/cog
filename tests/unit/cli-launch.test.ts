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

  it('launches Gemini with full MCP cleanup, env-var connection info, and model flags', () => {
    expect(buildCliLaunchCommands(
      makeConfig({ cli: 'gemini', model: 'gemini-2.5-pro', autoMode: true }),
      'C:\\temp\\agentorch-mcp.json',
      'C:\\temp\\mcp-server.js',
      7777,
      'secret'
    )).toEqual([
      "gemini mcp list 2>$null | ForEach-Object { if ($_ -match '(agentorch[^\\s:]+)') { gemini mcp remove $Matches[1] 2>$null } }",
      'gemini mcp add agentorch-worker-1 -e AGENTORCH_HUB_PORT=7777 -e AGENTORCH_HUB_SECRET=secret -e AGENTORCH_AGENT_ID=agent-1 -e AGENTORCH_AGENT_NAME_ENC=worker-1 node "C:\\temp\\mcp-server.js"',
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
    expect(addCmd).toContain('gemini mcp add agentorch-worker-1 -e ')
    expect(addCmd).not.toContain(' -- node ')
  })

  it('passes gemini connection info via -e env vars instead of positional args (closes #40)', () => {
    // Positional args after `node "path"` were lossy when the agent name contained
    // spaces (e.g. "Gemini 2.5 Pro" became multiple yargs positionals). Switch to
    // -e flags so the MCP server reads connection info from env vars.
    const cmds = buildCliLaunchCommands(
      makeConfig({ cli: 'gemini', name: 'RESEARCHER Gemini 2.5 Pro' }),
      '/tmp/agentorch-mcp.json',
      '/tmp/mcp-server.js',
      7777,
      'secret'
    )!
    const addCmd = cmds.find(c => c.startsWith('gemini mcp add'))!
    // Name is sanitized for the mcp server name (no dots, no spaces).
    expect(addCmd).toContain('gemini mcp add agentorch-RESEARCHER-Gemini-2-5-Pro ')
    // Connection info passed via env flags, not positional args.
    expect(addCmd).toContain('-e AGENTORCH_HUB_PORT=7777')
    expect(addCmd).toContain('-e AGENTORCH_HUB_SECRET=secret')
    expect(addCmd).toContain('-e AGENTORCH_AGENT_ID=agent-1')
    // Agent name is URL-encoded so spaces and dots survive any shell intact.
    expect(addCmd).toContain('-e AGENTORCH_AGENT_NAME_ENC=RESEARCHER%20Gemini%202.5%20Pro')
    // The script path is the only positional arg after `node` — no agent name leakage.
    expect(addCmd).toContain('node "/tmp/mcp-server.js"')
    expect(addCmd).not.toMatch(/node "[^"]+" \d+ secret/)
  })

  it('sanitizes gemini mcp server names that contain dots or other special chars', () => {
    const cmds = buildCliLaunchCommands(
      makeConfig({ cli: 'gemini', name: 'Worker.v1 (alpha)' }),
      '/tmp/agentorch-mcp.json',
      '/tmp/mcp-server.js',
      7777,
      'secret'
    )!
    const addCmd = cmds.find(c => c.startsWith('gemini mcp add'))!
    // Dots, spaces, and parens are collapsed to a single dash.
    expect(addCmd).toContain('gemini mcp add agentorch-Worker-v1-alpha ')
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
