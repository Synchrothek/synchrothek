/**
 * Vermittler des offiziellen Sync-Dienstes (Knoten-Pool, siehe docs/offizielle-dienste.md).
 *
 * Nur für den offiziellen Server. Der Vermittler vergibt beim Erstellen Raumcode, Knoten und ein Ticket
 * (einmal gültig, 60 s); beim Beitreten nennt er den Knoten eines Raums. Danach spricht die Extension per
 * WebSocket direkt mit dem Knoten. Wiederverbinden geht ohne Vermittler direkt zum zuletzt benutzten Knoten.
 *
 * Tokens gehen nur an BROKER_BASE_URL und an Knoten-Adressen, die isOfficialNodeUrl erfüllen.
 * Ohne Abhängigkeit von `browser`, damit sich das Modul unter Node testen lässt.
 */
import { TICKET_MAX_LENGTH } from './protocol.ts';

export const BROKER_BASE_URL = 'https://sync.synchrothek.de/v1';
/** Knoten: wss://<kürzel>.sync.synchrothek.de */
const NODE_HOST_SUFFIX = '.sync.synchrothek.de';
const ROOM_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;

export const BROKER_UNREACHABLE_TEXT = 'Der Sync-Dienst ist gerade nicht erreichbar.';
export const TICKET_INVALID_TEXT = 'Der Raum konnte nicht erstellt werden. Bitte versuch es noch einmal.';

export type BrokerErrorCode =
  | 'room_not_found'
  | 'server_full'
  | 'maintenance'
  | 'rate_limited'
  | 'auth_failed'
  | 'auth_unavailable'
  | 'unreachable' // Netzwerkfehler, Zeitüberschreitung, unerwartete Antwort
  | (string & {}); // andere Codes des Vermittlers: Meldung anzeigen

export class BrokerError extends Error {
  code: BrokerErrorCode;
  retryAfterMs: number | null;
  constructor(code: BrokerErrorCode, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface PoolNode {
  id: string;
  url: string; // geprüft mit isOfficialNodeUrl
}

export interface CreatedRoom {
  code: string;
  node: PoolNode;
  ticket: string;
}

/**
 * Darf an diese Adresse ein Token gehen? Nur wss, Host <etwas>.sync.synchrothek.de, Standard-Port,
 * keine Zugangsdaten, kein Pfad, keine Query.
 */
export function isOfficialNodeUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 256) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname;
  const label = host.endsWith(NODE_HOST_SUFFIX) ? host.slice(0, -NODE_HOST_SUFFIX.length) : '';
  return (
    url.protocol === 'wss:' &&
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(label) &&
    url.port === '' &&
    !url.username &&
    !url.password &&
    (url.pathname === '/' || url.pathname === '') &&
    !url.search &&
    !url.hash
  );
}

/** Kanonische Form einer geprüften Knoten-Adresse (ohne „/“ am Ende). */
function nodeFrom(data: unknown): PoolNode | null {
  if (!data || typeof data !== 'object') return null;
  const n = data as Record<string, unknown>;
  if (typeof n.id !== 'string' || !n.id || n.id.length > 64 || !isOfficialNodeUrl(n.url)) return null;
  const url = new URL(n.url);
  return { id: n.id, url: `wss://${url.hostname}` };
}

export interface BrokerDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export function createBroker(deps: BrokerDeps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? Date.now;
  let blockedUntil = 0; // 429: bis dahin keine Anfragen
  let blockedMessage = '';

  async function request(method: 'GET' | 'POST', path: string, token: string | null): Promise<{ status: number; data: unknown }> {
    if (now() < blockedUntil) {
      throw new BrokerError('rate_limited', blockedMessage || 'Zu viele Anfragen. Bitte versuch es gleich noch einmal.', blockedUntil - now());
    }
    let res: Response;
    try {
      res = await doFetch(`${BROKER_BASE_URL}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(method === 'POST' && { 'Content-Type': 'application/json' }),
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        ...(method === 'POST' && { body: '{}' }),
        credentials: 'omit',
        redirect: 'error', // ein Token folgt keiner Weiterleitung
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new BrokerError('unreachable', BROKER_UNREACHABLE_TEXT);
    }
    let data: unknown = null;
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      try {
        data = await res.json();
      } catch {}
    }
    if (res.ok) return { status: res.status, data };

    const body = (data && typeof data === 'object' ? data : {}) as { error?: unknown; message?: unknown };
    const code = typeof body.error === 'string' ? body.error : '';
    const message = typeof body.message === 'string' ? [...body.message.replace(/\s+/g, ' ').trim()].slice(0, 300).join('') : '';
    if (res.status === 429) {
      const seconds = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : DEFAULT_RETRY_AFTER_MS;
      blockedUntil = now() + wait;
      blockedMessage = message;
      throw new BrokerError('rate_limited', message || 'Zu viele Anfragen. Bitte versuch es gleich noch einmal.', wait);
    }
    if (!code) {
      // Keine Antwort des Vermittlers (z. B. Proxy-Fehlerseite)
      if (res.status === 404 && path.startsWith('/rooms/')) throw new BrokerError('room_not_found', 'Raum nicht gefunden.');
      throw new BrokerError('unreachable', BROKER_UNREACHABLE_TEXT);
    }
    throw new BrokerError(code, message || (code === 'room_not_found' ? 'Raum nicht gefunden.' : BROKER_UNREACHABLE_TEXT));
  }

  return {
    /** Raum erstellen lassen: Code, Knoten und Ticket. Mit Token = Raum mit den Grenzen des Kontos. */
    async createRoom(token: string | null): Promise<CreatedRoom> {
      const { data } = await request('POST', '/rooms', token);
      const d = (data ?? {}) as Record<string, unknown>;
      const node = nodeFrom(d.node);
      const code = typeof d.code === 'string' ? d.code : '';
      const ticket = typeof d.ticket === 'string' ? d.ticket : '';
      if (!node || !ROOM_CODE.test(code) || !ticket || ticket.length > TICKET_MAX_LENGTH) {
        // Unerwartete Antwort oder Knoten außerhalb von *.sync.synchrothek.de: nicht verbinden
        throw new BrokerError('unreachable', BROKER_UNREACHABLE_TEXT);
      }
      return { code, node, ticket };
    },

    /** Knoten eines Raums. */
    async lookupRoom(code: string): Promise<PoolNode> {
      if (!ROOM_CODE.test(code)) throw new BrokerError('room_not_found', 'Raum nicht gefunden.');
      const { data } = await request('GET', `/rooms/${code}`, null);
      const node = nodeFrom((data as Record<string, unknown> | null)?.node);
      if (!node) throw new BrokerError('unreachable', BROKER_UNREACHABLE_TEXT);
      return node;
    },
  };
}

export type Broker = ReturnType<typeof createBroker>;
