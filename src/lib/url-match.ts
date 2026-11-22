/**
 * Adressen gegen Match-Patterns der Extension prüfen (echte Host-Prüfung, kein Textvergleich).
 *
 * Unterstützt die Form, die die Extension verwendet: `https://*.beispiel.de/*` bzw. `https://host/*`.
 * `*.beispiel.de` passt auf beispiel.de und alle Subdomains, nicht auf `xbeispiel.de` oder `beispiel.de.evil`.
 * Ohne Abhängigkeit von `browser`, damit sich das Modul unter Node testen lässt.
 */
import { APP_MATCH, MEDIATHEK_MATCHES } from './config.ts';

interface Pattern {
  scheme: string; // z. B. 'https:'
  host: string; // ohne '*.'
  subdomains: boolean;
}

function parsePattern(pattern: string): Pattern | null {
  const m = /^(https?):\/\/(\*\.)?([a-z0-9.-]+)\/\*$/.exec(pattern);
  return m ? { scheme: `${m[1]}:`, subdomains: !!m[2], host: m[3]! } : null;
}

/** Passt die Adresse (nur https, ohne Zugangsdaten, Standard-Port) auf eines der Patterns? */
export function matchesAny(raw: unknown, patterns: readonly string[]): boolean {
  if (typeof raw !== 'string' || raw.length > 4096) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.replace(/\.$/, '');
  return patterns.some((p) => {
    const pattern = parsePattern(p);
    if (!pattern || pattern.scheme !== url.protocol) return false;
    return host === pattern.host || (pattern.subdomains && host.endsWith(`.${pattern.host}`));
  });
}

/** Seite einer unterstützten Mediathek (https, Host aus MEDIATHEK_MATCHES)? */
export const isMediathekUrl = (raw: unknown): raw is string => matchesAny(raw, MEDIATHEK_MATCHES);

/** Seite der offiziellen Plattform (Versionsabfrage)? */
export const isAppUrl = (raw: unknown): raw is string => matchesAny(raw, [APP_MATCH]);
