import type Database from 'better-sqlite3'
import { createDatabase } from '../db/database'
import { MessageStore } from '../db/message-store'
import { PinboardStore } from '../db/pinboard-store'
import { InfoStore } from '../db/info-store'
import { InboxStore } from '../db/inbox-store'
import { ProposalsStore } from '../db/proposals-store'
import { SchedulesStore } from '../scheduler/schedules-store'
import { AutonomyStore } from '../db/autonomy-store'
import { BoardStore } from '../db/board-store'
import { BoardAppearanceStore } from '../db/board-appearance-store'
import { AgentRegistry } from './agent-registry'
import { MessageRouter } from './message-router'
import { Pinboard } from './pinboard'
import { InfoChannel } from './info-channel'
import { InboxChannel } from './inbox-channel'
import { ProposalsChannel } from './proposals-channel'
import { GroupManager } from './group-manager'
import { AgentMetrics } from './agent-metrics'

/**
 * One workspace's project context: its SQLite DB, its stores, and its in-memory
 * channels — everything scoped to a single project folder. P2 turns the app's
 * single global hub into N of these (one per open workspace), so several teams
 * run concurrently in one process, each isolated and persisting to its own
 * folder's .cog/cog.db.
 *
 * This class is a pure state container. index.ts owns the side-effect wiring
 * (persistence callbacks, IPC pushes, Telegram relay, notifications) and installs
 * it per-context, and the hub HTTP router dispatches each request to the right
 * context by the caller's workspace id.
 */
export class ProjectContext {
  readonly db: Database.Database
  readonly stores: {
    message: MessageStore
    pinboard: PinboardStore
    info: InfoStore
    inbox: InboxStore
    proposals: ProposalsStore
    schedules: SchedulesStore
    autonomy: AutonomyStore
    board: BoardStore
    boardAppearance: BoardAppearanceStore
  }
  readonly channels: {
    registry: AgentRegistry
    messages: MessageRouter
    pinboard: Pinboard
    info: InfoChannel
    inbox: InboxChannel
    proposals: ProposalsChannel
    groups: GroupManager
    metrics: AgentMetrics
  }

  constructor(
    readonly workspaceId: string,
    readonly projectPath: string,
    dbPath: string
  ) {
    this.db = createDatabase(dbPath)

    this.stores = {
      message: new MessageStore(this.db),
      pinboard: new PinboardStore(this.db),
      info: new InfoStore(this.db),
      inbox: new InboxStore(this.db),
      proposals: new ProposalsStore(this.db),
      schedules: new SchedulesStore(this.db),
      autonomy: new AutonomyStore(this.db),
      board: new BoardStore(this.db),
      boardAppearance: new BoardAppearanceStore(this.db)
    }

    const registry = new AgentRegistry()
    const groups = new GroupManager()
    const metrics = new AgentMetrics()
    this.channels = {
      registry,
      groups,
      metrics,
      messages: new MessageRouter(registry, groups, metrics),
      pinboard: new Pinboard(),
      info: new InfoChannel(),
      inbox: new InboxChannel(),
      proposals: new ProposalsChannel()
    }
  }

  /** Load persisted state from this project's DB into its in-memory channels. */
  restore(): void {
    this.channels.pinboard.loadTasks(this.stores.pinboard.loadTasks())
    this.channels.info.loadEntries(this.stores.info.loadEntries())
    this.channels.inbox.loadMessages(this.stores.inbox.loadMessages())
    this.channels.proposals.loadProposals(this.stores.proposals.loadAll())
  }

  /** Register the virtual "user" agent so the UI can send/receive messages. */
  registerUser(): void {
    this.channels.registry.register({
      id: 'user',
      name: 'user',
      cli: 'none',
      cwd: this.projectPath,
      role: 'human',
      ceoNotes: '',
      shell: 'powershell',
      admin: false,
      autoMode: false
    })
  }

  /** Close the DB. Call on workspace close / app shutdown. */
  close(): void {
    try { this.db.close() } catch { /* already closed */ }
  }
}
