import { describe, it, expect } from 'vitest'
import { Pinboard } from '../../src/main/hub/pinboard'

describe('Pinboard', () => {
  it('posts a task with defaults', () => {
    const board = new Pinboard()
    const task = board.postTask('Fix bug', 'The login page is broken')
    expect(task.title).toBe('Fix bug')
    expect(task.description).toBe('The login page is broken')
    expect(task.priority).toBe('medium')
    expect(task.status).toBe('open')
    expect(task.claimedBy).toBeNull()
    expect(task.result).toBeNull()
    expect(task.id).toBeTruthy()
    expect(task.createdAt).toBeTruthy()
  })

  it('posts a task with custom priority', () => {
    const board = new Pinboard()
    const task = board.postTask('Critical fix', 'Server is down', 'high')
    expect(task.priority).toBe('high')
  })

  it('reads all tasks', () => {
    const board = new Pinboard()
    board.postTask('Task 1', 'Desc 1')
    board.postTask('Task 2', 'Desc 2', 'low')
    const tasks = board.readTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks[0].title).toBe('Task 1')
    expect(tasks[1].title).toBe('Task 2')
  })

  it('claims an open task', () => {
    const board = new Pinboard()
    const task = board.postTask('Do work', 'Some work')
    const result = board.claimTask(task.id, 'worker-1')
    expect(result.status).toBe('ok')

    const tasks = board.readTasks()
    expect(tasks[0].status).toBe('in_progress')
    expect(tasks[0].claimedBy).toBe('worker-1')
  })

  it('rejects double-claim', () => {
    const board = new Pinboard()
    const task = board.postTask('Do work', 'Some work')
    board.claimTask(task.id, 'worker-1')
    const result = board.claimTask(task.id, 'worker-2')
    expect(result.status).toBe('error')
    expect(result.detail).toContain('already claimed')
  })

  it('rejects claim on nonexistent task', () => {
    const board = new Pinboard()
    const result = board.claimTask('fake-id', 'worker-1')
    expect(result.status).toBe('error')
    expect(result.detail).toContain('not found')
  })

  it('completes a claimed task', () => {
    const board = new Pinboard()
    const task = board.postTask('Do work', 'Some work')
    board.claimTask(task.id, 'worker-1')
    const result = board.completeTask(task.id, 'worker-1', 'All done')
    expect(result.status).toBe('ok')

    const tasks = board.readTasks()
    expect(tasks[0].status).toBe('completed')
    expect(tasks[0].result).toBe('All done')
  })

  it('completes a task without result', () => {
    const board = new Pinboard()
    const task = board.postTask('Do work', 'Some work')
    board.claimTask(task.id, 'worker-1')
    const result = board.completeTask(task.id, 'worker-1')
    expect(result.status).toBe('ok')

    const tasks = board.readTasks()
    expect(tasks[0].result).toBeNull()
  })

  it('rejects complete by non-claimer', () => {
    const board = new Pinboard()
    const task = board.postTask('Do work', 'Some work')
    board.claimTask(task.id, 'worker-1')
    const result = board.completeTask(task.id, 'worker-2')
    expect(result.status).toBe('error')
    expect(result.detail).toContain('Only the claimer')
  })

  it('rejects complete on nonexistent task', () => {
    const board = new Pinboard()
    const result = board.completeTask('fake-id', 'worker-1')
    expect(result.status).toBe('error')
    expect(result.detail).toContain('not found')
  })

  it('rejects claim on completed task', () => {
    const board = new Pinboard()
    const task = board.postTask('Do work', 'Some work')
    board.claimTask(task.id, 'worker-1')
    board.completeTask(task.id, 'worker-1')
    const result = board.claimTask(task.id, 'worker-2')
    expect(result.status).toBe('error')
    expect(result.detail).toContain('already completed')
  })

  it('posts a task with targetAgent', () => {
    const board = new Pinboard()
    const task = board.postTask('Research API', 'Look into auth', 'medium', 'boss', undefined, undefined, undefined, 'researcher-1')
    expect(task.targetAgent).toBe('researcher-1')
  })

  it('posts a task without targetAgent defaults to undefined', () => {
    const board = new Pinboard()
    const task = board.postTask('Fix bug', 'Login broken')
    expect(task.targetAgent).toBeUndefined()
  })
})
