# Preset System Redesign

**Date:** 2026-04-03
**Status:** Approved

## Problem

Saved presets are currently project-scoped (`.agentorch/presets/`). Users want to save a team once and reuse it across all projects. Additionally, built-in templates assume all users have all models — need search + filter so users can find templates matching their setup.

## Solution

Two changes:
1. Move saved presets to global storage (`userData/presets/`) so they follow the user across projects
2. Expand built-in templates to ~15-20 with search bar and model filter chips

## Save/Load (Global Personal Presets)

- Presets stored in `app.getPath('userData')/presets/` (global)
- `setPresetsDir()` called with userData path instead of project path
- Save tab: unchanged behavior
- Load tab: shows saved presets from any project — they're portable
- CWD override prompt on load: unchanged (user picks working directory)

### Migration

The `.agentorch/presets/` folder per-project becomes unused for user presets. No migration needed — presets were empty in the new system.

## Templates Tab (Search + Filter)

### UI Layout

```
┌──────────────────────────────────────┐
│ [Search templates...]                │
│ Filters: [Claude] [Codex] [Kimi]    │
│          [Gemini] [OpenClaude]       │
│          [Ollama]                    │
├──────────────────────────────────────┤
│ Orchestrator + Workers               │
│ 1 orchestrator (Opus) + 2 workers   │
│ Requires: Claude                     │
│                                      │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ GPT-4o + DeepSeek (greyed out)       │
│ Requires: OpenClaude ← not checked  │
│                                      │
│ ...more templates...                 │
├──────────────────────────────────────┤
│                    [Cancel] [Use]    │
└──────────────────────────────────────┘
```

### Filter Behavior

- Filter chips are toggleable (click to enable/disable)
- **No filters active** = show ALL templates (unfiltered by default)
- **Filters active** = only show templates whose `requiredClis` are ALL present in the active filters
- Templates that don't match are hidden (not greyed out — cleaner)
- Search filters on template `name` and `description` (case-insensitive substring match)

### Template Data Structure

```ts
interface PresetTemplate {
  name: string
  description: string
  requiredClis: string[]  // e.g., ['claude'], ['openclaude'], ['claude', 'codex']
  agents: Omit<AgentConfig, 'id' | 'cwd'>[]
}
```

### Template Library (~18 templates)

**Claude-only (requires: claude):**

1. **Orchestrator + Workers** — 1 Opus orchestrator + 2 Sonnet workers. Classic delegation.
2. **Research Squad** — 1 Opus lead + 3 researchers (2 Sonnet, 1 Haiku). Deep parallel research.
3. **Code + Review** — 1 Sonnet coder + 1 Opus reviewer. Continuous code review loop.
4. **Speed Swarm** — 3 Haiku agents, all workers. Max throughput for simple tasks.
5. **Solo Opus** — 1 Opus agent. Full power, no coordination overhead.
6. **TDD Pipeline** — 1 Sonnet coder + 1 Sonnet tester + 1 Opus reviewer. Red-green-refactor.
7. **Documentation Team** — 1 Haiku researcher + 1 Sonnet writer + 1 Opus reviewer.

**Multi-CLI (requires: varies):**

8. **Claude + Codex** (requires: claude, codex) — Claude Opus orchestrates, Codex o4-mini implements. Best of both ecosystems.
9. **Claude + Kimi** (requires: claude, kimi) — Claude plans, Kimi K2.5 researches. Dual-brain research.
10. **Claude + Gemini** (requires: claude, gemini) — Claude orchestrates, Gemini 2.5 Pro researches. Google's knowledge + Anthropic's reasoning.

**OpenClaude teams (requires: openclaude):**

11. **GPT-4o + DeepSeek** — GPT-4o orchestrator + DeepSeek coder. Cost-optimized multi-model.
12. **Full OpenAI** — GPT-4o lead + 2 GPT-4.1 workers. All OpenAI, max compatibility.
13. **DeepSeek Squad** — 3 DeepSeek agents. Cheapest possible team.
14. **Mixed Provider** — GPT-4o lead + DeepSeek coder + Claude Sonnet reviewer. Best of three worlds.
15. **OpenRouter Mix** — Via OpenRouter: GPT-4o + Claude + DeepSeek. Single API key for all models.

**Local teams (requires: openclaude):**

16. **Ollama Local** — 2 Llama 3 agents via Ollama. Fully offline, no API keys.
17. **Hybrid Local + Cloud** — Ollama worker (local, free) + Claude Opus orchestrator (cloud, smart). (requires: openclaude, claude)

**Specialty:**

18. **Rapid Prototyper** (requires: claude) — 1 Opus architect + 2 Sonnet builders. Architecture-first workflow.

## Module Changes

### preset-manager.ts

- `setPresetsDir()` now called with `app.getPath('userData')/presets/` in the main process (not project path)
- Called in `main()` before `openProject()`, not inside `openProject()`
- Project's `.agentorch/presets/` folder still created but unused for user presets (may be used for project-specific configs later)

### PresetDialog.tsx

- Templates tab: replace static list with search + filter UI
- `BUILT_IN_TEMPLATES` expanded to ~18 entries with `requiredClis` field
- Filter state: `Set<string>` of active CLI filters
- Search state: string
- Computed filtered list: templates matching search AND filter criteria

### main/index.ts

- Move `setPresetsDir(...)` call from inside `openProject()` to `main()` after creating `projectManager`
- Use `path.join(app.getPath('userData'), 'presets')` as the presets dir

## What Doesn't Change

- TopBar, Workspace panel rendering
- CWD override flow on load/template use
- Save tab behavior
- PresetTemplate agent configs (same shape, just more of them)
