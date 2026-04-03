import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

import {
  setPresetsDir,
  savePreset,
  loadPreset,
  listPresets,
  deletePreset,
  presetExists
} from '../../src/main/presets/preset-manager'
import type { AgentConfig, WindowPosition, CanvasState } from '../../src/shared/types'

function makePresetData(name: string) {
  const agents: AgentConfig[] = [
    {
      id: 'agent-1',
      name,
      cli: 'test-cli',
      cwd: '/tmp',
      role: 'worker',
      ceoNotes: 'test',
      shell: 'bash',
      admin: false,
      autoMode: false
    }
  ]
  const windows: WindowPosition[] = [
    { agentName: name, x: 10, y: 20, width: 300, height: 400 }
  ]
  const canvas: CanvasState = { zoom: 1, panX: 0, panY: 0 }
  return { agents, windows, canvas }
}

describe('preset-manager', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-manager-test-'))
    const presetsPath = path.join(tmpDir, 'presets')
    fs.mkdirSync(presetsPath, { recursive: true })
    setPresetsDir(presetsPath)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('savePreset', () => {
    it('writes a JSON file to the presets directory', () => {
      const { agents, windows, canvas } = makePresetData('my-preset')
      savePreset('my-preset', agents, windows, canvas)

      const presetPath = path.join(tmpDir, 'presets', 'my-preset.json')
      expect(fs.existsSync(presetPath)).toBe(true)

      const content = JSON.parse(fs.readFileSync(presetPath, 'utf-8'))
      expect(content.name).toBe('my-preset')
      expect(content.agents).toEqual(agents)
      expect(content.windows).toEqual(windows)
      expect(content.canvas).toEqual(canvas)
      expect(typeof content.savedAt).toBe('string')
    })

    it('sanitizes invalid characters in the name', () => {
      const { agents, windows, canvas } = makePresetData('test')
      savePreset('hello world!!!', agents, windows, canvas)

      const presetPath = path.join(tmpDir, 'presets', 'hello-world-.json')
      expect(fs.existsSync(presetPath)).toBe(true)
    })

    it('replaces underscores with hyphens', () => {
      const { agents, windows, canvas } = makePresetData('test')
      savePreset('my_preset_name', agents, windows, canvas)

      const presetPath = path.join(tmpDir, 'presets', 'my-preset-name.json')
      expect(fs.existsSync(presetPath)).toBe(true)
    })

    it('truncates names longer than 50 characters', () => {
      const longName = 'a'.repeat(60)
      const { agents, windows, canvas } = makePresetData('test')
      savePreset(longName, agents, windows, canvas)

      const files = fs.readdirSync(path.join(tmpDir, 'presets'))
      expect(files.length).toBe(1)
      expect(files[0]).toBe('a'.repeat(50) + '.json')
    })
  })

  describe('loadPreset', () => {
    it('reads back a saved preset', () => {
      const { agents, windows, canvas } = makePresetData('load-test')
      savePreset('load-test', agents, windows, canvas)

      const preset = loadPreset('load-test')
      expect(preset.name).toBe('load-test')
      expect(preset.agents).toEqual(agents)
      expect(preset.windows).toEqual(windows)
      expect(preset.canvas).toEqual(canvas)
      expect(typeof preset.savedAt).toBe('string')
    })

    it('throws when loading a non-existent preset', () => {
      expect(() => loadPreset('does-not-exist')).toThrow("Preset 'does-not-exist' not found")
    })
  })

  describe('listPresets', () => {
    it('returns names of all saved presets sorted alphabetically', () => {
      const { agents, windows, canvas } = makePresetData('test')
      savePreset('zebra', agents, windows, canvas)
      savePreset('apple', agents, windows, canvas)
      savePreset('mango', agents, windows, canvas)

      const presets = listPresets()
      expect(presets).toEqual(['apple', 'mango', 'zebra'])
    })

    it('returns an empty array when no presets exist', () => {
      const presets = listPresets()
      expect(presets).toEqual([])
    })

    it('ignores non-JSON files in the presets directory', () => {
      const { agents, windows, canvas } = makePresetData('test')
      savePreset('valid', agents, windows, canvas)

      fs.writeFileSync(path.join(tmpDir, 'presets', 'readme.txt'), 'hello')
      const presets = listPresets()
      expect(presets).toEqual(['valid'])
    })
  })

  describe('deletePreset', () => {
    it('removes a preset file', () => {
      const { agents, windows, canvas } = makePresetData('test')
      savePreset('to-delete', agents, windows, canvas)

      const presetPath = path.join(tmpDir, 'presets', 'to-delete.json')
      expect(fs.existsSync(presetPath)).toBe(true)

      deletePreset('to-delete')
      expect(fs.existsSync(presetPath)).toBe(false)
    })

    it('throws when deleting a non-existent preset', () => {
      expect(() => deletePreset('does-not-exist')).toThrow("Preset 'does-not-exist' not found")
    })
  })

  describe('presetExists', () => {
    it('returns true for an existing preset', () => {
      const { agents, windows, canvas } = makePresetData('test')
      savePreset('exists', agents, windows, canvas)
      expect(presetExists('exists')).toBe(true)
    })

    it('returns false for a missing preset', () => {
      expect(presetExists('missing')).toBe(false)
    })

    it('sanitizes the name before checking', () => {
      const { agents, windows, canvas } = makePresetData('test')
      savePreset('my preset', agents, windows, canvas)
      expect(presetExists('my preset')).toBe(true)
      expect(presetExists('my-preset')).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('throws for an invalid preset name that sanitizes to empty', () => {
      const { agents, windows, canvas } = makePresetData('test')
      expect(() => savePreset('', agents, windows, canvas)).toThrow('Invalid preset name')
      expect(() => savePreset('   ', agents, windows, canvas)).toThrow('Invalid preset name')
    })

    it('handles mixed case names by lowercasing', () => {
      const { agents, windows, canvas } = makePresetData('test')
      savePreset('MyPreset', agents, windows, canvas)

      const presetPath = path.join(tmpDir, 'presets', 'mypreset.json')
      expect(fs.existsSync(presetPath)).toBe(true)
    })
  })
})
