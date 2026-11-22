/**
 * Login mit Synchrothek-Konto: OAuth 2.0 Authorization Code mit PKCE (S256) über identity.launchWebAuthFlow.
 * Endpunkte der offiziellen Plattform, siehe docs/offizielle-dienste.md.
 *
 * Nur im Background verwenden. Tokens verlassen den Background nie (kein Popup, kein Content-Script)
 * und gehen nur an AUTH_BASE_URL, immer im Body oder Header, nie in einer URL.
 */
import { browser } from 'wxt/browser';
import { AUTH_BASE_URL, AUTH_DISCOVERY_URL, AUTH_ISSUER, AUTH_RESOURCES } from './config';
import { deleteSecure, readSecure, writeSecure } from './secure-store';

const CLIENT_ID =
  import.meta.env.MODE !== 'production'
    ? 'synchrothek-dev'
    : import.meta.env.FIREFOX
      ? 'synchrothek-firefox'
      : 'synchrothek-chrome';
const SCOPE = 'openid profile offline_access';
const STORE_KEY = 'auth';
const REFRESH_MARGIN_MS = 60_000; // Access-Token so lange vor Ablauf erneuern
const PROFILE_MAX_AGE_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface Profile {
  sub: string;
  name: string | null;
}

interface StoredAuth {
  clientId: string;
  accessToken: string;
  accessExpiresAt: number; // lokale Uhr
  refreshToken: string;
  profile: Profile | null;
  profileAt: number;
}

export type AccountStatus =
  | { state: 'signedOut' }
  | { state: 'signingIn' }
  | { state: 'signedIn'; name: string | null };

/** Fehler mit deutscher Meldung für die Oberfläche. */
export class AuthError extends Error {}

/** Antwort der Plattform mit OAuth-Fehlercode (z. B. invalid_grant). */
class OAuthResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly description?: string,
  ) {
    super(`OAuth-Fehler ${status}${code ? ` (${code})` : ''}`);
  }
}

/** Warum die Anmeldung weg ist: abgelaufen/widerrufen/im Konto abgemeldet oder Konto gesperrt. */
export type SessionLostReason = 'expired' | 'banned';

/** `invalid_grant` eines gesperrten Kontos (error_description „Dieses Konto ist gesperrt.“). */
export function isBanDescription(description: string | undefined): boolean {
  return !!description && /gesperrt/i.test(description);
}

export interface AuthCallbacks {
  /** Kontostatus hat sich geändert. */
  onChange(): void;
  /** Anmeldung serverseitig ungültig geworden (Refresh-Token abgelaufen, widerrufen, wiederverwendet; Konto gesperrt). */
  onSessionLost(reason: SessionLostReason): void;
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const randomString = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** POST als Formular an einen festen Endpunkt der Plattform. Ohne Cookies, ohne Weiterleitungen. */
async function postForm(path: string, body: URLSearchParams): Promise<Response> {
  return fetch(`${AUTH_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function tokenRequest(params: Record<string, string>): Promise<Omit<StoredAuth, 'profile' | 'profileAt'>> {
  const body = new URLSearchParams({ ...params, client_id: CLIENT_ID });
  for (const r of AUTH_RESOURCES) body.append('resource', r);
  const res = await postForm('/oauth2/token', body);
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new OAuthResponseError(
      res.status,
      typeof data?.error === 'string' ? data.error : undefined,
      typeof data?.error_description === 'string' ? data.error_description : undefined,
    );
  }
  const { access_token, refresh_token, expires_in } = data ?? {};
  if (typeof access_token !== 'string' || typeof refresh_token !== 'string') {
    throw new OAuthResponseError(res.status, 'invalid_response');
  }
  const lifetime = typeof expires_in === 'number' && expires_in > 0 ? expires_in : 600;
  return {
    clientId: CLIENT_ID,
    accessToken: access_token,
    accessExpiresAt: Date.now() + lifetime * 1000,
    refreshToken: refresh_token,
  };
}

/**
 * Kündigt der Autorisierungsserver `iss` in der Redirect-Antwort an (RFC 9207, Metadaten nach RFC 8414)?
 * Nicht abrufbar: false (nur ein fest eingebauter Autorisierungsserver, die Prüfung ist Zusatzschutz).
 */
let issAnnounced: Promise<boolean> | null = null;
function issuerParameterAnnounced(): Promise<boolean> {
  issAnnounced ??= fetch(AUTH_DISCOVERY_URL, {
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: unknown) => (data as Record<string, unknown> | null)?.authorization_response_iss_parameter_supported === true)
    .catch(() => {
      issAnnounced = null; // beim nächsten Login erneut fragen
      return false;
    });
  return issAnnounced;
}

async function fetchProfile(accessToken: string): Promise<Profile> {
  const res = await fetch(`${AUTH_BASE_URL}/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new OAuthResponseError(res.status, undefined);
  const data = (await res.json()) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof data[k] === 'string' && data[k]) return data[k] as string;
    return null;
  };
  return { sub: pick('sub') ?? '', name: pick('preferred_username', 'username', 'name') };
}

