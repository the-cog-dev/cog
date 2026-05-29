import * as fs from 'fs'
import * as path from 'path'

/**
 * Resolves `requestedPath` against `projectRoot` and rejects (returns null)
 * any path that escapes the root — directly, via `..`, or via a symlink that
 * lexically lives inside the root but targets something outside.
 *
 * The realpath check matters because an attacker with project-write access
 * could plant a symlink whose lexical path is inside the root but whose
 * target is arbitrary (e.g. /etc/passwd). For not-yet-existing targets we
 * realpath the parent so a symlinked parent can't escape the sandbox on a
 * subsequent write.
 *
 * Returns the absolute resolved path (lexical, not the realpath) suitable
 * for fs.readFileSync/writeFileSync. Returns null when the path is invalid
 * or escapes the sandbox.
 */
export function resolveProjectPath(projectRoot: string | null, requestedPath: string): string | null {
  if (!projectRoot) return null
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) return null
  const root = path.resolve(projectRoot)
  const resolved = path.resolve(root, requestedPath)
  let realResolved = resolved
  try {
    realResolved = fs.realpathSync(resolved)
  } catch { /* path doesn't exist yet — safe, containment checked below */ }
  let anchor = realResolved
  if (!fs.existsSync(realResolved)) {
    try { anchor = fs.realpathSync(path.dirname(resolved)) } catch { anchor = path.dirname(resolved) }
  }
  let realRoot = root
  try { realRoot = fs.realpathSync(root) } catch { /* keep lexical */ }
  const normalize = (p: string): string => p.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedRoot = normalize(realRoot)
  const normalizedResolved = normalize(realResolved)
  const normalizedAnchor = normalize(anchor)
  // Append separator so `/home/u/proj` doesn't match `/home/u/proj-evil`.
  const rootWithSep = normalizedRoot + '/'
  const inRoot = (p: string): boolean => p === normalizedRoot || p.startsWith(rootWithSep)
  if (!inRoot(normalizedResolved)) return null
  if (!inRoot(normalizedAnchor)) return null
  return resolved
}
