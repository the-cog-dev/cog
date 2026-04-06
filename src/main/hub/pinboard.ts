import { v4 as uuid } from 'uuid'

export interface PinboardTask {
  id: string
  title: string
  description: string
  priority: 'low' | 'medium' | 'high'
  status: 'open' | 'in_progress' | 'completed'
  createdBy: string | null
  claimedBy: string | null
  result: string | null
  createdAt: string
  groupId?: string
  tabId?: string
  targetRole?: string  // only nudge agents with this role (e.g., 'reviewer', 'worker')
}

export class Pinboard {
  private tasks = new Map<string, PinboardTask>()
  onTaskCreated?: (task: PinboardTask) => void
  onTaskUpdated?: (task: PinboardTask) => void
  onTaskDeleted?: (taskId: string) => void

  postTask(title: string, description: string, priority: 'low' | 'medium' | 'high' = 'medium', createdBy?: string, groupId?: string, targetRole?: string, tabId?: string): PinboardTask {
    const task: PinboardTask = {
      id: uuid(),
      title,
      description,
      priority,
      status: 'open',
      createdBy: createdBy ?? null,
      claimedBy: null,
      result: null,
      targetRole: targetRole ?? undefined,
      createdAt: new Date().toISOString(),
      groupId: groupId ?? undefined,
      tabId: tabId ?? undefined
    }
    this.tasks.set(task.id, task)
    this.onTaskCreated?.(task)
    return task
  }

  loadTasks(tasks: PinboardTask[]): void {
    for (const task of tasks) {
      this.tasks.set(task.id, task)
    }
  }

  readTasks(): PinboardTask[] {
    return Array.from(this.tasks.values())
  }

  readTasksForGroup(groupId: string | null): PinboardTask[] {
    if (!groupId) return this.readTasks()
    return this.readTasks().filter(t => !t.groupId || t.groupId === groupId)
  }

  readTasksForTab(tabId: string | null): PinboardTask[] {
    if (!tabId) return this.readTasks()
    return this.readTasks().filter(t => !t.tabId || t.tabId === tabId)
  }

  claimTask(taskId: string, agentName: string): { status: string; detail: string; task?: PinboardTask } {
    const task = this.tasks.get(taskId)
    if (!task) {
      return { status: 'error', detail: `Task '${taskId}' not found` }
    }
    if (task.status === 'completed') {
      return { status: 'error', detail: 'Task is already completed' }
    }
    if (task.claimedBy) {
      return { status: 'error', detail: `Task already claimed by '${task.claimedBy}'` }
    }
    task.claimedBy = agentName
    task.status = 'in_progress'
    this.onTaskUpdated?.(task)
    return { status: 'ok', detail: `Task claimed by '${agentName}'`, task }
  }

  completeTask(taskId: string, agentName: string, result?: string): { status: string; detail: string } {
    const task = this.tasks.get(taskId)
    if (!task) {
      return { status: 'error', detail: `Task '${taskId}' not found` }
    }
    if (task.claimedBy !== agentName) {
      return { status: 'error', detail: `Only the claimer ('${task.claimedBy}') can complete this task` }
    }
    task.status = 'completed'
    task.result = result ?? null
    this.onTaskUpdated?.(task)
    return { status: 'ok', detail: 'Task completed' }
  }

  abandonTask(taskId: string): { status: string; detail: string } {
    const task = this.tasks.get(taskId)
    if (!task) {
      return { status: 'error', detail: `Task '${taskId}' not found` }
    }
    if (task.status === 'completed') {
      return { status: 'error', detail: 'Cannot abandon a completed task' }
    }
    if (task.status === 'open') {
      return { status: 'error', detail: 'Task is not claimed — nothing to abandon' }
    }
    const previousClaimer = task.claimedBy
    task.status = 'open'
    task.claimedBy = null
    this.onTaskUpdated?.(task)
    return { status: 'ok', detail: `Task abandoned by '${previousClaimer}', now open for claiming` }
  }

  getTask(taskId: string): PinboardTask | undefined {
    return this.tasks.get(taskId)
  }

  clearCompleted(tabId?: string | null): number {
    let cleared = 0
    for (const [id, task] of this.tasks) {
      if (task.status !== 'completed') continue
      if (tabId && task.tabId && task.tabId !== tabId) continue
      this.tasks.delete(id)
      this.onTaskDeleted?.(id)
      cleared++
    }
    return cleared
  }
}
