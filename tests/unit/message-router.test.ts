import { describe, it, expect, beforeEach } from 'vitest'
import { MessageRouter } from '../../src/main/hub/message-router'
import { AgentRegistry } from '../../src/main/hub/agent-registry'
import type { AgentConfig } from '../../src/shared/types'

const makeConfig = (name: string): AgentConfig => ({
  id: `id-${name}`,
  name,
  cli: 'claude',
  cwd: '/tmp',
  role: 'Test',
  ceoNotes: '',
  shell: 'powershell' as const,
  admin: false,
  autoMode: false
})

describe('MessageRouter', () => {
  let registry: AgentRegistry
  let router: MessageRouter

  beforeEach(() => {
    registry = new AgentRegistry()
    router = new MessageRouter(registry)
    registry.register(makeConfig('orchestrator'))
    registry.register(makeConfig('worker-1'))
  })

  it('delivers a message to an existing agent', () => {
    const result = router.send('orchestrator', 'worker-1', 'do the thing')
    expect(result.status).toBe('delivered')
  })

  it('returns error for nonexistent target', () => {
    const result = router.send('orchestrator', 'ghost', 'hello')
    expect(result.status).toBe('error')
    expect(result.detail).toContain('not found')
  })

  it('queues message for disconnected agent', () => {
    registry.updateStatus('worker-1', 'disconnected')
    const result = router.send('orchestrator', 'worker-1', 'hello')
    expect(result.status).toBe('queued')
    expect(result.detail).toContain('offline')
  })

  it('retrieves messages (destructive read)', () => {
    router.send('orchestrator', 'worker-1', 'task 1')
    router.send('orchestrator', 'worker-1', 'task 2')

    const messages = router.getMessages('worker-1')
    expect(messages).toHaveLength(2)
    expect(messages[0].message).toBe('task 1')
    expect(messages[0].from).toBe('orchestrator')
    expect(messages[1].message).toBe('task 2')

    expect(router.getMessages('worker-1')).toHaveLength(0)
  })

  it('enforces max message size (10KB)', () => {
    const bigMsg = 'x'.repeat(11_000)
    const result = router.send('orchestrator', 'worker-1', bigMsg)
    expect(result.status).toBe('error')
    expect(result.detail).toContain('size')
  })

  it('enforces max queue depth (100), dropping oldest', () => {
    for (let i = 0; i < 105; i++) {
      router.send('orchestrator', 'worker-1', `msg-${i}`)
    }
    const messages = router.getMessages('worker-1')
    expect(messages).toHaveLength(100)
    expect(messages[0].message).toBe('msg-5')
  })
})
