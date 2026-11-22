/**
 * Name des Formats (Serie, Reihe) aus den strukturierten Daten einer Mediathek-Seite (JSON-LD),
 * z. B. `partOfSeries.name`. Die Plattform fasst damit Folgen in der Statistik zusammen.
 * Fehlt die Angabe (Filme, Einzelstücke), bleibt es bei null.
 *
 * Ohne Abhängigkeit von `browser` oder dem DOM, damit sich das Modul unter Node testen lässt.
 */

const SERIES_KEYS = ['partOfSeries', 'partOfTVSeries', 'partOfSeason'] as const;
const MAX_LENGTH = 300;
const MAX_NODES = 500;

function nameOf(raw: unknown): string | null {
  const node = Array.isArray(raw) ? raw[0] : raw;
  if (!node || typeof node !== 'object') return null;
  const o = node as Record<string, unknown>;
  // Staffel: deren Serie bevorzugen
  if (o.partOfSeries) return nameOf(o.partOfSeries);
  const name = typeof o.name === 'string' ? o.name : null;
  if (!name) return null;
  const clean = [...name.replace(/\s+/g, ' ').trim()].slice(0, MAX_LENGTH).join('').trim();
  return clean || null;
}

/** Erster Formatname in den JSON-LD-Blöcken der Seite (Texte der `<script type="application/ld+json">`). */
export function seriesFromJsonLd(blocks: readonly string[]): string | null {
  let visited = 0;
  const walk = (value: unknown, depth: number): string | null => {
    if (!value || typeof value !== 'object' || depth > 6 || ++visited > MAX_NODES) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const o = value as Record<string, unknown>;
    for (const key of SERIES_KEYS) {
      const found = nameOf(o[key]);
      if (found) return found;
    }
    for (const key of ['@graph', 'mainEntity', 'video', 'episode']) {
      const found = walk(o[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  for (const text of blocks.slice(0, 20)) {
    if (text.length > 200_000) continue;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    const found = walk(data, 0);
    if (found) return found;
  }
  return null;
}
