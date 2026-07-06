import { BrowserWindow, ipcMain } from 'electron'
import { listStreamDecks, openStreamDeck, DeviceModelId, type StreamDeck } from '@elgato-stream-deck/node'
import { StreamDeckBridge, type StreamDeckHandle } from './bridge'
import { VoiceCoordinator } from './voice-coordinator'
import { CloudWhisperClient, LocalWhisperClient, type WhisperClient } from './whisper-client'
import { readStreamDeckSettings } from './settings'
import { buildBridgeActions, type ActionDeps } from './handlers'
import { IPC } from '../../shared/types'
import type { AgentRegistry } from '../hub/agent-registry'
import type { StreamDeckButtonControlDefinition, StreamDeckEncoderControlDefinition } from '@elgato-stream-deck/node'
import fs from 'node:fs'
import path from 'node:path'

// Mirrors the pattern in src/main/remote/remote-server.ts: vite's static-copy
// plugin doesn't always populate the bundled main dir reliably, so we fall
// back to the source path. Returns the first candidate that contains
// cogsworth-happy.svg (a sentinel file).
export function resolveCogsworthDir(): string {
  const candidates = [
    path.join(__dirname, 'assets', 'cogsworth'),
    path.resolve(__dirname, '..', '..', 'src', 'main', 'streamdeck', 'assets', 'cogsworth'),
    path.resolve(process.cwd(), 'src', 'main', 'streamdeck', 'assets', 'cogsworth'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'cogsworth-happy.svg'))) {
      console.log(`[streamdeck] svgRoot resolved: ${dir}`)
      return dir
    }
  }
  console.warn('[streamdeck] svgRoot not found; tried:', candidates.join(' | '))
  return candidates[0] // best-guess fallback; renderer will throw at first read
}

let bridge: StreamDeckBridge | null = null
let coord: VoiceCoordinator | null = null
let pollTimer: NodeJS.Timeout | null = null
let lastSerial: string | null = null
let voiceAudioHandler: ((event: unknown, audio: ArrayBuffer) => void) | null = null

export interface InitOpts {
  registry: AgentRegistry
  listPresets: () => Promise<{ name: string; agentCount: number }[]>
  getUnread: () => { inbox: number; trollbox: number; stale: number }
  settingsIO: { load(): Record<string, unknown>; save(next: Record<string, unknown>): void }
  actionDeps: Omit<ActionDeps, 'voiceCoordinator'>
  mainWindow: () => BrowserWindow | null
  svgRoot: string
}

