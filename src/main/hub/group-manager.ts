import type { AgentGroup, LinkState } from '../../shared/types'

const GROUP_COLORS = [
  '#4a9eff', '#4caf50', '#ffc107', '#e91e63', '#9c27b0',
  '#00bcd4', '#ff5722', '#8bc34a', '#3f51b5', '#ff9800'
]

interface Link {
  from: string
  to: string
}

export class GroupManager {
  private links: Link[] = []
  private groups: AgentGroup[] = []
  private nextGroupNum = 1
  onChange?: () => void

  addLink(from: string, to: string): void {
    const [a, b] = [from, to].sort()
    const exists = this.links.some(l => l.from === a && l.to === b)
    if (exists) return
    this.links.push({ from: a, to: b })
    this.recalculateGroups()
    this.onChange?.()
  }

  removeLink(from: string, to: string): void {
    const [a, b] = [from, to].sort()
    this.links = this.links.filter(l => !(l.from === a && l.to === b))
    this.recalculateGroups()
    this.onChange?.()
  }

  getLinks(): Link[] {
    return [...this.links]
  }

  getGroups(): AgentGroup[] {
    return [...this.groups]
  }

  getGroupForAgent(agentName: string): AgentGroup | null {
    return this.groups.find(g => g.members.includes(agentName)) ?? null
  }

  getGroupIdForAgent(agentName: string): string | null {
    return this.getGroupForAgent(agentName)?.id ?? null
  }

  canCommunicate(from: string, to: string): boolean {
    const fromGroup = this.getGroupForAgent(from)
    const toGroup = this.getGroupForAgent(to)
    if (!fromGroup || !toGroup) return true
    return fromGroup.id === toGroup.id
  }

  exportState(): LinkState {
    return { links: [...this.links], groups: [...this.groups] }
  }

  importState(state: LinkState): void {
    this.links = [...state.links]
    this.recalculateGroups()
  }

  private recalculateGroups(): void {
    const agents = new Set<string>()
    for (const link of this.links) {
      agents.add(link.from)
      agents.add(link.to)
    }

    const parent = new Map<string, string>()
    for (const agent of agents) parent.set(agent, agent)

    const find = (x: string): string => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)!)!)
        x = parent.get(x)!
      }
      return x
    }

    const union = (a: string, b: string) => {
      parent.set(find(a), find(b))
    }

    for (const link of this.links) {
      union(link.from, link.to)
    }

    const components = new Map<string, string[]>()
    for (const agent of agents) {
      const root = find(agent)
      if (!components.has(root)) components.set(root, [])
      components.get(root)!.push(agent)
    }

    const clusters = Array.from(components.values()).filter(c => c.length >= 2)

    const newGroups: AgentGroup[] = []
    for (const members of clusters) {
      const sorted = members.sort()
      const existing = this.groups.find(g =>
        g.members.length === sorted.length &&
        g.members.sort().every((m, i) => m === sorted[i])
      )

      if (existing) {
        newGroups.push(existing)
      } else {
        newGroups.push({
          id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: `Group ${this.nextGroupNum++}`,
          color: GROUP_COLORS[newGroups.length % GROUP_COLORS.length],
          members: sorted
        })
      }
    }

    this.groups = newGroups
  }
}
