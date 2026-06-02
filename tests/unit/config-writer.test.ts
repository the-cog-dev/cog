import { describe, it, expect, afterEach } from 'vitest'
import { writeAgentMcpConfig, cleanupConfig, writePiAgentConfig, cleanupPiAgentDir, piAgentDir } from '../../src/main/mcp/config-writer'
import { existsSync, readFileSync, unlinkSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'

describe('MCP Config Writer', () => {
  const createdFiles: string[] = []

  afterEach(() => {
    for (const f of createdFiles) {
      try { unlinkSync(f) } catch {}
    }
    createdFiles.length = 0
  })

  it('writes a valid MCP config JSON file', () => {
    const filePath = writeAgentMcpConfig({
      agentId: 'test-agent',
      agentName: 'worker-1',
      hubPort: 9999,
      hubSecret: 'abc123',
      mcpServerPath: '/path/to/mcp-server.js'
    })
    createdFiles.push(filePath)

    expect(existsSync(filePath)).toBe(true)
    expect(filePath).toContain('cog-test-agent')

    const content = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(content.mcpServers).toBeDefined()
    expect(content.mcpServers.cog).toBeDefined()
    expect(content.mcpServers.cog.command).toBe('node')
    expect(content.mcpServers.cog.args).toContain('/path/to/mcp-server.js')
    // Dual-emit env vars: COG_* (new) + AGENTORCH_* (legacy for in-flight agents)
    expect(content.mcpServers.cog.env.COG_HUB_PORT).toBe('9999')
    expect(content.mcpServers.cog.env.AGENTORCH_HUB_PORT).toBe('9999')
  })

  it('cleans up config file', () => {
    const filePath = writeAgentMcpConfig({
      agentId: 'cleanup-test',
      agentName: 'worker-2',
      hubPort: 9999,
      hubSecret: 'abc123',
      mcpServerPath: '/path/to/mcp-server.js'
    })
    expect(existsSync(filePath)).toBe(true)
    cleanupConfig(filePath)
    expect(existsSync(filePath)).toBe(false)
  })
})

describe('Pi Agent Config Writer', () => {
  const createdDirs: string[] = []

  afterEach(() => {
    for (const d of createdDirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
    createdDirs.length = 0
  })

  it('derives a per-agent dir from the agent id under tmpdir', () => {
    const dir = piAgentDir('agent-xyz')
    expect(dir).toBe(path.join(os.tmpdir(), 'cog-pi-agent-xyz'))
  })

  it('writes mcp.json into a per-agent dir and returns both paths', () => {
    const { agentDir, configPath } = writePiAgentConfig({
      agentId: 'pi-1',
      agentName: 'pi-worker',
      hubPort: 9999,
      hubSecret: 'abc123',
      mcpServerPath: '/path/to/mcp-server.js'
    })
    createdDirs.push(agentDir)

    expect(agentDir).toBe(path.join(os.tmpdir(), 'cog-pi-pi-1'))
    expect(configPath).toBe(path.join(agentDir, 'mcp.json'))
    expect(existsSync(configPath)).toBe(true)

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(content.mcpServers.cog.command).toBe('node')
    expect(content.mcpServers.cog.args).toContain('/path/to/mcp-server.js')
    expect(content.mcpServers.cog.env.COG_HUB_PORT).toBe('9999')
    expect(content.mcpServers.cog.env.COG_AGENT_ID).toBe('pi-1')
    expect(content.mcpServers.cog.env.AGENTORCH_HUB_PORT).toBe('9999')
  })

  it('gives distinct agents distinct dirs', () => {
    const a = writePiAgentConfig({ agentId: 'a', agentName: 'A', hubPort: 1, hubSecret: 'x', mcpServerPath: '/m.js' })
    const b = writePiAgentConfig({ agentId: 'b', agentName: 'B', hubPort: 1, hubSecret: 'x', mcpServerPath: '/m.js' })
    createdDirs.push(a.agentDir, b.agentDir)
    expect(a.agentDir).not.toBe(b.agentDir)
  })

  it('cleanupPiAgentDir removes the whole dir', () => {
    const { agentDir, configPath } = writePiAgentConfig({ agentId: 'cleanup', agentName: 'C', hubPort: 1, hubSecret: 'x', mcpServerPath: '/m.js' })
    expect(existsSync(configPath)).toBe(true)
    cleanupPiAgentDir(agentDir)
    expect(existsSync(agentDir)).toBe(false)
  })
})
