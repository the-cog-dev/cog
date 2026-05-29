import express from 'express'
import type { Server } from 'http'
import { AgentRegistry } from './agent-registry'
import { MessageRouter } from './message-router'
import { Pinboard } from './pinboard'
import { InfoChannel } from './info-channel'
import { InboxChannel } from './inbox-channel'
import { ProposalsChannel } from './proposals-channel'
import { generateSecret, validateSecret } from './auth'
import { createRoutes, type OutputAccessor, type ScheduleBridge } from './routes'
import { GroupManager } from './group-manager'
import { AgentMetrics } from './agent-metrics'
import type { MessageStore } from '../db/message-store'

export interface HubServer {
  port: number
  secret: string
  registry: AgentRegistry
  messages: MessageRouter
  pinboard: Pinboard
  infoChannel: InfoChannel
  inboxChannel: InboxChannel
  proposalsChannel: ProposalsChannel
  groupManager: GroupManager
  agentMetrics: AgentMetrics
  setOutputAccessor: (fn: OutputAccessor) => void
  setMessageStore: (store: MessageStore) => void
  setProjectPath: (projectPath: string) => void
  close: () => void
}

export function createHubServer(
  preferredPort = 0,
  getScheduleBridge?: () => ScheduleBridge | undefined
): Promise<HubServer> {
  return new Promise((resolve, reject) => {
    const app = express()
    const secret = generateSecret()
    const registry = new AgentRegistry()
    const groupManager = new GroupManager()
    const agentMetrics = new AgentMetrics()
    const messages = new MessageRouter(registry, groupManager, agentMetrics)
    const pinboard = new Pinboard()
    const infoChannel = new InfoChannel()
    const inboxChannel = new InboxChannel()
    const proposalsChannel = new ProposalsChannel()

    app.use(express.json())

    app.use((req, res, next) => {
      const token = req.headers.authorization?.replace('Bearer ', '')
      if (!token || !validateSecret(secret, token)) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      next()
    })

    const outputRef: { accessor: OutputAccessor | null } = { accessor: null }
    const messageStoreRef: { store: MessageStore | null } = { store: null }
    const projectPathRef: { path: string | null } = { path: null }
    app.use(createRoutes(registry, messages, outputRef, pinboard, infoChannel, messageStoreRef, projectPathRef, groupManager, inboxChannel, proposalsChannel, getScheduleBridge))

    // Bind to 0.0.0.0 so MCP servers running inside WSL2 can reach the hub via
    // the Windows host IP (their `127.0.0.1` is the WSL VM's loopback, not
    // Windows'). Authentication is enforced by HUB_SECRET (64 random hex chars,
    // checked in the middleware above), and Windows Firewall blocks unsolicited
    // LAN inbound by default. The Remote View / LAN access feature exposes the
    // hub explicitly through its own opt-in cloudflared/LAN code path; this
    // bind change only affects loopback + WSL traffic in practice.
    const server: Server = app.listen(preferredPort, '0.0.0.0', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'))
        return
      }
      resolve({
        port: addr.port,
        secret,
        registry,
        messages,
        pinboard,
        infoChannel,
        inboxChannel,
        proposalsChannel,
        groupManager,
        agentMetrics,
        setOutputAccessor: (fn) => { outputRef.accessor = fn },
        setMessageStore: (store) => { messageStoreRef.store = store },
        setProjectPath: (p) => { projectPathRef.path = p },
        close: () => server.close()
      })
    })

    server.on('error', reject)
  })
}
