import React, { useState, useEffect } from 'react'
import type { AgentConfig, AgentState, WorkspacePreset, WindowPosition, CanvasState } from '../../shared/types'
import type { WindowState } from '../hooks/useWindowManager'

interface PresetDialogProps {
  agents: AgentState[]
  windows: WindowState[]
  zoom: number
  pan: { x: number; y: number }
  onLoadPreset: (configs: Omit<AgentConfig, 'id'>[], windows: WindowPosition[], canvas: CanvasState) => void
  onClose: () => void
}

interface PresetInfo {
  name: string
  savedAt: string
}

type Tab = 'save' | 'load' | 'templates'

interface PresetTemplate {
  name: string
  description: string
  requiredClis: string[]
  agents: Omit<AgentConfig, 'id' | 'cwd'>[]
}

const BUILT_IN_TEMPLATES: PresetTemplate[] = [
  {
    name: 'Orchestrator + Workers',
    description: '1 orchestrator (Opus) directing 2 workers (Sonnet). Classic delegation pattern.',
    requiredClis: ['claude'],
    agents: [
      { name: 'orchestrator', cli: 'claude', role: 'orchestrator', ceoNotes: 'You are the lead. Break tasks into subtasks and delegate to workers. Synthesize their results. Use post_task() and send_message() to coordinate.', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
      { name: 'worker-1', cli: 'claude', role: 'worker', ceoNotes: 'You are a worker. Check read_tasks() and get_messages() for assignments. Complete tasks and report back to the orchestrator.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
      { name: 'worker-2', cli: 'claude', role: 'worker', ceoNotes: 'You are a worker. Check read_tasks() and get_messages() for assignments. Complete tasks and report back to the orchestrator.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
    ]
  },
  {
    name: 'Research Squad',
    description: '1 orchestrator + 3 researchers. Deep research with parallel information gathering.',
    requiredClis: ['claude'],
    agents: [
      { name: 'lead', cli: 'claude', role: 'orchestrator', ceoNotes: 'You coordinate a research team. Break research questions into sub-questions. Assign to researchers via post_task(). Synthesize findings posted to the info channel.', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
      { name: 'researcher-1', cli: 'claude', role: 'researcher', ceoNotes: 'You are a researcher. Check read_tasks() for research assignments. Post findings to post_info() with relevant tags.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
      { name: 'researcher-2', cli: 'claude', role: 'researcher', ceoNotes: 'You are a researcher. Check read_tasks() for research assignments. Post findings to post_info() with relevant tags.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
      { name: 'researcher-3', cli: 'claude', role: 'researcher', ceoNotes: 'You are a researcher. Check read_tasks() for research assignments. Post findings to post_info() with relevant tags.', shell: 'powershell', admin: false, autoMode: true, model: 'haiku' },
    ]
  },
  {
    name: 'Code + Review',
    description: '1 coder + 1 reviewer. Continuous code review workflow.',
    requiredClis: ['claude'],
    agents: [
      { name: 'coder', cli: 'claude', role: 'worker', ceoNotes: 'You write code. After completing each change, send_message() to the reviewer with a summary of what changed and why.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
      { name: 'reviewer', cli: 'claude', role: 'reviewer', ceoNotes: 'You review code. When the coder messages you, use get_agent_output() to see their terminal, review the changes, and send_message() back with feedback.', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
    ]
  },
  {
    name: 'Speed Swarm',
    description: '3 Haiku agents for maximum throughput on simple parallel tasks.',
    requiredClis: ['claude'],
    agents: [
      { name: 'swarm-1', cli: 'claude', role: 'worker', ceoNotes: 'You are a fast worker. Check read_tasks() for assignments. Complete them quickly and move to the next.', shell: 'powershell', admin: false, autoMode: true, model: 'haiku' },
      { name: 'swarm-2', cli: 'claude', role: 'worker', ceoNotes: 'You are a fast worker. Check read_tasks() for assignments. Complete them quickly and move to the next.', shell: 'powershell', admin: false, autoMode: true, model: 'haiku' },
      { name: 'swarm-3', cli: 'claude', role: 'worker', ceoNotes: 'You are a fast worker. Check read_tasks() for assignments. Complete them quickly and move to the next.', shell: 'powershell', admin: false, autoMode: true, model: 'haiku' },
    ]
  },
  {
    name: 'Solo Opus',
    description: '1 Opus agent. Full power, no coordination overhead.',
    requiredClis: ['claude'],
    agents: [
      { name: 'agent', cli: 'claude', role: 'worker', ceoNotes: 'You are a solo agent. Check read_tasks() and get_messages() for work. You have full autonomy to plan and execute.', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
    ]
  },
  {
    name: 'TDD Pipeline',
    description: '1 coder + 1 tester + 1 reviewer. Red-green-refactor workflow.',
    requiredClis: ['claude'],
    agents: [
      { name: 'coder', cli: 'claude', role: 'worker', ceoNotes: 'You implement features. Wait for test specs from the tester before writing code. After implementing, send_message() to the reviewer.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
      { name: 'tester', cli: 'claude', role: 'worker', ceoNotes: 'You write tests FIRST. When a task is posted, write failing tests that define the expected behavior, then send_message() to the coder with the test file path.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
      { name: 'reviewer', cli: 'claude', role: 'reviewer', ceoNotes: 'You review completed work. When the coder messages you, review both tests and implementation. send_message() back with feedback.', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
    ]
  },
  {
    name: 'Documentation Team',
    description: '1 researcher + 1 writer + 1 reviewer. Produce polished documentation.',
    requiredClis: ['claude'],
    agents: [
      { name: 'researcher', cli: 'claude', role: 'researcher', ceoNotes: 'You gather information for documentation. Read source code, existing docs, and tests. Post findings to post_info() with tags.', shell: 'powershell', admin: false, autoMode: true, model: 'haiku' },
      { name: 'writer', cli: 'claude', role: 'worker', ceoNotes: 'You write documentation. Use read_info() to access research findings. send_message() to the reviewer when a section is complete.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
      { name: 'reviewer', cli: 'claude', role: 'reviewer', ceoNotes: 'You review documentation for accuracy, clarity, and completeness. send_message() back with feedback.', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
    ]
  },
  {
    name: 'Rapid Prototyper',
    description: '1 architect (Opus) + 2 builders (Sonnet). Architecture-first rapid development.',
    requiredClis: ['claude'],
    agents: [
      { name: 'architect', cli: 'claude', role: 'orchestrator', ceoNotes: 'You design the architecture first. Post the design to post_info() with tag "architecture". Then break implementation into tasks via post_task().', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
      { name: 'builder-1', cli: 'claude', role: 'worker', ceoNotes: 'You build what the architect designs. Check read_info() for architecture specs, then read_tasks() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
      { name: 'builder-2', cli: 'claude', role: 'worker', ceoNotes: 'You build what the architect designs. Check read_info() for architecture specs, then read_tasks() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
    ]
  },
  {
    name: 'Claude + Codex',
    description: 'Claude Opus orchestrates, Codex o4-mini implements. Best of both ecosystems.',
    requiredClis: ['claude', 'codex'],
    agents: [
      { name: 'lead', cli: 'claude', role: 'orchestrator', ceoNotes: 'You orchestrate. Break tasks down and delegate to the coder via post_task() and send_message().', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
      { name: 'coder', cli: 'codex', role: 'worker', ceoNotes: 'You implement code. Check read_tasks() and get_messages() for assignments from the lead.', shell: 'powershell', admin: false, autoMode: true, model: '' },
    ]
  },
  {
    name: 'Claude + Kimi',
    description: 'Claude plans and coordinates, Kimi researches. Dual-brain research team.',
    requiredClis: ['claude', 'kimi'],
    agents: [
      { name: 'planner', cli: 'claude', role: 'orchestrator', ceoNotes: 'You plan research strategy. Break questions into sub-questions. Delegate to the researcher via post_task().', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
      { name: 'researcher', cli: 'kimi', role: 'researcher', ceoNotes: 'You research deeply. Check read_tasks() for assignments. Post findings to post_info().', shell: 'powershell', admin: false, autoMode: true, model: '' },
    ]
  },
  {
    name: 'Claude + Gemini',
    description: 'Claude orchestrates, Gemini 2.5 Pro researches. Google knowledge + Anthropic reasoning.',
    requiredClis: ['claude', 'gemini'],
    agents: [
      { name: 'lead', cli: 'claude', role: 'orchestrator', ceoNotes: 'You coordinate. Delegate research tasks to the researcher. Synthesize findings.', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
      { name: 'researcher', cli: 'gemini', role: 'researcher', ceoNotes: 'You research using your broad knowledge. Check read_tasks() for assignments. Post findings to post_info().', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-pro' },
    ]
  },
  {
    name: 'GPT-4o + DeepSeek',
    description: 'GPT-4o orchestrator, DeepSeek coder. Cost-optimized multi-model team.',
    requiredClis: ['openclaude'],
    agents: [
      { name: 'lead', cli: 'openclaude', role: 'orchestrator', ceoNotes: 'You orchestrate the team. Break tasks down and delegate.', shell: 'powershell', admin: false, autoMode: true, model: 'gpt-4o', providerUrl: 'https://api.openai.com/v1' },
      { name: 'coder', cli: 'openclaude', role: 'worker', ceoNotes: 'You implement code. Check read_tasks() and get_messages() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: 'deepseek-chat', providerUrl: 'https://api.deepseek.com/v1' },
    ]
  },
  {
    name: 'Full OpenAI',
    description: 'GPT-4o lead + 2 GPT-4.1 workers. All OpenAI, maximum compatibility.',
    requiredClis: ['openclaude'],
    agents: [
      { name: 'lead', cli: 'openclaude', role: 'orchestrator', ceoNotes: 'You orchestrate. Break tasks down and delegate to workers.', shell: 'powershell', admin: false, autoMode: true, model: 'gpt-4o', providerUrl: 'https://api.openai.com/v1' },
      { name: 'worker-1', cli: 'openclaude', role: 'worker', ceoNotes: 'You implement. Check read_tasks() and get_messages() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: 'gpt-4.1', providerUrl: 'https://api.openai.com/v1' },
      { name: 'worker-2', cli: 'openclaude', role: 'worker', ceoNotes: 'You implement. Check read_tasks() and get_messages() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: 'gpt-4.1', providerUrl: 'https://api.openai.com/v1' },
    ]
  },
  {
    name: 'DeepSeek Squad',
    description: '3 DeepSeek agents. Cheapest possible multi-agent team.',
    requiredClis: ['openclaude'],
    agents: [
      { name: 'lead', cli: 'openclaude', role: 'orchestrator', ceoNotes: 'You coordinate. Break tasks and delegate.', shell: 'powershell', admin: false, autoMode: true, model: 'deepseek-chat', providerUrl: 'https://api.deepseek.com/v1' },
      { name: 'worker-1', cli: 'openclaude', role: 'worker', ceoNotes: 'Check read_tasks() and get_messages() for work.', shell: 'powershell', admin: false, autoMode: true, model: 'deepseek-chat', providerUrl: 'https://api.deepseek.com/v1' },
      { name: 'worker-2', cli: 'openclaude', role: 'worker', ceoNotes: 'Check read_tasks() and get_messages() for work.', shell: 'powershell', admin: false, autoMode: true, model: 'deepseek-chat', providerUrl: 'https://api.deepseek.com/v1' },
    ]
  },
  {
    name: 'Mixed Provider',
    description: 'GPT-4o lead + DeepSeek coder + Claude reviewer. Best of three worlds.',
    requiredClis: ['openclaude', 'claude'],
    agents: [
      { name: 'lead', cli: 'openclaude', role: 'orchestrator', ceoNotes: 'You orchestrate. Delegate coding to the coder, review requests to the reviewer.', shell: 'powershell', admin: false, autoMode: true, model: 'gpt-4o', providerUrl: 'https://api.openai.com/v1' },
      { name: 'coder', cli: 'openclaude', role: 'worker', ceoNotes: 'You implement code. Check read_tasks() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: 'deepseek-chat', providerUrl: 'https://api.deepseek.com/v1' },
      { name: 'reviewer', cli: 'claude', role: 'reviewer', ceoNotes: 'You review code. Use get_agent_output() to inspect work. send_message() back with feedback.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
    ]
  },
  {
    name: 'OpenRouter Mix',
    description: 'Via OpenRouter: access multiple models with a single API key.',
    requiredClis: ['openclaude'],
    agents: [
      { name: 'lead', cli: 'openclaude', role: 'orchestrator', ceoNotes: 'You orchestrate. Delegate tasks.', shell: 'powershell', admin: false, autoMode: true, model: 'openai/gpt-4o', providerUrl: 'https://openrouter.ai/api/v1' },
      { name: 'coder', cli: 'openclaude', role: 'worker', ceoNotes: 'You implement. Check read_tasks() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: 'deepseek/deepseek-chat', providerUrl: 'https://openrouter.ai/api/v1' },
    ]
  },
  {
    name: 'Ollama Local',
    description: '2 Llama 3 agents running locally via Ollama. Fully offline, no API keys needed.',
    requiredClis: ['openclaude'],
    agents: [
      { name: 'orchestrator', cli: 'openclaude', role: 'orchestrator', ceoNotes: 'You coordinate local agents. Break tasks and delegate.', shell: 'powershell', admin: false, autoMode: true, model: 'llama3', providerUrl: 'http://localhost:11434/v1' },
      { name: 'worker-1', cli: 'openclaude', role: 'worker', ceoNotes: 'Check read_tasks() and get_messages() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: 'llama3', providerUrl: 'http://localhost:11434/v1' },
    ]
  },
  {
    name: 'Hybrid Local + Cloud',
    description: 'Ollama worker (free, local) + Claude Opus orchestrator (smart, cloud).',
    requiredClis: ['openclaude', 'claude'],
    agents: [
      { name: 'orchestrator', cli: 'claude', role: 'orchestrator', ceoNotes: 'You orchestrate. The worker runs locally and is slower — give clear, specific instructions.', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
      { name: 'worker', cli: 'openclaude', role: 'worker', ceoNotes: 'Check read_tasks() and get_messages() for assignments. You run locally.', shell: 'powershell', admin: false, autoMode: true, model: 'llama3', providerUrl: 'http://localhost:11434/v1' },
    ]
  },
  // --- Codex-only ---
  {
    name: 'Solo Codex',
    description: '1 Codex agent with o4-mini. Lightweight, fast, OpenAI-powered.',
    requiredClis: ['codex'],
    agents: [
      { name: 'agent', cli: 'codex', role: 'worker', ceoNotes: 'You are a solo agent. Check read_tasks() and get_messages() for work. You have full autonomy.', shell: 'powershell', admin: false, autoMode: true, model: '' },
    ]
  },
  {
    name: 'Codex Orchestrator + Workers',
    description: '1 o3 orchestrator + 2 o4-mini workers. All OpenAI native.',
    requiredClis: ['codex'],
    agents: [
      { name: 'orchestrator', cli: 'codex', role: 'orchestrator', ceoNotes: 'You are the lead. Break tasks into subtasks and delegate to workers via post_task() and send_message().', shell: 'powershell', admin: false, autoMode: true, model: 'o3' },
      { name: 'worker-1', cli: 'codex', role: 'worker', ceoNotes: 'Check read_tasks() and get_messages() for assignments. Complete tasks and report back.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'worker-2', cli: 'codex', role: 'worker', ceoNotes: 'Check read_tasks() and get_messages() for assignments. Complete tasks and report back.', shell: 'powershell', admin: false, autoMode: true, model: '' },
    ]
  },
  {
    name: 'Codex Code + Review',
    description: '1 o4-mini coder + 1 o3 reviewer. Codex-native code review loop.',
    requiredClis: ['codex'],
    agents: [
      { name: 'coder', cli: 'codex', role: 'worker', ceoNotes: 'You write code. After each change, send_message() to the reviewer with a summary.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'reviewer', cli: 'codex', role: 'reviewer', ceoNotes: 'You review code. When the coder messages you, use get_agent_output() to inspect their work. send_message() back with feedback.', shell: 'powershell', admin: false, autoMode: true, model: 'o3' },
    ]
  },
  // --- Kimi-only ---
  {
    name: 'Solo Kimi',
    description: '1 Kimi agent. Moonshot-powered, strong at research and Chinese language tasks.',
    requiredClis: ['kimi'],
    agents: [
      { name: 'agent', cli: 'kimi', role: 'worker', ceoNotes: 'You are a solo agent. Check read_tasks() and get_messages() for work.', shell: 'powershell', admin: false, autoMode: true, model: '' },
    ]
  },
  {
    name: 'Kimi Research Pair',
    description: '1 orchestrator + 1 researcher. Kimi-native deep research team.',
    requiredClis: ['kimi'],
    agents: [
      { name: 'lead', cli: 'kimi', role: 'orchestrator', ceoNotes: 'You plan research. Break questions into sub-questions. Delegate via post_task(). Synthesize findings.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'researcher', cli: 'kimi', role: 'researcher', ceoNotes: 'You research deeply. Check read_tasks() for assignments. Post findings to post_info().', shell: 'powershell', admin: false, autoMode: true, model: '' },
    ]
  },
  {
    name: 'Kimi Code + Review',
    description: '1 coder + 1 reviewer. Kimi-native code review workflow.',
    requiredClis: ['kimi'],
    agents: [
      { name: 'coder', cli: 'kimi', role: 'worker', ceoNotes: 'You write code. After each change, send_message() to the reviewer.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'reviewer', cli: 'kimi', role: 'reviewer', ceoNotes: 'You review code. Use get_agent_output() to inspect work. send_message() back with feedback.', shell: 'powershell', admin: false, autoMode: true, model: '' },
    ]
  },
  // --- Gemini-only ---
  {
    name: 'Solo Gemini',
    description: '1 Gemini 2.5 Pro agent. Google-powered, strong at broad knowledge tasks.',
    requiredClis: ['gemini'],
    agents: [
      { name: 'agent', cli: 'gemini', role: 'worker', ceoNotes: 'You are a solo agent. Check read_tasks() and get_messages() for work.', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-pro' },
    ]
  },
  {
    name: 'Gemini Research Squad',
    description: '1 Pro orchestrator + 2 Flash researchers. Google-native research team.',
    requiredClis: ['gemini'],
    agents: [
      { name: 'lead', cli: 'gemini', role: 'orchestrator', ceoNotes: 'You coordinate research. Break questions into sub-questions. Delegate via post_task().', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-pro' },
      { name: 'researcher-1', cli: 'gemini', role: 'researcher', ceoNotes: 'Check read_tasks() for assignments. Post findings to post_info().', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-flash' },
      { name: 'researcher-2', cli: 'gemini', role: 'researcher', ceoNotes: 'Check read_tasks() for assignments. Post findings to post_info().', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-flash' },
    ]
  },
  {
    name: 'Gemini Code + Review',
    description: '1 Flash coder + 1 Pro reviewer. Gemini-native code review loop.',
    requiredClis: ['gemini'],
    agents: [
      { name: 'coder', cli: 'gemini', role: 'worker', ceoNotes: 'You write code. After each change, send_message() to the reviewer.', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-flash' },
      { name: 'reviewer', cli: 'gemini', role: 'reviewer', ceoNotes: 'You review code. Use get_agent_output() to inspect work. send_message() back with feedback.', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-pro' },
    ]
  },
  // --- Cross-CLI (non-Claude) ---
  {
    name: 'Codex + Kimi',
    description: 'Codex codes, Kimi researches. OpenAI implementation + Moonshot knowledge.',
    requiredClis: ['codex', 'kimi'],
    agents: [
      { name: 'coder', cli: 'codex', role: 'worker', ceoNotes: 'You implement code. Check read_tasks() and get_messages() for assignments. Report back when done.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'researcher', cli: 'kimi', role: 'researcher', ceoNotes: 'You research and provide context. Check read_tasks() for assignments. Post findings to post_info().', shell: 'powershell', admin: false, autoMode: true, model: '' },
    ]
  },
  {
    name: 'Codex + Gemini',
    description: 'Codex codes, Gemini researches. OpenAI implementation + Google knowledge.',
    requiredClis: ['codex', 'gemini'],
    agents: [
      { name: 'coder', cli: 'codex', role: 'worker', ceoNotes: 'You implement code. Check read_tasks() and get_messages() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'researcher', cli: 'gemini', role: 'researcher', ceoNotes: 'You research and provide context. Check read_tasks() for assignments. Post findings to post_info().', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-pro' },
    ]
  },
  {
    name: 'Kimi + Gemini',
    description: 'Kimi + Gemini dual research. Two knowledge bases, one team.',
    requiredClis: ['kimi', 'gemini'],
    agents: [
      { name: 'kimi-researcher', cli: 'kimi', role: 'researcher', ceoNotes: 'You research from the Moonshot perspective. Check read_tasks() for assignments. Post findings to post_info() with tags.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'gemini-researcher', cli: 'gemini', role: 'researcher', ceoNotes: 'You research from the Google perspective. Check read_tasks() for assignments. Post findings to post_info() with tags.', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-pro' },
    ]
  },
  {
    name: 'Triple Threat',
    description: 'Codex + Kimi + Gemini. Three ecosystems, one project. No Claude needed.',
    requiredClis: ['codex', 'kimi', 'gemini'],
    agents: [
      { name: 'coder', cli: 'codex', role: 'worker', ceoNotes: 'You implement code. Check read_tasks() and get_messages() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: 'o3' },
      { name: 'researcher', cli: 'kimi', role: 'researcher', ceoNotes: 'You research. Check read_tasks() for assignments. Post findings to post_info().', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'analyst', cli: 'gemini', role: 'researcher', ceoNotes: 'You analyze and verify. Check read_tasks() for assignments. Cross-reference findings in read_info().', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-pro' },
    ]
  },
  // --- Triple combos with Claude ---
  {
    name: 'Claude + Codex + Kimi',
    description: 'Claude orchestrates, Codex implements, Kimi researches. Three ecosystems working in harmony.',
    requiredClis: ['claude', 'codex', 'kimi'],
    agents: [
      { name: 'orchestrator', cli: 'claude', role: 'orchestrator', ceoNotes: 'You coordinate. Delegate coding to the coder and research to the researcher via post_task() and send_message().', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
      { name: 'coder', cli: 'codex', role: 'worker', ceoNotes: 'You implement code. Check read_tasks() and get_messages() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'researcher', cli: 'kimi', role: 'researcher', ceoNotes: 'You research. Check read_tasks() for assignments. Post findings to post_info().', shell: 'powershell', admin: false, autoMode: true, model: '' },
    ]
  },
  {
    name: 'Claude + Codex + Gemini',
    description: 'Claude orchestrates, Codex implements, Gemini researches. Anthropic brains + OpenAI hands + Google eyes.',
    requiredClis: ['claude', 'codex', 'gemini'],
    agents: [
      { name: 'orchestrator', cli: 'claude', role: 'orchestrator', ceoNotes: 'You coordinate. Delegate coding to the coder and research to the researcher.', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
      { name: 'coder', cli: 'codex', role: 'worker', ceoNotes: 'You implement code. Check read_tasks() and get_messages() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'researcher', cli: 'gemini', role: 'researcher', ceoNotes: 'You research. Check read_tasks() for assignments. Post findings to post_info().', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-pro' },
    ]
  },
  {
    name: 'Claude + Kimi + Gemini',
    description: 'Claude orchestrates two research powerhouses. Dual-source knowledge gathering.',
    requiredClis: ['claude', 'kimi', 'gemini'],
    agents: [
      { name: 'lead', cli: 'claude', role: 'orchestrator', ceoNotes: 'You coordinate dual researchers. Give each different angles on the same question. Synthesize their findings.', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
      { name: 'kimi-researcher', cli: 'kimi', role: 'researcher', ceoNotes: 'You research from the Moonshot perspective. Post findings to post_info() with tags.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'gemini-researcher', cli: 'gemini', role: 'researcher', ceoNotes: 'You research from the Google perspective. Post findings to post_info() with tags.', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-pro' },
    ]
  },
  // --- Quad combo ---
  {
    name: 'The Full Stack',
    description: 'Claude + Codex + Kimi + Gemini. All four major CLIs in one team. Maximum ecosystem diversity.',
    requiredClis: ['claude', 'codex', 'kimi', 'gemini'],
    agents: [
      { name: 'orchestrator', cli: 'claude', role: 'orchestrator', ceoNotes: 'You lead a multi-ecosystem team. Delegate implementation to Codex, research to Kimi and Gemini. Synthesize everything.', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
      { name: 'coder', cli: 'codex', role: 'worker', ceoNotes: 'You implement code. Check read_tasks() and get_messages() for assignments from the orchestrator.', shell: 'powershell', admin: false, autoMode: true, model: 'o3' },
      { name: 'researcher-east', cli: 'kimi', role: 'researcher', ceoNotes: 'You research. Focus on technical depth and implementation patterns. Post findings to post_info().', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'researcher-west', cli: 'gemini', role: 'researcher', ceoNotes: 'You research. Focus on broad context and documentation. Post findings to post_info().', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-pro' },
    ]
  },
  // --- More creative cross-CLI mixes ---
  {
    name: 'Codex + Claude Review',
    description: 'Codex does the heavy coding, Claude Opus reviews everything. Speed + quality.',
    requiredClis: ['codex', 'claude'],
    agents: [
      { name: 'coder-1', cli: 'codex', role: 'worker', ceoNotes: 'You implement code. After each change, send_message() to the reviewer.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'coder-2', cli: 'codex', role: 'worker', ceoNotes: 'You implement code. After each change, send_message() to the reviewer.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'reviewer', cli: 'claude', role: 'reviewer', ceoNotes: 'You review all code from both coders. Use get_agent_output() to inspect. Be thorough — you are the quality gate.', shell: 'powershell', admin: false, autoMode: true, model: 'opus' },
    ]
  },
  {
    name: 'Gemini Lead + Claude Workers',
    description: 'Gemini Pro orchestrates, Claude Sonnet workers execute. Google planning + Anthropic hands.',
    requiredClis: ['gemini', 'claude'],
    agents: [
      { name: 'lead', cli: 'gemini', role: 'orchestrator', ceoNotes: 'You plan and coordinate. Break work into tasks via post_task(). Review results.', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-pro' },
      { name: 'worker-1', cli: 'claude', role: 'worker', ceoNotes: 'Check read_tasks() and get_messages() for assignments. Execute and report back.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
      { name: 'worker-2', cli: 'claude', role: 'worker', ceoNotes: 'Check read_tasks() and get_messages() for assignments. Execute and report back.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
    ]
  },
  {
    name: 'Kimi Lead + Codex Workers',
    description: 'Kimi orchestrates, Codex workers implement. Moonshot planning + OpenAI execution.',
    requiredClis: ['kimi', 'codex'],
    agents: [
      { name: 'lead', cli: 'kimi', role: 'orchestrator', ceoNotes: 'You plan and delegate. Break work into tasks. Review completed work.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'worker-1', cli: 'codex', role: 'worker', ceoNotes: 'Check read_tasks() and get_messages() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'worker-2', cli: 'codex', role: 'worker', ceoNotes: 'Check read_tasks() and get_messages() for assignments.', shell: 'powershell', admin: false, autoMode: true, model: '' },
    ]
  },
  {
    name: 'Everyone Reviews Claude',
    description: 'Claude codes, everyone else reviews from their perspective. Maximum feedback diversity.',
    requiredClis: ['claude', 'codex', 'kimi', 'gemini'],
    agents: [
      { name: 'coder', cli: 'claude', role: 'worker', ceoNotes: 'You write code. After each change, broadcast() to all reviewers and wait for feedback from all three before proceeding.', shell: 'powershell', admin: false, autoMode: true, model: 'sonnet' },
      { name: 'reviewer-openai', cli: 'codex', role: 'reviewer', ceoNotes: 'You review code from the OpenAI perspective. Use get_agent_output() to inspect. send_message() back with feedback.', shell: 'powershell', admin: false, autoMode: true, model: 'o3' },
      { name: 'reviewer-kimi', cli: 'kimi', role: 'reviewer', ceoNotes: 'You review code from the Moonshot perspective. Use get_agent_output() to inspect. send_message() back with feedback.', shell: 'powershell', admin: false, autoMode: true, model: '' },
      { name: 'reviewer-gemini', cli: 'gemini', role: 'reviewer', ceoNotes: 'You review code from the Google perspective. Use get_agent_output() to inspect. send_message() back with feedback.', shell: 'powershell', admin: false, autoMode: true, model: 'gemini-2.5-pro' },
    ]
  },
]

const ALL_CLIS = ['claude', 'codex', 'kimi', 'gemini', 'openclaude']
const CLI_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  gemini: 'Gemini',
  openclaude: 'OpenClaude',
}

export function PresetDialog({ agents, windows, zoom, pan, onLoadPreset, onClose }: PresetDialogProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<Tab>('save')
  const [presetName, setPresetName] = useState('')
  const [presets, setPresets] = useState<PresetInfo[]>([])
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null)
  const [cwdOverride, setCwdOverride] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCwdPrompt, setShowCwdPrompt] = useState(false)
  const [templateToLoad, setTemplateToLoad] = useState<PresetTemplate | null>(null)
  const [templateSearch, setTemplateSearch] = useState('')
  const [cliFilters, setCliFilters] = useState<Set<string>>(new Set())
  const [editingAgents, setEditingAgents] = useState<AgentConfig[] | null>(null)

  const filteredTemplates = BUILT_IN_TEMPLATES.filter(t => {
    if (templateSearch) {
      const q = templateSearch.toLowerCase()
      if (!t.name.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) return false
    }
    if (cliFilters.size > 0) {
      if (!t.requiredClis.every(cli => cliFilters.has(cli))) return false
    }
    return true
  })

  const toggleCliFilter = (cli: string) => {
    setCliFilters(prev => {
      const next = new Set(prev)
      if (next.has(cli)) next.delete(cli)
      else next.add(cli)
      return next
    })
  }

  // Reset selection and load presets list when tab changes
  // Note: don't clear editingAgents here — it gets set before setActiveTab('save')
  useEffect(() => {
    setSelectedPreset(null)
    setTemplateToLoad(null)
    setTemplateSearch('')
    setCliFilters(new Set())
    if (activeTab === 'load') {
      setEditingAgents(null)
      loadPresetsList()
    } else if (activeTab === 'templates') {
      setEditingAgents(null)
    }
  }, [activeTab])

  const loadPresetsList = async () => {
    try {
      setLoading(true)
      setError(null)
      const names = await window.electronAPI.listPresets()
      // Fetch details for each preset to get savedAt
      const presetInfos: PresetInfo[] = []
      for (const name of names) {
        try {
          const preset = await window.electronAPI.loadPreset(name)
          presetInfos.push({
            name,
            savedAt: preset.savedAt
          })
        } catch {
          // Skip corrupted presets
        }
      }
      setPresets(presetInfos.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime()))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load presets')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!presetName.trim()) return

    try {
      setLoading(true)
      setError(null)

      // Convert WindowState[] to WindowPosition[]
      const windowPositions: WindowPosition[] = windows.map(w => ({
        agentName: w.title,
        x: w.x,
        y: w.y,
        width: w.width,
        height: w.height
      }))

      const canvas: CanvasState = {
        zoom,
        panX: pan.x,
        panY: pan.y
      }

      // Use editingAgents if editing an existing preset, otherwise save current workspace
      const agentConfigs: AgentConfig[] = editingAgents
        ? editingAgents
        : agents.map(a => ({
            id: a.id,
            name: a.name,
            cli: a.cli,
            cwd: a.cwd,
            role: a.role,
            ceoNotes: a.ceoNotes,
            shell: a.shell,
            admin: a.admin,
            autoMode: a.autoMode,
            promptRegex: a.promptRegex,
            model: a.model,
            experimental: a.experimental
          }))

      await window.electronAPI.savePreset(presetName.trim(), agentConfigs, windowPositions, canvas)
      setPresetName('')
      setEditingAgents(null)
      setActiveTab('load')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save preset')
    } finally {
      setLoading(false)
    }
  }

  const handleEditPreset = async (name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      setLoading(true)
      setError(null)
      const preset = await window.electronAPI.loadPreset(name)
      setEditingAgents(preset.agents)
      setPresetName(name)
      setActiveTab('save')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load preset for editing')
    } finally {
      setLoading(false)
    }
  }

  const handleClonePreset = async (name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      setLoading(true)
      setError(null)
      const preset = await window.electronAPI.loadPreset(name)
      setEditingAgents(preset.agents)
      setPresetName(`${name}-copy`)
      setActiveTab('save')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clone preset')
    } finally {
      setLoading(false)
    }
  }

  const updateEditingAgent = (index: number, field: keyof AgentConfig, value: string | boolean) => {
    setEditingAgents(prev => {
      if (!prev) return prev
      const updated = [...prev]
      updated[index] = { ...updated[index], [field]: value }
      return updated
    })
  }

  const removeEditingAgent = (index: number) => {
    setEditingAgents(prev => {
      if (!prev) return prev
      return prev.filter((_, i) => i !== index)
    })
  }

  const handleDelete = async (name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm(`Delete preset "${name}"?`)) return

    try {
      setLoading(true)
      await window.electronAPI.deletePreset(name)
      if (selectedPreset === name) setSelectedPreset(null)
      await loadPresetsList()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete preset')
    } finally {
      setLoading(false)
    }
  }

  const handleLoadClick = () => {
    if (!selectedPreset) return
    setShowCwdPrompt(true)
  }

  const handleUpdatePreset = async (name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      setLoading(true)
      setError(null)

      const windowPositions: WindowPosition[] = windows.map(w => ({
        agentName: w.title,
        x: w.x,
        y: w.y,
        width: w.width,
        height: w.height
      }))

      const canvas: CanvasState = {
        zoom,
        panX: pan.x,
        panY: pan.y
      }

      const agentConfigs: AgentConfig[] = agents.map(a => ({
        id: a.id,
        name: a.name,
        cli: a.cli,
        cwd: a.cwd,
        role: a.role,
        ceoNotes: a.ceoNotes,
        shell: a.shell,
        admin: a.admin,
        autoMode: a.autoMode,
        promptRegex: a.promptRegex,
        model: a.model,
        experimental: a.experimental
      }))

      await window.electronAPI.savePreset(name, agentConfigs, windowPositions, canvas)
      await loadPresetsList()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update preset')
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmLoad = async () => {
    try {
      setLoading(true)
      setError(null)

      let configs: Omit<AgentConfig, 'id'>[]
      let savedWindows: WindowPosition[] = []
      let savedCanvas: CanvasState = { zoom: 1, panX: 0, panY: 0 }

      if (templateToLoad && activeTab === 'templates') {
        // Loading from built-in template — no saved positions
        configs = templateToLoad.agents.map(agent => ({
          ...agent,
          cwd: cwdOverride.trim() || ''
        }))
      } else if (selectedPreset) {
        // Loading from saved preset — include window positions and canvas
        const preset = await window.electronAPI.loadPreset(selectedPreset)
        configs = preset.agents.map(({ id, ...rest }) => ({
          ...rest,
          cwd: cwdOverride.trim() || rest.cwd
        }))
        savedWindows = preset.windows || []
        savedCanvas = preset.canvas || savedCanvas
      } else {
        return
      }

      onLoadPreset(configs, savedWindows, savedCanvas)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  const formatDate = (isoString: string) => {
    try {
      const date = new Date(isoString)
      return date.toLocaleString()
    } catch {
      return isoString
    }
  }

  const handleBrowseCwd = async () => {
    const dir = await window.electronAPI.browseDirectory(cwdOverride || '')
    if (dir) setCwdOverride(dir)
  }

  // CWD Override Prompt Modal
  if (showCwdPrompt) {
    return (
      <div style={overlayStyle}>
        <div style={{ ...modalStyle, width: '400px' }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', color: '#e0e0e0' }}>
            {activeTab === 'templates' ? `Use Template: ${templateToLoad?.name}` : `Load Preset: ${selectedPreset}`}
          </h3>
          <p style={{ color: '#aaa', fontSize: '13px', margin: '0 0 12px 0' }}>
            Working directory for all agents:
          </p>
          <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
            <input
              value={cwdOverride}
              onChange={e => setCwdOverride(e.target.value)}
              placeholder="Leave empty to use original paths"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              type="button"
              onClick={handleBrowseCwd}
              style={browseBtnStyle}
            >
              Browse
            </button>
          </div>
          {error && <div style={{ color: '#ff6b6b', fontSize: '12px', marginBottom: '12px' }}>{error}</div>}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button onClick={() => setShowCwdPrompt(false)} style={cancelBtnStyle}>
              Back
            </button>
            <button onClick={handleConfirmLoad} disabled={loading} style={loadBtnStyle}>
              Load
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0, fontSize: '16px', color: '#e0e0e0' }}>Workspace Presets</h2>
          <button onClick={onClose} style={closeBtnStyle}>×</button>
        </div>

        {/* Tabs */}
        <div style={tabsContainerStyle}>
          <button
            onClick={() => setActiveTab('save')}
            style={activeTab === 'save' ? activeTabStyle : tabStyle}
          >
            Save
          </button>
          <button
            onClick={() => setActiveTab('load')}
            style={activeTab === 'load' ? activeTabStyle : tabStyle}
          >
            Load
          </button>
          <button
            onClick={() => setActiveTab('templates')}
            style={activeTab === 'templates' ? activeTabStyle : tabStyle}
          >
            Templates
          </button>
        </div>

        {error && (
          <div style={{ color: '#ff6b6b', fontSize: '12px', marginBottom: '12px', padding: '8px', backgroundColor: '#3a1a1a', borderRadius: '4px' }}>
            {error}
          </div>
        )}

        {activeTab === 'save' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <label style={labelStyle}>
              Preset Name
              <input
                value={presetName}
                onChange={e => setPresetName(e.target.value)}
                placeholder="e.g., My Workspace"
                style={inputStyle}
              />
            </label>
            {editingAgents ? (
              <>
                <div style={{ color: '#aaa', fontSize: '12px' }}>
                  Editing {editingAgents.length} agent{editingAgents.length !== 1 ? 's' : ''}
                </div>
                <div style={{ maxHeight: '320px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {editingAgents.map((agent, idx) => (
                    <div key={idx} style={agentCardStyle}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <span style={{ fontSize: '13px', color: '#e0e0e0', fontWeight: 'bold' }}>Agent {idx + 1}</span>
                        {editingAgents.length > 1 && (
                          <button
                            onClick={() => removeEditingAgent(idx)}
                            style={{ ...deleteBtnStyle, width: '20px', height: '20px', fontSize: '14px' }}
                            title="Remove agent"
                          >
                            ×
                          </button>
                        )}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                        <label style={agentFieldLabelStyle}>
                          Name
                          <input
                            value={agent.name}
                            onChange={e => updateEditingAgent(idx, 'name', e.target.value)}
                            style={agentFieldInputStyle}
                          />
                        </label>
                        <label style={agentFieldLabelStyle}>
                          CLI
                          <select
                            value={agent.cli}
                            onChange={e => updateEditingAgent(idx, 'cli', e.target.value)}
                            style={agentFieldInputStyle}
                          >
                            <option value="claude">Claude Code</option>
                            <option value="codex">Codex CLI</option>
                            <option value="kimi">Kimi CLI</option>
                            <option value="gemini">Gemini CLI</option>
                            <option value="openclaude">OpenClaude</option>
                            <option value="copilot">Copilot CLI</option>
                            <option value="grok">Grok CLI</option>
                            <option value="terminal">Plain Terminal</option>
                          </select>
                        </label>
                        <label style={agentFieldLabelStyle}>
                          Role
                          <select
                            value={agent.role}
                            onChange={e => updateEditingAgent(idx, 'role', e.target.value)}
                            style={agentFieldInputStyle}
                          >
                            <option value="orchestrator">Orchestrator</option>
                            <option value="worker">Worker</option>
                            <option value="researcher">Researcher</option>
                            <option value="reviewer">Reviewer</option>
                          </select>
                        </label>
                        <label style={agentFieldLabelStyle}>
                          Model
                          <input
                            value={agent.model || ''}
                            onChange={e => updateEditingAgent(idx, 'model', e.target.value)}
                            placeholder="default"
                            style={agentFieldInputStyle}
                          />
                        </label>
                      </div>
                      <label style={{ ...agentFieldLabelStyle, marginTop: '6px' }}>
                        Instructions
                        <textarea
                          value={agent.ceoNotes}
                          onChange={e => updateEditingAgent(idx, 'ceoNotes', e.target.value)}
                          rows={2}
                          style={{ ...agentFieldInputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                        />
                      </label>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ color: '#666', fontSize: '12px' }}>
                Saves {agents.length} agent{agents.length !== 1 ? 's' : ''} and {windows.length} window position{windows.length !== 1 ? 's' : ''}
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
              <button onClick={() => { setEditingAgents(null); if (editingAgents) setActiveTab('load'); else onClose() }} style={cancelBtnStyle}>
                {editingAgents ? 'Back' : 'Cancel'}
              </button>
              <button
                onClick={handleSave}
                disabled={!presetName.trim() || loading || (editingAgents !== null && editingAgents.length === 0)}
                style={saveBtnStyle}
              >
                Save
              </button>
            </div>
          </div>
        )}

        {activeTab === 'load' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {loading ? (
              <div style={{ color: '#666', textAlign: 'center', padding: '32px' }}>Loading presets...</div>
            ) : presets.length === 0 ? (
              <div style={{ color: '#666', textAlign: 'center', padding: '32px' }}>
                No presets saved yet
              </div>
            ) : (
              <div style={presetListStyle}>
                {presets.map(preset => (
                  <div
                    key={preset.name}
                    onClick={() => setSelectedPreset(preset.name)}
                    style={selectedPreset === preset.name ? selectedPresetItemStyle : presetItemStyle}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '13px', color: '#e0e0e0', marginBottom: '2px' }}>{preset.name}</div>
                      <div style={{ fontSize: '11px', color: '#666' }}>{formatDate(preset.savedAt)}</div>
                    </div>
                    <button
                      onClick={e => handleUpdatePreset(preset.name, e)}
                      style={updateBtnStyle}
                      title="Update preset with current layout"
                    >
                      &#8635;
                    </button>
                    <button
                      onClick={e => handleClonePreset(preset.name, e)}
                      style={cloneBtnStyle}
                      title="Clone preset"
                    >
                      &#10697;
                    </button>
                    <button
                      onClick={e => handleEditPreset(preset.name, e)}
                      style={editBtnStyle}
                      title="Edit preset"
                    >
                      &#9998;
                    </button>
                    <button
                      onClick={e => handleDelete(preset.name, e)}
                      style={deleteBtnStyle}
                      title="Delete preset"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
              <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
              <button
                onClick={handleLoadClick}
                disabled={!selectedPreset || loading}
                style={loadBtnStyle}
              >
                Load
              </button>
            </div>
          </div>
        )}

        {activeTab === 'templates' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <input
              value={templateSearch}
              onChange={e => setTemplateSearch(e.target.value)}
              placeholder="Search templates..."
              style={inputStyle}
            />
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {ALL_CLIS.map(cli => (
                <button
                  key={cli}
                  onClick={() => toggleCliFilter(cli)}
                  style={{
                    padding: '4px 10px',
                    fontSize: '11px',
                    borderRadius: '12px',
                    border: cliFilters.has(cli) ? '1px solid #4a9eff' : '1px solid #444',
                    backgroundColor: cliFilters.has(cli) ? '#1e3a5f' : '#2a2a2a',
                    color: cliFilters.has(cli) ? '#8cc4ff' : '#888',
                    cursor: 'pointer',
                  }}
                >
                  {CLI_LABELS[cli]}
                </button>
              ))}
              {cliFilters.size > 0 && (
                <button
                  onClick={() => setCliFilters(new Set())}
                  style={{
                    padding: '4px 10px',
                    fontSize: '11px',
                    borderRadius: '12px',
                    border: '1px solid #444',
                    backgroundColor: 'transparent',
                    color: '#666',
                    cursor: 'pointer',
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            <div style={{ maxHeight: '320px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {filteredTemplates.length === 0 ? (
                <div style={{ color: '#555', textAlign: 'center', padding: '20px 0' }}>
                  No templates match your filters.
                </div>
              ) : (
                filteredTemplates.map(template => (
                  <div
                    key={template.name}
                    onClick={() => {
                      setSelectedPreset(template.name)
                      setTemplateToLoad(template)
                    }}
                    style={selectedPreset === template.name && activeTab === 'templates' ? selectedPresetItemStyle : presetItemStyle}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '13px', color: '#e0e0e0', marginBottom: '2px' }}>{template.name}</div>
                      <div style={{ fontSize: '11px', color: '#666' }}>{template.description}</div>
                      <div style={{ fontSize: '10px', color: '#555', marginTop: '3px' }}>
                        {template.agents.length} agent{template.agents.length !== 1 ? 's' : ''}
                        {' \u00B7 '}
                        Requires: {template.requiredClis.map(c => CLI_LABELS[c] || c).join(', ')}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
              <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
              <button
                onClick={() => { if (templateToLoad) setShowCwdPrompt(true) }}
                disabled={!templateToLoad}
                style={loadBtnStyle}
              >
                Use Template
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Styles
const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(0,0,0,0.7)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 10000
}

const modalStyle: React.CSSProperties = {
  backgroundColor: '#1e1e1e',
  border: '1px solid #333',
  borderRadius: '8px',
  padding: '24px',
  width: '450px',
  display: 'flex',
  flexDirection: 'column'
}

const closeBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#666',
  fontSize: '24px',
  cursor: 'pointer',
  lineHeight: 1,
  padding: '0 4px'
}

const tabsContainerStyle: React.CSSProperties = {
  display: 'flex',
  gap: '4px',
  marginBottom: '16px',
  borderBottom: '1px solid #333',
  paddingBottom: '8px'
}

const tabStyle: React.CSSProperties = {
  flex: 1,
  padding: '8px 16px',
  backgroundColor: '#2a2a2a',
  border: '1px solid #444',
  borderRadius: '4px',
  color: '#aaa',
  cursor: 'pointer',
  fontSize: '13px'
}

const activeTabStyle: React.CSSProperties = {
  flex: 1,
  padding: '8px 16px',
  backgroundColor: '#3a3a3a',
  border: '1px solid #555',
  borderRadius: '4px',
  color: '#e0e0e0',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: 'bold'
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  fontSize: '12px',
  color: '#aaa'
}

const inputStyle: React.CSSProperties = {
  backgroundColor: '#2a2a2a',
  border: '1px solid #444',
  borderRadius: '4px',
  padding: '8px',
  color: '#e0e0e0',
  fontSize: '13px',
  fontFamily: 'inherit'
}

const presetListStyle: React.CSSProperties = {
  maxHeight: '240px',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px'
}

const presetItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '10px 12px',
  backgroundColor: '#2a2a2a',
  border: '1px solid #333',
  borderRadius: '4px',
  cursor: 'pointer'
}

const selectedPresetItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '10px 12px',
  backgroundColor: '#2d4a3e',
  border: '1px solid #4caf50',
  borderRadius: '4px',
  cursor: 'pointer'
}

const updateBtnStyle: React.CSSProperties = {
  width: '24px',
  height: '24px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'transparent',
  border: 'none',
  color: '#666',
  fontSize: '16px',
  cursor: 'pointer',
  borderRadius: '4px'
}

const cloneBtnStyle: React.CSSProperties = {
  width: '24px',
  height: '24px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'transparent',
  border: 'none',
  color: '#666',
  fontSize: '14px',
  cursor: 'pointer',
  borderRadius: '4px'
}

const editBtnStyle: React.CSSProperties = {
  width: '24px',
  height: '24px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'transparent',
  border: 'none',
  color: '#666',
  fontSize: '14px',
  cursor: 'pointer',
  borderRadius: '4px'
}

const deleteBtnStyle: React.CSSProperties = {
  width: '24px',
  height: '24px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'transparent',
  border: 'none',
  color: '#666',
  fontSize: '18px',
  cursor: 'pointer',
  borderRadius: '4px'
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  backgroundColor: '#2a2a2a',
  border: '1px solid #444',
  borderRadius: '4px',
  color: '#aaa',
  cursor: 'pointer',
  fontSize: '13px'
}

const saveBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  backgroundColor: '#2d5a2d',
  border: '1px solid #4caf50',
  borderRadius: '4px',
  color: '#4caf50',
  cursor: 'pointer',
  fontSize: '13px'
}

const loadBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  backgroundColor: '#2a4a5a',
  border: '1px solid #4a9eff',
  borderRadius: '4px',
  color: '#4a9eff',
  cursor: 'pointer',
  fontSize: '13px'
}

const browseBtnStyle: React.CSSProperties = {
  padding: '8px 12px',
  backgroundColor: '#2a2a2a',
  border: '1px solid #444',
  borderRadius: '4px',
  color: '#aaa',
  cursor: 'pointer',
  fontSize: '12px',
  whiteSpace: 'nowrap'
}

const agentCardStyle: React.CSSProperties = {
  padding: '10px',
  backgroundColor: '#252525',
  border: '1px solid #3a3a3a',
  borderRadius: '6px'
}

const agentFieldLabelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  fontSize: '11px',
  color: '#888'
}

const agentFieldInputStyle: React.CSSProperties = {
  backgroundColor: '#1e1e1e',
  border: '1px solid #3a3a3a',
  borderRadius: '3px',
  padding: '4px 6px',
  color: '#e0e0e0',
  fontSize: '12px'
}
