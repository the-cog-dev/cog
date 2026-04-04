export interface MetricsCounters {
  messagesSent: number
  messagesReceived: number
  tasksPosted: number
  tasksClaimed: number
  tasksCompleted: number
  infoPosted: number
  spawnedAt: string
}

export class AgentMetrics {
  private metrics = new Map<string, MetricsCounters>()

  register(agentName: string): void {
    if (!this.metrics.has(agentName)) {
      this.metrics.set(agentName, {
        messagesSent: 0,
        messagesReceived: 0,
        tasksPosted: 0,
        tasksClaimed: 0,
        tasksCompleted: 0,
        infoPosted: 0,
        spawnedAt: new Date().toISOString()
      })
    }
  }

  increment(agentName: string, field: keyof Omit<MetricsCounters, 'spawnedAt'>): void {
    const m = this.metrics.get(agentName)
    if (m) (m[field] as number)++
  }

  get(agentName: string): MetricsCounters | null {
    return this.metrics.get(agentName) ?? null
  }

  getAll(): Map<string, MetricsCounters> {
    return new Map(this.metrics)
  }

  remove(agentName: string): void {
    this.metrics.delete(agentName)
  }

  clear(): void {
    this.metrics.clear()
  }
}
