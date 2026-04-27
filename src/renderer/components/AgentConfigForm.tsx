import React, { useState, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { AgentConfig } from '../../shared/types'
import { SkillBrowser } from './SkillBrowser'

export const ROLE_PRESETS = [
  { label: 'Orchestrator', value: 'orchestrator', hint: 'Coordinates agents, dispatches tasks, synthesizes results' },
  { label: 'Worker', value: 'worker', hint: 'Executes tasks assigned by the orchestrator' },
  { label: 'Researcher', value: 'researcher', hint: 'Gathers information, reads docs, explores codebases' },
  { label: 'Reviewer', value: 'reviewer', hint: 'Reviews code and work from other agents' },
  { label: 'Custom', value: '', hint: '' }
]

export const CLI_PRESETS = [
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

export const OPENCLAUDE_PROVIDERS: { label: string; url: string }[] = [
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

export interface AgentConfigFormValue {
  name: string
  cli: string
  customCli: string
  cwd: string
  role: string
  customRole: string
  ceoNotes: string
  shell: AgentConfig['shell']
  admin: boolean
  autoMode: boolean
  promptRegex: string
  model: string
  customModel: string
  providerUrl: string
  customProviderUrl: string
  selectedSkills: Array<{ id: string; name: string }>
  showAdvanced: boolean
}

export interface AgentConfigFormProps {
  value: AgentConfigFormValue
  onChange: Dispatch<SetStateAction<AgentConfigFormValue>>
  /** Inline error messages keyed by field name */
  errors?: Partial<Record<keyof AgentConfigFormValue, string>>
}

export function buildSubmitConfig(v: AgentConfigFormValue): Omit<AgentConfig, 'id'> {
  return {
    name: v.name.trim(),
    cli: v.cli || v.customCli.trim(),
    cwd: v.cwd.trim(),
    role: (v.role || v.customRole).trim(),
    ceoNotes: v.ceoNotes.trim(),
    shell: v.shell,
    admin: v.admin,
    autoMode: v.autoMode,
    promptRegex: v.promptRegex.trim() || undefined,
    model: (v.model || v.customModel.trim()) || undefined,
    providerUrl: v.cli === 'openclaude' ? (v.providerUrl || v.customProviderUrl.trim()) || undefined : undefined,
    experimental: v.cli === 'grok' ? true : undefined,
    skills: v.selectedSkills.length > 0 ? v.selectedSkills.map(s => s.id) : undefined,
  }
}

export function emptyFormValue(defaults?: Partial<AgentConfigFormValue>): AgentConfigFormValue {
  const isWindows = navigator.platform.toLowerCase().includes('win')
  return {
    name: '',
    cli: 'claude',
    customCli: '',
    cwd: '',
    role: 'worker',
    customRole: '',
    ceoNotes: '',
    shell: isWindows ? 'powershell' : 'bash',
    admin: false,
    autoMode: false,
    promptRegex: '',
    model: 'sonnet',
    customModel: '',
    providerUrl: 'https://api.openai.com/v1',
    customProviderUrl: '',
    selectedSkills: [],
    showAdvanced: false,
    ...defaults,
  }
}

export function AgentConfigForm({ value, onChange, errors }: AgentConfigFormProps): React.ReactElement {
  const [showSkillBrowser, setShowSkillBrowser] = useState(false)
  const isWindows = navigator.platform.toLowerCase().includes('win')
  const shellOptions = isWindows ? WINDOWS_SHELLS : POSIX_SHELLS

  const set = <K extends keyof AgentConfigFormValue>(key: K, v: AgentConfigFormValue[K]) => {
    onChange(prev => ({ ...prev, [key]: v }))
  }

  // Reset model + provider to defaults when CLI actually changes (not on mount)
  const prevCliRef = useRef(value.cli)
  useEffect(() => {
    if (prevCliRef.current !== value.cli) {
      prevCliRef.current = value.cli
      onChange(prev => ({
        ...prev,
        model: '',
        customModel: '',
        providerUrl: 'https://api.openai.com/v1',
        customProviderUrl: '',
      }))
    }
  }, [value.cli])

  // Keep shell valid when platform changes
  useEffect(() => {
    if (!shellOptions.includes(value.shell)) {
      set('shell', shellOptions[0])
    }
  }, [isWindows])

  return (
    <>
      <label style={labelStyle}>
        Name
        <input value={value.name} onChange={e => set('name', e.target.value)} required style={inputStyle} placeholder="worker-1" />
        {errors?.name && <span style={errorStyle}>{errors.name}</span>}
      </label>

      <label style={labelStyle}>
        CLI
        <select value={value.cli} onChange={e => set('cli', e.target.value)} style={inputStyle}>
          {CLI_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </label>

      {value.cli === '' && (
        <label style={labelStyle}>
          Custom Command
          <input value={value.customCli} onChange={e => set('customCli', e.target.value)} required style={inputStyle} placeholder="my-agent --flag" />
        </label>
      )}

      {CLI_MODELS[value.cli] && (
        <label style={labelStyle}>
          Model
          <select value={value.model} onChange={e => set('model', e.target.value)} style={inputStyle}>
            {CLI_MODELS[value.cli].map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
      )}

      {value.cli === 'grok' && (
        <div style={{ color: '#d0a85c', fontSize: '11px' }}>
          Experimental integration: community-maintained Grok CLI support may change underneath us.
        </div>
      )}

      {value.cli === 'openclaude' && (
        <label style={labelStyle}>
          Provider
          <select
            value={value.providerUrl}
            onChange={e => set('providerUrl', e.target.value)}
            style={inputStyle}
          >
            {OPENCLAUDE_PROVIDERS.map(p => (
              <option key={p.url} value={p.url}>{p.label}</option>
            ))}
          </select>
        </label>
      )}

      {value.cli === 'openclaude' && value.providerUrl === '' && (
        <label style={labelStyle}>
          Custom Provider URL
          <input
            value={value.customProviderUrl}
            onChange={e => set('customProviderUrl', e.target.value)}
            style={inputStyle}
            placeholder="https://api.example.com/v1"
            required
          />
        </label>
      )}

      {value.cli === 'openclaude' && value.model === '' && (
        <label style={labelStyle}>
          Custom Model Name
          <input
            value={value.customModel}
            onChange={e => set('customModel', e.target.value)}
            style={inputStyle}
            placeholder="e.g. gpt-4o-mini, codellama"
          />
        </label>
      )}

      <label style={labelStyle}>
        Working Directory
        <div style={{ display: 'flex', gap: '4px' }}>
          <input value={value.cwd} onChange={e => set('cwd', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <button
            type="button"
            onClick={() => window.electronAPI.browseDirectory(value.cwd).then(d => { if (d) set('cwd', d) })}
            style={{
              padding: '8px 12px', backgroundColor: '#2a2a2a', border: '1px solid #444',
              borderRadius: '4px', color: '#aaa', cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap'
            }}
          >
            Browse
          </button>
        </div>
        {errors?.cwd && <span style={errorStyle}>{errors.cwd}</span>}
      </label>

      <label style={labelStyle}>
        Role
        <select value={value.role} onChange={e => set('role', e.target.value)} style={inputStyle}>
          {ROLE_PRESETS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        {ROLE_PRESETS.find(r => r.value === value.role)?.hint && (
          <span style={{ color: '#555', fontSize: '11px' }}>{ROLE_PRESETS.find(r => r.value === value.role)?.hint}</span>
        )}
      </label>

      {value.role === '' && (
        <label style={labelStyle}>
          Custom Role
          <input value={value.customRole} onChange={e => set('customRole', e.target.value)} required style={inputStyle} placeholder="e.g. Monitor, Tester" />
        </label>
      )}

      <label style={labelStyle}>
        Skills (optional)
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', minHeight: '28px' }}>
          {value.selectedSkills.map(skill => (
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
                onClick={() => set('selectedSkills', value.selectedSkills.filter(s => s.id !== skill.id))}
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
          value={value.ceoNotes}
          onChange={e => set('ceoNotes', e.target.value)}
          style={{ ...inputStyle, height: '80px', resize: 'vertical' }}
          placeholder="Instructions for this agent..."
        />
      </label>

      <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
        <input type="checkbox" checked={value.autoMode} onChange={e => set('autoMode', e.target.checked)} />
        Auto-approve mode
        <span style={{ color: '#666', fontSize: '11px' }}>
          {value.cli === 'claude' ? '(--dangerously-skip-permissions)' :
           value.cli === 'openclaude' ? '(--dangerously-skip-permissions)' :
           value.cli === 'codex' ? '(--yolo)' :
           value.cli === 'kimi' ? '(--yolo)' :
           value.cli === 'gemini' ? '(--yolo)' :
           value.cli === 'copilot' ? '(--allow-all)' : '(auto-run)'}
        </span>
      </label>

      <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
        <input type="checkbox" checked={value.admin} onChange={e => set('admin', e.target.checked)} />
        Run as admin
      </label>

      <button
        type="button"
        onClick={() => set('showAdvanced', !value.showAdvanced)}
        style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', textAlign: 'left', fontSize: '12px' }}
      >
        {value.showAdvanced ? '\u25BC' : '\u25B6'} Advanced
      </button>

      {value.showAdvanced && (
        <>
          <label style={labelStyle}>
            Shell
            <select value={value.shell} onChange={e => set('shell', e.target.value as AgentConfig['shell'])} style={inputStyle}>
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
            <input value={value.promptRegex} onChange={e => set('promptRegex', e.target.value)} style={inputStyle} placeholder="[>❯]\\s*$" />
          </label>
        </>
      )}

      {showSkillBrowser && (
        <SkillBrowser
          selectedIds={value.selectedSkills.map(s => s.id)}
          onToggleSkill={(skill) => {
            const exists = value.selectedSkills.find(s => s.id === skill.id)
            if (exists) {
              set('selectedSkills', value.selectedSkills.filter(s => s.id !== skill.id))
            } else {
              set('selectedSkills', [...value.selectedSkills, { id: skill.id, name: skill.name }])
            }
          }}
          onClose={() => setShowSkillBrowser(false)}
        />
      )}
    </>
  )
}

const errorStyle: React.CSSProperties = {
  color: '#e55', fontSize: '11px', marginTop: '2px'
}

const labelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '4px',
  fontSize: '12px', color: '#aaa'
}

const inputStyle: React.CSSProperties = {
  backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '4px',
  padding: '8px', color: '#e0e0e0', fontSize: '13px', fontFamily: 'inherit'
}