export async function initStreamDeck(opts: InitOpts): Promise<void> {
  const settings = readStreamDeckSettings(opts.settingsIO)
  if (!settings.enabled) return

  const tryOpen = async () => {
    if (bridge) return
    let raw: StreamDeck
    try {
      const list = await listStreamDecks()
      // MK2 = original-mk2, also accept originalv2 (earlier 15-key model)
      const mk2 = list.find(d =>
        d.model === DeviceModelId.ORIGINALMK2 ||
        d.model === DeviceModelId.ORIGINALV2 ||
        d.model === DeviceModelId.ORIGINALMK2SCISSOR
      )
      if (!mk2) return
      raw = await openStreamDeck(mk2.path)
    } catch (err) {
      console.warn('[streamdeck] open failed:', (err as Error).message)
      return
    }

    lastSerial = await raw.getSerialNumber().catch(() => 'unknown')

    // Derive NUM_KEYS and KEY_COLUMNS from CONTROLS (the library's abstraction)
    const buttonControls = raw.CONTROLS.filter(
      (c): c is StreamDeckButtonControlDefinition => c.type === 'button'
    )
    const numKeys = buttonControls.length
    if (numKeys !== 15) {
      console.warn(`[streamdeck] unsupported model (${numKeys} keys) — only MK.2 / 15-key supported in v1`)
      await raw.close().catch(() => {})
      return
    }
    const keyColumns = Math.max(...buttonControls.map(c => c.column)) + 1

    const handle: StreamDeckHandle = {
      NUM_KEYS: numKeys,
      KEY_COLUMNS: keyColumns,
      // KeyRenderer outputs raw RGBA pixels; tell the lib to skip PNG decoding.
      setKeyImage: (i, pixels) => raw.fillKeyBuffer(i, pixels, { format: 'rgba' }) as Promise<void>,
      clearAllKeys: () => raw.clearPanel() as Promise<void>,
      close: () => raw.close() as Promise<void>,
      on: (e, cb) => {
        if (e === 'down' || e === 'up') {
          // The library emits (control: StreamDeckButtonControlDefinition | StreamDeckEncoderControlDefinition)
          // The bridge expects (index: number) — extract .index here
          raw.on(e as 'down' | 'up', (control: StreamDeckButtonControlDefinition | StreamDeckEncoderControlDefinition) => {
            console.log(`[streamdeck] raw ${e} event: type=${control.type} index=${(control as { index?: number }).index}`)
            if (control.type === 'button') cb(control.index)
          })
        }
      },
      off: (e, cb) => {
        // EventEmitter3 removeListener needs the exact function reference.
        // Since we wrap in an anonymous function above, we can't reliably remove
        // by reference. Best-effort: remove all listeners for the event when
        // disposing (the device will be closed immediately after anyway).
        if (e === 'down' || e === 'up') {
          raw.removeAllListeners(e as 'down' | 'up')
        }
      },
    }

    const whisper = buildWhisperClient(settings)
    console.log(`[streamdeck] voice: backend=${settings.whisperBackend} apiKey=${settings.openaiApiKey ? 'set' : 'not set'} client=${whisper ? whisper.constructor.name : 'null'}`)
    coord = new VoiceCoordinator({
      sendStart: () => {
        const w = opts.mainWindow()
        console.log(`[streamdeck] voice: sendStart → mainWindow=${w ? 'ok' : 'NULL'}`)
        w?.webContents.send(IPC.VOICE_START)
      },
      sendStop: () => {
        const w = opts.mainWindow()
        console.log(`[streamdeck] voice: sendStop → mainWindow=${w ? 'ok' : 'NULL'}`)
        w?.webContents.send(IPC.VOICE_STOP)
      },
      onTranscript: (text) => {
        console.log(`[streamdeck] voice: onTranscript text="${text}"`)
        actions.onTranscript(text)
      },
      onState: (s) => {
        console.log(`[streamdeck] voice: state → ${s}`)
        actions.onVoiceState(s)
        // Tint the 🎙️ key on the deck so the user can see they're recording.
        bridge?.setVoiceState(s)
      },
      onError: (err) => {
        console.warn(`[streamdeck] voice: error`, err)
        actions.onVoiceError(err)
      },
      getWhisper: () => whisper,
    })

    const actions = buildBridgeActions({
      ...opts.actionDeps,
      voiceCoordinator: coord,
    })

    bridge = new StreamDeckBridge({
      deck: handle,
      registry: opts.registry,
      listPresets: opts.listPresets,
      getUnread: opts.getUnread,
      svgRoot: opts.svgRoot,
      actions,
    })
    await bridge.start()
    console.log(`[streamdeck] connected MK.2 (serial: ${lastSerial})`)
  }

  // Captured here so dispose can detach this exact handler reference.
  const onVoiceAudio = (_e: unknown, audio: ArrayBuffer) => {
    console.log(`[streamdeck] voice: received audio buffer (${audio?.byteLength ?? 'undefined'} bytes), coord=${coord ? 'set' : 'null'}`)
    coord?.handleAudio(audio)
  }
  ipcMain.on(IPC.VOICE_AUDIO, onVoiceAudio)
  voiceAudioHandler = onVoiceAudio

  await tryOpen()

  // Hotplug poll — node-hid does not surface attach events on all platforms,
  // so we poll the device list every 3s. Cheap enumeration, exits early when
  // already connected.
  pollTimer = setInterval(() => { void tryOpen() }, 3000)
}

export async function disposeStreamDeck(): Promise<void> {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (voiceAudioHandler) {
    ipcMain.removeListener(IPC.VOICE_AUDIO, voiceAudioHandler)
    voiceAudioHandler = null
  }
  if (bridge) {
    await bridge.dispose().catch(() => {})
    bridge = null
  }
  coord = null
}

export function getStreamDeckStatus(): 'connected' | 'disconnected' {
  return bridge ? 'connected' : 'disconnected'
}

export async function reconnectStreamDeck(opts: InitOpts): Promise<void> {
  await disposeStreamDeck()
  await initStreamDeck(opts)
}

export function buildWhisperClient(settings: { whisperBackend: string; openaiApiKey?: string }): WhisperClient | null {
  if (settings.whisperBackend === 'cloud') {
    const key = settings.openaiApiKey || process.env.OPENAI_API_KEY || ''
    return new CloudWhisperClient({ apiKey: key })
  }
  if (settings.whisperBackend === 'local') {
    return new LocalWhisperClient({ model: 'base.en' })
  }
  return null
}
