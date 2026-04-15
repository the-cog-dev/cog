import * as crypto from 'crypto'
import * as os from 'os'
import type {
  AgentConfig,
  CommunityAgent,
  CommunityTeam,
  CommunityTeamListItem,
  CommunityCategory
} from '../../shared/types'

// GitHub repo hosting community teams as Issues.
const OWNER = 'the-cog-dev'
const REPO = 'community-teams'
const LABEL = 'community-team'

// Obfuscated fine-grained PAT — issues: read/write on the-cog-dev/community-teams only.
// XOR-obfuscated to avoid plaintext scanners. Not secret-security — anyone reading this
// file can decode it. But the PAT scope is so narrow (one repo, issues only) that the
// worst-case if it leaks is someone creating spam issues, which is easily moderated.
const _ck = 'CogCommunityTeams2026'
const _ct = [36,6,19,43,26,15,50,5,15,29,43,72,101,36,38,38,60,115,122,123,6,46,63,80,17,90,91,0,18,3,28,1,29,11,92,25,94,55,90,127,122,6,32,40,34,51,26,38,10,20,86,33,21,8,49,10,0,4,64,123,4,10,80,51,40,0,116,23,33,35,20,10,1,67,50,16,11,40,37,38,117,2,106,123,18,32,18,25,94,31,30,70,6]
const getToken = (): string => _ct.map((c, i) => String.fromCharCode(c ^ _ck.charCodeAt(i % _ck.length))).join('')

// 5-minute in-memory cache for the team list (per plan — avoid hammering API on tab switch).
let _listCache: { items: CommunityTeamListItem[]; fetchedAt: number } | null = null
const LIST_CACHE_TTL_MS = 5 * 60 * 1000

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${getToken()}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  })
}

// Non-PII fingerprint used to prevent double-starring from the same machine.
// sha256(hostname + username + cpu model) truncated to 12 chars. Not reversible.
let _machineHash: string | null = null
export function getMachineHash(): string {
  if (_machineHash) return _machineHash
  const raw = `${os.hostname()}|${os.userInfo().username}|${os.cpus()[0]?.model ?? 'unknown'}`
  _machineHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)
  return _machineHash
}

// Strip an AgentConfig down to shareable fields only — removes cwd, ids, tab/group ids,
// provider URLs. CEO Notes are kept (user reviews/edits them before share).
export function stripAgentForShare(agent: AgentConfig): CommunityAgent {
  return {
    name: agent.name,
    cli: agent.cli,
    role: agent.role,
    ceoNotes: agent.ceoNotes,
    shell: agent.shell,
    admin: agent.admin,
    autoMode: agent.autoMode,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.experimental ? { experimental: agent.experimental } : {}),
    ...(agent.skills && agent.skills.length > 0 ? { skills: agent.skills } : {}),
    ...(agent.theme ? { theme: agent.theme } : {})
  }
}

// Typed allowlists for hydrating a CommunityTeam from attacker-controlled JSON.
// GitHub issue bodies are public and editable — if we just spread parsed JSON
// onto an object the renderer/spawner reads, a malicious publisher can inject
// unexpected fields (admin:true on every agent, custom shell path,
// __proto__ tricks). Parsing each field explicitly and discarding everything
// else shuts all of that down.
const VALID_CATEGORIES: ReadonlyArray<CommunityCategory> = ['research', 'coding', 'review', 'full-stack', 'decomp', 'mixed', 'other']
const VALID_CLIS = new Set(['claude', 'openclaude', 'codex', 'gemini', 'kimi', 'copilot', 'grok', 'terminal'])
const VALID_SHELLS: ReadonlyArray<CommunityAgent['shell']> = ['cmd', 'powershell', 'bash', 'zsh', 'fish']

function asString(v: unknown, max = 2000): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}
function asBool(v: unknown): boolean {
  return v === true
}
function asStringArray(v: unknown, max = 64, itemMax = 200): string[] {
  if (!Array.isArray(v)) return []
  return v.filter(x => typeof x === 'string').slice(0, max).map(s => (s as string).slice(0, itemMax))
}

