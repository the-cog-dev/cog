import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ed25519, x25519 } from '@noble/curves/ed25519'
import { TrollboxClient } from './trollbox-client'
import { openFp, signAdmin } from '../../../shared/trollbox-crypto'

// Minimal fake matching the subset of @supabase/supabase-js Channel API we call.
function makeFakeChannel() {
  const handlers: Record<string, (payload: any) => void> = {}
  const state: { presence: Record<string, any[]> } = { presence: {} }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chan: any = {
    on: vi.fn((kind: string, opts: any, handler: any) => {
      const key = kind === 'broadcast' ? `broadcast:${opts.event}` : kind
      handlers[key] = handler
      return chan
    }),
    subscribe: vi.fn((cb?: (status: string) => void) => {
      cb?.('SUBSCRIBED')
      return chan
    }),
    send: vi.fn(async () => 'ok'),
    track: vi.fn(async () => 'ok'),
    untrack: vi.fn(async () => 'ok'),
    unsubscribe: vi.fn(async () => 'ok'),
    presenceState: vi.fn(() => state.presence),
    __trigger: (key: string, payload: any) => handlers[key]?.(payload),
    __setPresence: (p: Record<string, any[]>) => { state.presence = p },
  }
  return chan
}

function makeFakeSupabase() {
  const chan = makeFakeChannel()
  return { channel: vi.fn(() => chan), __chan: chan }
}

describe('TrollboxClient lifecycle', () => {
  it('transitions closed → connecting → connected on connect()', async () => {
    const sb = makeFakeSupabase()
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const edPub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey())
    const client = new TrollboxClient({ supabase: sb as any, machineHash: 'abc', adminX25519Pub: xPub, adminEd25519Pub: edPub })
    const states: string[] = []
    client.onState(s => states.push(s.status))
    await client.connect()
    expect(states).toContain('connecting')
    expect(states).toContain('connected')
  })

  it('updates onlineCount from presence sync', async () => {
    const sb = makeFakeSupabase()
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const edPub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey())
    const client = new TrollboxClient({ supabase: sb as any, machineHash: 'abc', adminX25519Pub: xPub, adminEd25519Pub: edPub })
    let count = -1
    client.onState(s => { count = s.onlineCount })
    await client.connect()
    sb.__chan.__setPresence({ a: [{}], b: [{}], c: [{}] })
    sb.__chan.__trigger('presence', {})
    expect(count).toBe(3)
  })

  it('calls untrack + unsubscribe on disconnect()', async () => {
    const sb = makeFakeSupabase()
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const edPub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey())
    const client = new TrollboxClient({ supabase: sb as any, machineHash: 'abc', adminX25519Pub: xPub, adminEd25519Pub: edPub })
    await client.connect()
    await client.disconnect()
    expect(sb.__chan.untrack).toHaveBeenCalled()
    expect(sb.__chan.unsubscribe).toHaveBeenCalled()
  })
})

describe('TrollboxClient chat', () => {
  it('sends a chat message with encrypted fp', async () => {
    const xPriv = x25519.utils.randomPrivateKey()
    const xPub = x25519.getPublicKey(xPriv)
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'deadbeef1234',
      adminX25519Pub: xPub,
      adminEd25519Pub: ed25519.getPublicKey(ed25519.utils.randomPrivateKey()),
    })
    await client.connect()
    await client.sendChat('satoshi', 'gm')
    expect(sb.__chan.send).toHaveBeenCalledTimes(1)
    const call = sb.__chan.send.mock.calls[0][0]
    expect(call.event).toBe('chat')
    expect(call.payload.nick).toBe('satoshi')
    expect(call.payload.text).toBe('gm')
    expect(typeof call.payload.fp_enc).toBe('string')
    // Admin can open it
    expect(openFp(call.payload.fp_enc, xPriv, xPub)).toBe('deadbeef1234')
  })

  it('appends incoming chat messages to the buffer', async () => {
    const xPriv = x25519.utils.randomPrivateKey()
    const xPub = x25519.getPublicKey(xPriv)
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp-a',
      adminX25519Pub: xPub,
      adminEd25519Pub: ed25519.getPublicKey(ed25519.utils.randomPrivateKey()),
    })
    let messages: any[] = []
    client.onState(s => { messages = s.messages })
    await client.connect()
    sb.__chan.__trigger('broadcast:chat', {
      payload: { type: 'chat', id: 'x1', ts: 1, nick: 'bob', fp_enc: 'zzz', text: 'hi' },
    })
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toBe('hi')
  })

  it('drops buffer to 500 when overflowing', async () => {
    const xPriv = x25519.utils.randomPrivateKey()
    const xPub = x25519.getPublicKey(xPriv)
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp-a',
      adminX25519Pub: xPub,
      adminEd25519Pub: ed25519.getPublicKey(ed25519.utils.randomPrivateKey()),
    })
    let messages: any[] = []
    client.onState(s => { messages = s.messages })
    await client.connect()
    for (let i = 0; i < 600; i++) {
      sb.__chan.__trigger('broadcast:chat', {
        payload: { type: 'chat', id: `x${i}`, ts: i, nick: 'n', fp_enc: `fp${i}`, text: `m${i}` },
      })
    }
    expect(messages).toHaveLength(500)
    expect(messages[0].text).toBe('m100')
    expect(messages[499].text).toBe('m599')
  })
})

