import React, { useState, useEffect } from 'react'
import type { AgentConfig } from '../../shared/types'
import { SkillBrowser } from './SkillBrowser'

interface SpawnDialogProps {
  onSpawn: (config: Omit<AgentConfig, 'id'>) => void
  onCancel: () => void
}

const ROLE_PRESETS = [
  { label: 'Orchestrator', value: 'orchestrator', hint: 'Coordinates agents, dispatches tasks, synthesizes results' },
  { label: 'Worker', value: 'worker', hint: 'Executes tasks assigned by the orchestrator' },
  { label: 'Researcher', value: 'researcher', hint: 'Gathers information, reads docs, explores codebases' },
  { label: 'Reviewer', value: 'reviewer', hint: 'Reviews code and work from other agents' },
  { label: 'Custom', value: '', hint: '' }
]

const CLI_PRESETS = [
  { label: 'Claude Code', value: 'claude' },
  { label: 'Codex CLI', value: 'codex' },
  { label: 'Kimi CLI', value: 'kimi' },
  { label: 'Gemini CLI', value: 'gemini' },
  { label: 'OpenClaude (Any Model)', value: 'openclaude' },
  { label: 'GitHub Copilot CLI', value: 'copilot' },
  { label: 'Grok CLI (Experimental)', value: 'grok' },
  { label: 'Plain Terminal', value: 'terminal' },
  { label: 'Custom', value: '' }
]