export function createAuth({ onChange, onSessionLost }: AuthCallbacks) {
  let record: StoredAuth | null = null;
  let signingIn = false;

  // Alle Zugriffe auf die gespeicherten Tokens laufen nacheinander. So gibt es nie zwei
  // Erneuerungen gleichzeitig: Ein Refresh-Token gilt genau einmal, eine Wiederverwendung
  // sperrt auf der Plattform alle Tokens dieses Logins.
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn, fn);
    queue = result.catch(() => {});
    return result;
  }

  async function save(next: StoredAuth | null) {
    if (next) await writeSecure(STORE_KEY, next);
    else await deleteSecure(STORE_KEY);
    record = next;
    onChange();
  }

  const ready = exclusive(async () => {
    try {
      const stored = await readSecure<StoredAuth>(STORE_KEY);
      // Tokens eines anderen Clients (z. B. Entwicklungs-Build) nicht verwenden
      record = stored && stored.clientId === CLIENT_ID ? stored : null;
    } catch (err) {
      console.warn('Synchrothek: Anmeldedaten nicht lesbar', err);
    }
    onChange();
  });

  /** Erneuert die Tokens. Nur innerhalb von exclusive() aufrufen. */
  async function refreshLocked(current: StoredAuth): Promise<StoredAuth> {
    try {
      const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refreshToken });
      const next = { ...current, ...tokens };
      await save(next); // neues Refresh-Token sofort speichern, bevor irgendetwas weiterläuft
      return next;
    } catch (err) {
      if (err instanceof OAuthResponseError && (err.code === 'invalid_grant' || err.status === 401)) {
        const banned = isBanDescription(err.description);
        await save(null);
        onSessionLost(banned ? 'banned' : 'expired');
        if (banned) throw new AuthError('Dieses Konto ist gesperrt.');
        // invalid_grant: abgelaufen, widerrufen oder im Konto abgemeldet (app.synchrothek.de/einstellungen#konto-geraete).
        // Danach gibt es kein Token mehr, Aufrufer bekommen null statt weiterer Fehler.
        throw new AuthError('Du bist nicht mehr angemeldet. Bitte melde dich erneut an.');
      }
      throw new AuthError('Die Synchrothek-Plattform ist gerade nicht erreichbar.');
    }
  }

  /**
   * Gültiges Access-Token (erneuert es bei Bedarf), oder null ohne Anmeldung.
   * `minValidMs`: Mindest-Restlaufzeit, sonst wird erneuert. `forceRefresh`: immer erneuern.
   * Nur für Anfragen an die fest eingebauten offiziellen Adressen verwenden.
   */
  function getAccessToken({ forceRefresh = false, minValidMs = REFRESH_MARGIN_MS } = {}): Promise<string | null> {
    return exclusive(async () => {
      if (!record) return null;
      const remaining = record.accessExpiresAt - Date.now();
      if (!forceRefresh && remaining > Math.max(minValidMs, REFRESH_MARGIN_MS)) return record.accessToken;
      return (await refreshLocked(record)).accessToken;
    });
  }

  async function updateProfile(): Promise<void> {
    const token = await getAccessToken();
    if (!token) return;
    const profile = await fetchProfile(token);
    await exclusive(async () => {
      if (record) await save({ ...record, profile, profileAt: Date.now() });
    });
  }

  /** Startet den Login im Browserfenster der Plattform. Wirft AuthError mit Meldung für die Oberfläche. */
  async function login(): Promise<void> {
    await ready;
    if (signingIn || record) return;
    signingIn = true;
    onChange();
    try {
      const redirectUri = browser.identity.getRedirectURL();
      const verifier = randomString(32);
      const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const state = randomString(16);

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      for (const r of AUTH_RESOURCES) params.append('resource', r);

      let result: string | undefined;
      try {
        result = await browser.identity.launchWebAuthFlow({ url: `${AUTH_BASE_URL}/oauth2/authorize?${params}`, interactive: true });
      } catch (err) {
        console.info('Synchrothek: Login-Fenster beendet', err);
        throw new AuthError('Anmeldung abgebrochen.');
      }
      if (!result) throw new AuthError('Anmeldung abgebrochen.');

      const back = new URL(result);
      // Antwort kann im Query oder (bei manchen Fehlern) im Fragment stehen
      const answer = back.search ? back.searchParams : new URLSearchParams(back.hash.slice(1));
      if (answer.get('state') !== state) throw new AuthError('Anmeldung fehlgeschlagen (ungültige Antwort).');
      // RFC 9207: Steht `iss` in der Antwort, muss es der fest eingebaute Aussteller sein
      const iss = answer.get('iss');
      if (iss !== null && iss !== AUTH_ISSUER) throw new AuthError('Anmeldung fehlgeschlagen (unerwarteter Aussteller).');
      const error = answer.get('error');
      if (error) throw new AuthError(error === 'access_denied' ? 'Anmeldung abgebrochen.' : `Anmeldung fehlgeschlagen (${error}).`);
      const code = answer.get('code');
      if (!code) throw new AuthError('Anmeldung fehlgeschlagen (kein Code erhalten).');
      // Fehlt `iss`, obwohl der Server es laut Metadaten immer mitschickt: Antwort nicht verwenden
      if (iss === null && (await issuerParameterAnnounced())) {
        throw new AuthError('Anmeldung fehlgeschlagen (Antwort ohne Aussteller).');
      }

      let tokens: Awaited<ReturnType<typeof tokenRequest>>;
      try {
        tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
      } catch (err) {
        console.warn('Synchrothek: Token-Tausch fehlgeschlagen', err);
        throw new AuthError('Anmeldung fehlgeschlagen. Bitte versuche es noch einmal.');
      }

      let profile: Profile | null = null;
      try {
        profile = await fetchProfile(tokens.accessToken);
      } catch (err) {
        console.warn('Synchrothek: Profil nicht abrufbar', err); // Anmeldung gilt trotzdem
      }
      await exclusive(() => save({ ...tokens, profile, profileAt: profile ? Date.now() : 0 }));
    } finally {
      signingIn = false;
      onChange();
    }
  }

  /** Widerruft das Refresh-Token und löscht danach alles lokal. Liefert false, wenn der Widerruf scheiterte. */
  function logout(): Promise<boolean> {
    return exclusive(async () => {
      if (!record) return true;
      let revoked = false;
      try {
        const res = await postForm(
          '/oauth2/revoke',
          new URLSearchParams({ token: record.refreshToken, token_type_hint: 'refresh_token', client_id: CLIENT_ID }),
        );
        revoked = res.ok;
      } catch (err) {
        console.warn('Synchrothek: Widerruf fehlgeschlagen', err);
      }
      await save(null);
      return revoked;
    });
  }

  function status(): AccountStatus {
    if (signingIn) return { state: 'signingIn' };
    if (record) return { state: 'signedIn', name: record.profile?.name ?? null };
    return { state: 'signedOut' };
  }

  /** Profil im Hintergrund auffrischen, wenn es älter als eine Stunde ist. */
  function refreshProfileIfStale() {
    if (!record || signingIn || Date.now() - record.profileAt < PROFILE_MAX_AGE_MS) return;
    updateProfile().catch((err) => console.info('Synchrothek: Profil nicht aktualisiert', err));
  }

  return { ready, login, logout, status, getAccessToken, refreshProfileIfStale, clientId: CLIENT_ID };
}
