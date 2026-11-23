/**
 * Login mit Synchrothek-Konto: OAuth 2.0 Authorization Code mit PKCE (S256).
 * Standard: Anmeldung in einem normalen Tab, Rückkehr über die Seite /extension/verbunden der Plattform
 * (login-flow.ts, login-callback.content.ts). Rückfall: identity.launchWebAuthFlow (eigenes Fenster).
 * Endpunkte der offiziellen Plattform, siehe docs/offizielle-dienste.md.
 *
 * Nur im Background verwenden. Tokens verlassen den Background nie (kein Popup, kein Content-Script)
 * und gehen nur an AUTH_BASE_URL, immer im Body oder Header, nie in einer URL.
 */
import { browser } from 'wxt/browser';
import { AUTH_BASE_URL, AUTH_CALLBACK_URL, AUTH_DISCOVERY_URL, AUTH_HOST_MATCH, AUTH_ISSUER, AUTH_RESOURCES } from './config';
import { getLanguage, msg, tr, type MessageKey, type Msg, type Params } from './i18n/index.ts';
import {
  buildAuthorizeUrl,
  checkAnswer,
  classifyTokenError,
  createPendingStore,
  isBanResponse,
  matchesPending,
  parseCallbackParams,
  PENDING_LOGIN_MAX_AGE_MS,
  withOneRetry,
  type CallbackParams,
  type LoginErrorKind,
  type LoginMode,
  type PendingLogin,
} from './login-flow.ts';
import { deleteSecure, readSecure, writeSecure } from './secure-store';

export { isBanResponse };

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
  | { state: 'signingIn'; where: LoginMode }
  | { state: 'signedIn'; name: string | null };

/** Fehler mit Meldung für die Oberfläche (`text`: wird beim Anzeigen in der aktuellen Sprache übersetzt). */
export class AuthError extends Error {
  readonly text: Msg;
  readonly kind: LoginErrorKind;
  constructor(key: MessageKey, params?: Params, kind: LoginErrorKind = 'failed') {
    const text = msg(key, params);
    super(tr(text));
    this.text = text;
    this.kind = kind;
  }
}

const LOGIN_ERROR_TEXT: Record<LoginErrorKind, MessageKey> = {
  cancelled: 'auth.cancelled',
  expired: 'auth.expired',
  network: 'auth.network',
  server: 'auth.server',
  state: 'auth.invalidState',
  issuer: 'auth.unexpectedIssuer',
  banned: 'account.banned',
  failed: 'auth.failed',
};

/** Fehler der Anmeldung mit Text je Art; `detail` (OAuth-Fehlercode) nur bei `failed`. */
export function loginError(kind: LoginErrorKind, detail?: string): AuthError {
  if (kind === 'failed' && detail) return new AuthError('auth.failedWithCode', { error: detail }, kind);
  return new AuthError(LOGIN_ERROR_TEXT[kind], undefined, kind);
}

/** Ergebnis der Rückkehr aus dem Anmelde-Tab. `matched: false`: gehört zu keiner offenen Anmeldung (nichts verbraucht). */
export type TabLoginResult =
  | { ok: true; returnTabId: number | null }
  | { ok: false; error: AuthError; matched: boolean; returnTabId: number | null };

/** Antwort der Plattform mit OAuth-Fehlercode (z. B. invalid_grant). */
class OAuthResponseError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly description: string | undefined;
  /** Maschinenlesbarer Zusatz der Plattform, z. B. `account_banned`. */
  readonly errorCode: string | undefined;
  constructor(status: number, code: string | undefined, description?: string, errorCode?: string) {
    super(`OAuth-Fehler ${status}${code ? ` (${code})` : ''}`);
    this.status = status;
    this.code = code;
    this.description = description;
    this.errorCode = errorCode;
  }
}

