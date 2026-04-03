import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SkillManager } from '../../src/main/skills/skill-manager'
import type { Skill } from '../../src/shared/types'

describe('SkillManager', () => {
  let tmpDir: string
  let builtInDir: string
  let userDir: string
  let sm: SkillManager

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'))
    builtInDir = path.join(tmpDir, 'built-in')
    userDir = path.join(tmpDir, 'user')
    fs.mkdirSync(builtInDir, { recursive: true })
    fs.mkdirSync(userDir, { recursive: true })

    fs.writeFileSync(path.join(builtInDir, 'test-skill.json'), JSON.stringify({
      id: 'built-in:test-skill',
      name: 'Test Skill',
      description: 'A test skill',
      category: 'testing',
      source: 'built-in',
      prompt: 'You are a tester.',
      tags: ['test']
    }))

    sm = new SkillManager(builtInDir, userDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('listSkills', () => {
    it('loads built-in skills', () => {
      const skills = sm.listSkills()
      expect(skills.length).toBeGreaterThanOrEqual(1)
      expect(skills.find(s => s.id === 'built-in:test-skill')).toBeTruthy()
    })

    it('loads user skills alongside built-in', () => {
      sm.createSkill({ name: 'My Skill', description: 'Custom', category: 'custom', prompt: 'Do stuff', tags: ['custom'] })
      const skills = sm.listSkills()
      expect(skills.some(s => s.source === 'built-in')).toBe(true)
      expect(skills.some(s => s.source === 'user')).toBe(true)
    })
  })

  describe('getSkill', () => {
    it('finds built-in skill by ID', () => {
      const skill = sm.getSkill('built-in:test-skill')
      expect(skill).not.toBeNull()
      expect(skill!.name).toBe('Test Skill')
    })

    it('returns null for unknown ID', () => {
      expect(sm.getSkill('nonexistent')).toBeNull()
    })
  })

  describe('createSkill', () => {
    it('creates a user skill', () => {
      const skill = sm.createSkill({ name: 'Custom Skill', description: 'My custom skill', category: 'custom', prompt: 'Be custom', tags: ['mine'] })
      expect(skill.id).toMatch(/^user:/)
      expect(skill.source).toBe('user')
      expect(sm.getSkill(skill.id)).toBeTruthy()
    })
  })

  describe('updateSkill', () => {
    it('updates a user skill', () => {
      const skill = sm.createSkill({ name: 'Original', description: 'Before', category: 'test', prompt: 'Old prompt', tags: [] })
      const updated = sm.updateSkill(skill.id, { name: 'Updated', prompt: 'New prompt' })
      expect(updated).not.toBeNull()
      expect(updated!.name).toBe('Updated')
      expect(updated!.prompt).toBe('New prompt')
    })

    it('refuses to update built-in skills', () => {
      expect(sm.updateSkill('built-in:test-skill', { name: 'Hacked' })).toBeNull()
    })
  })

  describe('deleteSkill', () => {
    it('deletes a user skill', () => {
      const skill = sm.createSkill({ name: 'To Delete', description: 'Gone', category: 'test', prompt: 'Bye', tags: [] })
      expect(sm.deleteSkill(skill.id)).toBe(true)
      expect(sm.getSkill(skill.id)).toBeNull()
    })

    it('refuses to delete built-in skills', () => {
      expect(sm.deleteSkill('built-in:test-skill')).toBe(false)
    })
  })

  describe('resolveSkillPrompts', () => {
    it('returns combined prompt for skill IDs', () => {
      const skill = sm.createSkill({ name: 'Skill A', description: 'A', category: 'test', prompt: 'Do A things.', tags: [] })
      const result = sm.resolveSkillPrompts([skill.id, 'built-in:test-skill'])
      expect(result).toContain('Do A things.')
      expect(result).toContain('You are a tester.')
    })

    it('skips unknown skill IDs', () => {
      expect(sm.resolveSkillPrompts(['nonexistent'])).toBe('')
    })

    it('returns empty for no skills', () => {
      expect(sm.resolveSkillPrompts([])).toBe('')
    })
  })
})
