import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs'
import path from 'path'
import os from 'os'

interface McpConfigOptions {
  agentId: string
  agentName: string
  hubPort: number
  hubSecret: string
  mcpServerPath: string
}

// The `cog` MCP server entry shared by every agent config (file-based and Pi).
// Dual-emit COG_* (new) + AGENTORCH_* (legacy) so in-flight agents keep working.
function cogServerEntry(opts: McpConfigOptions) {
  return {
    command: 'node',
    args: [opts.mcpServerPath],
    env: {
      COG_HUB_PORT: String(opts.hubPort),
      COG_HUB_SECRET: opts.hubSecret,
      COG_AGENT_ID: opts.agentId,
      COG_AGENT_NAME: opts.agentName,
      AGENTORCH_HUB_PORT: String(opts.hubPort),
      AGENTORCH_HUB_SECRET: opts.hubSecret,
      AGENTORCH_AGENT_ID: opts.agentId,
      AGENTORCH_AGENT_NAME: opts.agentName
    }
  }
}

export function writeAgentMcpConfig(opts: McpConfigOptions): string {
  const fileName = `cog-${opts.agentId}-mcp.json`
  const filePath = path.join(os.tmpdir(), fileName)

  // Dual-emit COG_* (new) + AGENTORCH_* (legacy) env vars. The MCP server
  // prefers COG_* but falls back to AGENTORCH_*, so in-flight agents keep
  // working across the rebrand.
  const config = {
    mcpServers: {
      cog: cogServerEntry(opts)
    }
  }

  writeFileSync(filePath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
  return filePath
}

export function cleanupConfig(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch {
    // File already deleted or inaccessible
  }
}

/**
 * Pi (pi.dev) has no native MCP support; the pi-mcp-adapter reads its downstream
 * MCP servers from `$PI_CODING_AGENT_DIR/mcp.json`. We give each Pi agent its own
 * dir so concurrent Pi agents get distinct hub identities (no global collision).
 */
export function piAgentDir(agentId: string): string {
  return path.join(os.tmpdir(), `cog-pi-${agentId}`)
}

export function writePiAgentConfig(opts: McpConfigOptions): { agentDir: string; configPath: string } {
  const agentDir = piAgentDir(opts.agentId)
  mkdirSync(agentDir, { recursive: true })
  const configPath = path.join(agentDir, 'mcp.json')
  const config = {
    mcpServers: {
      cog: cogServerEntry(opts)
    }
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
  return { agentDir, configPath }
}

export function cleanupPiAgentDir(agentDir: string): void {
  try {
    rmSync(agentDir, { recursive: true, force: true })
  } catch {
    // Dir already removed or inaccessible
  }
}
