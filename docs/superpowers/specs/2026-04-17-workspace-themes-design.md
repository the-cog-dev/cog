# Workspace Themes Design

## Goal

Add curated visual themes that bulk-apply cohesive agent color schemes across the workspace. Ships 8 built-in themes, supports user-created custom themes, and community sharing (upload/download via GitHub issues). New Themes tab in Settings. Zero 3DS changes required — existing color-sync continues to work.

## Architecture

### The `WorkspaceTheme` concept

A `WorkspaceTheme` is a self-contained bundle:

```ts
interface WorkspaceTheme {
  id: string
  label: string
  emoji: string
  description?: string
  author?: string
  roles: Record<string, Required<AgentTheme>>  // keyed by role name
  fallback: Required<AgentTheme>               // used for roles not in map
  savedAt?: string  // ISO date, present for custom/community themes
  source?: 'builtin' | 'custom' | 'community'
}
```

Each entry in `roles` is a complete `AgentTheme` (`{ chrome, border, bg, text }`). Standard roles: `orchestrator`, `worker`, `researcher`, `reviewer`. The `fallback` field paints any agent whose role isn't in the map.

Themes coexist with — not replace — the existing per-agent `ThemePreset` (renamed to `AgentColorPreset` for clarity). The color wheel and single-agent theming keep working unchanged.

### Apply semantics

One-shot paint action. No persistent "active theme" state. Picking a theme:

1. Iterate every agent currently in the workspace
2. Look up `theme.roles[agent.role]`, fall back to `theme.fallback` if missing
3. Call the existing `setAgentTheme(agentId, agentTheme)` IPC for each agent

After apply, agents are just agents with custom themes. User can still override individual agents via the color wheel. New agents spawned later get default colors — theme doesn't "stick."

No new IPC is needed for apply — the renderer owns agent state and calls existing IPCs.

## Built-in themes

Ships with 8 themes in `src/renderer/workspace-themes.ts`:

| id | Label | Emoji | Palette direction |
|---|---|---|---|
| `sunshine` | Sunshine | ☀️ | Gold on dark — existing default |
| `vaporwave` | Vaporwave | 🌴 | Hot pink, cyan, purple, magenta |
| `blue-lagoon` | Blue Lagoon | 🌊 | Navy → teal → sky variations |
| `sunrise` | Sunrise | 🌅 | Orange, peach, yellow, coral |
| `stock-market` | Stock Market | 📈 | Green, red, black, gold |
| `frutiger-aero` | Frutiger Aero | 💧 | Glossy tech-blue, grass green, silver, sky |
| `bubblegum` | Bubblegum | 🍬 | Pink, magenta, baby blue, lavender |
| `midnight` | Midnight | 🌙 | Deep indigo, slate, silver, violet |

Each defines all 4 standard roles plus fallback. Exact hex values finalized during implementation with one pass per theme to ensure readability alongside xterm ANSI colors.

## Storage

### Built-in
Constant array in `src/renderer/workspace-themes.ts`. Never persisted.

### Custom (user-created)
Stored via `src/main/themes/themes-store.ts` — existing file gains a new key in its JSON file:

```ts
{
  agentThemes: {...},               // existing — per-agent theme overrides
  customWorkspaceThemes: [...]      // new — array of WorkspaceTheme with source='custom'
}
```

Exposed via new IPC methods:
- `getCustomWorkspaceThemes(): WorkspaceTheme[]`
- `saveCustomWorkspaceTheme(theme: WorkspaceTheme): void`
- `deleteCustomWorkspaceTheme(id: string): void`

### Community
Fetched on-demand from GitHub issues with label `community-theme`. Cached in renderer memory per session.

**Favorite vs Download are distinct:**
- **Favorite (heart icon):** toggles a flag stored locally — a list of favorited community theme IDs in the themes store (`favoritedCommunityThemes: string[]`). Does not copy the theme. Persists across sessions.
- **Download (download icon):** copies the theme into `customWorkspaceThemes` with `source: 'community'`. User can then edit, customize, or re-upload their own version.

## Community sharing

Mirrors the existing community preset flow in `src/main/community/community-client.ts`:

- **Upload:** User clicks star icon on one of their custom themes → opens upload modal to edit label/description/author → clicks upload → `community-client` uses the user's PAT-scoped token to create a new GitHub issue on the central community repo with the theme JSON in the body and label `community-theme`.
- **Browse:** `listCommunityThemes()` fetches open issues with label `community-theme`, parses the JSON bodies, returns them.
- **Favorite:** UI heart button. Favorite = save locally into custom themes. A favorited community theme shows up in both Community tab (still heart-filled) and My Themes tab.

New methods on `community-client.ts`:
- `listCommunityThemes(): Promise<WorkspaceTheme[]>`
- `uploadCommunityTheme(theme: WorkspaceTheme): Promise<void>`

