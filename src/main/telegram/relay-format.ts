/**
 * Pure formatting helpers for the shared-DM relay. When several Cog instances
 * relay into one Telegram DM, each message is prefixed with its project so the
 * "heads" are distinguishable. No grammY, no hub — trivially unit-testable.
 */

/** `[Project] ` prefix for a relayed message, or '' when no project is known. */
export function projectPrefix(project?: string): string {
  const p = (project ?? '').trim()
  return p ? `[${p}] ` : ''
}

/** Compose the outbound relay line: `[Project] 💬 Agent:\n<message>`. */
export function formatRelay(project: string | undefined, badge: string, fromName: string, message: string): string {
  return `${projectPrefix(project)}${badge}${fromName}:\n${message}`
}
