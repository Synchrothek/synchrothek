/**
 * Standard-Server, mit dem sich die Extension verbindet.
 * Nutzer können im Popup unter „Einstellungen“ einen eigenen Server eintragen.
 */
export const DEFAULT_SERVER_URL = 'wss://sync.synchrothek.de';

/**
 * Frühere Standardserver. Steht einer davon noch in den gespeicherten Einstellungen, wird er beim
 * Start entfernt, damit der aktuelle Standard greift. Kein offizieller Server: nie ein Token dorthin.
 */
export const LEGACY_SERVER_URLS = ['wss://sync.realtm.de'];

/** Vergleichbare Form einer Server-Adresse (Kleinschreibung, ohne abschließenden Schrägstrich). */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** Seiten, auf denen die Extension Videos synchronisiert. */
export const MEDIATHEK_MATCHES = ['https://*.ardmediathek.de/*', 'https://*.zdf.de/*'];

/**
 * Synchrothek-Konto (OAuth 2.0 auf der offiziellen Plattform, siehe docs/offizielle-dienste.md).
 * Tokens gehen ausschließlich an diese fest eingebauten Adressen.
 */
export const AUTH_BASE_URL = 'https://app.synchrothek.de/api/auth';
export const AUTH_HOST_MATCH = 'https://app.synchrothek.de/*';
/** Seiten der Plattform, auf denen die Versionsabfrage (app-bridge) läuft. */
export const APP_MATCH = 'https://app.synchrothek.de/*';
/**
 * Rückkehrseite der Anmeldung im Tab (Redirect-URI, siehe login-flow.ts). Die Plattform zeigt dort nur den
 * Zustand an; den Code liest das Content-Script login-callback.content.ts und löst nur der Hintergrund ein.
 */
export const AUTH_CALLBACK_URL = 'https://app.synchrothek.de/extension/verbunden';
export const AUTH_CALLBACK_MATCH = 'https://app.synchrothek.de/extension/verbunden*';
/** Issuer des Autorisierungsservers (RFC 9207: `iss` in der Redirect-Antwort). */
export const AUTH_ISSUER = AUTH_BASE_URL;
/** Metadaten des Autorisierungsservers (RFC 8414). */
export const AUTH_DISCOVERY_URL = 'https://app.synchrothek.de/.well-known/oauth-authorization-server/api/auth';
/** Audiences des Access-Tokens: bei der Autorisierung und bei jedem Token-Request mitschicken. */
export const AUTH_RESOURCES = ['https://sync.synchrothek.de', 'https://api.synchrothek.de'];
/**
 * Offizieller Sync-Dienst. Tokens gehen nur an seinen Vermittler (https://sync.synchrothek.de) und an
 * Knoten unter wss://*.sync.synchrothek.de (siehe broker.ts), nie an selbst gehostete Server.
 */
export const OFFICIAL_SYNC_URL: string = DEFAULT_SERVER_URL;

/**
 * API der offiziellen Plattform für Weiterschauen, Marker, Statistik und Freunde (docs/offizielle-dienste.md).
 * Nur aus dem Background aufrufen (keine CORS-Header). Tokens gehen ausschließlich an diese Adresse.
 */
export const API_BASE_URL = 'https://api.synchrothek.de/v1';
export const API_HOST_MATCH = 'https://api.synchrothek.de/*';
