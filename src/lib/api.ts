/**
 * Plattform-API (https://api.synchrothek.de/v1): Weiterschauen, Marker, Statistik, Freunde, Raum-Einladungen.
 * API der offiziellen Plattform, Überblick in docs/offizielle-dienste.md.
 *
 * Nur im Background verwenden: Die API sendet keine CORS-Header, und das Access-Token verlässt
 * den Background nie. Es geht ausschließlich an die fest eingebaute API_BASE_URL, immer im Header.
 *
 * Ohne Abhängigkeit von `browser`, damit sich das Modul unter Node testen lässt (test/api.test.ts).
 */
import { API_BASE_URL } from './config.ts';
import { getLanguage, t as text, type Lang } from './i18n/index.ts';

/** Hauptzwecke: gemeinsames Schauen in Räumen des offiziellen Sync-Servers. */
export type BasePurpose = 'watch_progress' | 'markers' | 'statistics';
/** Zusatz-Einwilligungen: dieselbe Funktion auch beim alleine Schauen (setzt den Hauptzweck voraus). */
export type SoloPurpose = `${BasePurpose}_solo`;
export type Purpose = BasePurpose | SoloPurpose;
export const PURPOSES: readonly Purpose[] = [
  'watch_progress',
  'markers',
  'statistics',
  'watch_progress_solo',
  'markers_solo',
  'statistics_solo',
];

/** Sammlung: gemeinsam (`room`) oder allein (`solo`). */
export type DataContext = 'room' | 'solo';

export interface ConsentEntry {
  granted: boolean;
  version: string | null;
  grantedAt: string | null;
  currentVersion: string;
  title: string;
  text: string; // Fassung der Plattform, unverändert anzeigen
  requires: BasePurpose | null; // nur bei Zusatz-Einwilligungen: vorausgesetzter Hauptzweck
}
/** Zwecke, die die Plattform (noch) nicht kennt, fehlen und werden nicht angeboten. */
export type Consent = Partial<Record<Purpose, ConsentEntry>>;

export interface ProgressItem {
  url: string;
  title: string;
  position: number;
  duration: number | null;
  updatedAt: string;
  context: DataContext;
}

export interface Marker {
  id: string;
  url: string;
  title: string;
  position: number;
  text: string | null;
  createdAt: string;
  context: DataContext;
}

export interface StatsSummary {
  from: string;
  to: string;
  totalSeconds: number;
  togetherSeconds: number;
  aloneSeconds: number;
  top: { url: string; title: string | null; seconds: number }[];
}

/** Anderes Konto: Freunde sehen voneinander nur den Benutzernamen. */
export interface Person {
  id: string;
  username: string;
}

export interface Friend extends Person {
  since: string;
  avatarUrl: string | null; // nur Adressen unter AVATAR_URL_PREFIX, sonst null
}

/** Eigenes Konto (GET /v1/me). */
export interface Me extends Person {
  avatarUrl: string | null;
}

/** Profilbilder gibt es nur unter dieser Adresse; nur dorthin geht beim Laden das Token. */
export const AVATAR_URL_PREFIX = `${API_BASE_URL}/avatars/`;
const AVATAR_MAX_BYTES = 1024 * 1024; // 256 × 256 WebP ist deutlich kleiner

