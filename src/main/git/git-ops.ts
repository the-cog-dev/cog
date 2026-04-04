import { execSync } from 'child_process'
import type { GitStatus, GitFileStatus, GitLogEntry } from '../../shared/types'

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd, encoding: 'utf-8', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

function parseStatusLine(line: string): { status: GitFileStatus['status']; path: string; staged: boolean } | null {
  if (line.length < 4) return null
  const x = line[0]
  const y = line[1]
  const filePath = line.slice(3).trim()

  if (x !== ' ' && x !== '?') {
    const status = x === 'A' ? 'added' : x === 'D' ? 'deleted' : x === 'R' ? 'renamed' : 'modified'
    return { status, path: filePath, staged: true }
  }
  if (y !== ' ') {
    const status = y === '?' ? 'added' : y === 'D' ? 'deleted' : 'modified'
    return { status, path: filePath, staged: false }
  }
  return null
}

export function getStatus(cwd: string): GitStatus {
  if (!isGitRepo(cwd)) {
    return { branch: '', ahead: 0, behind: 0, staged: [], unstaged: [], isRepo: false }
  }

  const branch = run('git branch --show-current', cwd) || 'HEAD'

  let ahead = 0, behind = 0
  const counts = run('git rev-list --left-right --count HEAD...@{upstream}', cwd)
  if (counts) {
    const parts = counts.split('\t')
    ahead = parseInt(parts[0]) || 0
    behind = parseInt(parts[1]) || 0
  }

  const statusOutput = run('git status --porcelain', cwd)
  const staged: GitFileStatus[] = []
  const unstaged: GitFileStatus[] = []

  for (const line of statusOutput.split('\n')) {
    if (!line.trim()) continue
    const parsed = parseStatusLine(line)
    if (!parsed) continue
    if (parsed.staged) {
      staged.push({ path: parsed.path, status: parsed.status, staged: true })
    } else {
      unstaged.push({ path: parsed.path, status: parsed.status, staged: false })
    }
  }

  return { branch, ahead, behind, staged, unstaged, isRepo: true }
}

export function getLog(cwd: string, count = 20): GitLogEntry[] {
  const output = run(`git log --pretty=format:"%h|||%s|||%an|||%ar" -${count}`, cwd)
  if (!output) return []

  return output.split('\n').filter(Boolean).map(line => {
    const [sha, message, author, relativeDate] = line.split('|||')
    return { sha, message, author, relativeDate }
  })
}

export function getDiff(cwd: string, file: string, staged: boolean): string {
  const flag = staged ? '--cached ' : ''
  return run(`git diff ${flag}-- "${file}"`, cwd)
}

export function stageFile(cwd: string, file: string): void {
  execSync(`git add "${file}"`, { cwd, encoding: 'utf-8', timeout: 5000 })
}

export function unstageFile(cwd: string, file: string): void {
  execSync(`git reset HEAD -- "${file}"`, { cwd, encoding: 'utf-8', timeout: 5000 })
}

export function commit(cwd: string, message: string): string {
  return execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd, encoding: 'utf-8', timeout: 10000 }).trim()
}

export function push(cwd: string): string {
  return execSync('git push', { cwd, encoding: 'utf-8', timeout: 30000 }).trim()
}

export function pull(cwd: string): string {
  return execSync('git pull', { cwd, encoding: 'utf-8', timeout: 30000 }).trim()
}

export function getBranches(cwd: string): { current: string; branches: string[] } {
  const output = run('git branch', cwd)
  const branches: string[] = []
  let current = ''
  for (const line of output.split('\n')) {
    const name = line.replace(/^\*?\s+/, '').trim()
    if (!name) continue
    branches.push(name)
    if (line.startsWith('*')) current = name
  }
  return { current, branches }
}

export function checkout(cwd: string, branch: string): void {
  execSync(`git checkout "${branch}"`, { cwd, encoding: 'utf-8', timeout: 10000 })
}

export function createBranch(cwd: string, name: string): void {
  execSync(`git checkout -b "${name}"`, { cwd, encoding: 'utf-8', timeout: 10000 })
}
