/** Sendernamen am Ende von Seitentiteln („Tatort | ARD Mediathek“), für eine lesbare Anzeige. */
const TITLE_SUFFIX = /\s*[|–—-]\s*(ARD[ -]?Mediathek|ZDF[ -]?mediathek|ZDF)\s*$/i;

export function cleanTitle(raw: string | null | undefined): string {
  return (raw ?? '').replace(TITLE_SUFFIX, '').replace(/\s+/g, ' ').trim();
}