/** `avatarUrl` aus einer Antwort übernehmen, aber nur, wenn sie auf die feste API-Adresse zeigt. */
export function avatarUrlFrom(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith(AVATAR_URL_PREFIX) || raw.length > 512) return null;
  try {
    const u = new URL(raw);
    return u.origin === new URL(API_BASE_URL).origin && !u.hash && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

export interface RoomInvite {
  id: string;
  from: Person;
  roomCode: string;
  title: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Raumcodes, die die Plattform annimmt (API der offiziellen Plattform). */
export const ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

export interface ShowRef {
  url: string;
  title: string;
  position: number;
  series?: string | null; // Name des Formats (z. B. einer Serie), falls auf der Seite angegeben
}

/** Zuschauzeit beim alleine Schauen (POST /v1/stats/solo). */
export interface SoloStatsReport {
  url: string;
  seconds: number; // 30 s bis 24 h
  startedAt: string; // ISO 8601
}

/** Grenzen der API (API der offiziellen Plattform). */
export const LIMITS = {
  urlLength: 2048,
  titleLength: 300,
  markerText: 200,
  maxSeconds: 100 * 3600,
  soloStatsMinSeconds: 30,
  soloStatsMaxSeconds: 24 * 3600,
} as const;

export type ApiErrorCode =
  | 'signed_out' // keine Anmeldung
  | 'auth' // Token nicht erneuerbar (Plattform nicht erreichbar oder Anmeldung abgelaufen)
  | 'reauth' // API lehnt auch ein frisches Token ab: neu anmelden
  | 'banned' // Konto gesperrt (403 account_banned): abmelden, nicht erneut versuchen
  | 'consent_required'
  | 'consent_version_mismatch'
  | 'base_consent_required' // Zusatz-Einwilligung ohne Haupteinwilligung
  | 'limit_reached'
  | 'not_friends' // Raum-Einladung an jemanden, der (nicht mehr) befreundet ist
  | 'rate_limited'
  | 'not_found'
  | 'invalid' // 4xx wegen der Anfrage
  | 'unavailable'; // Netz, Zeitüberschreitung, 5xx, keine JSON-Antwort (z. B. vorgeschaltetes Gate)

export interface ApiErrorExtra {
  status?: number;
  purpose?: Purpose;
  requires?: BasePurpose;
  retryAfter?: number;
  limit?: number;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly extra: ApiErrorExtra;
  constructor(code: ApiErrorCode, message: string, extra: ApiErrorExtra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export interface ApiDeps {
  /** Gültiges Access-Token oder null ohne Anmeldung (siehe auth.ts). */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Konto gesperrt (403 account_banned). Wird bei jeder solchen Antwort aufgerufen. */
  onAccountBanned?: () => void;
  /** Sprache der Oberfläche für `Accept-Language` (Meldungen und Einwilligungstexte der Plattform). */
  language?: () => Lang;
}

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_AFTER_S = 60;

export const isPurpose = (v: unknown): v is Purpose => typeof v === 'string' && (PURPOSES as readonly string[]).includes(v);
export const isBasePurpose = (v: unknown): v is BasePurpose => v === 'watch_progress' || v === 'markers' || v === 'statistics';

/** Text auf eine Länge in Zeichen (nicht UTF-16-Einheiten) kürzen, Leerraum zusammenfassen. */
export function clip(text: string, max: number): string {
  return [...text.replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
}

const seconds = (n: number) => Math.min(LIMITS.maxSeconds, Math.max(0, Math.round(n * 1000) / 1000));

/** Nur Adressen, die die API annimmt (https, Länge). Liefert null sonst. */
export function apiUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    u.hash = '';
    const s = u.toString();
    return s.length <= LIMITS.urlLength ? s : null;
  } catch {
    return null;
  }
}

function show(ref: ShowRef) {
  const url = apiUrl(ref.url);
  if (!url) throw new ApiError('invalid', text('api.cannotSave'));
  const title = clip(ref.title, LIMITS.titleLength) || clip(new URL(url).hostname, LIMITS.titleLength);
  if (!Number.isFinite(ref.position)) throw new ApiError('invalid', text('common.invalidPosition'));
  const series = ref.series ? clip(ref.series, LIMITS.titleLength) : '';
  return { url, title, position: seconds(ref.position), ...(series && { series }) };
}

/** `context` für Anfragen: `room` ist der Standard der API und wird nicht mitgeschickt. */
const contextBody = (context: DataContext) => (context === 'solo' ? { context } : {});

export function createApi({
  getAccessToken,
  fetch: doFetch = globalThis.fetch.bind(globalThis),
  now = Date.now,
  onAccountBanned,
  language = getLanguage,
}: ApiDeps) {
  let blockedUntil = 0; // nach 429 bis hierhin nichts senden

  async function token(forceRefresh = false): Promise<string> {
    let t: string | null;
    try {
      t = await getAccessToken({ forceRefresh });
    } catch (err) {
      throw new ApiError('auth', err instanceof Error && err.message ? err.message : text('api.authUnavailable'));
    }
    if (!t) throw new ApiError('signed_out', text('api.signedOut'));
    return t;
  }

  /** JSON einer Antwort der API, oder null, wenn es keine ist (z. B. Seite eines Gates oder Proxys). */
  async function readJson(res: Response): Promise<Record<string, unknown> | null> {
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return null;
    const data = (await res.json().catch(() => null)) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  }

  async function send(method: string, path: string, accessToken: string, body?: unknown, accept = 'application/json'): Promise<Response> {
    try {
      return await doFetch(`${API_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: accept,
          'Accept-Language': language(),
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        redirect: 'error', // Token nie über eine Weiterleitung woandershin
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError('unavailable', text('api.platformUnreachable'));
    }
  }

  /** Anfrage mit Token. Bei 401 einmal mit erneuertem Token wiederholen; liefert die Antwort ungelesen. */
  async function authorized(method: string, path: string, body?: unknown, accept?: string): Promise<Response> {
    if (now() < blockedUntil) {
      throw new ApiError('rate_limited', text('error.rateLimited'), {
        retryAfter: Math.ceil((blockedUntil - now()) / 1000),
      });
    }
    let res = await send(method, path, await token(), body, accept);
    if (res.status !== 401) return res;

    const data = await readJson(res);
    if (!data) throw new ApiError('unavailable', text('api.unreachable'), { status: 401 });
    // Abgelaufen oder (z. B. durch Uhrabweichung) abgelehnt: einmal mit frischem Token wiederholen
    if (data.error === 'token_expired' || data.error === 'invalid_token') {
      res = await send(method, path, await token(true), body, accept);
    }
    if (res.status === 401) {
      throw new ApiError('reauth', text('api.reauth'), { status: 401 });
    }
    return res;
  }

  /** Fehlerantwort der API in einen ApiError übersetzen. */
  function fail(res: Response, data: Record<string, unknown> | null): never {
    if (!data) throw new ApiError('unavailable', text('api.unreachable'), { status: res.status });
    const code = typeof data.error === 'string' ? data.error : '';
    // `message` kommt in der Sprache aus Accept-Language; die Codes bleiben gleich
    const message = typeof data.message === 'string' && data.message ? data.message : text('api.errorStatus', { status: res.status });
    const purpose = isPurpose(data.purpose) ? data.purpose : undefined;
    switch (res.status) {
      case 403:
        if (code === 'consent_required') throw new ApiError('consent_required', message, { status: 403, purpose });
        if (code === 'account_banned') {
          onAccountBanned?.();
          throw new ApiError('banned', text('account.banned'), { status: 403 });
        }
        break;
      case 404:
        if (code === 'not_friends') throw new ApiError('not_friends', message, { status: 404 });
        throw new ApiError('not_found', message, { status: 404 });
      case 409:
        if (code === 'consent_version_mismatch') throw new ApiError('consent_version_mismatch', message, { status: 409, purpose });
        if (code === 'base_consent_required') {
          const requires = isBasePurpose(data.requires) ? data.requires : undefined;
          throw new ApiError('base_consent_required', message, { status: 409, purpose, requires });
        }
        if (code === 'limit_reached') {
          throw new ApiError('limit_reached', message, { status: 409, limit: typeof data.limit === 'number' ? data.limit : undefined });
        }
        break;
      case 429: {
        const header = Number(res.headers.get('retry-after'));
        const retryAfter =
          typeof data.retryAfter === 'number' && data.retryAfter > 0
            ? data.retryAfter
            : header > 0
              ? header
              : DEFAULT_RETRY_AFTER_S;
        blockedUntil = now() + retryAfter * 1000;
        throw new ApiError('rate_limited', text('error.rateLimited'), { status: 429, retryAfter });
      }
    }
    if (res.status >= 500) throw new ApiError('unavailable', text('api.serverError'), { status: res.status });
    throw new ApiError('invalid', message, { status: res.status });
  }

  async function call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await authorized(method, path, body);
    const data = await readJson(res);
    if (res.ok && data) return data;
    fail(res, data);
  }

  // --- Antworten prüfen ------------------------------------------------------

  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  function consentFrom(data: Record<string, unknown>): Consent {
    const entry = (raw: unknown): ConsentEntry | null => {
      if (!raw || typeof raw !== 'object') return null;
      const o = raw as Record<string, unknown>;
      const currentVersion = str(o.currentVersion);
      const text = str(o.text);
      if (!currentVersion || !text) return null; // ohne Text keine Einwilligung
      return {
        granted: o.granted === true,
        version: str(o.version),
        grantedAt: str(o.grantedAt),
        currentVersion,
        title: str(o.title) ?? '',
        text,
        requires: isBasePurpose(o.requires) ? o.requires : null,
      };
    };
    const consent: Consent = {};
    for (const p of PURPOSES) {
      const e = entry(data[p]);
      if (e) consent[p] = e;
    }
    if (!consent.watch_progress && !consent.markers && !consent.statistics) {
      throw new ApiError('unavailable', text('api.unexpected'));
    }
    return consent;
  }

  function personFrom(raw: unknown): Person | null {
    const o = (raw ?? {}) as Record<string, unknown>;
    const id = str(o.id);
    const username = str(o.username);
    return id && username ? { id, username } : null;
  }

  function friendFrom(raw: unknown): Friend | null {
    const person = personFrom(raw);
    if (!person) return null;
    const o = raw as Record<string, unknown>;
    return { ...person, since: str(o.since) ?? '', avatarUrl: avatarUrlFrom(o.avatarUrl) };
  }

  function inviteFrom(raw: unknown): RoomInvite | null {
    const o = (raw ?? {}) as Record<string, unknown>;
    const id = str(o.id);
    const from = personFrom(o.from);
    const roomCode = str(o.roomCode)?.toUpperCase() ?? '';
    const expiresAt = str(o.expiresAt);
    if (!id || !from || !ROOM_CODE_PATTERN.test(roomCode) || !expiresAt) return null;
    return { id, from, roomCode, title: str(o.title), createdAt: str(o.createdAt) ?? '', expiresAt };
  }

  function statsFrom(data: Record<string, unknown>): StatsSummary {
    const top = list(data.top, (raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const url = str(o.url);
      const secs = num(o.seconds);
      return url && secs !== null ? { url, title: str(o.title), seconds: secs } : null;
    });
    return {
      from: str(data.from) ?? '',
      to: str(data.to) ?? '',
      totalSeconds: num(data.totalSeconds) ?? 0,
      togetherSeconds: num(data.togetherSeconds) ?? 0, // Kontext room (gemeinsam)
      aloneSeconds: num(data.aloneSeconds) ?? 0,
      top,
    };
  }

  function progressFrom(raw: unknown): ProgressItem | null {
    const o = (raw ?? {}) as Record<string, unknown>;
    const url = str(o.url);
    const position = num(o.position);
    if (!url || position === null) return null;
    return {
      url,
      title: str(o.title) ?? url,
      position,
      duration: num(o.duration),
      updatedAt: str(o.updatedAt) ?? '',
      context: contextFrom(o.context),
    };
  }

  function markerFrom(raw: unknown): Marker | null {
    const o = (raw ?? {}) as Record<string, unknown>;
    const id = str(o.id);
    const url = str(o.url);
    const position = num(o.position);
    if (!id || !url || position === null) return null;
    return {
      id,
      url,
      title: str(o.title) ?? url,
      position,
      text: str(o.text),
      createdAt: str(o.createdAt) ?? '',
      context: contextFrom(o.context),
    };
  }

  /** Fehlt `context` (ältere Plattform), ist es die gemeinsame Sammlung. */
  const contextFrom = (raw: unknown): DataContext => (raw === 'solo' ? 'solo' : 'room');

  const list = <T>(raw: unknown, map: (r: unknown) => T | null): T[] =>
    Array.isArray(raw) ? raw.map(map).filter((x): x is T => x !== null) : [];

  // --- Endpunkte -------------------------------------------------------------

  return {
    async getConsent(): Promise<Consent> {
      return consentFrom(await call('GET', '/consent'));
    },

    /**
     * Erteilen (mit der angezeigten Fassung) oder widerrufen. Widerruf löscht alle Daten des Zwecks
     * (Hauptzweck: beide Sammlungen und die Zusatz-Einwilligung; Zusatz-Einwilligung: nur „allein“).
     */
    async setConsent(purpose: Purpose, granted: boolean, version?: string): Promise<{ consent: Consent; deleted: number }> {
      const entry = granted ? { granted: true, version } : { granted: false };
      const data = await call('PUT', '/consent', { [purpose]: entry });
      // Beim Widerruf des Hauptzwecks kann auch die Zusatz-Einwilligung mit ihren Daten genannt sein
      const counts = (data.deleted ?? {}) as Record<string, unknown>;
      const deleted = Object.entries(counts).reduce((sum, [k, v]) => (k.startsWith(purpose) ? sum + (num(v) ?? 0) : sum), 0);
      return { consent: consentFrom(data), deleted };
    },

    /** Stand speichern. `solo` nur mit Zusatz-Einwilligung `watch_progress_solo` (sonst 403). */
    async saveProgress(ref: ShowRef & { duration?: number | null }, context: DataContext = 'room'): Promise<ProgressItem | null> {
      const body: Record<string, unknown> = { ...show(ref), ...contextBody(context) };
      if (ref.duration != null && Number.isFinite(ref.duration) && ref.duration > 0) body.duration = seconds(ref.duration);
      return progressFrom((await call('PUT', '/progress', body)).item);
    },

    async getProgress(url: string, context: DataContext = 'room'): Promise<ProgressItem | null> {
      const u = apiUrl(url);
      if (!u) return null;
      return progressFrom((await call('GET', `/progress?url=${encodeURIComponent(u)}&context=${context}`)).item);
    },

    /** Liste, zuletzt aktualisierte zuerst. `all` = gemeinsam und allein (jeder Eintrag mit `context`). */
    async listProgress(limit = 50, context: DataContext | 'all' = 'room'): Promise<ProgressItem[]> {
      return list((await call('GET', `/progress?limit=${limit}&context=${context}`)).items, progressFrom);
    },

    async deleteProgress(url: string, context: DataContext = 'room'): Promise<void> {
      const u = apiUrl(url);
      if (u) await call('DELETE', `/progress?url=${encodeURIComponent(u)}&context=${context}`);
    },

    /** Marker setzen. `solo` nur mit Zusatz-Einwilligung `markers_solo` (sonst 403). */
    async addMarker(ref: ShowRef & { text?: string }, context: DataContext = 'room'): Promise<Marker | null> {
      const body: Record<string, unknown> = { ...show(ref), ...contextBody(context) };
      const text = ref.text ? clip(ref.text, LIMITS.markerText) : '';
      if (text) body.text = text;
      return markerFrom((await call('POST', '/markers', body)).item);
    },

    async listMarkers(url: string, context: DataContext = 'room'): Promise<Marker[]> {
      const u = apiUrl(url);
      if (!u) return [];
      return list((await call('GET', `/markers?url=${encodeURIComponent(u)}&context=${context}`)).items, markerFrom);
    },

    async deleteMarker(id: string): Promise<void> {
      await call('DELETE', `/markers/${encodeURIComponent(id)}`);
    },

    /** Überblick der letzten `days` Tage (Einwilligung `statistics`), gemeinsam und allein. */
    async getStatsSummary(days = 30): Promise<StatsSummary> {
      return statsFrom(await call('GET', `/stats/summary?days=${days}&context=all`));
    },

    /**
     * Zuschauzeit beim alleine Schauen melden (Einwilligungen `statistics` und `statistics_solo`).
     * Abschnitte unter 30 s werden gar nicht erst gesendet.
     */
    async reportSoloStats(report: SoloStatsReport): Promise<boolean> {
      const url = apiUrl(report.url);
      const secs = Math.round(report.seconds);
      if (!url || !Number.isFinite(secs) || secs < LIMITS.soloStatsMinSeconds) return false;
      const startedAt = Date.parse(report.startedAt);
      if (!Number.isFinite(startedAt)) return false;
      await call('POST', '/stats/solo', {
        url,
        seconds: Math.min(secs, LIMITS.soloStatsMaxSeconds),
        startedAt: new Date(startedAt).toISOString(),
      });
      return true;
    },

    /** „Allein-Daten löschen“ einer Funktion, ohne die Einwilligung zu widerrufen. Liefert die Zahl gelöschter Einträge. */
    async deleteSoloData(purpose: BasePurpose): Promise<number> {
      const data = await call('DELETE', `/solo-data?purpose=${purpose}`);
      return num(data.deleted) ?? 0;
    },

    async listFriends(): Promise<Friend[]> {
      return list((await call('GET', '/friends')).items, friendFrom);
    },

    /** Eigenes Konto mit Profilbild (keine Einwilligung nötig). */
    async getMe(): Promise<Me> {
      const data = await call('GET', '/me');
      const person = personFrom(data);
      if (!person) throw new ApiError('unavailable', text('api.unexpected'));
      return { ...person, avatarUrl: avatarUrlFrom(data.avatarUrl) };
    },

    /**
     * Profilbild laden (mit Token, deshalb nicht per <img src>). `null` bei 404 = kein Bild.
     * Nur für Adressen aus `avatarUrl` (geprüft mit avatarUrlFrom).
     */
    async fetchAvatar(avatarUrl: string): Promise<Blob | null> {
      const url = avatarUrlFrom(avatarUrl);
      if (!url) return null;
      const res = await authorized('GET', url.slice(API_BASE_URL.length), undefined, 'image/webp,image/*');
      if (res.status === 404) return null;
      const type = res.headers.get('content-type') ?? '';
      if (res.ok && type.startsWith('image/')) {
        const blob = await res.blob();
        if (blob.size > AVATAR_MAX_BYTES) throw new ApiError('invalid', text('api.avatarTooLarge'));
        return blob;
      }
      fail(res, await readJson(res));
    },

    /** Lädt einen bestätigten Freund (Konto-ID) in einen Raum des offiziellen Sync-Servers ein. */
    async createRoomInvite(friendId: string, roomCode: string, title?: string | null): Promise<void> {
      const code = roomCode.toUpperCase();
      if (!ROOM_CODE_PATTERN.test(code)) throw new ApiError('invalid', text('api.invalidRoomCode'));
      const body: Record<string, unknown> = { friend: friendId, roomCode: code };
      const t = title ? clip(title, LIMITS.titleLength) : '';
      if (t) body.title = t;
      await call('POST', '/room-invites', body);
    },

    /** Offene Einladungen an das eigene Konto, neueste zuerst. */
    async listRoomInvites(): Promise<RoomInvite[]> {
      return list((await call('GET', '/room-invites')).items, inviteFrom);
    },

    /** Einladung annehmen bzw. ablehnen (beides löscht sie). */
    async deleteRoomInvite(id: string): Promise<void> {
      await call('DELETE', `/room-invites/${encodeURIComponent(id)}`);
    },
  };
}

export type Api = ReturnType<typeof createApi>;
