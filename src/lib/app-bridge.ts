/**
 * Versionsabfrage durch app.synchrothek.de („Hilfe & Kontakt“).
 * Handshake wie von der offiziellen Plattform vorgegeben (window.postMessage, nur dieselbe Origin).
 *
 * Beantwortet genau eine Anfrage der Seite und gibt nur Version und Browser heraus:
 * keine Tokens, keine Konto-, Raum-, Verlaufs- oder Einstellungsdaten, keine Extension-ID.
 */

export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export type BrowserName = 'chrome' | 'firefox';

export interface ExtensionInfo {
  source: 'synchrothek-extension';
  type: 'extension-info';
  nonce: string;
  version: string;
  browser: BrowserName;
}

/** Die Teile eines MessageEvent, die geprüft werden. */
export interface IncomingMessage {
  source: unknown;
  origin: string;
  data: unknown;
}

/**
 * Antwort auf eine Anfrage der Seite, oder null, wenn die Nachricht nicht exakt passt.
 * `self`: das eigene Fenster, `origin`: dessen Origin (location.origin).
 */
export function answerFor(
  event: IncomingMessage,
  self: unknown,
  origin: string,
  info: { version: string; browser: BrowserName },
): ExtensionInfo | null {
  if (event.source !== self) return null; // nicht aus iframes oder anderen Fenstern
  if (event.origin !== origin) return null;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { source, type, nonce } = data as Record<string, unknown>;
  if (source !== 'synchrothek-app' || type !== 'extension-info-request') return null;
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return null;
  return { source: 'synchrothek-extension', type: 'extension-info', nonce, version: info.version, browser: info.browser };
}