describe('TrollboxClient rate limits', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('blocks 2nd send within 1s window', async () => {
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: x25519.getPublicKey(x25519.utils.randomPrivateKey()),
      adminEd25519Pub: ed25519.getPublicKey(ed25519.utils.randomPrivateKey()),
    })
    await client.connect()
    vi.setSystemTime(1000)
    const r1 = await client.sendChat('a', 'first')
    vi.setSystemTime(1500)
    const r2 = await client.sendChat('a', 'second')
    expect(r1).toEqual({ ok: true })
    expect(r2).toEqual({ ok: false, reason: 'rate-limit' })
    expect(sb.__chan.send).toHaveBeenCalledTimes(1)
  })

  it('allows send after 1s passes', async () => {
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: x25519.getPublicKey(x25519.utils.randomPrivateKey()),
      adminEd25519Pub: ed25519.getPublicKey(ed25519.utils.randomPrivateKey()),
    })
    await client.connect()
    vi.setSystemTime(1000)
    await client.sendChat('a', 'first')
    vi.setSystemTime(2100)
    const r2 = await client.sendChat('a', 'second')
    expect(r2).toEqual({ ok: true })
    expect(sb.__chan.send).toHaveBeenCalledTimes(2)
  })
})

describe('TrollboxClient per-source filter', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('drops 11th message from same fp_enc within 10s', async () => {
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: x25519.getPublicKey(x25519.utils.randomPrivateKey()),
      adminEd25519Pub: ed25519.getPublicKey(ed25519.utils.randomPrivateKey()),
    })
    let messages: any[] = []
    client.onState(s => { messages = s.messages })
    await client.connect()
    vi.setSystemTime(0)
    for (let i = 0; i < 15; i++) {
      vi.setSystemTime(i * 500)
      sb.__chan.__trigger('broadcast:chat', {
        payload: { type: 'chat', id: `id${i}`, ts: i, nick: 'spammer', fp_enc: 'SAME', text: `m${i}` },
      })
    }
    expect(messages).toHaveLength(10)
    // The EARLY messages (m0-m9) should pass; the LATER ones (m10-m14) drop.
    expect(messages.map(m => m.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i}`)
    )
  })
})

describe('TrollboxClient admin verification', () => {
  it('applies a valid admin.delete to the buffer', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    let messages: any[] = []
    client.onState(s => { messages = s.messages })
    await client.connect()
    sb.__chan.__trigger('broadcast:chat', {
      payload: { type: 'chat', id: 'x1', ts: 1, nick: 'a', fp_enc: 'z', text: 'hi' },
    })
    const signed = signAdmin({ type: 'admin.delete', target_id: 'x1', ts: 2 }, edPriv)
    sb.__chan.__trigger('broadcast:admin', { payload: signed })
    expect(messages).toHaveLength(0)
  })

  it('ignores an admin message with invalid signature', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey()) // wrong pub
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    let messages: any[] = []
    client.onState(s => { messages = s.messages })
    await client.connect()
    sb.__chan.__trigger('broadcast:chat', {
      payload: { type: 'chat', id: 'x1', ts: 1, nick: 'a', fp_enc: 'z', text: 'hi' },
    })
    const signed = signAdmin({ type: 'admin.delete', target_id: 'x1', ts: 2 }, edPriv)
    sb.__chan.__trigger('broadcast:admin', { payload: signed })
    expect(messages).toHaveLength(1) // delete rejected
  })

  it('applies admin.ban (nick) — banned nick messages dropped', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    let messages: any[] = []
    client.onState(s => { messages = s.messages })
    await client.connect()
    const ban = signAdmin(
      { type: 'admin.ban', kind: 'nick', target: 'spammer', duration_ms: 60_000, ts: Date.now() },
      edPriv,
    )
    sb.__chan.__trigger('broadcast:admin', { payload: ban })
    sb.__chan.__trigger('broadcast:chat', {
      payload: { type: 'chat', id: 'x1', ts: Date.now(), nick: 'spammer', fp_enc: 'z', text: 'hi' },
    })
    sb.__chan.__trigger('broadcast:chat', {
      payload: { type: 'chat', id: 'x2', ts: Date.now(), nick: 'friend', fp_enc: 'z', text: 'yo' },
    })
    expect(messages.map(m => m.nick)).toEqual(['friend'])
  })
})

describe('TrollboxClient pause state', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('enters paused state on admin.pause', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    await client.connect()
    vi.setSystemTime(0)
    const pause = signAdmin(
      { type: 'admin.pause', reason: 'chill', until: 60_000, ts: 0 },
      edPriv,
    )
    sb.__chan.__trigger('broadcast:admin', { payload: pause })
    expect(client.getState().status).toBe('paused')
    expect(client.getState().pauseReason).toBe('chill')
  })

  it('self-expires pause when until < now', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    await client.connect()
    vi.setSystemTime(0)
    const pause = signAdmin(
      { type: 'admin.pause', reason: 'chill', until: 5_000, ts: 0 },
      edPriv,
    )
    sb.__chan.__trigger('broadcast:admin', { payload: pause })
    expect(client.getState().status).toBe('paused')
    vi.setSystemTime(6_000)
    vi.advanceTimersByTime(1_500)  // pause-tick interval runs
    expect(client.getState().status).toBe('connected')
  })

  it('blocks sendChat while paused', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    await client.connect()
    vi.setSystemTime(0)
    const pause = signAdmin(
      { type: 'admin.pause', reason: 'x', until: 60_000, ts: 0 },
      edPriv,
    )
    sb.__chan.__trigger('broadcast:admin', { payload: pause })
    const res = await client.sendChat('a', 'hi')
    expect(res).toEqual({ ok: false, reason: 'paused' })
  })
})

describe('TrollboxClient admin send', () => {
  it('sendAdmin signs and broadcasts', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPriv = x25519.utils.randomPrivateKey()
    const xPub = x25519.getPublicKey(xPriv)
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    await client.connect()
    client.loadAdminKeys(edPriv, xPriv)
    await client.adminDelete('target-msg-id')
    expect(sb.__chan.send).toHaveBeenCalled()
    const call = sb.__chan.send.mock.calls.at(-1)![0]
    expect(call.event).toBe('admin')
    expect(call.payload.type).toBe('admin.delete')
    expect(call.payload.target_id).toBe('target-msg-id')
    expect(typeof call.payload.sig).toBe('string')
  })
})

describe('TrollboxClient admin fp decryption', () => {
  it('decrypts fp_enc of incoming chat when admin keys loaded', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPriv = x25519.utils.randomPrivateKey()
    const xPub = x25519.getPublicKey(xPriv)
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'abc',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    await client.connect()
    client.loadAdminKeys(edPriv, xPriv)
    const { sealFp } = await import('../../../shared/trollbox-crypto')
    const fp_enc = sealFp('target-fp-1', xPub)
    sb.__chan.__trigger('broadcast:chat', {
      payload: { type: 'chat', id: 'xyz', ts: 1, nick: 'n', fp_enc, text: 't' },
    })
    expect(client.getDecryptedFp('xyz')).toBe('target-fp-1')
  })

  it('enforces fp-ban on admin side after decryption', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPriv = x25519.utils.randomPrivateKey()
    const xPub = x25519.getPublicKey(xPriv)
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'me',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    let messages: any[] = []
    client.onState(s => { messages = s.messages })
    await client.connect()
    client.loadAdminKeys(edPriv, xPriv)
    const { sealFp, signAdmin } = await import('../../../shared/trollbox-crypto')
    const ban = signAdmin(
      { type: 'admin.ban', kind: 'fp', target: 'evil-fp', duration_ms: 60_000, ts: Date.now() },
      edPriv,
    )
    sb.__chan.__trigger('broadcast:admin', { payload: ban })
    sb.__chan.__trigger('broadcast:chat', {
      payload: { type: 'chat', id: 'a', ts: Date.now(), nick: 'x',
                 fp_enc: sealFp('evil-fp', xPub), text: 'banned' },
    })
    sb.__chan.__trigger('broadcast:chat', {
      payload: { type: 'chat', id: 'b', ts: Date.now(), nick: 'y',
                 fp_enc: sealFp('good-fp', xPub), text: 'clean' },
    })
    expect(messages.map(m => m.text)).toEqual(['clean'])
  })

  it('does NOT enforce fp-ban on non-admin (no priv key) side', async () => {
    const edPub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey())
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'me',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    let messages: any[] = []
    client.onState(s => { messages = s.messages })
    await client.connect()
    // No loadAdminKeys — non-admin instance.
    // Directly poke an fp-ban into localBans (simulate ban existing; sig verify would normally gate)
    ;(client as any).localBans.set('fp:evil-fp', Date.now() + 60_000)
    const { sealFp } = await import('../../../shared/trollbox-crypto')
    sb.__chan.__trigger('broadcast:chat', {
      payload: { type: 'chat', id: 'a', ts: Date.now(), nick: 'x',
                 fp_enc: sealFp('evil-fp', xPub), text: 'still-visible' },
    })
    expect(messages.map(m => m.text)).toEqual(['still-visible'])
  })
})

describe('TrollboxClient admin unban', () => {
  it('admin.unban removes nick ban so the user can post again', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    let messages: any[] = []
    client.onState(s => { messages = s.messages })
    await client.connect()
    // Ban 'spammer'
    const ban = signAdmin(
      { type: 'admin.ban', kind: 'nick', target: 'spammer', duration_ms: 60_000, ts: Date.now() },
      edPriv,
    )
    sb.__chan.__trigger('broadcast:admin', { payload: ban })
    sb.__chan.__trigger('broadcast:chat', {
      payload: { type: 'chat', id: 'x1', ts: Date.now(), nick: 'spammer', fp_enc: 'z1', text: 'blocked' },
    })
    expect(messages).toHaveLength(0)
    // Unban 'spammer'
    const unban = signAdmin(
      { type: 'admin.unban', kind: 'nick', target: 'spammer', ts: Date.now() },
      edPriv,
    )
    sb.__chan.__trigger('broadcast:admin', { payload: unban })
    sb.__chan.__trigger('broadcast:chat', {
      payload: { type: 'chat', id: 'x2', ts: Date.now(), nick: 'spammer', fp_enc: 'z2', text: 'back' },
    })
    expect(messages.map(m => m.text)).toEqual(['back'])
  })

  it('adminUnban signs and broadcasts admin.unban', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPriv = x25519.utils.randomPrivateKey()
    const xPub = x25519.getPublicKey(xPriv)
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    await client.connect()
    client.loadAdminKeys(edPriv, xPriv)
    await client.adminUnban('nick', 'spammer')
    const call = sb.__chan.send.mock.calls.at(-1)![0]
    expect(call.event).toBe('admin')
    expect(call.payload.type).toBe('admin.unban')
    expect(call.payload.kind).toBe('nick')
    expect(call.payload.target).toBe('spammer')
    expect(typeof call.payload.sig).toBe('string')
  })

  it('getActiveBans returns live bans sorted by expiry', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    await client.connect()
    const now = Date.now()
    const banLong = signAdmin(
      { type: 'admin.ban', kind: 'nick', target: 'a', duration_ms: 120_000, ts: now },
      edPriv,
    )
    const banShort = signAdmin(
      { type: 'admin.ban', kind: 'fp', target: 'b', duration_ms: 30_000, ts: now },
      edPriv,
    )
    sb.__chan.__trigger('broadcast:admin', { payload: banLong })
    sb.__chan.__trigger('broadcast:admin', { payload: banShort })
    const bans = client.getActiveBans()
    expect(bans).toHaveLength(2)
    expect(bans[0].kind).toBe('fp')   // shorter expiry first
    expect(bans[0].target).toBe('b')
    expect(bans[1].kind).toBe('nick')
    expect(bans[1].target).toBe('a')
  })
})

describe('TrollboxClient admin self-apply (broadcast self:false)', () => {
  // Supabase is configured with broadcast.self=false, so admin senders do NOT
  // receive their own admin messages back. Each admin action must apply itself
  // locally so admin's own state reflects their own moderation.

  it('adminBan self-applies so admin immediately filters banned nicks', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPriv = x25519.utils.randomPrivateKey()
    const xPub = x25519.getPublicKey(xPriv)
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'admin-fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    let messages: any[] = []
    client.onState(s => { messages = s.messages })
    await client.connect()
    client.loadAdminKeys(edPriv, xPriv)

    // Admin bans 'NewNATE' — no broadcast arrives back (self:false).
    await client.adminBan('nick', 'NewNATE', 60_000)
    // Verify ban is in localBans now (via getActiveBans).
    expect(client.getActiveBans().map(b => `${b.kind}:${b.target}`)).toContain('nick:NewNATE')

    // When a chat from 'NewNATE' arrives from the other instance, admin filters it.
    sb.__chan.__trigger('broadcast:chat', {
      payload: { type: 'chat', id: 'x1', ts: Date.now(), nick: 'NewNATE', fp_enc: 'z', text: 'hi' },
    })
    expect(messages).toHaveLength(0)
  })

  it('adminDelete self-applies so admin sees their own deletion in their buffer', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPriv = x25519.utils.randomPrivateKey()
    const xPub = x25519.getPublicKey(xPriv)
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'admin-fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    let messages: any[] = []
    client.onState(s => { messages = s.messages })
    await client.connect()
    client.loadAdminKeys(edPriv, xPriv)

    // A message arrives, admin deletes it.
    sb.__chan.__trigger('broadcast:chat', {
      payload: { type: 'chat', id: 'doomed', ts: Date.now(), nick: 'x', fp_enc: 'z', text: 't' },
    })
    expect(messages).toHaveLength(1)
    await client.adminDelete('doomed')
    expect(messages).toHaveLength(0)
  })

  it('adminPause self-applies so admin enters paused state immediately', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPriv = x25519.utils.randomPrivateKey()
    const xPub = x25519.getPublicKey(xPriv)
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'admin-fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    await client.connect()
    client.loadAdminKeys(edPriv, xPriv)
    await client.adminPause('test', 60_000)
    expect(client.getState().status).toBe('paused')
    expect(client.getState().pauseReason).toBe('test')
  })

  it('adminUnban self-applies so admin can re-allow immediately', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPriv = x25519.utils.randomPrivateKey()
    const xPub = x25519.getPublicKey(xPriv)
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'admin-fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    await client.connect()
    client.loadAdminKeys(edPriv, xPriv)
    await client.adminBan('nick', 'foo', 60_000)
    expect(client.getActiveBans().map(b => b.target)).toContain('foo')
    await client.adminUnban('nick', 'foo')
    expect(client.getActiveBans().map(b => b.target)).not.toContain('foo')
  })
})

describe('TrollboxClient configurable rate limit', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('adminSetRateLimit(0) disables the self-rate-limit (unlimited)', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPriv = x25519.utils.randomPrivateKey()
    const xPub = x25519.getPublicKey(xPriv)
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    await client.connect()
    client.loadAdminKeys(edPriv, xPriv)
    await client.adminSetRateLimit(0)
    expect(client.getRateLimitMs()).toBe(0)
    vi.setSystemTime(1000)
    const r1 = await client.sendChat('a', 'first')
    const r2 = await client.sendChat('a', 'spam')
    const r3 = await client.sendChat('a', 'spam')
    expect(r1).toEqual({ ok: true })
    expect(r2).toEqual({ ok: true })
    expect(r3).toEqual({ ok: true })
  })

  it('admin.config broadcast from another admin updates this client', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    await client.connect()
    expect(client.getRateLimitMs()).toBe(1000)
    const cfg = signAdmin(
      { type: 'admin.config', rate_limit_ms: 5000, ts: Date.now() },
      edPriv,
    )
    sb.__chan.__trigger('broadcast:admin', { payload: cfg })
    expect(client.getRateLimitMs()).toBe(5000)
  })

  it('rejects admin.config with negative or non-number rate_limit_ms', async () => {
    const edPriv = ed25519.utils.randomPrivateKey()
    const edPub = ed25519.getPublicKey(edPriv)
    const xPub = x25519.getPublicKey(x25519.utils.randomPrivateKey())
    const sb = makeFakeSupabase()
    const client = new TrollboxClient({
      supabase: sb as any,
      machineHash: 'fp',
      adminX25519Pub: xPub,
      adminEd25519Pub: edPub,
    })
    await client.connect()
    const cfgBad = signAdmin(
      { type: 'admin.config', rate_limit_ms: -1, ts: Date.now() },
      edPriv,
    )
    sb.__chan.__trigger('broadcast:admin', { payload: cfgBad })
    expect(client.getRateLimitMs()).toBe(1000) // unchanged
  })
})
