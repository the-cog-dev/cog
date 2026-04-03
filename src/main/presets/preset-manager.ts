import * as fs from 'fs'
import * as path from 'path'
import type { WorkspacePreset, AgentConfig, WindowPosition, CanvasState } from '../../shared/types'

const MAX_PRESET_NAME_LENGTH = 50

let _presetsDir: string | null = null

export function setPresetsDir(dir: string): void {
  _presetsDir = dir
}

function getPresetsDir(): string {
  if (!_presetsDir) throw new Error('Presets directory not configured — open a project first')
  if (!fs.existsSync(_presetsDir)) {
    fs.mkdirSync(_presetsDir, { recursive: true })
  }
  return _presetsDir
}

function sanitizePresetName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/_+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, MAX_PRESET_NAME_LENGTH)
}

function getPresetPath(name: string): string {
  const sanitized = sanitizePresetName(name)
  if (!sanitized) {
    throw new Error('Invalid preset name')
  }
  return path.join(getPresetsDir(), `${sanitized}.json`)
}

export function savePreset(
  name: string,
  agents: AgentConfig[],
  windows: WindowPosition[],
  canvas: CanvasState
): void {
  const preset: WorkspacePreset = {
    name,
    agents,
    windows,
    canvas,
    savedAt: new Date().toISOString()
  }

  const presetPath = getPresetPath(name)
  fs.writeFileSync(presetPath, JSON.stringify(preset, null, 2), 'utf-8')
}

export function loadPreset(name: string): WorkspacePreset {
  const presetPath = getPresetPath(name)

  if (!fs.existsSync(presetPath)) {
    throw new Error(`Preset '${name}' not found`)
  }

  const content = fs.readFileSync(presetPath, 'utf-8')
  return JSON.parse(content) as WorkspacePreset
}

export function listPresets(): string[] {
  const presetsDir = getPresetsDir()
  const files = fs.readdirSync(presetsDir)

  return files
    .filter(f => f.endsWith('.json'))
    .map(f => path.basename(f, '.json'))
    .sort()
}

export function deletePreset(name: string): void {
  const presetPath = getPresetPath(name)

  if (!fs.existsSync(presetPath)) {
    throw new Error(`Preset '${name}' not found`)
  }

  fs.unlinkSync(presetPath)
}

export function presetExists(name: string): boolean {
  const presetPath = getPresetPath(name)
  return fs.existsSync(presetPath)
}
