import React, { useState, useEffect } from 'react'
import type { Skill } from '../../shared/types'

interface SkillBrowserProps {
  selectedIds: string[]
  onToggleSkill: (skill: Skill) => void
  onClose: () => void
}

const CATEGORIES = ['All', 'coding', 'security', 'research', 'workflow', 'language', 'custom']

type Tab = 'built-in' | 'my-skills' | 'community'

export function SkillBrowser({ selectedIds, onToggleSkill, onClose }: SkillBrowserProps): React.ReactElement {
  const [skills, setSkills] = useState<Skill[]>([])
  const [activeTab, setActiveTab] = useState<Tab>('built-in')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newSkill, setNewSkill] = useState({ name: '', description: '', category: 'custom', prompt: '', tags: '' })

  useEffect(() => {
    window.electronAPI.listSkills().then(setSkills)
  }, [])

  const filteredSkills = skills.filter(s => {
    if (activeTab === 'built-in' && s.source !== 'built-in') return false
    if (activeTab === 'my-skills' && s.source !== 'user' && s.source !== 'community') return false
    if (activeTab === 'community') return false
    if (search) {
      const q = search.toLowerCase()
      if (!s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q) && !s.tags.some(t => t.toLowerCase().includes(q))) return false
    }
    if (category !== 'All' && s.category !== category) return false
    return true
  })

  const handleCreate = async () => {
    if (!newSkill.name || !newSkill.prompt) return
    const created = await window.electronAPI.createSkill({
      name: newSkill.name,
      description: newSkill.description,
      category: newSkill.category,
      prompt: newSkill.prompt,
      tags: newSkill.tags.split(',').map(t => t.trim()).filter(Boolean)
    })
    setSkills(prev => [...prev, created])
    setShowCreateForm(false)
    setNewSkill({ name: '', description: '', category: 'custom', prompt: '', tags: '' })
  }

  const handleDelete = async (id: string) => {
    await window.electronAPI.deleteSkill(id)
    setSkills(prev => prev.filter(s => s.id !== id))
  }

  const inputStyle: React.CSSProperties = {
    backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '4px',
    padding: '6px 8px', color: '#e0e0e0', fontSize: '12px', fontFamily: 'inherit'
  }

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100001
    }}>
      <div style={{
        backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px',
        padding: '24px', width: '550px', maxHeight: '600px',
        display: 'flex', flexDirection: 'column', gap: '12px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '16px', color: '#e0e0e0' }}>Skills Browser</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#666', fontSize: '24px', cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}>x</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid #333', paddingBottom: '8px' }}>
          {(['built-in', 'my-skills', 'community'] as Tab[]).map(tab => (
            <button key={tab} onClick={() => { setActiveTab(tab); setSearch(''); setCategory('All') }} style={{
              flex: 1, padding: '6px 12px', fontSize: '12px', borderRadius: '4px', cursor: 'pointer',
              border: activeTab === tab ? '1px solid #555' : '1px solid #444',
              backgroundColor: activeTab === tab ? '#3a3a3a' : '#2a2a2a',
              color: activeTab === tab ? '#e0e0e0' : '#888',
              fontWeight: activeTab === tab ? 'bold' : 'normal'
            }}>
              {tab === 'built-in' ? 'Built-in' : tab === 'my-skills' ? 'My Skills' : 'Community'}
            </button>
          ))}
        </div>

        {/* Search + Category (non-community tabs) */}
        {activeTab !== 'community' && (
          <>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search skills..." style={{ ...inputStyle, padding: '8px' }} />
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {CATEGORIES.map(cat => (
                <button key={cat} onClick={() => setCategory(cat)} style={{
                  padding: '3px 8px', fontSize: '10px', borderRadius: '10px', cursor: 'pointer',
                  border: category === cat ? '1px solid #4a9eff' : '1px solid #444',
                  backgroundColor: category === cat ? '#1e3a5f' : '#2a2a2a',
                  color: category === cat ? '#8cc4ff' : '#888'
                }}>{cat}</button>
              ))}
            </div>
          </>
        )}

        {/* Skill List */}
        {activeTab !== 'community' && (
          <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '300px' }}>
            {filteredSkills.length === 0 ? (
              <div style={{ color: '#555', textAlign: 'center', padding: '20px 0' }}>
                {activeTab === 'my-skills' ? 'No custom skills yet. Create one below.' : 'No skills match your search.'}
              </div>
            ) : filteredSkills.map(skill => (
              <div key={skill.id} style={{
                padding: '8px 10px', borderRadius: '4px',
                border: selectedIds.includes(skill.id) ? '1px solid #4a9eff' : '1px solid #333',
                backgroundColor: selectedIds.includes(skill.id) ? '#1e3a5f' : '#252525'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                     onClick={() => setExpandedId(expandedId === skill.id ? null : skill.id)}>
                  <div>
                    <span style={{ fontSize: '13px', color: '#e0e0e0' }}>{skill.name}</span>
                    <span style={{ fontSize: '10px', color: '#666', marginLeft: '8px' }}>{skill.category}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {skill.source !== 'built-in' && (
                      <button onClick={(e) => { e.stopPropagation(); handleDelete(skill.id) }} style={{
                        background: 'none', border: 'none', color: '#666', fontSize: '12px', cursor: 'pointer'
                      }}>del</button>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); onToggleSkill(skill) }} style={{
                      padding: '2px 8px', fontSize: '10px', borderRadius: '4px', cursor: 'pointer',
                      border: selectedIds.includes(skill.id) ? '1px solid #f44336' : '1px solid #4caf50',
                      backgroundColor: 'transparent',
                      color: selectedIds.includes(skill.id) ? '#f44336' : '#4caf50'
                    }}>{selectedIds.includes(skill.id) ? 'Remove' : 'Attach'}</button>
                  </div>
                </div>
                <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>{skill.description}</div>
                {expandedId === skill.id && (
                  <pre style={{
                    marginTop: '8px', padding: '8px', backgroundColor: '#1a1a1a', borderRadius: '4px',
                    fontSize: '11px', color: '#aaa', whiteSpace: 'pre-wrap', maxHeight: '120px', overflow: 'auto'
                  }}>{skill.prompt}</pre>
                )}
              </div>
            ))}
          </div>
        )}

        {/* My Skills: Create button */}
        {activeTab === 'my-skills' && !showCreateForm && (
          <button onClick={() => setShowCreateForm(true)} style={{
            padding: '8px', backgroundColor: '#2d5a2d', border: '1px solid #4caf50',
            borderRadius: '4px', color: '#4caf50', cursor: 'pointer', fontSize: '12px'
          }}>+ Create Skill</button>
        )}

        {/* Create Skill Form */}
        {activeTab === 'my-skills' && showCreateForm && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px', backgroundColor: '#252525', borderRadius: '4px' }}>
            <input value={newSkill.name} onChange={e => setNewSkill(p => ({ ...p, name: e.target.value }))}
              placeholder="Skill name" style={inputStyle} />
            <input value={newSkill.description} onChange={e => setNewSkill(p => ({ ...p, description: e.target.value }))}
              placeholder="Description" style={inputStyle} />
            <select value={newSkill.category} onChange={e => setNewSkill(p => ({ ...p, category: e.target.value }))}
              style={inputStyle}>
              {CATEGORIES.filter(c => c !== 'All').map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <textarea value={newSkill.prompt} onChange={e => setNewSkill(p => ({ ...p, prompt: e.target.value }))}
              placeholder="Skill prompt (instructions for the agent)" rows={4}
              style={{ ...inputStyle, resize: 'vertical' }} />
            <input value={newSkill.tags} onChange={e => setNewSkill(p => ({ ...p, tags: e.target.value }))}
              placeholder="Tags (comma-separated)" style={inputStyle} />
            <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowCreateForm(false)} style={{
                padding: '4px 12px', backgroundColor: '#2a2a2a', border: '1px solid #444',
                borderRadius: '4px', color: '#888', cursor: 'pointer', fontSize: '11px'
              }}>Cancel</button>
              <button onClick={handleCreate} disabled={!newSkill.name || !newSkill.prompt} style={{
                padding: '4px 12px', backgroundColor: '#2d5a2d', border: '1px solid #4caf50',
                borderRadius: '4px', color: '#4caf50', cursor: 'pointer', fontSize: '11px'
              }}>Save</button>
            </div>
          </div>
        )}

        {/* Community Tab */}
        {activeTab === 'community' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '20px 0' }}>
            <div style={{ color: '#888', fontSize: '13px', textAlign: 'center' }}>
              Browse 90,000+ community skills on skills.sh
            </div>
            <button onClick={() => window.open('https://skills.sh', '_blank')} style={{
              padding: '10px 20px', backgroundColor: '#1e3a5f', border: '1px solid #4a9eff',
              borderRadius: '6px', color: '#8cc4ff', cursor: 'pointer', fontSize: '13px'
            }}>
              Open skills.sh
            </button>
            <div style={{ color: '#555', fontSize: '11px', textAlign: 'center', maxWidth: '350px' }}>
              Find a skill you like, then create it in "My Skills" with the prompt content.
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #333', paddingTop: '8px' }}>
          <span style={{ fontSize: '11px', color: '#666' }}>
            {selectedIds.length} skill{selectedIds.length !== 1 ? 's' : ''} attached
          </span>
          <button onClick={onClose} style={{
            padding: '6px 16px', backgroundColor: '#2a4a5a', border: '1px solid #4a9eff',
            borderRadius: '4px', color: '#4a9eff', cursor: 'pointer', fontSize: '12px'
          }}>Done</button>
        </div>
      </div>
    </div>
  )
}