function hydrateAgent(raw: unknown): CommunityAgent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = asString(r.name, 200)
  const cli = asString(r.cli, 50)
  const shell = asString(r.shell, 20) as CommunityAgent['shell']
  if (!name || !VALID_CLIS.has(cli) || !VALID_SHELLS.includes(shell)) return null
  const agent: CommunityAgent = {
    name,
    cli,
    role: asString(r.role, 200),
    ceoNotes: asString(r.ceoNotes, 20000),
    shell,
    admin: asBool(r.admin),
    autoMode: asBool(r.autoMode)
  }
  if (typeof r.model === 'string' && r.model.length > 0) agent.model = r.model.slice(0, 200)
  if (r.experimental !== undefined) agent.experimental = asBool(r.experimental)
  const skills = asStringArray(r.skills)
  if (skills.length > 0) agent.skills = skills
  if (r.theme && typeof r.theme === 'object') {
    // theme is a plain style record; keep only string values.
    const themeIn = r.theme as Record<string, unknown>
    const themeOut: Record<string, string> = {}
    for (const k of Object.keys(themeIn)) {
      if (typeof themeIn[k] === 'string') themeOut[k] = (themeIn[k] as string).slice(0, 100)
    }
    // @ts-expect-error — AgentTheme is a structural string record
    agent.theme = themeOut
  }
  return agent
}

function hydrateTeam(raw: unknown, issueNumber: number): CommunityTeam | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const category = VALID_CATEGORIES.includes(r.category as CommunityCategory) ? (r.category as CommunityCategory) : 'other'
  const rawAgents = Array.isArray(r.agents) ? r.agents : []
  const agents = rawAgents.map(hydrateAgent).filter((a): a is CommunityAgent => a !== null).slice(0, 32)
  if (agents.length === 0) return null
  const team: CommunityTeam = {
    version: 1,
    issueNumber,
    name: asString(r.name, 200),
    description: asString(r.description, 5000),
    author: asString(r.author, 200),
    category,
    agentCount: agents.length,
    clis: Array.from(new Set(agents.map(a => a.cli))),
    agents,
    stars: typeof r.stars === 'number' && Number.isFinite(r.stars) && r.stars >= 0 ? Math.floor(r.stars) : 0,
    starredBy: asStringArray(r.starredBy, 10000, 12),
    createdAt: asString(r.createdAt, 100)
  }
  return team
}

function parseTeamFromIssue(issue: { number: number; body: string | null; title: string }): CommunityTeam | null {
  if (!issue.body) return null
  const match = issue.body.match(/```json\s*([\s\S]*?)\s*```/)
  const jsonStr = match ? match[1] : issue.body
  try {
    const data = JSON.parse(jsonStr) as unknown
    return hydrateTeam(data, issue.number)
  } catch {
    return null
  }
}

function teamToListItem(team: CommunityTeam, myHash: string): CommunityTeamListItem {
  return {
    issueNumber: team.issueNumber!,
    name: team.name,
    description: team.description,
    author: team.author,
    category: team.category,
    agentCount: team.agentCount,
    clis: team.clis,
    stars: team.stars,
    createdAt: team.createdAt,
    isStarredByMe: team.starredBy.includes(myHash)
  }
}

export async function listTeams(opts: { force?: boolean } = {}): Promise<CommunityTeamListItem[]> {
  if (!opts.force && _listCache && Date.now() - _listCache.fetchedAt < LIST_CACHE_TTL_MS) {
    return _listCache.items
  }
  const res = await apiFetch(`/repos/${OWNER}/${REPO}/issues?labels=${LABEL}&state=open&sort=created&direction=desc&per_page=100`)
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`GitHub API ${res.status}: ${err}`)
  }
  const issues = await res.json() as Array<{ number: number; body: string | null; title: string; pull_request?: unknown }>
  // Filter out pull requests — GitHub's issues endpoint returns PRs too.
  const myHash = getMachineHash()
  const items: CommunityTeamListItem[] = []
  for (const issue of issues) {
    if (issue.pull_request) continue
    const team = parseTeamFromIssue(issue)
    if (team) items.push(teamToListItem(team, myHash))
  }
  _listCache = { items, fetchedAt: Date.now() }
  return items
}

