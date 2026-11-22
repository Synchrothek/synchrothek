/**
 * Client-Konfiguration der Plattform: GET /v1/client-config (API der offiziellen Plattform).
 * Einziger Endpunkt ohne Token, für alle Extensions, auch ohne Konto. Fehler beim Abruf werden ignoriert.
 *
 * Ohne Abhängigkeit von `browser`, damit sich das Modul unter Node testen lässt.
 */
import { API_BASE_URL } from './config.ts';

export interface ClientConfig {
  minExtensionVersion: string | null; // x.y.z
  notice: string | null; // Wartungshinweis, nur als Text anzeigen
}

const VERSION = /^\d+(\.\d+){0,3}$/;
const NOTICE_MAX = 300;
const REQUEST_TIMEOUT_MS = 10_000;
export const CLIENT_CONFIG_MAX_AGE_MS = 5 * 60_000; // Cache-Control: max-age=300

/**
 * Versionen numerisch je Stelle vergleichen (0.10.0 > 0.4.0). Fehlende Stellen zählen als 0,
 * Zusätze wie „-beta“ werden ignoriert. Ergebnis < 0, 0 oder > 0.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/, 1)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Ist die eigene Version älter als die geforderte? */
export function needsUpdate(own: string, config: ClientConfig | null): boolean {
  return !!config?.minExtensionVersion && compareVersions(own, config.minExtensionVersion) < 0;
}

/** Antwort prüfen: nur erwartete Felder, Hinweis als einzeiliger Text. */
export function parseClientConfig(data: unknown): ClientConfig | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  const min = typeof o.minExtensionVersion === 'string' && VERSION.test(o.minExtensionVersion) ? o.minExtensionVersion : null;
  const notice =
    typeof o.notice === 'string' ? [...o.notice.replace(/\s+/g, ' ').trim()].slice(0, NOTICE_MAX).join('') || null : null;
  return { minExtensionVersion: min, notice };
}

/** Abruf ohne Token und ohne Cookies. Liefert null bei jedem Fehler. */
export async function fetchClientConfig(doFetch: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<ClientConfig | null> {
  try {
    const res = await doFetch(`${API_BASE_URL}/client-config`, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return null;
    return parseClientConfig(await res.json());
  } catch {
    return null;
  }
}
