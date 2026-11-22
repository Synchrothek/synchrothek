/**
 * Zeigen beide URLs auf dieselbe Sendung?
 * Vergleicht Host (ohne „www.“) und Pfad; Query, Hash und abschließender Slash werden ignoriert.
 */
export function sameContent(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const host = (u: URL) => u.hostname.replace(/^www\./, '');
    const path = (u: URL) => u.pathname.replace(/\/+$/, '');
    return host(ua) === host(ub) && path(ua) === path(ub);
  } catch {
    return a === b;
  }
}
