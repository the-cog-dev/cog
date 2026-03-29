import { describe, it, expect, afterEach } from 'vitest'
import { writeAgentMcpConfig, cleanupConfig } from '../../src/main/mcp/config-writer'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import os from 'os'

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
    expect(filePath).toContain('agentorch-test-agent')

    const content = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(content.mcpServers).toBeDefined()
    expect(content.mcpServers.agentorch).toBeDefined()
    expect(content.mcpServers.agentorch.command).toBe('node')
    expect(content.mcpServers.agentorch.args).toContain('/path/to/mcp-server.js')
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