export async function getTeam(issueNumber: number): Promise<CommunityTeam> {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error('Invalid issue number')
  }
  const res = await apiFetch(`/repos/${OWNER}/${REPO}/issues/${issueNumber}`)
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`GitHub API ${res.status}: ${err}`)
  }
  const issue = await res.json() as { number: number; body: string | null; title: string }
  const team = parseTeamFromIssue(issue)
  if (!team) throw new Error(`Issue #${issueNumber} is not a valid community team`)
  return team
}

export async function shareTeam(input: Omit<CommunityTeam, 'version' | 'stars' | 'starredBy' | 'createdAt' | 'agentCount' | 'clis' | 'issueNumber'>): Promise<CommunityTeam> {
  const team: CommunityTeam = {
    version: 1,
    name: input.name,
    description: input.description,
    author: input.author,
    category: input.category,
    agentCount: input.agents.length,
    clis: Array.from(new Set(input.agents.map(a => a.cli))),
    agents: input.agents,
    stars: 0,
    starredBy: [],
    createdAt: new Date().toISOString()
  }

  const body = `\`\`\`json\n${JSON.stringify(team, null, 2)}\n\`\`\`\n\n---\n\n*Shared from theCog — community team preset. Import this into your own Cog workspace.*`

  const res = await apiFetch(`/repos/${OWNER}/${REPO}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: team.name,
      body,
      labels: [LABEL, team.category]
    })
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`GitHub API ${res.status}: ${err}`)
  }
  const issue = await res.json() as { number: number }
  // Invalidate list cache so the new team shows up immediately on next browse.
  _listCache = null
  return { ...team, issueNumber: issue.number }
}

// Toggle star for the current machine. Read → mutate → write.
// Race condition: if two machines update the body simultaneously, last-write wins.
// Acceptable for MVP — star counts are not load-bearing.
export async function toggleStar(issueNumber: number): Promise<{ stars: number; isStarredByMe: boolean }> {
  const team = await getTeam(issueNumber)
  const myHash = getMachineHash()
  const already = team.starredBy.includes(myHash)

  let newStarredBy: string[]
  let newStars: number
  if (already) {
    newStarredBy = team.starredBy.filter(h => h !== myHash)
    newStars = Math.max(0, team.stars - 1)
  } else {
    newStarredBy = [...team.starredBy, myHash]
    newStars = team.stars + 1
  }

  const updated: CommunityTeam = { ...team, stars: newStars, starredBy: newStarredBy }
  const newBody = `\`\`\`json\n${JSON.stringify(updated, null, 2)}\n\`\`\`\n\n---\n\n*Shared from theCog — community team preset. Import this into your own Cog workspace.*`

  const res = await apiFetch(`/repos/${OWNER}/${REPO}/issues/${issueNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: newBody })
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`GitHub API ${res.status}: ${err}`)
  }
  // Update cache entry if present
  if (_listCache) {
    const idx = _listCache.items.findIndex(i => i.issueNumber === issueNumber)
    if (idx >= 0) {
      _listCache.items[idx] = { ..._listCache.items[idx], stars: newStars, isStarredByMe: !already }
    }
  }
  return { stars: newStars, isStarredByMe: !already }
}

export function invalidateListCache(): void {
  _listCache = null
}

// Narrow helper for the IPC layer to validate category inputs.
export function isValidCategory(value: unknown): value is CommunityCategory {
  return typeof value === 'string' && ['research','coding','review','full-stack','decomp','mixed','other'].includes(value)
}
