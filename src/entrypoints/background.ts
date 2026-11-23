/*
 * Synchrothek – Hintergrund
 * Hält die WebSocket-Verbindung zum Server (überlebt Seitenwechsel), vermittelt zwischen
 * Popup, Content-Script und Server und führt den Raum-Tab zur aktuellen Sendung.
 */
import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { apiUrl, createApi, ROOM_CODE_PATTERN, type BasePurpose, type DataContext, type Purpose, type RoomInvite } from '../lib/api';
import { createAuth, AuthError } from '../lib/auth';
import { isLoginCallbackMessage, loginCallbackTabId, type LoginCallbackResult } from '../lib/login-flow';
import { createAvatars } from '../lib/avatars';
import { BrokerError, createBroker, isOfficialNodeUrl } from '../lib/broker';
import { syncErrorMsg } from '../lib/i18n/errors';
import {
  browserLanguages,
  getLanguage,
  LANG_STORAGE_KEY,
  msg as localized,
  parseLangSetting,
  resolveLanguage,
  setLanguage,
  t,
  tr,
  type LangSetting,
  type Msg,
} from '../lib/i18n';
import { CLIENT_CONFIG_MAX_AGE_MS, fetchClientConfig, needsUpdate, type ClientConfig } from '../lib/client-config';
import { API_HOST_MATCH, DEFAULT_SERVER_URL, LEGACY_SERVER_URLS, OFFICIAL_SYNC_URL, normalizeServerUrl } from '../lib/config';
import { sameContent } from '../lib/content-url';
import { cleanTitle } from '../lib/title';
import { createSocial } from '../lib/social';
import { createSoloStats } from '../lib/solo-stats';
import { isAppUrl, isMediathekUrl } from '../lib/url-match';
import { basePurposeOf, contextFor, isSoloPurpose } from '../lib/watch-context';
import { createWatchFeatures } from '../lib/watch-features';
import { NAME_MAX_LENGTH } from '../lib/protocol';
import type {
  AccountInfo,
  ClientMessage,
  CloseReason,
  MemberInfo,
  RoomSettings,
  RoomSnapshot,
  ServerInfo,
  ServerMessage,
} from '../lib/protocol';
import type {
  FromContent,
  Notice,
  NoticeRetry,
  PopupCommand,
  PopupStatus,
  ProgressReason,
  ShowSnapshot,
  ToContent,
  ToPopup,
} from '../lib/messages';

type Port = Browser.runtime.Port;

const EXTENSION_VERSION = browser.runtime.getManifest().version;

interface RoomInfo {
  hostId: string | null;
  members: MemberInfo[];
  settings: RoomSettings;
  memberLimit: number;
  closesAt: number | null; // Server-Uhr
}

/** Letzter bekannter Wiedergabezustand. `alias`: tatsächliche Seiten-URL nach einer Weiterleitung. */
interface Playback {
  playing: boolean;
  position: number;
  at: number;
  url: string | null;
  alias: string | null;
}

interface State {
  serverUrl: string;
  autoFollow: boolean;
  name: string; // selbst gewählter Name bzw. „Gast …“
  nameChosen: boolean; // selbst gewählt: gilt auch mit Konto (sonst ist der Konto-Name der Vorschlag)
  installId: string;
  conn: 'idle' | 'connecting' | 'open';
  server: ServerInfo | null;
  clockOffset: number; // Server-Uhr minus lokale Uhr (grob)
  code: string | null; // Raumcode (Ziel oder aktueller Raum)
  inRoom: boolean; // vom Server bestätigt
  wantCreate: WantCreate | null; // Raum wird erstellt (Tab erst bei Erfolg binden)
  /** Offizieller Server: Knoten des Raums (vom Vermittler). Wiederverbinden geht direkt dorthin. */
  nodeUrl: string | null;
  tabId: number | null; // Tab, der mit dem Raum synchronisiert wird
  memberId: string | null;
  resumeToken: string | null;
  info: RoomInfo | null;
  playback: Playback | null;
  followedUrl: string | null; // Sendung, zu der der Tab bereits geführt wurde (einmal pro Sendung)
  createdWithAccount: boolean; // Raum selbst erstellt, während die Verbindung mit Konto angemeldet war
  notice: NoticeState | null;
  langSetting: LangSetting; // Sprache: automatisch (Browser) oder fest gewählt
}

interface WantCreate {
  url: string | null;
  tabId: number | null;
  ticket: string | null; // vom Vermittler (offizieller Server), einmal gültig
  sent: boolean; // create ist an den Server gegangen (erst dann gehören joined/error dazu)
}

/** Anmeldung mit Synchrothek-Konto auf der aktuellen WebSocket-Verbindung. */
interface ConnAuth {
  official: boolean; // nur dann geht ein Token raus (fest eingebaute Adresse, nicht `features`)
  sentAt: number[]; // Zeitpunkte gesendeter auth (Grenze des Servers je Minute nicht überschreiten)
  identified: boolean; // auth (falls möglich) gesendet, create/join dürfen folgen
  account: AccountInfo | null; // vom Server bestätigt
  pending: number; // gesendete auth ohne Antwort
  sentWhilePending: number; // seit dem ältesten offenen auth gesendete andere Nachrichten
  retried: boolean; // nach auth_failed schon einmal mit erneuertem Token versucht
  renewTimer?: ReturnType<typeof setTimeout>;
  settle?: () => void; // wartet auf die Antwort zu auth (create mit Ticket erst danach)
}

interface ContentPortInfo {
  tabId: number;
  hasVideo: boolean;
  url: string | null;
}

const KEEPALIVE_MS = 20_000; // hält zugleich den Chrome-Service-Worker wach
const MAX_RECONNECT_MS = 30_000;
const ALIAS_WINDOW_MS = 30_000;
const AUTH_TOKEN_WAIT_MS = 5_000; // so lange höchstens auf ein erneuertes Token warten, bevor create/join ohne geht
const AUTH_RENEW_AHEAD_MS = 2 * 60_000; // auth so lange vor Ablauf der Anmeldung erneuern
const AUTH_RENEW_RETRY_MS = 30_000;
const AUTH_REPLY_WAIT_MS = 10_000; // so lange höchstens auf authenticated warten, bevor create mit Ticket trotzdem geht
const SNAPSHOT_TIMEOUT_MS = 2_000;
const RECONNECT_LOOKUP_AFTER = 3; // nach so vielen Fehlversuchen beim Vermittler nach dem Knoten des Raums fragen
const AUTH_MAX_PER_MINUTE = 9; // Server: höchstens 10 auth pro Minute und Verbindung

const INVITE_ALARM = 'room-invites';
const INVITE_NOTIFICATION_PREFIX = 'invite:';

const CLOSE_TEXTS: Record<CloseReason, Msg> = {
  idle: localized('closed.idle'),
  duration: localized('closed.duration'),
  shutdown: localized('closed.shutdown'),
  admin: localized('closed.admin'),
};
const CLOSE_FALLBACK = localized('closed.other'); // unbekannter Grund (neuerer Server)

/** Ankündigung vor dem Schließen, je Grund. */
function closingText(reason: CloseReason | string, minutes: number): Msg {
  const key =
    reason === 'duration' || reason === 'idle' || reason === 'shutdown' || reason === 'admin' ? (`closing.${reason}` as const) : 'closing.other';
  return localized(key, { count: minutes });
}
const BANNED_TEXT = localized('account.banned');
const KICKED = localized('room.kicked');
const BANNED_OUT = localized('room.bannedOut');
const ROOM_NOT_FOUND = (code: string) => localized('room.notFound', { code });

/** „12 Marker“, „3 gespeicherte Stände“, „Alle Statistikdaten“ – für Hinweise nach dem Löschen. */
function deletedText(purpose: BasePurpose, deleted: number, solo: boolean): Msg {
  const what =
    purpose === 'markers'
      ? localized('deleted.markers', { count: deleted })
      : purpose === 'statistics'
        ? localized('deleted.stats')
        : localized('deleted.progress', { count: deleted });
  return solo ? localized('deleted.solo', { what }) : what;
}

/** Hinweis im Popup. Der Text wird erst beim Anzeigen übersetzt, damit er einen Sprachwechsel übersteht. */
interface NoticeState {
  kind: Notice['kind'];
  text: Msg;
  retry?: NoticeRetry;
}

/** Automatisch erzeugter Gastname („Gast 1234“ / „Guest 1234“) folgt der Sprache. */
const GUEST_NAME = /^(?:Gast|Guest) (\d{4})$/;

/**
 * Antworten des Servers auf `auth` können `rate_limited` sein („zu viele Anmeldeversuche“). Dieselbe
 * Fehlerart bekommen aber auch Nachrichten, die während einer laufenden Prüfung warten und die
 * Warteschlange des Servers (32 Nachrichten) sprengen. Solange seit dem ältesten offenen `auth` weniger
 * Nachrichten gesendet wurden, kann `rate_limited` nur die Antwort auf `auth` sein.
 */
const SERVER_MAX_BACKLOG = 32;