/** Warum die Anmeldung weg ist: abgelaufen/widerrufen/im Konto abgemeldet oder Konto gesperrt. */
export type SessionLostReason = 'expired' | 'banned';

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
      typeof data?.error_code === 'string' ? data.error_code : undefined,
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
  // Offene Anmeldung (Verifier, State, Tab) in storage.session: überlebt einen Neustart des Service Workers.
  // Im Speicher nur Art und Beginn, für die Anzeige im Popup.
  const pendingStore = createPendingStore({
    get: (key) => browser.storage.session.get(key),
    set: (items) => browser.storage.session.set(items),
    remove: (key) => browser.storage.session.remove(key),
  });
  let pendingInfo: { mode: LoginMode; createdAt: number } | null = null;
  let starting = false; // Start einer Anmeldung läuft (bis der Tab bzw. das Fenster offen ist)

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
    try {
      const pending = await pendingStore.load();
      if (pending && pending !== 'expired') pendingInfo = { mode: pending.mode, createdAt: pending.createdAt };
    } catch (err) {
      console.info('Synchrothek: offene Anmeldung nicht lesbar', err);
    }
    onChange();
  });

  function setPendingInfo(pending: PendingLogin | null) {
    pendingInfo = pending ? { mode: pending.mode, createdAt: pending.createdAt } : null;
    onChange();
  }

  /** Erneuert die Tokens. Nur innerhalb von exclusive() aufrufen. */
  async function refreshLocked(current: StoredAuth): Promise<StoredAuth> {
    try {
      const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refreshToken });
      const next = { ...current, ...tokens };
      await save(next); // neues Refresh-Token sofort speichern, bevor irgendetwas weiterläuft
      return next;
    } catch (err) {
      if (err instanceof OAuthResponseError && (err.code === 'invalid_grant' || err.status === 401)) {
        const banned = isBanResponse(err.errorCode, err.description);
        await save(null);
        onSessionLost(banned ? 'banned' : 'expired');
        if (banned) throw new AuthError('account.banned');
        // invalid_grant: abgelaufen, widerrufen oder im Konto abgemeldet (app.synchrothek.de/einstellungen#konto-geraete).
        // Danach gibt es kein Token mehr, Aufrufer bekommen null statt weiterer Fehler.
        throw new AuthError('auth.signedOutAgain');
      }
      throw new AuthError('api.platformUnreachable');
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

  /** Kann die Anmeldung im Tab laufen? Dafür muss das Content-Script der Rückkehrseite laufen dürfen. */
  async function tabLoginPossible(): Promise<boolean> {
    if (typeof browser.tabs?.create !== 'function') return false;
    return browser.permissions.contains({ origins: [AUTH_HOST_MATCH] }).catch(() => false);
  }

  /** Öffnet den Anmelde-Tab neben dem bisherigen Tab (im selben Fenster), sonst im zuletzt aktiven Fenster. */
  async function openLoginTab(url: string, returnTabId: number | null): Promise<number | null> {
    const near = returnTabId === null ? null : await browser.tabs.get(returnTabId).catch(() => null);
    const attempts = near ? [{ url, active: true, windowId: near.windowId, index: near.index + 1 }, { url, active: true }] : [{ url, active: true }];
    for (const props of attempts) {
      const tab = await browser.tabs.create(props).catch((err) => {
        console.info('Synchrothek: Anmelde-Tab nicht geöffnet', err);
        return null;
      });
      if (tab?.id != null) return tab.id;
    }
    return null;
  }

  /** Code mit Verifier eintauschen (ein automatischer Wiederholversuch), Profil laden, speichern. */
  async function exchangeCode(code: string, pending: PendingLogin): Promise<void> {
    let tokens: Awaited<ReturnType<typeof tokenRequest>>;
    try {
      tokens = await withOneRetry(() =>
        tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier }),
      );
    } catch (err) {
      console.warn('Synchrothek: Token-Tausch fehlgeschlagen', err);
      throw loginError(classifyTokenError(err));
    }
    let profile: Profile | null = null;
    try {
      profile = await fetchProfile(tokens.accessToken);
    } catch (err) {
      console.warn('Synchrothek: Profil nicht abrufbar', err); // Anmeldung gilt trotzdem
    }
    await exclusive(() => save({ ...tokens, profile, profileAt: profile ? Date.now() : 0 }));
  }

  /** Antwort der Plattform prüfen und eintauschen. Die offene Anmeldung ist zu diesem Zeitpunkt schon verbraucht. */
  async function finish(params: CallbackParams, pending: PendingLogin): Promise<void> {
    // `iss` fehlt, obwohl der Server es laut Metadaten immer mitschickt: Antwort nicht verwenden
    const announced = params.iss === null && params.error === null && !!params.code ? await issuerParameterAnnounced() : false;
    const answer = checkAnswer(params, AUTH_ISSUER, announced);
    if (!answer.ok) throw loginError(answer.error, answer.detail);
    await exchangeCode(answer.code, pending);
  }

  /** Rückfall: Anmeldung im Fenster von identity.launchWebAuthFlow. */
  async function loginInWindow(pending: PendingLogin, url: string): Promise<void> {
    let result: string | undefined;
    try {
      result = await browser.identity.launchWebAuthFlow({ url, interactive: true });
    } catch (err) {
      console.info('Synchrothek: Login-Fenster beendet', err);
    }
    // Inzwischen durch eine neue Anmeldung ersetzt: still beenden
    const mine = await pendingStore.takeIf((p) => p.state === pending.state);
    if (!mine) {
      if (pendingInfo?.createdAt === pending.createdAt) setPendingInfo(null);
      return;
    }
    setPendingInfo(null);
    if (!result) throw loginError('cancelled');
    let params: CallbackParams;
    try {
      params = parseCallbackParams(result);
    } catch {
      throw loginError('failed');
    }
    if (!matchesPending(mine, params, null)) throw loginError('state');
    await finish(params, mine);
  }

  /**
   * Startet die Anmeldung. Im Tab: kehrt zurück, sobald der Tab offen ist; das Ergebnis kommt über
   * completeTabLogin bzw. loginTabClosed. Im Fenster (Rückfall): kehrt nach der Anmeldung zurück.
   * Eine noch offene Anmeldung wird ersetzt (ihr Tab geschlossen). Wirft AuthError mit Meldung für die Oberfläche.
   */
  async function login({ returnTabId = null }: { returnTabId?: number | null } = {}): Promise<void> {
    if (starting) return;
    starting = true;
    let inWindow: (() => Promise<void>) | null = null;
    try {
      await ready;
      if (record) return;
      const previous = await pendingStore.take();
      setPendingInfo(null);
      if (previous && previous !== 'expired' && previous.mode === 'tab' && previous.tabId !== null) {
        await browser.tabs.remove(previous.tabId).catch(() => {});
      }

      const verifier = randomString(32);
      const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const state = randomString(16);
      const base = { state, verifier, createdAt: Date.now() };
      const authorizeUrl = (redirectUri: string) =>
        buildAuthorizeUrl({
          authBaseUrl: AUTH_BASE_URL,
          clientId: CLIENT_ID,
          redirectUri,
          scope: SCOPE,
          state,
          codeChallenge: challenge,
          resources: AUTH_RESOURCES,
          lang: getLanguage(),
        });

      if (await tabLoginPossible()) {
        const pending: PendingLogin = { ...base, mode: 'tab', redirectUri: AUTH_CALLBACK_URL, tabId: null, returnTabId };
        // Vor dem Öffnen speichern (ohne Tab passt noch keine Rückkehr), danach mit Tab
        await pendingStore.save(pending);
        const tabId = await openLoginTab(authorizeUrl(pending.redirectUri), returnTabId);
        if (tabId !== null) {
          const withTab = { ...pending, tabId };
          await pendingStore.save(withTab);
          setPendingInfo(withTab);
          return;
        }
        await pendingStore.clear();
      }

      const redirectUri = browser.identity.getRedirectURL();
      const pending: PendingLogin = { ...base, mode: 'window', redirectUri, tabId: null, returnTabId: null };
      await pendingStore.save(pending);
      setPendingInfo(pending);
      inWindow = () => loginInWindow(pending, authorizeUrl(redirectUri));
    } finally {
      starting = false;
    }
    // Während das Fenster offen ist, darf eine neue Anmeldung diese ersetzen
    if (inWindow) await inWindow();
  }

  /**
   * Rückkehr aus dem Anmelde-Tab (Nachricht des Content-Scripts, Absender schon geprüft: eigenes
   * Content-Script, oberster Frame, Rückkehrseite). Ordnet sie über Tab und State der offenen
   * Anmeldung zu und tauscht den Code ein. Wirft nicht.
   */
  async function completeTabLogin(tabId: number, params: CallbackParams): Promise<TabLoginResult> {
    await ready;
    let pending: PendingLogin | null;
    try {
      const current = await pendingStore.load();
      if (current === 'expired') {
        setPendingInfo(null);
        return { ok: false, error: loginError('expired'), matched: false, returnTabId: null };
      }
      // Nur verbrauchen, wenn Tab und State passen; sonst bleibt die offene Anmeldung bestehen
      pending = current && matchesPending(current, params, tabId) ? await pendingStore.takeIf((p) => p.state === current.state) : null;
    } catch (err) {
      console.warn('Synchrothek: offene Anmeldung nicht lesbar', err);
      return { ok: false, error: loginError('failed'), matched: false, returnTabId: null };
    }
    if (!pending) return { ok: false, error: loginError('state'), matched: false, returnTabId: null };
    setPendingInfo(null);
    if (record) return { ok: true, returnTabId: pending.returnTabId }; // inzwischen anders angemeldet
    try {
      await finish(params, pending);
      return { ok: true, returnTabId: pending.returnTabId };
    } catch (err) {
      const error = err instanceof AuthError ? err : loginError('failed');
      if (!(err instanceof AuthError)) console.warn('Synchrothek: Anmeldung fehlgeschlagen', err);
      return { ok: false, error, matched: true, returnTabId: pending.returnTabId };
    }
  }

  /** Anmelde-Tab geschlossen: offene Anmeldung abbrechen. Liefert true, wenn es der Tab einer offenen Anmeldung war. */
  async function loginTabClosed(tabId: number): Promise<boolean> {
    await ready;
    const pending = await pendingStore.takeIf((p) => p.mode === 'tab' && p.tabId === tabId).catch(() => null);
    if (!pending) return false;
    setPendingInfo(null);
    return true;
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

  /** Läuft eine Anmeldung? (Nach 15 Minuten gilt sie als verfallen, auch ohne Aufräumen.) */
  function signingIn(): boolean {
    return !!pendingInfo && Date.now() - pendingInfo.createdAt < PENDING_LOGIN_MAX_AGE_MS;
  }

  function status(): AccountStatus {
    if (!record && pendingInfo && signingIn()) return { state: 'signingIn', where: pendingInfo.mode };
    if (record) return { state: 'signedIn', name: record.profile?.name ?? null };
    return { state: 'signedOut' };
  }

  /** Profil im Hintergrund auffrischen, wenn es älter als eine Stunde ist. */
  function refreshProfileIfStale() {
    if (!record || Date.now() - record.profileAt < PROFILE_MAX_AGE_MS) return;
    updateProfile().catch((err) => console.info('Synchrothek: Profil nicht aktualisiert', err));
  }

  return { ready, login, completeTabLogin, loginTabClosed, logout, status, getAccessToken, refreshProfileIfStale, clientId: CLIENT_ID };
}
