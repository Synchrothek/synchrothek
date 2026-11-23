/**
 * Login mit Synchrothek-Konto: Bausteine ohne Abhängigkeit von `browser` (unter Node testbar).
 *
 * Ablauf (Standard ab 0.6.0): Die Anmeldung läuft in einem normalen Tab. Redirect-URI ist die Seite
 * `https://app.synchrothek.de/extension/verbunden` der offiziellen Plattform; dort liest ein eigenes
 * Content-Script (login-callback.content.ts) `code`, `state`, `iss` bzw. `error` aus der Adresse und
 * schickt sie per runtime.sendMessage an den Hintergrund. Der Hintergrund nimmt die Nachricht nur an,
 * wenn Absender, Tab und `state` zur offenen Anmeldung passen (loginCallbackTabId, checkCallback),
 * und tauscht den Code mit dem PKCE-Verifier ein. Ohne Verifier ist der Code wertlos.
 *
 * Die offene Anmeldung (Verifier, State, Tab) liegt in storage.session, damit ein Neustart des Service
 * Workers sie nicht verliert. Sie gilt 15 Minuten und genau einmal.
 *
 * Rückfall: identity.launchWebAuthFlow (eigenes Fenster), z. B. wenn kein Tab geöffnet werden kann.
 */
import { AUTH_CALLBACK_URL } from './config.ts';

/** Wie lange eine offene Anmeldung gilt (die signierte Anfrage der Plattform erneuert sich selbst). */
export const PENDING_LOGIN_MAX_AGE_MS = 15 * 60_000;
/** Schlüssel in storage.session. */
export const PENDING_LOGIN_KEY = 'pendingLogin';
/** Typ der einzigen Einzelnachricht, die der Hintergrund annimmt (vom Content-Script der Rückkehrseite). */
export const LOGIN_CALLBACK_MESSAGE = 'synchrothek-login-callback';

/**
 * Abstimmung mit der Rückkehrseite der Plattform über Attribute am <html>-Element (keine Daten, nur Zustand):
 * `data-synchrothek-login` = `received` (Extension hat die Antwort gelesen; die Seite darf sie aus der Adresse
 * entfernen) | `done` (verbunden) | `error`; bei `error` zusätzlich `data-synchrothek-login-error` = LoginErrorKind.
 */
export const LOGIN_STATUS_ATTRIBUTE = 'data-synchrothek-login';
export const LOGIN_ERROR_ATTRIBUTE = 'data-synchrothek-login-error';

export type LoginMode = 'tab' | 'window';

export interface PendingLogin {
  mode: LoginMode;
  state: string;
  verifier: string;
  redirectUri: string;
  /** Tab der Anmeldung (nur `tab`), null bis er geöffnet ist. */
  tabId: number | null;
  /** Tab, der danach wieder aktiviert wird (falls es ihn noch gibt). */
  returnTabId: number | null;
  createdAt: number;
}

/**
 * Fehlerarten der Anmeldung (Texte in der Extension: auth.ts, auf der Rückkehrseite: Plattform).
 * - cancelled: Tab/Fenster geschlossen oder „Abbrechen“ (access_denied)
 * - expired: offene Anmeldung abgelaufen (15 min) bzw. Code abgelaufen/benutzt (invalid_grant)
 * - network: Plattform nicht erreichbar oder Zeitüberschreitung (mit „Erneut versuchen“)
 * - server: Fehler der Plattform (5xx, unerwartete Antwort; mit „Erneut versuchen“)
 * - state: Antwort passt zu keiner offenen Anmeldung (State, Tab)
 * - issuer: `iss` fehlt oder ist nicht der fest eingebaute Aussteller
 * - banned: Konto gesperrt
 * - failed: sonstige Fehler (z. B. anderer OAuth-Fehlercode, kein Code)
 */
export type LoginErrorKind = 'cancelled' | 'expired' | 'network' | 'server' | 'state' | 'issuer' | 'banned' | 'failed';
export const LOGIN_ERROR_KINDS: readonly LoginErrorKind[] = ['cancelled', 'expired', 'network', 'server', 'state', 'issuer', 'banned', 'failed'];

/** Ergebnis der Rückkehr, als Antwort an das Content-Script. */
export type LoginCallbackResult = { ok: true } | { ok: false; error: LoginErrorKind };

// -----------------------------------------------------------------------------
// Offene Anmeldung (storage.session)
// -----------------------------------------------------------------------------

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isToken = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(v);

/** Gespeicherter Wert → offene Anmeldung, `expired` (zu alt) oder null (keine bzw. unbrauchbar). */
export function parsePending(value: unknown, now = Date.now()): PendingLogin | 'expired' | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.mode !== 'tab' && v.mode !== 'window') return null;
  if (!isToken(v.state) || !isToken(v.verifier) || typeof v.redirectUri !== 'string') return null;
  if (typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return null;
  if (v.tabId !== null && !isId(v.tabId)) return null;
  if (v.returnTabId !== null && !isId(v.returnTabId)) return null;
  // Uhr zurückgestellt: nicht ewig gültig
  if (now - v.createdAt > PENDING_LOGIN_MAX_AGE_MS || v.createdAt - now > 60_000) return 'expired';
  return {
    mode: v.mode,
    state: v.state,
    verifier: v.verifier,
    redirectUri: v.redirectUri,
    tabId: v.tabId,
    returnTabId: v.returnTabId,
    createdAt: v.createdAt,
  };
}

