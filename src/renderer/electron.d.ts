import type { AgentConfig, AgentState, AgentTheme, HubInfo, PinboardTask, InfoEntry, WorkspacePreset, WorkspaceTheme, Skill, CreateScheduleInput, EditScheduleInput, CommunityTeam, CommunityTeamListItem, CommunityAgent, CommunityCategory, CommunityTheme, CommunityThemeListItem, RespawnResult, InboxMessage, NotificationThreshold, TeamProposal } from '../shared/types'

declare global {
  interface Window {
    electronAPI: {
      spawnAgent: (config: AgentConfig) => Promise<{ id: string; mcpConfigPath: string }>
      killAgent: (agentId: string) => Promise<void>
      respawnAgent: (agentId: string, newConfig: Omit<AgentConfig, 'id'>) => Promise<RespawnResult>
      getAgents: () => Promise<AgentState[]>
      getHubInfo: () => Promise<HubInfo>
      writeToPty: (agentId: string, data: string) => Promise<void>
      resizePty: (agentId: string, cols: number, rows: number) => Promise<void>
      getCwd: () => Promise<string>
      browseDirectory: (defaultPath: string) => Promise<string | null>
      savePreset: (name: string, agents: AgentConfig[], windows: unknown, canvas: unknown) => Promise<{ status: string }>
      loadPreset: (name: string) => Promise<WorkspacePreset>
      listPresets: () => Promise<string[]>
      deletePreset: (name: string) => Promise<{ status: string }>
      getPinboardTasks: (tabId?: string) => Promise<PinboardTask[]>
      onPinboardUpdate: (callback: (tasks: PinboardTask[]) => void) => () => void
      getInfoEntries: (tabId?: string) => Promise<InfoEntry[]>
      onInfoUpdate: (callback: (entries: InfoEntry[]) => void) => () => void
      // Inbox
      inboxList: () => Promise<InboxMessage[]>
      inboxMarkRead: (id: string) => Promise<InboxMessage | null>
      inboxMarkAllRead: () => Promise<number>
      inboxDelete: (id: string) => Promise<boolean>
      inboxReply: (agentName: string, message: string) => Promise<{ success: boolean; error?: string }>
      inboxGetNotifyThreshold: () => Promise<NotificationThreshold>
      inboxSetNotifyThreshold: (t: NotificationThreshold) => Promise<{ success: boolean; error?: string }>
      onInboxMessageAdded: (callback: (msgs: InboxMessage[]) => void) => () => void
      onInboxMessageUpdated: (callback: (msgs: InboxMessage[]) => void) => () => void
      // Team proposals
      proposalsListPending: () => Promise<TeamProposal[]>
      proposalsGet: (id: string) => Promise<TeamProposal | null>
      proposalsApprove: (proposalId: string, agents: import('../shared/types').ProposedAgent[], tabId?: string) => Promise<{
        success: boolean
        error?: string
        spawned?: Array<{ agentId: string; name: string; gridIndex: number }>
        totalRequested?: number
      }>
      proposalsReject: (proposalId: string, feedback?: string) => Promise<{ success: boolean; error?: string }>
      onProposalAdded: (callback: (proposal: TeamProposal) => void) => () => void
      onPtyOutput: (callback: (agentId: string, data: string) => void) => () => void
      onPtyExit: (callback: (agentId: string, exitCode: number | undefined) => void) => () => void
      onAgentStateUpdate: (callback: (agents: AgentState[]) => void) => () => void
      onAgentSpawnedRemote: (callback: (info: { agentId: string; name: string; cli: string; tabId?: string }) => void) => () => void
      // Skills
      listSkills: () => Promise<Skill[]>
      getSkill: (id: string) => Promise<Skill>
      createSkill: (input: { name: string; description: string; category: string; prompt: string; tags: string[] }) => Promise<Skill>
      updateSkill: (id: string, updates: unknown) => Promise<Skill>
      deleteSkill: (id: string) => Promise<boolean>
      // Scheduler
      listSchedules: () => Promise<unknown[]>
      createSchedule: (input: CreateScheduleInput) => Promise<unknown>
      pauseSchedule: (id: string) => Promise<unknown>
      resumeSchedule: (id: string) => Promise<unknown>
      stopSchedule: (id: string) => Promise<unknown>
      restartSchedule: (id: string) => Promise<unknown>
      editSchedule: (id: string, updates: EditScheduleInput) => Promise<unknown>
      deleteSchedule: (id: string) => Promise<unknown>
      onSchedulesUpdated: (callback: (list: unknown[]) => void) => () => void
      onSchedulerResumed: (callback: () => void) => () => void
      // Remote View
      enableRemoteView: () => Promise<{ ok: boolean }>
      disableRemoteView: () => Promise<{ ok: boolean }>
      enableRemoteLan: () => Promise<{ ok: boolean; error?: string }>
      disableRemoteLan: () => Promise<{ ok: boolean }>
      getRemoteViewState: () => Promise<{ enabled: boolean; publicUrl: string | null; lanUrl: string | null; lanEnabled: boolean; connectionCount: number; lastActivity: number | null }>
      killRemoteSessions: () => Promise<{ ok: boolean; newUrl?: string | null }>
      regenerateRemoteToken: () => Promise<{ ok: boolean; newUrl?: string | null }>
      onRemoteStatusUpdate: (cb: (status: { enabled: boolean; publicUrl: string | null; lanUrl: string | null; lanEnabled: boolean; connectionCount: number; lastActivity: number | null }) => void) => () => void
      onRemoteSetupProgress: (cb: (progress: { stage: 'downloading' | 'starting' | 'ready' | 'error'; message?: string }) => void) => () => void
      // Stale task alert snooze
      getStaleAlertSnooze: () => Promise<{ muteUntil: number | null }>
      setStaleAlertSnooze: (durationMs: number | null) => Promise<{ muteUntil: number | null }>
      onStaleAlertUpdate: (cb: (state: { muteUntil: number | null }) => void) => () => void
      // Machine identity (trollbox / community starring)
      getMachineHash: () => Promise<string>
      // Community Teams
      communityList: (opts?: { force?: boolean }) => Promise<{ success: true; items: CommunityTeamListItem[] } | { success: false; error: string }>
      communityGet: (issueNumber: number) => Promise<{ success: true; team: CommunityTeam; isStarredByMe: boolean } | { success: false; error: string }>
      communityShare: (input: { name: string; description: string; author: string; category: CommunityCategory; agents: CommunityAgent[] }) => Promise<{ success: true; team: CommunityTeam } | { success: false; error: string }>
      communityToggleStar: (issueNumber: number) => Promise<{ success: true; stars: number; isStarredByMe: boolean } | { success: false; error: string }>
      // Workshop passcode
      setWorkshopPasscode: (pin: string) => Promise<{ success: boolean; error?: string }>
      getWorkshopPasscodeSet: () => Promise<{ isSet: boolean }>
      clearWorkshopPasscode: () => Promise<{ success: boolean }>
      // Workspace state bridge (fire-and-forget)
      pushWorkspaceState: (state: unknown) => void
      // Trollbox bridge — renderer pushes state, main forwards 3DS sends
      pushTrollboxState: (state: unknown) => void
      onTrollboxRemoteSend: (
        callback: (payload: { id: string; text: string; nick: string }) => void
      ) => () => void
      replyTrollboxRemoteSend: (payload: { id: string; ok: boolean; error?: string }) => void
      // Workshop window updates from mobile
      onWorkshopWindowUpdate: (callback: (update: { id: string; x?: number; y?: number; width?: number; height?: number }) => void) => () => void
      // Workshop panel toggle from mobile
      onWorkshopPanelToggle: (callback: (update: { type: string; action: 'open' | 'close' | 'toggle' }) => void) => () => void
      // Workshop layout mirror (renderer → main)
      syncWorkshopLayout: (layouts: Array<{ id: string; x: number; y: number; width: number; height: number; color: string }>) => void
      registerShortLink: (lan: string | null, tunnel: string | null) => Promise<string | null>
      sendTo3DS: (ip: string, port: number, url: string) => Promise<string>
      // Per-agent theme
      setAgentTheme: (agentId: string, theme: AgentTheme | null) => Promise<{ success: boolean; error?: string }>
      // Community themes
      communityThemeList: (opts?: { force?: boolean }) => Promise<{ success: true; items: CommunityThemeListItem[] } | { success: false; error: string }>
      communityThemeGet: (issueNumber: number) => Promise<{ success: true; theme: CommunityTheme; isStarredByMe: boolean } | { success: false; error: string }>
      communityThemeShare: (input: { name: string; description: string; author: string; roleColors: Record<string, Required<AgentTheme>>; fallback: Required<AgentTheme> }) => Promise<{ success: true; theme: CommunityTheme } | { success: false; error: string }>
      communityThemeToggleStar: (issueNumber: number) => Promise<{ success: true; stars: number; isStarredByMe: boolean } | { success: false; error: string }>
      // Workspace themes
      getActiveWorkspaceTheme: () => Promise<string | null>
      setActiveWorkspaceTheme: (id: string | null) => Promise<{ success: boolean }>
      listCustomWorkspaceThemes: () => Promise<WorkspaceTheme[]>
      saveCustomWorkspaceTheme: (theme: WorkspaceTheme) => Promise<{ success: boolean }>
      deleteCustomWorkspaceTheme: (id: string) => Promise<{ success: boolean }>
      // Voice recorder — Stream Deck integration
      onVoiceStart(cb: () => void): () => void
      onVoiceStop(cb: () => void): () => void
      sendVoiceAudio(audio: ArrayBuffer): void
      // Stream Deck status + reconnect
      getStreamDeckStatus(): Promise<'connected' | 'disconnected'>
      reconnectStreamDeck(): Promise<void>
      // Stream Deck → renderer panel hooks
      onStreamDeckOpenPanel(cb: (panel: string) => void): () => void
      onStreamDeckFocusAgent(cb: (name: string) => void): () => void
      onStreamDeckMarkRead(cb: (kind: string) => void): () => void
      onStreamDeckToast(cb: (msg: string) => void): () => void
      onStreamDeckRunPreset(cb: (name: string) => void): () => void
      prepareLocalWhisper(): Promise<{ ok: boolean; error?: string }>
      onLocalWhisperProgress(cb: (evt: { stage: string; percent: number; detail?: string }) => void): () => void
      // Project info
      getProject: () => Promise<{ path: string; name: string; lastOpened: string } | null>
      // Project autonomy
      getAutonomy: () => Promise<{ scheduling: boolean }>
      setAutonomy: (value: { scheduling: boolean }) => Promise<{ scheduling: boolean }>
      // Workboard
      boardListPages: () => Promise<import('../shared/types').BoardPage[]>
      boardAddPage: () => Promise<import('../shared/types').BoardPage | null>
      boardSavePage: (page: import('../shared/types').BoardPage) => Promise<boolean>
      boardDeletePage: (id: string) => Promise<boolean>
      boardSaveImage: (base64: string, ext: string) => Promise<string | null>
      boardSaveRender: (pageId: string, base64: string) => Promise<string | null>
    }
  }
}
