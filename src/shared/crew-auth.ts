// Used by RacPanel and TrollboxPanel to gate admin UI surfaces.
// This is purely a client-side "hide the button" check — it carries no
// security weight. Real security comes from signed admin messages (for
// Trollbox) or the R.A.C. server (for RacPanel).
export async function hashCrewPassword(pw: string): Promise<string> {
  const data = new TextEncoder().encode(pw)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// sha256 of the shared crew password. Single source of truth for both the
// R.A.C. panel unlock and the Trollbox admin drawer unlock. Rotating the
// crew password means updating this one constant, not two.
export const CREW_ACCESS_HASH =
  '368fa83a780bba3be2be74ed7560b7a5d8dc46639f4646c997d631bc548ecda9'
