import * as fs from 'fs'
import * as path from 'path'
import { v4 as uuid } from 'uuid'
import type { Skill } from '../../shared/types'

export class SkillManager {
  constructor(
    private builtInDir: string,
    private userDir: string
  ) {
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true })
    }
  }

  listSkills(): Skill[] {
    return [...this.loadDir(this.builtInDir), ...this.loadDir(this.userDir)]
  }

  getSkill(id: string): Skill | null {
    return this.listSkills().find(s => s.id === id) ?? null
  }

  createSkill(input: { name: string; description: string; category: string; prompt: string; tags: string[] }): Skill {
    const skill: Skill = {
      id: `user:${uuid().slice(0, 8)}`,
      name: input.name,
      description: input.description,
      category: input.category,
      source: 'user',
      prompt: input.prompt,
      tags: input.tags
    }
    const filePath = path.join(this.userDir, `${skill.id.replace(':', '-')}.json`)
    fs.writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf-8')
    return skill
  }

  updateSkill(id: string, updates: Partial<Pick<Skill, 'name' | 'description' | 'category' | 'prompt' | 'tags'>>): Skill | null {
    if (id.startsWith('built-in:')) return null
    const filePath = this.findUserFile(id)
    if (!filePath) return null
    const skill: Skill = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    Object.assign(skill, updates)
    fs.writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf-8')
    return skill
  }

  deleteSkill(id: string): boolean {
    if (id.startsWith('built-in:')) return false
    const filePath = this.findUserFile(id)
    if (!filePath) return false
    fs.unlinkSync(filePath)
    return true
  }

  resolveSkillPrompts(skillIds: string[]): string {
    const prompts: string[] = []
    for (const id of skillIds) {
      const skill = this.getSkill(id)
      if (skill) prompts.push(skill.prompt)
    }
    return prompts.join('\n\n')
  }

  private loadDir(dir: string): Skill[] {
    if (!fs.existsSync(dir)) return []
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    const skills: Skill[] = []
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
        skills.push(data as Skill)
      } catch { /* skip corrupt files */ }
    }
    return skills
  }

  private findUserFile(id: string): string | null {
    const files = fs.readdirSync(this.userDir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.userDir, file), 'utf-8'))
        if (data.id === id) return path.join(this.userDir, file)
      } catch { /* skip */ }
    }
    return null
  }
}