/** Der Teil von storage.session, der gebraucht wird (in Tests ersetzbar). */
export interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface PendingStore {
  /** Aktuelle offene Anmeldung; eine abgelaufene wird dabei gelöscht (`expired`). */
  load(): Promise<PendingLogin | 'expired' | null>;
  save(pending: PendingLogin): Promise<void>;
  /** Holt und löscht die offene Anmeldung in einem Schritt (einmalig verwendbar). */
  take(): Promise<PendingLogin | 'expired' | null>;
  /** Löscht sie nur, wenn sie noch dieselbe ist (gleicher State). */
  takeIf(match: (pending: PendingLogin) => boolean): Promise<PendingLogin | null>;
  clear(): Promise<void>;
}

/** Speicher der offenen Anmeldung. Alle Zugriffe laufen nacheinander, damit `take` wirklich nur einmal liefert. */
export function createPendingStore(area: SessionArea, now: () => number = Date.now): PendingStore {
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn, fn);
    queue = result.catch(() => {});
    return result;
  }
  async function read(): Promise<PendingLogin | 'expired' | null> {
    const stored = (await area.get(PENDING_LOGIN_KEY))[PENDING_LOGIN_KEY];
    if (stored === undefined) return null;
    const pending = parsePending(stored, now());
    if (pending === null || pending === 'expired') await area.remove(PENDING_LOGIN_KEY);
    return pending;
  }
  return {
    load: () => serial(read),
    save: (pending) => serial(() => area.set({ [PENDING_LOGIN_KEY]: pending })),
    take: () =>
      serial(async () => {
        const pending = await read();
        if (pending && pending !== 'expired') await area.remove(PENDING_LOGIN_KEY);
        return pending;
      }),
    takeIf: (match) =>
      serial(async () => {
        const pending = await read();
        if (!pending || pending === 'expired' || !match(pending)) return null;
        await area.remove(PENDING_LOGIN_KEY);
        return pending;
      }),
    clear: () => serial(() => area.remove(PENDING_LOGIN_KEY)),
  };
}

// -----------------------------------------------------------------------------
// Autorisierungs-URL
// -----------------------------------------------------------------------------

export interface AuthorizeRequest {
  authBaseUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  resources: readonly string[];
  lang: string;
}

export function buildAuthorizeUrl(r: AuthorizeRequest): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: r.clientId,
    redirect_uri: r.redirectUri,
    scope: r.scope,
    state: r.state,
    code_challenge: r.codeChallenge,
    code_challenge_method: 'S256',
    // Sprache der Anmeldeseite: `lang` wie bei allen Links auf die Plattform, `ui_locales` nach OpenID Connect
    lang: r.lang,
    ui_locales: r.lang,
  });
  for (const resource of r.resources) params.append('resource', resource);
  return `${r.authBaseUrl}/oauth2/authorize?${params}`;
}

// -----------------------------------------------------------------------------
// Rückkehr: Parameter, Nachricht, Absender
// -----------------------------------------------------------------------------

export interface CallbackParams {
  code: string | null;
  state: string | null;
  iss: string | null;
  error: string | null;
}

const MAX_PARAM_LENGTH = 2048;

function param(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  return value === null || value.length > MAX_PARAM_LENGTH ? null : value;
}

/** Antwort der Plattform aus der Rückkehr-Adresse (Query; bei manchen Fehlern das Fragment). */
export function parseCallbackParams(url: string | URL): CallbackParams {
  const u = typeof url === 'string' ? new URL(url) : url;
  const answer = u.search.length > 1 ? u.searchParams : new URLSearchParams(u.hash.slice(1));
  return { code: param(answer, 'code'), state: param(answer, 'state'), iss: param(answer, 'iss'), error: param(answer, 'error') };
}

export interface LoginCallbackMessage extends CallbackParams {
  type: typeof LOGIN_CALLBACK_MESSAGE;
}

/** Ist das die Nachricht des Content-Scripts der Rückkehrseite (genau diese Form)? */
export function isLoginCallbackMessage(value: unknown): value is LoginCallbackMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== LOGIN_CALLBACK_MESSAGE) return false;
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'code,error,iss,state,type') return false;
  return (['code', 'state', 'iss', 'error'] as const).every(
    (k) => v[k] === null || (typeof v[k] === 'string' && (v[k] as string).length <= MAX_PARAM_LENGTH),
  );
}

