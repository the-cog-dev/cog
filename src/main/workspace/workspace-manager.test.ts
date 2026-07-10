import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WorkspaceManager, DEFAULT_WORKSPACE_ID } from './workspace-manager'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('WorkspaceManager', () => {
  it('starts with a single default workspace', () => {
    const m = new WorkspaceManager(dir)
    expect(m.list()).toEqual([{ id: DEFAULT_WORKSPACE_ID, name: 'Workspace 1' }])
    expect(m.getActiveId()).toBe(DEFAULT_WORKSPACE_ID)
  })

  it('adds a folder-bound workspace and can switch to it', () => {
    const m = new WorkspaceManager(dir)
    const ws = m.add('Poke', 'F:/coding/PokeMMO', 'tab-poke')
    expect(ws.projectPath).toBe('F:/coding/PokeMMO')
    expect(m.setActive('tab-poke')).toBe(true)
    expect(m.getActive()?.name).toBe('Poke')
    expect(m.projectPathFor('tab-poke')).toBe('F:/coding/PokeMMO')
  })

  it('rebinds a folder and renames', () => {
    const m = new WorkspaceManager(dir)
    m.add('W', undefined, 'tab-w')
    expect(m.setProjectPath('tab-w', 'C:/x')).toBe(true)
    expect(m.projectPathFor('tab-w')).toBe('C:/x')
    expect(m.rename('tab-w', 'Renamed')).toBe(true)
    expect(m.get('tab-w')?.name).toBe('Renamed')
  })

  it('removes a workspace and re-points active, but never the last one', () => {
    const m = new WorkspaceManager(dir)
    m.add('A', undefined, 'tab-a')
    m.add('B', undefined, 'tab-b')
    m.setActive('tab-b')
    expect(m.remove('tab-b')).toBe('tab-a')          // active fell back to neighbour
    // remove down to one, then the last is protected
    m.remove('tab-a')
    const only = m.list()
    expect(only.length).toBe(1)
    const activeBefore = m.getActiveId()
    expect(m.remove(only[0].id)).toBe(activeBefore)   // no-op, still there
    expect(m.list().length).toBe(1)
  })

  it('persists across instances (folder binding + active + order)', () => {
    const m1 = new WorkspaceManager(dir)
    m1.add('Poke', 'F:/poke', 'tab-poke')
    m1.add('Web', 'F:/web', 'tab-web')
    m1.setActive('tab-web')

    const m2 = new WorkspaceManager(dir)
    expect(m2.list().map(w => w.id)).toEqual([DEFAULT_WORKSPACE_ID, 'tab-poke', 'tab-web'])
    expect(m2.getActiveId()).toBe('tab-web')
    expect(m2.projectPathFor('tab-poke')).toBe('F:/poke')
  })

  it('falls back to the first workspace when the persisted active id is stale', () => {
    fs.writeFileSync(
      path.join(dir, 'workspaces.json'),
      JSON.stringify({ workspaces: [{ id: 'tab-x', name: 'X' }], activeId: 'ghost' })
    )
    const m = new WorkspaceManager(dir)
    expect(m.getActiveId()).toBe('tab-x')
  })
})
