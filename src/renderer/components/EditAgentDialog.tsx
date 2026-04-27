import React, { useState, useEffect, useMemo } from 'react'
import type { AgentConfig, AgentState } from '../../shared/types'
import { AgentConfigForm, buildSubmitConfig, emptyFormValue, CLI_MODELS, OPENCLAUDE_PROVIDERS, type AgentConfigFormValue } from './AgentConfigForm'

interface EditAgentDialogProps {
  agent: AgentState
  onClose: () => void
}

function configToFormValue(agent: AgentConfig): AgentConfigFormValue {
  const isPresetCli = ['claude', 'codex', 'kimi', 'gemini', 'openclaude', 'copilot', 'grok', 'terminal'].includes(agent.cli)
  const isPresetRole = ['orchestrator', 'worker', 'researcher', 'reviewer'].includes(agent.role)

  // Model: route to customModel if not a preset for this CLI
  const modelValue = agent.model ?? ''
  const presetModels = CLI_MODELS[agent.cli] ?? []
  const isPresetModel = modelValue === '' || presetModels.some(m => m.value === modelValue)
  const formModel = isPresetModel ? modelValue : ''
  const formCustomModel = isPresetModel ? '' : modelValue

  // Provider URL: route to customProviderUrl if not a preset
  const providerValue = agent.providerUrl ?? 'https://api.openai.com/v1'
  const isPresetProvider = OPENCLAUDE_PROVIDERS.some(p => p.url === providerValue)
  const formProviderUrl = isPresetProvider ? providerValue : ''
  const formCustomProviderUrl = isPresetProvider ? '' : providerValue

  return {
    ...emptyFormValue(),
    name: agent.name,
    cli: isPresetCli ? agent.cli : '',
    customCli: isPresetCli ? '' : agent.cli,
    cwd: agent.cwd,
    role: isPresetRole ? agent.role : '',
    customRole: isPresetRole ? '' : agent.role,
    ceoNotes: agent.ceoNotes,
    shell: agent.shell,
    admin: agent.admin,
    autoMode: agent.autoMode,
    promptRegex: agent.promptRegex ?? '',
    model: formModel,
    customModel: formCustomModel,
    providerUrl: formProviderUrl,
    customProviderUrl: formCustomProviderUrl,
    selectedSkills: (agent.skills ?? []).map(id => ({ id, name: id })),  // names re-resolved below
    showAdvanced: !!agent.promptRegex,
  }
}

export function EditAgentDialog({ agent, onClose }: EditAgentDialogProps): React.ReactElement {
  const [form, setForm] = useState<AgentConfigFormValue>(() => configToFormValue(agent))
  const [errors, setErrors] = useState<Partial<Record<keyof AgentConfigFormValue, string>>>({})
  const [busyConfirm, setBusyConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const initialForm = useMemo(() => configToFormValue(agent), [agent.id])
  const isDirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(initialForm),
    [form, initialForm]
  )

  // Resolve skill names from IDs
  useEffect(() => {
    if (!agent.skills || agent.skills.length === 0) return
    window.electronAPI.listSkills().then((skills: any[]) => {
      const named = agent.skills!.map(id => {
        const found = skills.find(s => s.id === id)
        return { id, name: found?.name ?? id }
      })
      setForm(prev => ({ ...prev, selectedSkills: named }))
    })
  }, [agent.id])

  const performRespawn = async () => {
    setSubmitting(true)
    setErrors({})
    try {
      const newConfig = buildSubmitConfig(form)
      const result = await window.electronAPI.respawnAgent(agent.id, newConfig)
      if (result.ok) {
        onClose()
      } else {
        const next: Partial<Record<keyof AgentConfigFormValue, string>> = {}
        if (result.error === 'NAME_TAKEN') next.name = 'An agent with this name already exists'
        else if (result.error === 'CWD_MISSING') next.cwd = 'Directory does not exist'
        else next.name = result.message ?? 'Could not respawn agent'
        setErrors(next)
      }
    } catch (err) {
      setErrors({ name: (err as Error).message })
    } finally {
      setSubmitting(false)
      setBusyConfirm(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isDirty) { onClose(); return }
    if (agent.status === 'working') {
      setBusyConfirm(true)
      return
    }
    void performRespawn()
  }

  const handleCancel = () => {
    if (!isDirty) { onClose(); return }
    if (window.confirm('Discard changes?')) onClose()
  }

  return (
    <div style={overlayStyle}>
      <form onSubmit={handleSubmit} style={formStyle}>
        <h2 style={{ margin: 0, fontSize: '16px', color: '#e0e0e0' }}>
          Edit Agent — <span style={{ color: '#888' }}>{agent.name}</span>
        </h2>
        <AgentConfigForm value={form} onChange={setForm} errors={errors} />
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
          <button type="button" onClick={handleCancel} style={cancelBtnStyle} disabled={submitting}>Cancel</button>
          <button type="submit" disabled={!form.name.trim() || submitting} style={saveBtnStyle}>
            {submitting ? 'Respawning…' : 'Save & Respawn'}
          </button>
        </div>

        {busyConfirm && (
          <div style={busyConfirmStyle}>
            <div style={{ fontSize: '13px', color: '#e0e0e0', marginBottom: '8px' }}>
              Agent is busy — kill and respawn anyway?
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setBusyConfirm(false)} style={cancelBtnStyle}>Cancel</button>
              <button type="button" onClick={() => void performRespawn()} style={saveBtnStyle}>Kill and respawn</button>
            </div>
          </div>
        )}
      </form>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  backgroundColor: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 99999
}

const formStyle: React.CSSProperties = {
  backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
  padding: '24px', width: '450px', display: 'flex', flexDirection: 'column', gap: '12px',
  position: 'relative'
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 16px', backgroundColor: '#2a2a2a', border: '1px solid #444',
  borderRadius: '4px', color: '#aaa', cursor: 'pointer', fontSize: '13px'
}

const saveBtnStyle: React.CSSProperties = {
  padding: '8px 16px', backgroundColor: '#2d4a5a', border: '1px solid #4c8aaf',
  borderRadius: '4px', color: '#8cc4e0', cursor: 'pointer', fontSize: '13px'
}

const busyConfirmStyle: React.CSSProperties = {
  position: 'absolute', inset: '50% 24px auto 24px',
  transform: 'translateY(-50%)',
  backgroundColor: '#2a1e1e', border: '1px solid #6c3030', borderRadius: '6px',
  padding: '16px', boxShadow: '0 8px 24px rgba(0,0,0,0.6)'
}