/** Was vom Absender einer Nachricht geprüft wird (runtime.MessageSender). */
export interface SenderInfo {
  id?: string;
  url?: string;
  origin?: string;
  frameId?: number;
  tab?: { id?: number };
}

/**
 * Tab der Rückkehrseite, wenn die Nachricht vom eigenen Content-Script im obersten Frame genau dieser
 * Seite stammt; sonst null. Die Adresse vergleicht Origin und Pfad exakt (Query zählt nicht).
 */
export function loginCallbackTabId(sender: SenderInfo | undefined, runtimeId: string, callbackUrl: string = AUTH_CALLBACK_URL): number | null {
  if (!sender || !runtimeId || sender.id !== runtimeId) return null;
  if (sender.frameId !== 0) return null;
  const tabId = sender.tab?.id;
  if (!isId(tabId)) return null;
  if (typeof sender.url !== 'string') return null;
  let url: URL;
  let expected: URL;
  try {
    url = new URL(sender.url);
    expected = new URL(callbackUrl);
  } catch {
    return null;
  }
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password) return null;
  // Chrome nennt zusätzlich die Origin des Dokuments
  if (sender.origin !== undefined && sender.origin !== expected.origin) return null;
  return tabId;
}

/**
 * Gehört die Rückkehr zur offenen Anmeldung? Nur Zuordnung (Tab, State); den Inhalt prüft `checkAnswer`.
 * Eine nicht passende Nachricht verbraucht die offene Anmeldung nicht.
 */
export function matchesPending(pending: PendingLogin, params: CallbackParams, tabId: number | null): boolean {
  if (pending.mode === 'tab' ? pending.tabId === null || pending.tabId !== tabId : tabId !== null) return false;
  return params.state !== null && params.state === pending.state;
}

/**
 * Inhalt der Antwort prüfen (nachdem sie der offenen Anmeldung zugeordnet ist).
 * `issAnnounced`: Der Server kündigt `iss` an (RFC 9207) – dann darf es nicht fehlen.
 */
export function checkAnswer(
  params: CallbackParams,
  issuer: string,
  issAnnounced: boolean,
): { ok: true; code: string } | { ok: false; error: LoginErrorKind; detail?: string } {
  // RFC 9207: Steht `iss` in der Antwort, muss es der fest eingebaute Aussteller sein
  if (params.iss !== null && params.iss !== issuer) return { ok: false, error: 'issuer' };
  if (params.error !== null) {
    return params.error === 'access_denied' ? { ok: false, error: 'cancelled' } : { ok: false, error: 'failed', detail: params.error.slice(0, 64) };
  }
  if (!params.code) return { ok: false, error: 'failed', detail: 'no_code' };
  if (params.iss === null && issAnnounced) return { ok: false, error: 'issuer' };
  return { ok: true, code: params.code };
}

// -----------------------------------------------------------------------------
// Fehler beim Token-Tausch
// -----------------------------------------------------------------------------

/** Form einer Fehlerantwort des Token-Endpunkts (OAuthResponseError in auth.ts). */
export interface TokenErrorInfo {
  status: number;
  code?: string;
  description?: string;
  errorCode?: string;
}

/**
 * `invalid_grant` eines gesperrten Kontos. Die Plattform meldet die Sperre als `error_code: "account_banned"`;
 * ältere Plattform-Stände nur als Text in `error_description` („Dieses Konto ist (bis …) gesperrt.“).
 */
export function isBanResponse(errorCode: string | undefined, description: string | undefined): boolean {
  if (errorCode === 'account_banned') return true;
  return !!description && /gesperrt|suspended|banned/i.test(description);
}

const isTokenError = (err: unknown): err is TokenErrorInfo =>
  !!err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number';

/** Fehler beim Code-Tausch einordnen. */
export function classifyTokenError(err: unknown): LoginErrorKind {
  if (isTokenError(err)) {
    if (isBanResponse(err.errorCode, err.description)) return 'banned';
    if (err.code === 'invalid_grant') return 'expired';
    if (err.status >= 500 || err.status === 429) return 'server';
    if (err.code === 'invalid_response') return 'server';
    return 'failed';
  }
  // fetch: TypeError (offline, DNS, TLS, redirect: 'error'), AbortSignal.timeout: TimeoutError/AbortError
  const name = (err as { name?: unknown } | null)?.name;
  if (err instanceof TypeError || name === 'TimeoutError' || name === 'AbortError' || name === 'NetworkError') return 'network';
  return 'failed';
}

/** Einmal automatisch wiederholen: nur bei Netzwerkfehlern und Serverfehlern (5xx). */
export function isRetryable(err: unknown): boolean {
  if (isTokenError(err)) return err.status >= 500;
  return classifyTokenError(err) === 'network';
}

/** Führt `fn` aus und wiederholt einmal nach `delayMs`, wenn der Fehler vorübergehend scheint. */
export async function withOneRetry<T>(fn: () => Promise<T>, delayMs = 1500, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRetryable(err)) throw err;
    await sleep(delayMs);
    return fn();
  }
}
