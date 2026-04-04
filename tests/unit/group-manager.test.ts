import { describe, it, expect, beforeEach } from 'vitest'
import { GroupManager } from '../../src/main/hub/group-manager'

describe('GroupManager', () => {
  let gm: GroupManager

  beforeEach(() => {
    gm = new GroupManager()
  })

  describe('addLink', () => {
    it('creates a link between two agents', () => {
      gm.addLink('A', 'B')
      expect(gm.getLinks()).toHaveLength(1)
    })

    it('does not create duplicate links', () => {
      gm.addLink('A', 'B')
      gm.addLink('A', 'B')
      gm.addLink('B', 'A')
      expect(gm.getLinks()).toHaveLength(1)
    })

    it('auto-detects groups from connected components', () => {
      gm.addLink('A', 'B')
      gm.addLink('B', 'C')
      const groups = gm.getGroups()
      expect(groups).toHaveLength(1)
      expect(groups[0].members.sort()).toEqual(['A', 'B', 'C'])
    })

    it('creates separate groups for disconnected clusters', () => {
      gm.addLink('A', 'B')
      gm.addLink('C', 'D')
      const groups = gm.getGroups()
      expect(groups).toHaveLength(2)
    })
  })

  describe('removeLink', () => {
    it('removes a link', () => {
      gm.addLink('A', 'B')
      gm.removeLink('A', 'B')
      expect(gm.getLinks()).toHaveLength(0)
    })

    it('splits groups when a link is removed', () => {
      gm.addLink('A', 'B')
      gm.addLink('B', 'C')
      expect(gm.getGroups()).toHaveLength(1)
      gm.removeLink('A', 'B')
      const groups = gm.getGroups()
      expect(groups).toHaveLength(1)
      expect(groups[0].members.sort()).toEqual(['B', 'C'])
    })
  })

  describe('getGroupForAgent', () => {
    it('returns the group for a linked agent', () => {
      gm.addLink('A', 'B')
      const group = gm.getGroupForAgent('A')
      expect(group).not.toBeNull()
      expect(group!.members).toContain('A')
      expect(group!.members).toContain('B')
    })

    it('returns null for an unlinked agent', () => {
      expect(gm.getGroupForAgent('X')).toBeNull()
    })
  })

  describe('canCommunicate', () => {
    it('allows same-group agents', () => {
      gm.addLink('A', 'B')
      expect(gm.canCommunicate('A', 'B')).toBe(true)
    })

    it('blocks cross-group agents', () => {
      gm.addLink('A', 'B')
      gm.addLink('C', 'D')
      expect(gm.canCommunicate('A', 'C')).toBe(false)
    })

    it('allows unlinked agents to talk to anyone', () => {
      gm.addLink('A', 'B')
      expect(gm.canCommunicate('X', 'A')).toBe(true)
      expect(gm.canCommunicate('A', 'X')).toBe(true)
    })

    it('allows two unlinked agents to talk', () => {
      expect(gm.canCommunicate('X', 'Y')).toBe(true)
    })
  })

  describe('serialization', () => {
    it('exports and imports state', () => {
      gm.addLink('A', 'B')
      gm.addLink('C', 'D')
      const state = gm.exportState()
      const gm2 = new GroupManager()
      gm2.importState(state)
      expect(gm2.getLinks()).toHaveLength(2)
      expect(gm2.getGroups()).toHaveLength(2)
    })
  })
})