export const CLI_MODELS: Record<string, { label: string; value: string }[]> = {
  claude: [
    { label: 'Sonnet', value: 'sonnet' },
    { label: 'Opus', value: 'opus' },
    { label: 'Haiku', value: 'haiku' },
    { label: 'Opus [1M context]', value: 'opus[1m]' },
    { label: 'Sonnet [1M context]', value: 'sonnet[1m]' },
    { label: 'Default (no --model flag)', value: '' },
  ],
  codex: [
    { label: 'o4-mini (default)', value: '' },
    { label: 'GPT-5.4', value: 'gpt-5.4' },
    { label: 'GPT-5', value: 'gpt-5' },
    { label: 'o3', value: 'o3' },
    { label: 'o3-pro', value: 'o3-pro' },
    { label: 'GPT-4.1', value: 'gpt-4.1' },
    { label: 'GPT-4.1 mini', value: 'gpt-4.1-mini' },
  ],
  kimi: [
    { label: 'Default', value: '' },
    { label: 'Kimi K2.5', value: 'kimi-k2.5' },
    { label: 'Kimi K2 Thinking Turbo', value: 'kimi-k2-thinking-turbo' },
    { label: 'Moonshot v1 8K', value: 'moonshot-v1-8k' },
  ],
  gemini: [
    { label: 'Default', value: '' },
    { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
    { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
    { label: 'Gemini 2.0 Flash', value: 'gemini-2.0-flash' },
    { label: 'Gemini 2.0 Flash Thinking', value: 'gemini-2.0-flash-thinking' },
  ],
  copilot: [
    { label: 'Default (Copilot model)', value: '' },
    { label: 'GPT-5.4', value: 'gpt-5.4' },
    { label: 'GPT-5', value: 'gpt-5' },
    { label: 'GPT-4o', value: 'gpt-4o' },
    { label: 'o3', value: 'o3' },
    { label: 'o4-mini', value: 'o4-mini' },
  ],
  grok: [
    { label: 'Default', value: '' },
    { label: 'Grok 3', value: 'grok-3' },
    { label: 'Grok 3 Mini', value: 'grok-3-mini' },
    { label: 'Grok 2', value: 'grok-2' },
  ],
  openclaude: [
    // OpenAI
    { label: 'GPT-5.4', value: 'gpt-5.4' },
    { label: 'GPT-5', value: 'gpt-5' },
    { label: 'GPT-4o', value: 'gpt-4o' },
    { label: 'GPT-4.1', value: 'gpt-4.1' },
    { label: 'GPT-4.1 mini', value: 'gpt-4.1-mini' },
    { label: 'o3', value: 'o3' },
    { label: 'o3-pro', value: 'o3-pro' },
    { label: 'o4-mini', value: 'o4-mini' },
    // Google (via OpenRouter/OpenAI-compatible)
    { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
    { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
    // DeepSeek
    { label: 'DeepSeek V3', value: 'deepseek-chat' },
    { label: 'DeepSeek R1', value: 'deepseek-reasoner' },
    // Meta / Ollama
    { label: 'Llama 4 Scout (Ollama)', value: 'llama4-scout' },
    { label: 'Llama 4 Maverick (Ollama)', value: 'llama4-maverick' },
    { label: 'Llama 3.3 70B (Ollama)', value: 'llama3.3' },
    { label: 'Llama 3.1 8B (Ollama)', value: 'llama3.1:8b' },
    // Mistral
    { label: 'Mistral Large', value: 'mistral-large-latest' },
    { label: 'Codestral', value: 'codestral-latest' },
    // Qwen
    { label: 'Qwen 3 (Ollama)', value: 'qwen3' },
    { label: 'Qwen 2.5 Coder (Ollama)', value: 'qwen2.5-coder' },
    // Custom
    { label: 'Custom Model', value: '' },
  ],
}

const OPENCLAUDE_PROVIDERS: { label: string; url: string }[] = [
  { label: 'OpenAI', url: 'https://api.openai.com/v1' },
  { label: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { label: 'Together AI', url: 'https://api.together.xyz/v1' },
  { label: 'Groq', url: 'https://api.groq.com/openai/v1' },
  { label: 'Ollama (Local)', url: 'http://localhost:11434/v1' },
  { label: 'Custom URL', url: '' },
]

const WINDOWS_SHELLS: AgentConfig['shell'][] = ['powershell', 'cmd']
const POSIX_SHELLS: AgentConfig['shell'][] = ['bash', 'zsh', 'fish']

export function SpawnDialog({ onSpawn, onCancel }: SpawnDialogProps): React.ReactElement {
  const [name, setName] = useState('')
  const [cli, setCli] = useState('claude')
  const [customCli, setCustomCli] = useState('')
  const [cwd, setCwd] = useState('')
  const [role, setRole] = useState('worker')
  const [customRole, setCustomRole] = useState('')
  const [ceoNotes, setCeoNotes] = useState('')
  const isWindows = navigator.platform.toLowerCase().includes('win')
  const shellOptions = isWindows ? WINDOWS_SHELLS : POSIX_SHELLS
  const [shell, setShell] = useState<AgentConfig['shell']>(isWindows ? 'powershell' : 'bash')
  const [admin, setAdmin] = useState(false)
  const [autoMode, setAutoMode] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [promptRegex, setPromptRegex] = useState('')
  const [model, setModel] = useState('sonnet')
  const [customModel, setCustomModel] = useState('')
  const [providerUrl, setProviderUrl] = useState('https://api.openai.com/v1')
  const [customProviderUrl, setCustomProviderUrl] = useState('')
  const [selectedSkills, setSelectedSkills] = useState<Array<{ id: string; name: string }>>([])
  const [showSkillBrowser, setShowSkillBrowser] = useState(false)

  // Fetch cwd from main process (process.cwd is unavailable in renderer with contextIsolation)
  useEffect(() => {
    window.electronAPI.getCwd().then(setCwd)
  }, [])

  useEffect(() => {
    setShell(prev => shellOptions.includes(prev) ? prev : shellOptions[0])
  }, [isWindows])

  useEffect(() => {
    setModel('')
    setCustomModel('')
    setProviderUrl('https://api.openai.com/v1')
    setCustomProviderUrl('')
  }, [cli])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSpawn({
      name: name.trim(),
      cli: cli || customCli.trim(),
      cwd: cwd.trim(),
      role: (role || customRole).trim(),
      ceoNotes: ceoNotes.trim(),
      shell,
      admin,
      autoMode,
      promptRegex: promptRegex.trim() || undefined,
      model: (model || customModel.trim()) || undefined,
      providerUrl: cli === 'openclaude' ? (providerUrl || customProviderUrl.trim()) || undefined : undefined,
      experimental: cli === 'grok' ? true : undefined,
      skills: selectedSkills.length > 0 ? selectedSkills.map(s => s.id) : undefined,
    })
  }

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 99999
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          backgroundColor: '#1e1e1e',
          border: '1px solid #333',
          borderRadius: '8px',
          padding: '24px',
          width: '450px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}
      >
        <h2 style={{ margin: 0, fontSize: '16px', color: '#e0e0e0' }}>New Agent</h2>

        <label style={labelStyle}>
          Name
          <input value={name} onChange={e => setName(e.target.value)} required style={inputStyle} placeholder="worker-1" />
        </label>

        <label style={labelStyle}>
          CLI
          <select value={cli} onChange={e => setCli(e.target.value)} style={inputStyle}>
            {CLI_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>

        {cli === '' && (
          <label style={labelStyle}>
            Custom Command
            <input value={customCli} onChange={e => setCustomCli(e.target.value)} required style={inputStyle} placeholder="my-agent --flag" />
          </label>
        )}

        {CLI_MODELS[cli] && (
          <label style={labelStyle}>
            Model
            <select value={model} onChange={e => setModel(e.target.value)} style={inputStyle}>
              {CLI_MODELS[cli].map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
        )}

        {cli === 'grok' && (
          <div style={{ color: '#d0a85c', fontSize: '11px' }}>
            Experimental integration: community-maintained Grok CLI support may change underneath us.
          </div>
        )}

        {cli === 'openclaude' && (
          <label style={labelStyle}>
            Provider
            <select
              value={providerUrl}
              onChange={e => setProviderUrl(e.target.value)}
              style={inputStyle}
            >
              {OPENCLAUDE_PROVIDERS.map(p => (
                <option key={p.url} value={p.url}>{p.label}</option>
              ))}
            </select>
          </label>
        )}

        {cli === 'openclaude' && providerUrl === '' && (
          <label style={labelStyle}>
            Custom Provider URL
            <input
              value={customProviderUrl}
              onChange={e => setCustomProviderUrl(e.target.value)}
              style={inputStyle}
              placeholder="https://api.example.com/v1"
              required
            />
          </label>
        )}

        {cli === 'openclaude' && model === '' && (
          <label style={labelStyle}>
            Custom Model Name
            <input
              value={customModel}
              onChange={e => setCustomModel(e.target.value)}
              style={inputStyle}
              placeholder="e.g. gpt-4o-mini, codellama"
            />
          </label>
        )}

        <label style={labelStyle}>
          Working Directory
          <div style={{ display: 'flex', gap: '4px' }}>
            <input value={cwd} onChange={e => setCwd(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            <button
              type="button"
              onClick={() => window.electronAPI.browseDirectory(cwd).then(dir => { if (dir) setCwd(dir) })}
              style={{
                padding: '8px 12px', backgroundColor: '#2a2a2a', border: '1px solid #444',
                borderRadius: '4px', color: '#aaa', cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap'
              }}
            >
              Browse
            </button>
          </div>
        </label>

        <label style={labelStyle}>
          Role
          <select value={role} onChange={e => setRole(e.target.value)} style={inputStyle}>
            {ROLE_PRESETS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          {ROLE_PRESETS.find(r => r.value === role)?.hint && (
            <span style={{ color: '#555', fontSize: '11px' }}>{ROLE_PRESETS.find(r => r.value === role)?.hint}</span>
          )}
        </label>

        {role === '' && (
          <label style={labelStyle}>
            Custom Role
            <input value={customRole} onChange={e => setCustomRole(e.target.value)} required style={inputStyle} placeholder="e.g. Monitor, Tester" />
          </label>
        )}

        <label style={labelStyle}>
          Skills (optional)
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', minHeight: '28px' }}>
            {selectedSkills.map(skill => (
              <span key={skill.id} style={{
                padding: '2px 8px',
                backgroundColor: '#2d3a4d',
                border: '1px solid #4a6fa5',
                borderRadius: '12px',
                fontSize: '11px',
                color: '#8cb4e0',
                display: 'flex',
                alignItems: 'center',
                gap: '4px'
              }}>
                {skill.name}
                <span
                  onClick={() => setSelectedSkills(prev => prev.filter(s => s.id !== skill.id))}
                  style={{ cursor: 'pointer', color: '#666' }}
                >x</span>
              </span>
            ))}
            <button
              type="button"
              onClick={() => setShowSkillBrowser(true)}
              style={{
                padding: '2px 10px',
                backgroundColor: '#2a2a2a',
                border: '1px solid #444',
                borderRadius: '12px',
                fontSize: '11px',
                color: '#888',
                cursor: 'pointer'
              }}
            >+ Add Skills</button>
          </div>
        </label>

        <label style={labelStyle}>
          CEO Notes
          <textarea
            value={ceoNotes}
            onChange={e => setCeoNotes(e.target.value)}
            style={{ ...inputStyle, height: '80px', resize: 'vertical' }}
            placeholder="Instructions for this agent..."
          />
        </label>

        <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
          <input type="checkbox" checked={autoMode} onChange={e => setAutoMode(e.target.checked)} />
          Auto-approve mode
          <span style={{ color: '#666', fontSize: '11px' }}>
            {cli === 'claude' ? '(--dangerously-skip-permissions)' :
             cli === 'openclaude' ? '(--dangerously-skip-permissions)' :
             cli === 'codex' ? '(--yolo)' :
             cli === 'kimi' ? '(--yolo)' :
             cli === 'gemini' ? '(--yolo)' :
             cli === 'copilot' ? '(--allow-all)' : '(auto-run)'}
          </span>
        </label>

        <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
          <input type="checkbox" checked={admin} onChange={e => setAdmin(e.target.checked)} />
          Run as admin
        </label>

        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', textAlign: 'left', fontSize: '12px' }}
        >
          {showAdvanced ? '\u25BC' : '\u25B6'} Advanced
        </button>

        {showAdvanced && (
          <>
            <label style={labelStyle}>
              Shell
              <select value={shell} onChange={e => setShell(e.target.value as AgentConfig['shell'])} style={inputStyle}>
                {shellOptions.map(option => (
                  <option key={option} value={option}>
                    {option === 'powershell' ? 'PowerShell' :
                     option === 'cmd' ? 'Command Prompt (cmd)' :
                     option === 'bash' ? 'Bash' :
                     option === 'zsh' ? 'Zsh' : 'Fish'}
                  </option>
                ))}
              </select>
              <span style={{ color: '#555', fontSize: '11px' }}>
                {isWindows ? 'Use cmd if a CLI is not found in PowerShell' : 'Pick the shell that matches your local CLI setup'}
              </span>
            </label>
            <label style={labelStyle}>
              Prompt Regex Override
              <input value={promptRegex} onChange={e => setPromptRegex(e.target.value)} style={inputStyle} placeholder="[>❯]\\s*$" />
            </label>
          </>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
          <button type="button" onClick={onCancel} style={cancelBtnStyle}>Cancel</button>
          <button type="submit" disabled={!name.trim()} style={spawnBtnStyle}>Spawn</button>
        </div>

        {showSkillBrowser && (
          <SkillBrowser
            selectedIds={selectedSkills.map(s => s.id)}
            onToggleSkill={(skill) => {
              setSelectedSkills(prev => {
                const exists = prev.find(s => s.id === skill.id)
                if (exists) return prev.filter(s => s.id !== skill.id)
                return [...prev, { id: skill.id, name: skill.name }]
              })
            }}
            onClose={() => setShowSkillBrowser(false)}
          />
        )}
      </form>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '4px',
  fontSize: '12px', color: '#aaa'
}

const inputStyle: React.CSSProperties = {
  backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '4px',
  padding: '8px', color: '#e0e0e0', fontSize: '13px', fontFamily: 'inherit'
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 16px', backgroundColor: '#2a2a2a', border: '1px solid #444',
  borderRadius: '4px', color: '#aaa', cursor: 'pointer', fontSize: '13px'
}

const spawnBtnStyle: React.CSSProperties = {
  padding: '8px 16px', backgroundColor: '#2d5a2d', border: '1px solid #4caf50',
  borderRadius: '4px', color: '#4caf50', cursor: 'pointer', fontSize: '13px'
}