(No server-side moderation. Report/flag functionality can be added later if needed.)

## UI

### Themes tab (in Settings dialog)

New tab alongside the existing ones. Owned by its own component — `src/renderer/components/ThemesTab.tsx` — so `SettingsDialog.tsx` (already 704 lines) doesn't grow further.

Three sub-tabs:

1. **Built-in** — grid of 8 built-in theme cards. No edit/delete controls.
2. **My Themes** — grid of user's custom themes + a "Create New" card. Each card has edit, delete, and star-to-upload buttons.
3. **Community** — grid of themes fetched from GitHub. Each card has heart (favorite flag) and download buttons. Favorited themes show a filled heart and can be filtered via a "Favorites only" toggle at the top of the tab.

### Theme card (`ThemeCard.tsx`)

Compact preview component:
- 2x2 grid of color swatches, each swatch tinted by one standard role's `chrome` color
- Emoji + label underneath
- Hover tooltip: description + author (if present)
- Click = apply flow (see below)

### Apply flow

Clicking any theme card triggers:
1. Confirmation dialog: "Apply [theme name] to all agents?" with a preview of the 4 swatches
2. User confirms → iterate agents, call `setAgentTheme` per agent
3. Toast notification: "Applied [theme name] — N agents updated"

### Create/edit modal (`ThemeEditor.tsx`)

Full-screen modal. Fields:
- Label (text input)
- Emoji (emoji picker or text input)
- Description (optional, textarea)
- Author (optional, pre-filled from the existing community username setting if present)
- Color pickers × 5: orchestrator, worker, researcher, reviewer, fallback — each with the existing color wheel component reused

Live preview of the theme card updates as you edit.

Save button writes via `saveCustomWorkspaceTheme`. Cancel discards.

## File structure

### New files
- `src/renderer/workspace-themes.ts` — `WorkspaceTheme` type, 8 built-ins, `resolveThemeForAgent(theme, role)` helper
- `src/renderer/components/ThemesTab.tsx` — tab UI with sub-tabs and card grid
- `src/renderer/components/ThemeCard.tsx` — 2x2 swatch preview card
- `src/renderer/components/ThemeEditor.tsx` — create/edit modal with color pickers

### Modified files
- `src/renderer/themes.ts` — rename `ThemePreset` → `AgentColorPreset` (find/replace, keep all functionality)
- `src/renderer/components/SettingsDialog.tsx` — add "Themes" tab, delegate to `ThemesTab`
- `src/main/themes/themes-store.ts` — add `getCustomWorkspaceThemes / saveCustomWorkspaceTheme / deleteCustomWorkspaceTheme`
- `src/main/community/community-client.ts` — add `listCommunityThemes / uploadCommunityTheme`
- `src/main/index.ts` — wire new IPC handlers
- `src/preload/index.ts` — expose new IPC methods to renderer
- `src/renderer/electron.d.ts` — type definitions for new IPC
- `src/shared/types.ts` — export `WorkspaceTheme` interface

### Untouched
- All 3DS code (`F:/coding/cog-3ds`) — theme changes flow through existing layout sync
- Cloudflare Worker — no changes needed
- Any agent lifecycle code — theme system only reads agent state, applies via existing IPC

## Non-goals (explicit)

Out of scope for this feature:
- Workspace-level chrome (background, panel tints, accent colors). Strict per-agent only.
- "Active theme" persistence — apply is one-shot, not sticky
- Moderation, flagging, or admin controls on community themes
- Auto-applying a theme to newly spawned agents
- Animation or transition effects when applying
- Exporting themes to disk as files (community upload is the share mechanism)

These can be added later if needed.

## Error handling

- **Community fetch fails:** show inline error in Community tab with retry button; don't block other tabs
- **Community upload fails:** show error toast with the GitHub error message; theme stays in My Themes untouched
- **Delete confirmation:** delete button on My Themes prompts before destroying
- **Apply failure (partial):** if any agent theme IPC fails, log the error, continue with remaining agents, show "Applied with N errors" toast. No rollback — partial apply is acceptable.
- **Invalid community theme JSON:** skip that issue, don't crash the Community list

## Testing

Unit tests for the theme module:
- `resolveThemeForAgent` returns `roles[role]` when role matches
- `resolveThemeForAgent` returns `fallback` when role missing
- Built-in themes all have the 4 standard roles + fallback populated
- `saveCustomWorkspaceTheme` persists correctly
- `deleteCustomWorkspaceTheme` removes correctly

Integration tests:
- Apply flow updates all agents with correct colors
- Community download saves to custom themes store
- Edit modal round-trip preserves all fields

No E2E needed — this is an additive UI feature with existing IPC plumbing.
