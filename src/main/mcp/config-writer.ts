import { writeFileSync, unlinkSync } from 'fs'
import path from 'path'
import os from 'os'

interface McpConfigOptions {
  agentId: string
  agentName: string
  hubPort: number
  hubSecret: string
  mcpServerPath: string
}

export function writeAgentMcpConfig(opts: McpConfigOptions): string {
  const fileName = `agentorch-${opts.agentId}-mcp.json`
  const filePath = path.join(os.tmpdir(), fileName)

  const config = {
    mcpServers: {
      agentorch: {
        command: 'node',
        args: [opts.mcpServerPath],
        env: {
          AGENTORCH_HUB_PORT: String(opts.hubPort),
          AGENTORCH_HUB_SECRET: opts.hubSecret,
          AGENTORCH_AGENT_ID: opts.agentId,
          AGENTORCH_AGENT_NAME: opts.agentName
        }
      }
    }
  }

  writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8')
  return filePath
}

export function cleanupConfig(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch {
    // File already deleted or inaccessible
  }
}