export default defineBackground(() => {
  const state: State = {
    serverUrl: DEFAULT_SERVER_URL,
    autoFollow: true,
    name: '',
    nameChosen: false,
    installId: '',
    conn: 'idle',
    server: null,
    clockOffset: 0,
    code: null,
    inRoom: false,
    wantCreate: null,
    nodeUrl: null,
    tabId: null,
    memberId: null,
    resumeToken: null,
    info: null,
    playback: null,
    followedUrl: null,
    createdWithAccount: false,
    notice: null,
    langSetting: 'auto',
  };

  let ws: WebSocket | null = null;
  let connAuth: ConnAuth | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = 1000;
  let reconnectFailures = 0; // Fehlversuche seit dem letzten erfolgreichen Beitritt
  let relocate = false; // beim nächsten Versuch zuerst den Vermittler nach dem Knoten fragen
  let followPending: { url: string; at: number } | null = null;
  let locating: string | null = null; // Raumcode, dessen Knoten gerade beim Vermittler erfragt wird

  // Vermittler des offiziellen Sync-Dienstes (Knoten-Pool)
  const broker = createBroker();
  const isOfficial = () => state.serverUrl === OFFICIAL_SYNC_URL;

  const contentPorts = new Map<Port, ContentPortInfo>();
  // Nur für die Anzeige im Popup, nur im Speicher: Seitentitel je Tab und zuletzt abgefragte Position
  const tabTitles = new Map<number, string>();
  const peeks = new Map<number, { url: string; position: number; duration: number | null }>();
  const popupPorts = new Map<Port, { tabId: number | null }>();

  const ready = init();

  // Plattform-API. Eine Instanz für alles, weil das Rate-Limit für alle Endpunkte zusammen gilt.
  // Das Token holt sie sich hier im Background.
  const api = createApi({
    getAccessToken: (options) => auth.getAccessToken(options),
    onAccountBanned: () => void signOutBanned(),
  });
  const isSignedIn = () => auth.status().state === 'signedIn';

  // Weiterschauen, Marker, Statistik-Einwilligung
  const features = createWatchFeatures({
    api,
    isSignedIn,
    hasPermission: () => browser.permissions.contains({ origins: [API_HOST_MATCH] }).catch(() => false),
    onChange: () => pushStatus(),
  });

  // Statistik beim alleine Schauen: Zeit je Tab im Speicher sammeln, gesammelt melden (nur mit Einwilligung)
  const soloStats = createSoloStats({ report: (report) => features.reportSoloStats(report) });

  // Freunde und Einladungen in Räume
  const social = createSocial({
    api,
    isSignedIn,
    onChange: () => pushStatus(),
    onReauth: () => features.markReauth(),
    onInvites: (invites) => void showInvites(invites),
  });
  // Eigenes Konto (/v1/me) und Profilbilder (eigenes und von Freunden)
  const avatars = createAvatars({
    api,
    isSignedIn,
    cache: typeof caches === 'undefined' ? null : caches,
    onMe: () => pushStatus(),
    onAvatar: (url, dataUrl) => {
      const msg: ToPopup = { type: 'avatar', url, dataUrl };
      for (const port of popupPorts.keys()) {
        try {
          port.postMessage(msg);
        } catch {}
      }
    },
    onReauth: () => features.markReauth(),
  });
  let signedIn = false;

  // Synchrothek-Konto. Tokens bleiben in diesem Modul; Popup und Content-Scripts sehen nur den Status.
  const auth = createAuth({
    onChange: () => {
      // An- oder Abmeldung: Einwilligungsstand und geladene Daten des alten Kontos vergessen
      const now = auth.status().state === 'signedIn';
      if (now !== signedIn) {
        signedIn = now;
        soloStats.clear(); // nichts für ein anderes (oder kein) Konto melden
        features.reset();
        social.reset();
        void scheduleInvitePolling(now);
        // Abgemeldet: auch die zwischengespeicherten Profilbilder löschen. Angemeldet (auch beim
        // Start des Service Workers): eigenes Konto laden, der Bild-Cache bleibt.
        if (now) void avatars.loadMe({ force: true });
        else avatars.reset();
      }
      syncDisplayName();
      pushStatus();
    },
    // Genau ein Hinweis; danach gibt es kein Token mehr, also auch keine weiteren Fehler
    onSessionLost: (reason) =>
      reason === 'banned'
        ? setNotice('error', BANNED_TEXT)
        : setNotice('info', localized('account.sessionLost')),
  });

  // -------------------------------------------------------------------------
  // Kontosperre: 403 account_banned von der API (beim Refresh: invalid_grant, siehe auth.ts)
  // -------------------------------------------------------------------------

  let banning = false;

  /** Gesperrtes Konto: einmal abmelden und den Hinweis zeigen. Danach gibt es kein Token, also keine Wiederholungen. */
  async function signOutBanned() {
    if (banning || !isSignedIn()) return;
    banning = true;
    try {
      if (connAuth) clearTimeout(connAuth.renewTimer);
      await auth.logout();
      setNotice('error', BANNED_TEXT);
      pushStatus();
    } finally {
      banning = false;
    }
  }

  // -------------------------------------------------------------------------
  // Client-Konfiguration (ohne Token): Mindestversion und Wartungshinweis
  // -------------------------------------------------------------------------

  // Store-Installation (automatische Updates) oder selbst geladen: nur für den Update-Hinweis im Popup
  let installType: PopupStatus['installType'] = 'other';
  browser.management
    ?.getSelf()
    .then((self) => {
      installType = self.installType === 'normal' ? 'normal' : self.installType === 'development' ? 'development' : 'other';
    })
    .catch(() => {});

  let clientConfig: ClientConfig | null = null;
  let clientConfigAt = 0;
  let clientConfigLoad: Promise<void> | null = null;

  /** Beim Start und beim Öffnen des Popups, höchstens alle 5 Minuten. Fehler werden ignoriert. */
  function loadClientConfig(): Promise<void> {
    if (clientConfigLoad || Date.now() - clientConfigAt < CLIENT_CONFIG_MAX_AGE_MS) return clientConfigLoad ?? Promise.resolve();
    clientConfigAt = Date.now();
    clientConfigLoad = fetchClientConfig(undefined, getLanguage())
      .then((config) => {
        if (config) clientConfig = config; // bei Fehlern den letzten bekannten Stand behalten
        pushStatus();
      })
      .finally(() => (clientConfigLoad = null));
    return clientConfigLoad;
  }
  void loadClientConfig();
  if (import.meta.env.MODE !== 'production') {
    console.info(`Synchrothek: OAuth-Client ${auth.clientId}, Rückfall-Redirect-URI ${browser.identity.getRedirectURL()}`);
  }

  async function init() {
    try {
      const local = await browser.storage.local.get(['serverUrl', 'autoFollow', 'name', 'nameChosen', 'installId', LANG_STORAGE_KEY]);
      state.langSetting = parseLangSetting(local[LANG_STORAGE_KEY]);
      applyLanguage();
      if (typeof local.serverUrl === 'string') {
        const legacy = LEGACY_SERVER_URLS.map(normalizeServerUrl);
        const stored = normalizeServerUrl(local.serverUrl);
        // Früheren Standard oder den aktuellen Standard nicht festhalten, sondern dem Standard folgen
        if (legacy.includes(stored) || stored === normalizeServerUrl(DEFAULT_SERVER_URL)) {
          await browser.storage.local.remove('serverUrl');
        } else state.serverUrl = local.serverUrl;
      }
      if (typeof local.autoFollow === 'boolean') state.autoFollow = local.autoFollow;
      state.installId = typeof local.installId === 'string' ? local.installId : crypto.randomUUID();
      state.name =
        typeof local.name === 'string' && local.name
          ? local.name
          : t('settings.guestName', { number: String(1000 + Math.floor(Math.random() * 9000)) });
      state.nameChosen = local.nameChosen === true;
      await browser.storage.local.set({ installId: state.installId, name: state.name });

      // Nach einem Neustart des Service Workers dem Raum wieder beitreten
      const { session } = await browser.storage.session.get('session');
      const saved = session as
        | {
            code?: string;
            tabId?: number;
            followedUrl?: string;
            resumeToken?: string;
            createdWithAccount?: boolean;
            nodeUrl?: string;
          }
        | undefined;
      if (saved?.code) {
        state.code = saved.code;
        state.tabId = saved.tabId ?? null;
        state.followedUrl = saved.followedUrl ?? null;
        state.resumeToken = saved.resumeToken ?? null;
        state.createdWithAccount = saved.createdWithAccount ?? false;
        state.nodeUrl = isOfficial() && isOfficialNodeUrl(saved.nodeUrl) ? saved.nodeUrl : null;
        state.inRoom = true;
        connect();
      }
    } catch (err) {
      console.warn('Synchrothek: Initialisierung fehlgeschlagen', err);
    }
  }

  /** Namen für die Anzeige im Raum: kürzen und Leerraum zusammenfassen. */
  function sanitizeName(raw: string): string {
    return [...raw.replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX_LENGTH).join('');
  }

  /** Benutzername des Kontos (Vorschlag für den Namen im Raum), oder null ohne Anmeldung. */
  function accountName(): string | null {
    const account = auth.status();
    if (account.state !== 'signedIn' || !account.name) return null;
    return sanitizeName(account.name) || null;
  }

  /** Selbst gewählter Name, sonst mit Konto dessen Benutzername, sonst der Gastname (in der aktuellen Sprache). */
  function displayName(): string {
    if (state.nameChosen) return state.name;
    const guest = GUEST_NAME.exec(state.name);
    return accountName() ?? (guest ? t('settings.guestName', { number: guest[1]! }) : state.name);
  }

  let sentName: string | null = null; // zuletzt an den Raum gemeldeter Name

  /** Nach An- oder Abmelden den Namen im laufenden Raum angleichen. */
  function syncDisplayName() {
    const name = displayName();
    if (!state.inRoom || !name || name === sentName) return;
    if (send({ type: 'setName', name })) sentName = name;
  }

  function persistSession() {
    const session = state.inRoom
      ? {
          code: state.code,
          tabId: state.tabId,
          followedUrl: state.followedUrl,
          resumeToken: state.resumeToken,
          createdWithAccount: state.createdWithAccount,
          nodeUrl: state.nodeUrl,
        }
      : null;
    return browser.storage.session.set({ session }).catch(() => {});
  }

  function setNotice(kind: Notice['kind'], text: Msg, { retry }: { retry?: NoticeRetry } = {}) {
    state.notice = { kind, text, ...(retry && { retry }) };
  }

  // -------------------------------------------------------------------------
  // Sprache: Einstellung (storage.local) oder Browser; gilt für Popup, Hinweise und Content-Scripts
  // -------------------------------------------------------------------------

  /** Sprache aus Einstellung und Browser neu bestimmen und, falls sie sich ändert, überall anwenden. */
  function applyLanguage() {
    const lang = resolveLanguage(state.langSetting, browserLanguages(), browser.i18n?.getUILanguage?.());
    if (!setLanguage(lang)) return;
    // Plattform: Meldungen und Einwilligungstexte kommen in der Sprache aus Accept-Language
    features.languageChanged();
    social.dismissError();
    clientConfigAt = 0;
    void loadClientConfig();
    syncDisplayName(); // „Gast …“ / „Guest …“
    for (const port of contentPorts.keys()) post(port, { type: 'lang', lang });
    pushStatus();
  }

  async function changeLanguage(setting: LangSetting) {
    state.langSetting = setting;
    if (setting === 'auto') await browser.storage.local.remove(LANG_STORAGE_KEY);
    else await browser.storage.local.set({ [LANG_STORAGE_KEY]: setting });
    applyLanguage();
  }

  const RETRY_CREATE: NoticeRetry = { action: 'create' };

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  /**
   * Adresse der WebSocket-Verbindung. Selbst gehostet: die eingestellte Adresse. Offiziell: der Knoten des
   * Raums (null = erst beim Vermittler nachfragen).
   */
  function socketUrl(): string | null {
    if (!isOfficial()) return state.serverUrl;
    return state.nodeUrl && isOfficialNodeUrl(state.nodeUrl) ? state.nodeUrl : null;
  }

  function connect() {
    clearTimeout(reconnectTimer);
    if (ws) return;
    const url = relocate && isOfficial() && state.code ? null : socketUrl();
    if (!url) {
      // Offiziell ohne bekannten Knoten (Beitreten, alte Sitzung): Knoten beim Vermittler erfragen
      if (state.code) void locateRoom(state.code);
      else if (state.wantCreate) state.wantCreate = null;
      pushStatus();
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      setNotice('error', localized('server.invalidAddress'));
      state.wantCreate = null;
      pushStatus();
      return;
    }
    ws = socket;
    // Offiziell ist allein die fest eingebaute Adresse mit einem Knoten unter *.sync.synchrothek.de,
    // nie ein Server, der sich selbst so ausgibt
    connAuth = {
      official: isOfficial() && isOfficialNodeUrl(url),
      sentAt: [],
      identified: false,
      account: null,
      pending: 0,
      sentWhilePending: 0,
      retried: false,
    };
    state.conn = 'connecting';
    pushStatus();

    socket.onopen = () => {
      if (ws !== socket) return;
      state.conn = 'open';
      reconnectDelay = 1000;
      if (state.notice?.kind === 'error') state.notice = null;
      keepaliveTimer = setInterval(() => send({ type: 'ping', t: Date.now() }), KEEPALIVE_MS);
      // create/join folgen nach `welcome` (siehe identify)
      pushStatus();
    };

    socket.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      handleServerMessage(msg);
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      clearAuth();
      clearInterval(keepaliveTimer);
      state.conn = 'idle';
      if (state.code) {
        setNotice('error', localized('conn.lostRetrying'));
        // Offiziell: Nach mehreren Fehlversuchen beim Vermittler nachfragen, wo der Raum liegt (Knoten
        // gewechselt oder Raum weg). connect() erfragt den Knoten, sobald keiner bekannt ist.
        if (isOfficial() && ++reconnectFailures >= RECONNECT_LOOKUP_AFTER) {
          reconnectFailures = 0;
          relocate = true;
        }
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
      } else if (state.wantCreate) {
        state.wantCreate = null;
        state.nodeUrl = null;
        if (isOfficial()) setNotice('error', localized('broker.unreachable'), { retry: RETRY_CREATE });
        else setNotice('error', localized('server.unreachable', { url: state.serverUrl }));
      }
      pushStatus();
    };
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    clearInterval(keepaliveTimer);
    const socket = ws;
    ws = null;
    clearAuth();
    state.conn = 'idle';
    socket?.close();
  }

  function clearAuth() {
    if (connAuth) clearTimeout(connAuth.renewTimer);
    connAuth = null;
  }

  /** Offiziell: Knoten eines Raums beim Vermittler erfragen, dann verbinden (Beitreten, alte Sitzung). */
  async function locateRoom(code: string) {
    if (locating === code) return;
    locating = code;
    state.conn = 'connecting';
    pushStatus();
    try {
      const node = await broker.lookupRoom(code);
      if (state.code !== code || !isOfficial() || ws) return;
      relocate = false;
      state.nodeUrl = node.url;
      persistSession();
      locating = null;
      connect();
    } catch (err) {
      if (state.code !== code || !isOfficial()) return;
      state.conn = 'idle';
      const e = err instanceof BrokerError ? err : new BrokerError('unreachable');
      if (e.code === 'room_not_found') {
        // Beim Beitreten: falscher Code. Beim Wiederverbinden: Raum ist weg (z. B. Knoten neu gestartet).
        const rejoin = state.inRoom;
        postToTab({ type: 'notice', text: t(rejoin ? 'room.gone' : 'room.notFound', { code }) });
        resetRoom();
        setNotice('error', localized(rejoin ? 'room.goneEnded' : 'room.notFound', { code }));
      } else if (!state.inRoom) {
        // Beitreten, Vermittler gestört: zurück in die Lobby, mit „Erneut versuchen“
        resetRoom();
        setNotice('error', e.text(), { retry: { action: 'join', code } });
      } else {
        // Wiederverbinden: später erneut versuchen (mit bekanntem Knoten zuerst wieder direkt)
        relocate = false;
        setNotice('error', localized('common.retrying', { message: e.text() }));
        reconnectTimer = setTimeout(connect, Math.max(reconnectDelay, e.retryAfterMs ?? 0));
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
      }
    } finally {
      if (locating === code) locating = null;
      pushStatus();
    }
  }

  // -------------------------------------------------------------------------
  // Konto auf dem Sync-Server (nur wss://sync.synchrothek.de)
  // -------------------------------------------------------------------------

  /** Nach `welcome`: zuerst auth (falls angemeldet und offizieller Server), dann create bzw. join. */
  async function identify(socket: WebSocket) {
    const ca = connAuth;
    if (!ca || ws !== socket || ca.identified) return;
    if (ca.official) {
      const sent = await sendAuth(socket, { waitMs: AUTH_TOKEN_WAIT_MS });
      // Raum mit Ticket für ein Konto: der Knoten verlangt die fertige Anmeldung vor dem create
      if (sent && state.wantCreate?.ticket) await authReply(ca);
    }
    if (ws !== socket || connAuth !== ca) return;
    ca.identified = true;
    sentName = displayName();
    const identity = { name: sentName, installId: state.installId };
    if (state.wantCreate) sendCreate(state.wantCreate, identity);
    else if (state.code) {
      send({ type: 'join', code: state.code, ...identity, ...(state.resumeToken && { resumeToken: state.resumeToken }) });
    }
    pushStatus();
  }

  /** Bis der Server auf alle gesendeten auth geantwortet hat (höchstens AUTH_REPLY_WAIT_MS). */
  function authReply(ca: ConnAuth): Promise<void> {
    if (ca.pending === 0 && !ca.settle) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, AUTH_REPLY_WAIT_MS);
      const previous = ca.settle;
      function done() {
        clearTimeout(timer);
        if (ca.settle === done) ca.settle = undefined;
        previous?.();
        resolve();
      }
      ca.settle = done;
    });
  }

  function settleAuth(ca: ConnAuth) {
    if (ca.pending === 0) ca.settle?.();
  }

  function sendCreate(want: WantCreate, identity: { name: string; installId: string }): boolean {
    const ok = send({ type: 'create', url: want.url, ...identity, ...(want.ticket && { ticket: want.ticket }) });
    if (ok) want.sent = true;
    return ok;
  }

  /**
   * Holt ein gültiges Access-Token (erneuert der Reihe nach im Auth-Modul) und sendet es als Nachricht.
   * Nie in der URL, nie an einen anderen als den offiziellen Server.
   */
  async function sendAuth(
    socket: WebSocket | null,
    { waitMs, ...tokenOptions }: { waitMs?: number; forceRefresh?: boolean; minValidMs?: number } = {},
  ): Promise<boolean> {
    const ca = connAuth;
    // Nur an den offiziellen Dienst: Knoten unter wss://*.sync.synchrothek.de
    if (!socket || !ca?.official || ws !== socket || !isOfficialNodeUrl(socket.url)) return false;
    let tokenPromise = auth.getAccessToken(tokenOptions).catch((err) => {
      console.info('Synchrothek: kein Token für den Sync-Server', err);
      return null;
    });
    if (waitMs) {
      // Nicht ewig auf die Plattform warten: Gemeinsam schauen geht auch ohne Konto
      tokenPromise = Promise.race([tokenPromise, new Promise<null>((r) => setTimeout(() => r(null), waitMs))]);
    }
    const token = await tokenPromise;
    if (!token || ws !== socket || connAuth !== ca || state.serverUrl !== OFFICIAL_SYNC_URL) return false;
    const now = Date.now();
    ca.sentAt = ca.sentAt.filter((t) => now - t < 60_000);
    if (ca.sentAt.length >= AUTH_MAX_PER_MINUTE) return false; // Server würde mit rate_limited antworten
    if (!send({ type: 'auth', token })) return false;
    ca.sentAt.push(now);
    if (ca.pending === 0) ca.sentWhilePending = 0;
    ca.pending++;
    return true;
  }

  function scheduleAuthRenewal(ca: ConnAuth, expiresAt: number | null) {
    clearTimeout(ca.renewTimer);
    if (expiresAt === null) return;
    const socket = ws;
    const localExpiry = expiresAt - state.clockOffset;
    const renew = async () => {
      if (connAuth !== ca || auth.status().state !== 'signedIn') return;
      // Frisches Token mit genug Restlaufzeit, also tatsächlich erneuern statt das alte erneut zu senden
      const sent = await sendAuth(socket, { minValidMs: AUTH_RENEW_AHEAD_MS + 60_000 });
      if (!sent && connAuth === ca && Date.now() < localExpiry && auth.status().state === 'signedIn') {
        ca.renewTimer = setTimeout(renew, AUTH_RENEW_RETRY_MS);
      }
    };
    ca.renewTimer = setTimeout(renew, Math.max(5_000, localExpiry - Date.now() - AUTH_RENEW_AHEAD_MS));
  }

  /** Antworten auf auth. Liefert true, wenn die Nachricht dazu gehörte. */
  function handleAuthReply(msg: ServerMessage): boolean {
    const ca = connAuth;
    if (!ca) return false;
    if (msg.type === 'authenticated') {
      ca.pending = Math.max(0, ca.pending - 1);
      ca.account = msg.account;
      ca.retried = false;
      scheduleAuthRenewal(ca, msg.account.expiresAt);
      settleAuth(ca);
      return true;
    }
    if (msg.type !== 'error') return false;
    switch (msg.code) {
      case 'auth_failed':
        ca.pending = Math.max(0, ca.pending - 1);
        ca.account = null;
        clearTimeout(ca.renewTimer);
        // Einmal mit erneuertem Token nachlegen; scheitert auch das, bleibt die Verbindung ohne Konto
        if (!ca.retried) {
          ca.retried = true;
          void sendAuth(ws, { forceRefresh: true }).then((sent) => sent || settleAuth(ca));
        } else settleAuth(ca);
        return true;
      case 'auth_unsupported':
        ca.pending = Math.max(0, ca.pending - 1);
        ca.account = null;
        settleAuth(ca);
        return true; // Server ohne Accounts: still hinnehmen
      case 'unknown_type': // älterer Server ohne auth
        if (ca.pending === 0) return false;
        ca.pending--;
        settleAuth(ca);
        return true;
      case 'rate_limited':
        // Nur „zu viele Anmeldeversuche“ gehört zu auth. Während eine Anmeldung geprüft wird, kann der
        // Server auch wartende Nachrichten mit rate_limited ablehnen („zu viele Nachrichten“), aber erst,
        // wenn seine Warteschlange voll ist; die zählen nicht als Antwort, sonst ginge ein create mit
        // Ticket zu früh raus. Entschieden wird am Zähler, nicht am Text der Meldung (SERVER_MAX_BACKLOG).
        if (ca.pending === 0 || ca.sentWhilePending >= SERVER_MAX_BACKLOG) return false;
        ca.pending--;
        settleAuth(ca);
        return true;
      default:
        return false;
    }
  }

  function send(message: ClientMessage): boolean {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    if (connAuth && connAuth.pending > 0 && message.type !== 'auth') connAuth.sentWhilePending++;
    return true;
  }

  function handleServerMessage(msg: ServerMessage) {
    if (handleAuthReply(msg)) {
      pushStatus();
      return;
    }
    switch (msg.type) {
      case 'welcome':
        state.server = msg.server;
        state.clockOffset = msg.serverTime - Date.now();
        if (ws) void identify(ws);
        break;

      case 'joined': {
        // Nur ein gesendetes create gehört zu diesem joined (nicht z. B. das Wiederverbinden mit dem alten Raum)
        const want = state.wantCreate?.sent ? state.wantCreate : null;
        const created = !!want;
        // Neuer Raum aus einem bestehenden heraus: alten Tab freigeben, neuen binden
        if (want && want.tabId !== state.tabId) {
          postToTab({ type: 'room', inRoom: false });
          state.tabId = want.tabId;
        }
        const previous = created ? null : state.playback;
        state.code = msg.room.code;
        state.inRoom = true;
        if (created) state.wantCreate = null;
        if (created) state.createdWithAccount = !!connAuth?.account;
        state.memberId = msg.memberId;
        state.resumeToken = msg.resumeToken;
        reconnectFailures = 0;
        relocate = false;
        // Ab jetzt gemeinsam: laufende Zählung „allein“ des Raum-Tabs abschließen (danach zählt der Sync-Server)
        if (state.tabId != null && isOfficial()) soloStats.end(state.tabId);
        refreshOpenPopups(); // Marker im Popup jetzt aus der gemeinsamen Sammlung
        state.info = infoFrom(msg.room);
        state.playback = {
          ...playbackFrom(msg.room),
          alias: sameContent(previous?.url, msg.room.url) ? (previous?.alias ?? null) : null,
        };
        if (created) {
          // Wer den Raum erstellt, gibt mit seinem aktuellen Video Sendung und Startpunkt vor
          state.followedUrl = state.playback.url;
          postToTab({ type: 'adopt' });
        } else {
          pushPlaybackToTab();
          void maybeFollow();
        }
        persistSession();
        break;
      }

      case 'room':
        state.info = infoFrom(msg.room);
        break;

      case 'state': {
        const previous = state.playback;
        const contentChanged = !sameContent(previous?.url, msg.url);
        state.playback = {
          ...playbackFrom(msg),
          alias: contentChanged ? null : (previous?.alias ?? null),
        };
        pushPlaybackToTab(msg.action === 'sync');
        if (contentChanged) void maybeFollow();
        break;
      }

      case 'positionRequest':
        requestHostPosition();
        return;

      case 'kicked':
        resetRoom();
        disconnect();
        setNotice('error', msg.banned ? BANNED_OUT : KICKED);
        break;

      case 'roomClosing': {
        const minutes = Math.max(1, Math.round((msg.closesAt - Date.now() - state.clockOffset) / 60_000));
        const text = closingText(msg.reason, minutes);
        setNotice('info', text);
        postToTab({ type: 'notice', text: tr(text) });
        break;
      }

      case 'roomClosed': {
        const text = CLOSE_TEXTS[msg.reason] ?? CLOSE_FALLBACK;
        postToTab({ type: 'notice', text: tr(text) });
        resetRoom();
        disconnect();
        setNotice('info', text);
        break;
      }

      case 'error':
        // Texte zu den Codes kommen aus der Extension (i18n/errors.ts), nicht aus `message` des Servers
        switch (msg.code) {
          case 'room_not_found': {
            const code = state.code;
            resetRoom();
            disconnect();
            setNotice('error', code ? ROOM_NOT_FOUND(code) : syncErrorMsg(msg.code, msg.message));
            break;
          }
          case 'room_full':
          case 'banned':
            resetRoom();
            disconnect();
            setNotice('error', syncErrorMsg(msg.code, msg.message));
            break;
          case 'not_allowed':
            postToTab({ type: 'notice', text: t('room.hostOnly') });
            setNotice('info', localized('room.hostOnly'));
            break;
          case 'server_full': // alle Plätze belegt
          case 'maintenance': // Wartung: keine neuen Räume
            rejectCreate(syncErrorMsg(msg.code, msg.message));
            break;
          case 'ticket_invalid': // Ticket abgelaufen oder schon benutzt: mit neuem Ticket erneut versuchen
            rejectCreate(syncErrorMsg(msg.code, msg.message), { retry: RETRY_CREATE });
            break;
          default:
            // Andere und unbekannte Codes (neuerer Server): eigener Text, unbekannt mit gekürzter Meldung als Zusatz
            if (state.wantCreate?.sent) rejectCreate(syncErrorMsg(msg.code, msg.message));
            else setNotice('error', syncErrorMsg(msg.code, msg.message));
        }
        break;

      default:
        return; // pong, left
    }
    pushStatus();
  }

  function infoFrom(room: RoomSnapshot): RoomInfo {
    return {
      hostId: room.hostId,
      members: room.members,
      settings: room.settings,
      memberLimit: room.memberLimit,
      closesAt: room.closesAt,
    };
  }

  function playbackFrom(s: { playing: boolean; position: number; url: string | null }) {
    return { playing: s.playing, position: s.position, at: Date.now(), url: s.url };
  }

  // -------------------------------------------------------------------------
  // Raum-Aktionen
  // -------------------------------------------------------------------------

  function resetRoom() {
    postToTab({ type: 'room', inRoom: false });
    reconnectFailures = 0;
    relocate = false;
    state.code = null;
    state.inRoom = false;
    state.wantCreate = null;
    state.nodeUrl = null;
    state.tabId = null;
    state.memberId = null;
    state.resumeToken = null;
    state.info = null;
    state.playback = null;
    state.followedUrl = null;
    state.createdWithAccount = false;
    followPending = null;
    persistSession();
    refreshOpenPopups(); // ohne Raum: Marker im Popup aus der Sammlung „allein“
  }

  function leaveRoom() {
    send({ type: 'leave' });
    resetRoom();
    disconnect();
  }

  function createRoom(tabId: number | null) {
    state.notice = null;
    const url = videoPortsOf(tabId)[0]?.url ?? null;
    if (isOfficial()) {
      void createOfficialRoom(tabId, url);
      return;
    }
    sentName = displayName();
    const identity = { name: sentName, installId: state.installId };
    // Im Raum und verbunden: über dieselbe Verbindung erstellen. Lehnt der Server ab (alle Plätze
    // belegt, Wartung), bleibt man im bisherigen Raum; erst bei Erfolg wechselt der Server.
    if (state.inRoom && connAuth?.identified) {
      state.wantCreate = { url, tabId, ticket: null, sent: false };
      if (sendCreate(state.wantCreate, identity)) return;
    }
    if (state.inRoom || state.code) leaveRoom();
    state.tabId = tabId;
    state.wantCreate = { url, tabId, ticket: null, sent: false };
    if (!(connAuth?.identified && sendCreate(state.wantCreate, identity))) connect();
  }

  /** Token für den Vermittler (nicht ewig warten: ohne Konto geht es auch). */
  function brokerToken(forceRefresh = false): Promise<string | null> {
    if (!isSignedIn()) return Promise.resolve(null);
    const token = auth.getAccessToken({ forceRefresh }).catch((err) => {
      console.info('Synchrothek: kein Token für den Vermittler', err);
      return null;
    });
    return Promise.race([token, new Promise<null>((r) => setTimeout(() => r(null), AUTH_TOKEN_WAIT_MS))]);
  }

  /**
   * Offizieller Server: Code, Knoten und Ticket beim Vermittler holen, dann mit dem Knoten verbinden
   * (angemeldet: auth, auf Antwort warten, dann create mit Ticket). Lehnt der Vermittler ab, bleibt
   * ein bestehender Raum erhalten. Jeder Versuch holt ein neues Ticket.
   */
  async function createOfficialRoom(tabId: number | null, url: string | null) {
    const want: WantCreate = { url, tabId, ticket: null, sent: false };
    state.wantCreate = want;
    if (!state.inRoom) state.conn = 'connecting';
    pushStatus();

    let room;
    try {
      let token = await brokerToken();
      try {
        room = await broker.createRoom(token);
      } catch (err) {
        // Token abgelehnt: einmal mit erneuertem Token
        if (!(err instanceof BrokerError && err.code === 'auth_failed' && token) || state.wantCreate !== want) throw err;
        token = await brokerToken(true);
        room = await broker.createRoom(token);
      }
    } catch (err) {
      if (state.wantCreate !== want) return; // abgebrochen oder neuer Versuch
      const e = err instanceof BrokerError ? err : new BrokerError('unreachable');
      if (!(err instanceof BrokerError)) console.warn('Synchrothek: Vermittler', err);
      if (e.code === 'auth_failed') {
        features.markReauth();
        rejectCreate(e.text()); // Text enthält schon „Bitte melde dich erneut an.“
      } else {
        rejectCreate(e.text(), { retry: e.code === 'unreachable' || e.code === 'auth_unavailable' ? RETRY_CREATE : undefined });
      }
      pushStatus();
      return;
    }
    if (state.wantCreate !== want || !isOfficial()) return;
    want.ticket = room.ticket;

    // Schon mit genau diesem Knoten verbunden und gleich angemeldet: dieselbe Verbindung nutzen.
    // Lehnt der Knoten ab, bleibt man im bisherigen Raum.
    const signedInNow = isSignedIn();
    if (state.inRoom && ws && connAuth?.identified && state.nodeUrl === room.node.url && !!connAuth.account === signedInNow) {
      sentName = displayName();
      if (sendCreate(want, { name: sentName, installId: state.installId })) {
        pushStatus();
        return;
      }
    }
    // Sonst: bisherigen Raum verlassen und mit dem Knoten des neuen Raums verbinden
    if (state.inRoom || state.code) leaveRoom();
    else disconnect();
    state.tabId = tabId;
    state.nodeUrl = room.node.url;
    state.wantCreate = want;
    connect();
  }

  /** Server erstellt keinen Raum: Meldung zeigen; ein bestehender Raum bleibt, sonst Verbindung trennen. */
  function rejectCreate(text: Msg, { retry }: { retry?: NoticeRetry } = {}) {
    state.wantCreate = null;
    setNotice('error', text, { retry });
    if (!state.inRoom) {
      state.code = null;
      state.nodeUrl = null;
      disconnect();
    }
  }

  function joinRoom(tabId: number | null, code: string) {
    if (state.inRoom || state.code) leaveRoom();
    state.notice = null;
    state.tabId = tabId;
    state.code = code;
    sentName = displayName();
    if (isOfficial()) {
      // Knoten beim Vermittler erfragen, dann verbinden und join (angemeldet: vorher auth)
      disconnect();
      state.nodeUrl = null;
      void locateRoom(code);
      return;
    }
    if (!(connAuth?.identified && send({ type: 'join', code, name: sentName, installId: state.installId }))) connect();
  }

  function bindTab(tabId: number | null) {
    if (!state.inRoom || tabId === state.tabId) return;
    postToTab({ type: 'room', inRoom: false });
    state.tabId = tabId;
    state.followedUrl = null;
    persistSession();
    pushPlaybackToTab();
    void maybeFollow();
  }

  /**
   * Gemeinsam oder allein für Weiterschauen, Marker und Statistik: gemeinsam nur im Raum-Tab eines Raums
   * auf dem offiziellen Sync-Server (siehe watch-context.ts).
   */
  function contextOf(tabId: number | null): DataContext {
    return contextFor({ inRoom: state.inRoom, official: isOfficial(), roomTab: tabId != null && tabId === state.tabId });
  }

  const isHost = () => !!state.memberId && state.info?.hostId === state.memberId;
  const canControl = () => isHost() || state.info?.settings.controlMode === 'all';

  function roomUrls(): string[] {
    return [state.playback?.url, state.playback?.alias].filter((u): u is string => !!u);
  }

  function isRoomContent(url: string | null | undefined): boolean {
    return !!url && roomUrls().some((u) => sameContent(url, u));
  }

  /**
   * Führt den Raum-Tab zur Sendung des Raums – je Sendung nur einmal, damit man
   * danach frei weitersurfen kann, ohne zurückgeholt zu werden.
   */
  async function maybeFollow({ force = false } = {}) {
    const url = state.playback?.url;
    if (!state.inRoom || !url || state.tabId == null) return;
    if (!force && (!state.autoFollow || state.followedUrl === url)) return;
    state.followedUrl = url;
    persistSession();
    // Nur Seiten der unterstützten Mediatheken öffnen (https, echte Host-Prüfung). Die Adresse kommt vom
    // Server bzw. von anderen Teilnehmenden und wird sonst nie geöffnet.
    if (!isMediathekUrl(url)) {
      setNotice('info', localized('room.followOutside'));
      pushStatus();
      return;
    }

    let tab: Browser.tabs.Tab;
    try {
      tab = await browser.tabs.get(state.tabId);
    } catch {
      return;
    }
    if (isRoomContent(tab.url || tab.pendingUrl)) return;
    followPending = { url, at: Date.now() };
    try {
      await browser.tabs.update(state.tabId, { url });
    } catch (err) {
      console.warn('Synchrothek: Wechsel zur Sendung fehlgeschlagen', err);
    }
  }

  /** Der Server fragt den Host nach seiner tatsächlichen Position („Sync zum Host“). */
  function requestHostPosition() {
    const port = roomContentPort();
    if (port) return post(port, { type: 'positionRequest' });
    // Kein Video der Sendung offen: hochgerechneten Stand liefern
    const p = state.playback;
    if (p) {
      const position = p.playing ? p.position + (Date.now() - p.at) / 1000 : p.position;
      send({ type: 'hostPosition', position, playing: p.playing });
    }
  }

  // -------------------------------------------------------------------------
  // Content-Scripts
  // -------------------------------------------------------------------------

  function videoPortsOf(tabId: number | null): ContentPortInfo[] {
    return [...contentPorts.values()].filter((p) => p.tabId === tabId && p.hasVideo);
  }

  function roomContentPort(): Port | null {
    for (const [port, info] of contentPorts) {
      if (info.tabId === state.tabId && info.hasVideo && isRoomContent(info.url)) return port;
    }
    return null;
  }

  function post(port: Port, msg: ToContent) {
    try {
      port.postMessage(msg);
    } catch {}
  }

  function postToTab(msg: ToContent) {
    for (const [port, info] of contentPorts) if (info.tabId === state.tabId) post(port, msg);
  }

  function playbackMessage(force = false): ToContent | null {
    const p = state.playback;
    if (!p) return null;
    return { type: 'state', playing: p.playing, position: p.position, at: p.at, urls: roomUrls(), force };
  }

  function pushPlaybackToTab(force = false) {
    const msg = state.inRoom ? playbackMessage(force) : null;
    if (msg) postToTab(msg);
  }

  /** Port eines eigenen Content-Scripts auf einer Mediathek- oder Plattform-Seite (in einem Tab)? */
  function isContentSender(sender: Browser.runtime.MessageSender | undefined): boolean {
    if (!sender || sender.id !== browser.runtime.id || sender.tab?.id == null) return false;
    return isMediathekUrl(sender.url) || isAppUrl(sender.url);
  }

  /** Port des eigenen Popups (Seite der Extension, nicht in einem Tab)? */
  function isPopupSender(sender: Browser.runtime.MessageSender | undefined): boolean {
    if (!sender || sender.id !== browser.runtime.id || sender.tab || !sender.url) return false;
    try {
      const url = new URL(sender.url);
      const popup = new URL(browser.runtime.getURL('/popup.html'));
      return url.origin === popup.origin && url.pathname === popup.pathname;
    } catch {
      return false;
    }
  }

  function onContentPort(port: Port) {
    const tabId = port.sender?.tab?.id;
    if (tabId == null || !isContentSender(port.sender)) {
      port.disconnect();
      return;
    }
    contentPorts.set(port, { tabId, hasVideo: false, url: null });
    port.onDisconnect.addListener(() => {
      const info = contentPorts.get(port);
      contentPorts.delete(port);
      // Seite verlassen oder neu geladen: Zählung „allein“ dieses Tabs abschließen
      if (info?.hasVideo && !videoPortsOf(info.tabId).length) soloStats.end(info.tabId);
      pushStatus();
    });
    port.onMessage.addListener(async (msg: FromContent) => {
      await ready;
      handleContentMessage(port, msg);
    });
  }

  function handleContentMessage(port: Port, msg: FromContent) {
    const info = contentPorts.get(port);
    if (!info) return;
    const bound = state.inRoom && info.tabId === state.tabId;

    switch (msg.type) {
      case 'progress': {
        if (!isMediathekUrl(msg.url)) return;
        const context = contextOf(info.tabId);
        trackSoloStats(info.tabId, msg.url, msg.reason, context);
        void withTitle(info.tabId, msg).then((snap) => features.reportProgress(snap, msg.reason, context));
        return;
      }
      case 'resumeQuery':
        void answerResume(port, info, msg.url);
        return;
      case 'snapshot':
        snapshotWaits.get(msg.id)?.({ url: msg.url, title: msg.title, position: msg.position, duration: msg.duration });
        return;
      case 'hello': {
        post(port, { type: 'lang', lang: getLanguage() }); // vor allen Hinweisen im Player
        info.hasVideo = true;
        info.url = isMediathekUrl(msg.url) ? msg.url : null;
        if (bound && state.playback) {
          // Wurde die Sendungs-URL nach unserem automatischen Wechsel weitergeleitet,
          // gilt die tatsächliche Seite als dieselbe Sendung.
          const pending = followPending;
          if (pending && pending.url === state.playback.url && Date.now() - pending.at < ALIAS_WINDOW_MS) {
            followPending = null;
            if (!isRoomContent(msg.url)) state.playback.alias = msg.url;
          }
          const playback = playbackMessage();
          if (playback) post(port, playback);
        } else if (!bound) {
          post(port, { type: 'room', inRoom: false });
        }
        refreshFeaturesForTab(info.tabId);
        break;
      }
      case 'video':
        info.hasVideo = msg.present;
        break;
      case 'url':
        if (info.url && info.url !== msg.url) soloStats.end(info.tabId); // andere Seite im selben Tab
        info.url = isMediathekUrl(msg.url) ? msg.url : null;
        refreshFeaturesForTab(info.tabId);
        break;
      case 'local': {
        if (!bound) return;
        // Sendungswechsel nur zu Seiten der unterstützten Mediatheken
        if (msg.url !== undefined && !isMediathekUrl(msg.url)) {
          setNotice('info', localized('room.shareOutside'));
          break;
        }
        const previous = state.playback;
        const switched = !!msg.url; // URL wird nur bei einem Sendungswechsel mitgeschickt
        state.playback = {
          playing: msg.action === 'play' ? true : msg.action === 'pause' ? false : !!previous?.playing,
          position: msg.position,
          at: Date.now(),
          url: switched ? msg.url! : (previous?.url ?? null),
          alias: switched ? null : (previous?.alias ?? null),
        };
        if (switched) {
          state.followedUrl = msg.url!;
          persistSession();
        }
        send({ type: msg.action, position: msg.position, ...(switched && { url: msg.url }) });
        break;
      }
      case 'position':
        if (bound && isHost()) send({ type: 'hostPosition', position: msg.position, playing: msg.playing });
        return;
      default:
        return; // heartbeat
    }
    pushStatus();
  }

  // -------------------------------------------------------------------------
  // Weiterschauen und Marker
  // -------------------------------------------------------------------------

  /** Sendung mit Video im Tab (für Marker im Popup). */
  function showUrlOf(tabId: number | null): string | null {
    const url = videoPortsOf(tabId)[0]?.url;
    return url && apiUrl(url) ? url : null;
  }

  /** Ist ein Popup für diesen Tab offen, Marker der (neuen) Sendung laden. */
  function refreshFeaturesForTab(tabId: number) {
    if ([...popupPorts.values()].some((p) => p.tabId === tabId)) void features.refresh(showUrlOf(tabId), contextOf(tabId));
  }

  /** Kontext gewechselt (Raum betreten/verlassen): offene Popups laden die Daten des neuen Kontexts. */
  function refreshOpenPopups() {
    for (const { tabId } of popupPorts.values()) if (tabId != null) void features.refresh(showUrlOf(tabId), contextOf(tabId));
  }

  /**
   * Zuschauzeit beim alleine Schauen mitzählen – nur im Kontext „allein“ und nur, solange die
   * Einwilligungen `statistics` und `statistics_solo` bekanntermaßen erteilt sind. Gemeinsam zählt der Sync-Server.
   */
  function trackSoloStats(tabId: number, url: string, reason: ProgressReason, context: DataContext) {
    if (context !== 'solo' || !features.mayWriteNow('statistics', 'solo')) {
      if (context !== 'solo') soloStats.end(tabId); // Abschnitt mit dem alten Kontext abschließen
      else soloStats.clear(); // keine Einwilligung (mehr): nichts sammeln
      return;
    }
    if (reason === 'tick') soloStats.tick(tabId, url);
    else if (reason === 'pause') soloStats.pause(tabId);
    else soloStats.end(tabId); // Ende oder Seite verlassen
  }

  /** Ohne Titel (Video in einem eingebetteten Frame) gilt der Titel des Tabs. */
  async function withTitle(tabId: number, snap: ShowSnapshot): Promise<ShowSnapshot> {
    const { url, title, position, duration } = snap;
    if (title) return { url, title, position, duration };
    const tab = await browser.tabs.get(tabId).catch(() => null);
    return { url, title: tab?.title ?? '', position, duration };
  }

  /** „Weiterschauen ab …?“ – nicht im Raum-Tab, dort gibt der Raum die Position vor. */
  async function answerResume(port: Port, info: ContentPortInfo, url: string) {
    const inRoomTab = () => (state.inRoom || !!state.code) && info.tabId === state.tabId;
    const position = inRoomTab() || !isMediathekUrl(url) ? null : await features.resumePosition(url, contextOf(info.tabId));
    post(port, { type: 'resume', url, position: inRoomTab() ? null : position });
  }

  let snapshotSeq = 0;
  const snapshotWaits = new Map<number, (snap: ShowSnapshot | null) => void>();

  /** Aktuelle Sendung und Position im Tab abfragen (erste Antwort eines Frames mit Video gilt). */
  function requestSnapshot(tabId: number | null): Promise<ShowSnapshot | null> {
    const ports = [...contentPorts].filter(([, i]) => i.tabId === tabId && i.hasVideo).map(([p]) => p);
    if (!ports.length) return Promise.resolve(null);
    const id = ++snapshotSeq;
    return new Promise((resolve) => {
      const done = (snap: ShowSnapshot | null) => {
        clearTimeout(timer);
        snapshotWaits.delete(id);
        resolve(snap);
      };
      const timer = setTimeout(() => done(null), SNAPSHOT_TIMEOUT_MS);
      snapshotWaits.set(id, done);
      for (const p of ports) post(p, { type: 'snapshotRequest', id });
    });
  }

  async function addMarker(tabId: number | null, text: string) {
    const snap = await requestSnapshot(tabId);
    if (tabId == null || !snap || !apiUrl(snap.url)) {
      setNotice('error', localized('markers.noShow'));
      return;
    }
    await features.addMarker(await withTitle(tabId, snap), text, contextOf(tabId));
  }

  function seekTo(tabId: number | null, position: number) {
    const ports = [...contentPorts].filter(([, i]) => i.tabId === tabId && i.hasVideo);
    if (!ports.length || !Number.isFinite(position)) return;
    // Im Raum-Tab gilt ein Sprung für alle, also nur mit Steuerrecht
    const roomTab = state.inRoom && tabId === state.tabId && ports.some(([, i]) => isRoomContent(i.url));
    if (roomTab && !canControl()) {
      setNotice('info', localized('room.hostOnly'));
      return;
    }
    for (const [p] of ports) post(p, { type: 'seekTo', position });
  }

  /** Anmeldung starten; `returnTabId`: Tab, aus dem das Popup geöffnet wurde (danach wieder aktiv). */
  function startLogin(returnTabId: number | null) {
    state.notice = null;
    // Nicht abwarten: Der Anmelde-Tab (bzw. das Fenster) bleibt offen, bis die Person fertig ist (das Popup schließt sich dabei)
    auth.login({ returnTabId }).then(afterLogin, loginFailed);
  }

  function afterLogin() {
    // Läuft schon eine Verbindung, gilt die Anmeldung ab sofort (z. B. für einen später erstellten Raum)
    if (isSignedIn() && connAuth?.identified && !connAuth.account) void sendAuth(ws);
  }

  function loginFailed(err: unknown) {
    if (err instanceof AuthError) {
      // Abgebrochen ist keine Störung; Netzwerk- und Serverfehler mit „Erneut versuchen“
      const retry = err.kind === 'network' || err.kind === 'server';
      setNotice(err.kind === 'cancelled' ? 'info' : 'error', err.text, retry ? { retry: { action: 'login' } } : {});
    } else {
      setNotice('error', localized('auth.failed'));
      console.warn('Synchrothek: Anmeldung fehlgeschlagen', err);
    }
    pushStatus();
  }

  /**
   * Rückkehr aus dem Anmelde-Tab (Content-Script der Seite /extension/verbunden, Absender geprüft).
   * Erfolg oder Abbruch: Tab schließen und den vorherigen Tab wieder aktivieren. Andere Fehler: Tab bleibt
   * offen und zeigt den Fehler; im Popup steht derselbe Hinweis.
   */
  async function handleLoginCallback(tabId: number, params: Parameters<typeof auth.completeTabLogin>[1]): Promise<LoginCallbackResult> {
    await ready;
    const result = await auth.completeTabLogin(tabId, params);
    if (result.ok) {
      afterLogin();
      pushStatus();
    } else if (result.matched || result.error.kind === 'expired') {
      // Abgelaufen: Die offene Anmeldung ist schon verworfen; das Popup soll es trotzdem sagen
      loginFailed(result.error);
    }
    if (result.ok || (result.matched && result.error.kind === 'cancelled')) {
      // Kurz „Verbunden“ zeigen, dann zurück
      setTimeout(() => void closeLoginTab(tabId, result.returnTabId), result.ok ? 900 : 300);
    }
    return result.ok ? { ok: true } : { ok: false, error: result.error.kind };
  }

  async function closeLoginTab(tabId: number, returnTabId: number | null) {
    if (returnTabId !== null) await browser.tabs.update(returnTabId, { active: true }).catch(() => {});
    await browser.tabs.remove(tabId).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Statistik: Die Einwilligung steckt im Token für den Sync-Server (Claim `stats`)
  // -------------------------------------------------------------------------

  /** Nach Erteilen oder Widerruf sofort ein frisches Token holen und dem Sync-Server melden. */
  async function renewSyncAuth() {
    if (ws && connAuth?.official && connAuth.identified) {
      if (await sendAuth(ws, { forceRefresh: true })) return;
    }
    // Ohne (fertige) Verbindung: erneuern, damit die nächste Anmeldung am Sync-Server das neue Token nutzt
    await auth.getAccessToken({ forceRefresh: true }).catch((err) => console.info('Synchrothek: Token nicht erneuert', err));
  }

  // -------------------------------------------------------------------------
  // Freunde und Einladungen in Räume
  // -------------------------------------------------------------------------

  /** Einladen dürfen Hosts eines Raums auf dem offiziellen Server, mit Konto. */
  function canInvite(): boolean {
    return isSignedIn() && state.inRoom && !!state.code && isHost() && state.serverUrl === OFFICIAL_SYNC_URL;
  }

  async function scheduleInvitePolling(on: boolean) {
    try {
      if (!on) {
        await browser.alarms.clear(INVITE_ALARM);
        return;
      }
      // Nicht bei jedem Aufwachen neu anlegen, sonst verschiebt sich der Termin immer wieder
      if (!(await browser.alarms.get(INVITE_ALARM))) {
        await browser.alarms.create(INVITE_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
      }
      await social.poll();
    } catch (err) {
      console.warn('Synchrothek: Abfrage der Einladungen nicht eingerichtet', err);
    }
  }

  let inviteUi: Promise<void> = Promise.resolve();

  /** Badge und Systembenachrichtigung (höchstens einmal je Einladung, auch nach Neustart des Service Workers). */
  function showInvites(invites: RoomInvite[]) {
    inviteUi = inviteUi.then(async () => {
      try {
        await browser.action.setBadgeText({ text: invites.length ? String(invites.length) : '' });
        if (invites.length) await browser.action.setBadgeBackgroundColor({ color: '#1e40af' });

        const { notifiedInvites } = await browser.storage.session.get('notifiedInvites');
        const notified: Record<string, number> = { ...((notifiedInvites as Record<string, number> | undefined) ?? {}) };
        const current = new Set(invites.map((i) => i.id));
        for (const [id, expires] of Object.entries(notified)) {
          if (!current.has(id)) await browser.notifications.clear(INVITE_NOTIFICATION_PREFIX + id).catch(() => {});
          if (expires < Date.now()) delete notified[id];
        }
        for (const invite of invites) {
          if (invite.id in notified) continue;
          notified[invite.id] = Date.parse(invite.expiresAt);
          await notifyInvite(invite);
        }
        await browser.storage.session.set({ notifiedInvites: notified });
      } catch (err) {
        console.warn('Synchrothek: Einladung nicht angezeigt', err);
      }
    });
    return inviteUi;
  }

  async function notifyInvite(invite: RoomInvite) {
    const options: Browser.notifications.NotificationCreateOptions = {
      type: 'basic',
      iconUrl: browser.runtime.getURL('/notification.png'),
      title: t('invites.notificationTitle'),
      message: invite.title
        ? t('invites.notificationWithTitle', { name: invite.from.username, title: invite.title })
        : t('invites.notificationNoTitle', { name: invite.from.username }),
    };
    // Firefox kennt keine Knöpfe in Benachrichtigungen; dort öffnet ein Klick das Popup
    if (!import.meta.env.FIREFOX) options.buttons = [{ title: t('lobby.join') }, { title: t('invites.decline') }];
    await browser.notifications.create(INVITE_NOTIFICATION_PREFIX + invite.id, options);
  }

  /** Einladung annehmen: join mit dem Code auf dem offiziellen Server, danach die Einladung löschen. */
  async function acceptInvite(tabId: number | null, id: string, { newTab = false } = {}) {
    const invite = social.take(id);
    if (!invite) {
      setNotice('error', localized('invites.expired'));
      return;
    }
    const switched = state.serverUrl !== OFFICIAL_SYNC_URL;
    if (switched) await changeServer(OFFICIAL_SYNC_URL); // Einladungen gelten für Räume des offiziellen Servers
    let target = tabId;
    if (newTab || target == null) target = (await browser.tabs.create({ active: true }).catch(() => null))?.id ?? null;
    joinRoom(target, invite.roomCode);
    if (switched) setNotice('info', localized('invites.serverReset'));
    void social.remove(invite.id);
  }

  function declineInvite(id: string) {
    social.take(id);
    void social.remove(id);
  }

  /** Titel der Sendung im Raum-Tab (für die Einladung), falls dort gerade die Sendung des Raums läuft. */
  async function roomTitle(): Promise<string | null> {
    if (state.tabId == null) return null;
    const tab = await browser.tabs.get(state.tabId).catch(() => null);
    return tab?.title && isRoomContent(tab.url) ? cleanTitle(tab.title) || null : null;
  }

  /** Seitentitel für die Anzeige im Popup nachladen (Host-Berechtigung der Mediatheken genügt). */
  async function loadTitles(tabIds: (number | null)[]) {
    let changed = false;
    for (const id of new Set(tabIds)) {
      if (id == null) continue;
      const tab = await browser.tabs.get(id).catch(() => null);
      const title = cleanTitle(tab?.title);
      if (title && tabTitles.get(id) !== title) {
        tabTitles.set(id, title);
        changed = true;
      }
    }
    if (changed) pushStatus();
  }

  /** Titel der Sendung im Tab, wenn dort ein Video der Seite läuft. */
  function titleOf(tabId: number | null, predicate: (url: string | null) => boolean): string | null {
    if (tabId == null) return null;
    const port = videoPortsOf(tabId).find((p) => predicate(p.url));
    return port ? (tabTitles.get(tabId) ?? null) : null;
  }

  // -------------------------------------------------------------------------
  // Popup
  // -------------------------------------------------------------------------

  function onPopupPort(port: Port) {
    if (!isPopupSender(port.sender)) {
      port.disconnect();
      return;
    }
    popupPorts.set(port, { tabId: null });
    port.onDisconnect.addListener(() => popupPorts.delete(port));
    port.onMessage.addListener(async (msg: PopupCommand) => {
      await ready;
      const info = popupPorts.get(port);
      if (!info) return;
      if (msg.cmd === 'hello') {
        info.tabId = msg.tabId;
        auth.refreshProfileIfStale();
        void features.refresh(showUrlOf(msg.tabId), contextOf(msg.tabId));
        void social.poll();
        void avatars.loadMe();
        void loadClientConfig();
        void loadTitles([msg.tabId, state.tabId]);
      } else await handlePopupCommand(info.tabId, msg);
      pushStatus();
    });
  }

  async function handlePopupCommand(tabId: number | null, msg: PopupCommand) {
    switch (msg.cmd) {
      case 'create':
        createRoom(tabId);
        break;
      case 'join': {
        const code = msg.code.trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code)) {
          setNotice('error', localized('lobby.codeLength'));
          break;
        }
        joinRoom(tabId, code);
        break;
      }
      case 'cancel':
      case 'leave':
        leaveRoom();
        break;
      case 'bindTab':
        bindTab(tabId);
        break;
      case 'openRoomUrl':
        await maybeFollow({ force: true });
        break;
      case 'shareContent':
        // Die Sendung im Raum-Tab für alle starten
        if (state.inRoom && tabId === state.tabId) postToTab({ type: 'adopt' });
        break;
      case 'setAutoFollow':
        state.autoFollow = msg.value;
        await browser.storage.local.set({ autoFollow: state.autoFollow });
        if (state.autoFollow) await maybeFollow();
        break;
      case 'setServer': {
        const url = msg.url.trim();
        if (!/^wss?:\/\/\S+$/.test(url)) {
          setNotice('error', localized('server.mustStartWithWs'));
          break;
        }
        // Schreibvarianten des Standards (z. B. mit „/“ am Ende) als Standard behandeln
        await changeServer(normalizeServerUrl(url) === normalizeServerUrl(DEFAULT_SERVER_URL) ? DEFAULT_SERVER_URL : url);
        break;
      }
      case 'resetServer':
        await changeServer(DEFAULT_SERVER_URL);
        break;
      case 'setName': {
        // Auch mit Konto änderbar: der Benutzername des Kontos ist nur der Vorschlag
        const name = sanitizeName(msg.name);
        if (!name) {
          setNotice('error', localized('settings.nameRequired'));
          break;
        }
        state.name = name;
        state.nameChosen = true;
        await browser.storage.local.set({ name, nameChosen: true });
        syncDisplayName();
        break;
      }
      case 'setLanguage':
        await changeLanguage(parseLangSetting(msg.value));
        break;
      case 'useAccountName':
        state.nameChosen = false;
        await browser.storage.local.set({ nameChosen: false });
        syncDisplayName();
        break;
      case 'control': {
        if (!state.inRoom || !canControl()) break;
        const port = roomContentPort();
        if (!port) {
          setNotice('error', localized('room.contentNotOpen'));
          break;
        }
        post(port, msg.action === 'seek' ? { type: 'control', action: 'seek', delta: msg.delta } : { type: 'control', action: 'toggle' });
        break;
      }
      case 'sync':
        if (!state.inRoom) break;
        // Host: eigene Position direkt an alle („Alle auf meine Position synchronisieren“); der Server
        // ignoriert syncRequest vom Host. Gast: den Host um seine Position bitten.
        if (isHost()) requestHostPosition();
        else send({ type: 'syncRequest' });
        break;
      case 'kick':
        send({ type: 'kick', memberId: msg.memberId, ban: msg.ban });
        break;
      case 'transferHost':
        send({ type: 'transferHost', memberId: msg.memberId });
        break;
      case 'updateSettings':
        send({ type: 'updateSettings', maxMembers: msg.maxMembers, controlMode: msg.controlMode });
        break;
      case 'dismissNotice':
        state.notice = null;
        features.dismissError();
        social.dismissError();
        break;
      case 'login':
        startLogin(tabId);
        break;
      case 'relogin':
        // Die API lehnt auch ein frisches Token ab: Anmeldung erneuern
        if (connAuth) clearTimeout(connAuth.renewTimer);
        await auth.logout();
        startLogin(tabId);
        break;
      case 'featuresRefresh':
        await features.refresh(showUrlOf(tabId), contextOf(tabId), { force: true });
        break;
      case 'grantConsent': {
        const ok = await features.grant(msg.purpose, msg.version);
        // Nur die Haupteinwilligung steckt im Token für den Sync-Server (Claim `stats`)
        if (ok && msg.purpose === 'statistics') await renewSyncAuth();
        await features.refresh(showUrlOf(tabId), contextOf(tabId));
        break;
      }
      case 'revokeConsent': {
        const solo = isSoloPurpose(msg.purpose);
        const base = basePurposeOf(msg.purpose);
        if (base === 'statistics') soloStats.clear(); // nichts mehr melden
        const deleted = await features.revoke(msg.purpose);
        if (deleted !== undefined) {
          const label = solo ? localized('purpose.soloLong', { label: localized(`purpose.${base}`) }) : localized(`purpose.${base}`);
          setNotice('info', localized('consents.revoked', { label, deleted: deletedText(base, deleted, solo) }));
          if (msg.purpose === 'statistics') await renewSyncAuth(); // Sync-Server zählt nicht weiter
        }
        break;
      }
      case 'deleteSoloData': {
        if (msg.purpose === 'statistics') soloStats.clear();
        const deleted = await features.deleteSoloData(msg.purpose);
        if (deleted !== undefined) setNotice('info', localized('deleted.done', { what: deletedText(msg.purpose, deleted, true) }));
        break;
      }
      case 'peek': {
        const snap = tabId == null ? null : await requestSnapshot(tabId);
        if (tabId == null) break;
        if (snap) peeks.set(tabId, { url: snap.url, position: snap.position, duration: snap.duration });
        else peeks.delete(tabId);
        break;
      }
      case 'acceptInvite':
        await acceptInvite(tabId, msg.id);
        break;
      case 'declineInvite':
        declineInvite(msg.id);
        break;
      case 'loadFriends': {
        await social.loadFriends();
        // Bilder von Personen, die keine Freunde mehr sind, aus dem Cache entfernen
        const friends = social.status(null, false).friends;
        if (friends) void avatars.prune(friends.map((f) => f.avatarUrl));
        break;
      }
      case 'avatars':
        avatars.want(msg.urls.slice(0, 100));
        break;
      case 'inviteFriend':
        if (canInvite() && state.code) await social.inviteFriend(msg.friendId, state.code, await roomTitle());
        break;
      case 'addMarker':
        await addMarker(tabId, msg.text);
        break;
      case 'deleteMarker':
        await features.deleteMarker(msg.id);
        break;
      case 'seekTo':
        seekTo(tabId, msg.position);
        break;
      case 'loadProgressList':
        await features.loadProgressList();
        break;
      case 'deleteProgress':
        await features.deleteProgress(msg.url, msg.context === 'solo' ? 'solo' : 'room');
        break;
      case 'openShow': {
        // Nur Seiten der unterstützten Mediatheken öffnen
        const url = apiUrl(msg.url);
        if (url && isMediathekUrl(url)) await browser.tabs.create({ url });
        break;
      }
      case 'logout':
        state.notice = null;
        // Keine Erneuerung mehr; die Anmeldung der Verbindung läuft beim Server mit dem Token ab
        if (connAuth) clearTimeout(connAuth.renewTimer);
        if (!(await auth.logout())) {
          setNotice('info', localized('account.loggedOutLocally'));
        }
        break;
    }
  }

  async function changeServer(url: string) {
    state.notice = null;
    if (url === state.serverUrl) return;
    if (state.inRoom || state.code || state.wantCreate) leaveRoom();
    disconnect();
    state.nodeUrl = null;
    state.serverUrl = url;
    state.server = null;
    // Nur abweichende Server speichern, damit ein geänderter Standard bei Updates greift
    if (url === DEFAULT_SERVER_URL) await browser.storage.local.remove('serverUrl');
    else await browser.storage.local.set({ serverUrl: url });
  }

  function peekOf(tabId: number | null, ports: ContentPortInfo[]) {
    const peek = tabId == null ? undefined : peeks.get(tabId);
    // Nur, solange die Seite noch dieselbe ist
    if (!peek || !ports.some((p) => p.url === peek.url)) return { position: null, duration: null };
    return { position: peek.position, duration: peek.duration };
  }

  function statusFor(tabId: number | null): PopupStatus {
    const ports = videoPortsOf(tabId);
    const info = state.info;
    const notice = state.notice;
    return {
      lang: getLanguage(),
      langSetting: state.langSetting,
      serverUrl: state.serverUrl,
      isDefaultServer: state.serverUrl === DEFAULT_SERVER_URL,
      server: state.server,
      autoFollow: state.autoFollow,
      name: displayName(),
      nameSuggestion: accountName(),
      nameChosen: state.nameChosen,
      conn: state.conn,
      notice: notice ? { kind: notice.kind, text: tr(notice.text), ...(notice.retry && { retry: notice.retry }) } : null,
      account: auth.status(),
      platform: {
        notice: clientConfig?.notice ?? null,
        update: needsUpdate(EXTENSION_VERSION, clientConfig)
          ? { current: EXTENSION_VERSION, minimum: clientConfig!.minExtensionVersion! }
          : null,
      },
      profile: (() => {
        const me = avatars.me();
        return me ? { username: me.username, avatarUrl: me.avatarUrl } : null;
      })(),
      installType,
      features: features.status(showUrlOf(tabId), contextOf(tabId)),
      social: social.status(state.inRoom ? state.code : null, canInvite()),
      code: state.code,
      inRoom: state.inRoom,
      pending: !state.inRoom && (!!state.wantCreate || !!state.code),
      me: state.memberId,
      isHost: isHost(),
      canControl: canControl(),
      room:
        info && state.inRoom
          ? {
              hostId: info.hostId,
              members: info.members,
              settings: info.settings,
              memberLimit: info.memberLimit,
              closesAt: info.closesAt === null ? null : info.closesAt - state.clockOffset,
              playing: !!state.playback?.playing,
              url: state.playback?.url ?? null,
              title: titleOf(state.tabId, isRoomContent),
              createdWithAccount: state.createdWithAccount,
            }
          : null,
      tab: {
        hasVideo: ports.length > 0,
        onRoomContent: ports.some((p) => isRoomContent(p.url)),
        isBound: tabId != null && tabId === state.tabId,
        title: titleOf(tabId, () => true),
        ...peekOf(tabId, ports),
      },
    };
  }

  function pushStatus() {
    for (const [port, info] of popupPorts) {
      const msg: ToPopup = { type: 'status', status: statusFor(info.tabId) };
      try {
        port.postMessage(msg);
      } catch {}
    }
  }

  // -------------------------------------------------------------------------
  // Listener (synchron registrieren)
  // -------------------------------------------------------------------------

  // Nur Ports: Popup (Seite der Extension) und eigene Content-Scripts auf Mediathek-/Plattform-Seiten,
  // geprüft über port.sender. Nachrichten von außen (onConnectExternal/onMessageExternal,
  // externally_connectable) nimmt der Hintergrund nicht an.
  browser.runtime.onConnect.addListener((port) => {
    if (port.name === 'content') onContentPort(port);
    else if (port.name === 'popup') onPopupPort(port);
    else port.disconnect();
  });

  // Einzige Einzelnachricht (runtime.onMessage): die Rückkehr der Anmeldung im Tab. Sie kommt genau einmal
  // vom Content-Script der Seite https://app.synchrothek.de/extension/verbunden; ein Port lohnt dafür nicht,
  // und die Antwort (Ergebnis für die Anzeige auf der Seite) passt zu sendMessage. Angenommen wird nur
  // genau diese Nachrichtenform vom eigenen Content-Script im obersten Frame genau dieser Seite
  // (loginCallbackTabId); dass Tab und State zur offenen Anmeldung passen, prüft auth.completeTabLogin.
  // Alles andere bleibt unbeantwortet.
  browser.runtime.onMessage.addListener((message: unknown, sender: Browser.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
    if (!isLoginCallbackMessage(message)) return false;
    const tabId = loginCallbackTabId(sender, browser.runtime.id);
    if (tabId === null) return false;
    const { code, state: oauthState, iss, error } = message;
    handleLoginCallback(tabId, { code, state: oauthState, iss, error }).then(sendResponse, (err) => {
      console.warn('Synchrothek: Rückkehr der Anmeldung fehlgeschlagen', err);
      sendResponse({ ok: false, error: 'failed' } satisfies LoginCallbackResult);
    });
    return true; // Antwort kommt asynchron
  });

  // Einladungen in Räume: etwa jede Minute abfragen, solange man angemeldet ist
  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== INVITE_ALARM) return;
    await auth.ready;
    if (!isSignedIn()) {
      await browser.alarms.clear(INVITE_ALARM);
      return;
    }
    await social.poll();
  });

  browser.notifications.onClicked.addListener(async (id) => {
    if (!id.startsWith(INVITE_NOTIFICATION_PREFIX)) return;
    try {
      await browser.action.openPopup(); // Einladung steht oben im Popup
    } catch {
      // nicht überall erlaubt; die Einladung bleibt im Popup und am Badge sichtbar
    }
  });

  // Nur Chrome: Knöpfe in der Benachrichtigung. Beitreten öffnet einen neuen Tab für den Raum.
  browser.notifications.onButtonClicked?.addListener(async (id, index) => {
    if (!id.startsWith(INVITE_NOTIFICATION_PREFIX)) return;
    await ready;
    await auth.ready;
    const inviteId = id.slice(INVITE_NOTIFICATION_PREFIX.length);
    if (index === 0) await acceptInvite(null, inviteId, { newTab: true });
    else declineInvite(inviteId);
    pushStatus();
  });

  // Bevorzugte Sprache des Browsers geändert: gilt bei „Automatisch“ sofort
  globalThis.addEventListener?.('languagechange', () => {
    void ready.then(applyLanguage);
  });

  // Titeländerungen (z. B. Navigation in der Mediathek) für die Anzeige im Popup
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.title === undefined) return;
    const title = cleanTitle(changeInfo.title);
    if (title) tabTitles.set(tabId, title);
    else tabTitles.delete(tabId);
    if (popupPorts.size) pushStatus();
  });

  browser.tabs.onRemoved.addListener(async (tabId) => {
    tabTitles.delete(tabId);
    peeks.delete(tabId);
    soloStats.end(tabId);
    // Anmelde-Tab geschlossen, bevor die Anmeldung fertig war: abgebrochen
    if (await auth.loginTabClosed(tabId).catch(() => false)) {
      setNotice('info', localized('auth.cancelled'));
      pushStatus();
    }
    await ready;
    if (tabId === state.tabId && (state.inRoom || state.code)) {
      leaveRoom();
      pushStatus();
    }
  });

  // Nur im E2E-Testbuild: Zugriff für automatisierte Tests (nicht in Release-Builds enthalten)
  if (import.meta.env.MODE === 'e2e') {
    Object.assign(globalThis, {
      synchrothekTest: {
        state,
        ready,
        command: async (tabId: number | null, cmd: PopupCommand) => {
          await handlePopupCommand(tabId, cmd);
          pushStatus();
        },
        dropSocket: () => ws?.close(), // Verbindungsabbruch nachstellen
      },
    });
  }
});
