/**
 * Fehlercodes von Vermittler und Sync-Server lokal übersetzen.
 *
 * Vermittler (sync.synchrothek.de/v1) und Sync-Server (WebSocket, auch selbst gehostet) senden neben dem
 * Code eine `message` in einer festen Sprache (Deutsch). Die Extension zeigt deshalb nur eigene Texte zu
 * bekannten Codes. Bei unbekannten Codes (neuerer Server) gibt es einen allgemeinen Text in der Sprache der
 * Oberfläche; die Meldung des Servers steht dann höchstens gekürzt als Zusatz dahinter.
 *
 * Plattform-API (api.synchrothek.de/v1): nicht hier. Sie liefert `message` in der Sprache aus
 * `Accept-Language` (api.ts).
 */
import type { ErrorCode } from '../protocol.ts';
import { msg, shorten, type MessageKey, type Msg } from './index.ts';

const DETAIL_MAX = 120;

/** Allgemeiner Text plus (gekürzte) Meldung des Servers als Zusatz. */
function withDetail(text: Msg, serverMessage: string | null | undefined): Msg {
  const detail = serverMessage ? shorten(serverMessage, DETAIL_MAX) : '';
  return detail ? msg('error.withDetail', { text, detail }) : text;
}

/** Codes des Vermittlers (Antwort `{ error, message }`) plus `unreachable` (Netz, Zeitüberschreitung, fremde Antwort). */
const BROKER_TEXTS: Readonly<Record<string, MessageKey>> = {
  room_not_found: 'broker.room_not_found',
  server_full: 'broker.server_full',
  maintenance: 'broker.maintenance',
  rate_limited: 'error.rateLimited',
  auth_failed: 'broker.auth_failed',
  auth_unavailable: 'broker.auth_unavailable',
  unreachable: 'broker.unreachable',
  internal_error: 'broker.internal_error',
  forbidden_origin: 'broker.forbidden_origin',
  not_found: 'broker.rejected',
  method_not_allowed: 'broker.rejected',
};

/** Bekannte Codes des Vermittlers (für Tests und Doku). */
export const BROKER_ERROR_CODES: readonly string[] = Object.keys(BROKER_TEXTS);

export function brokerErrorMsg(code: string, serverMessage?: string | null): Msg {
  const key = Object.hasOwn(BROKER_TEXTS, code) ? BROKER_TEXTS[code] : undefined;
  return key ? msg(key) : withDetail(msg('broker.unknown', { code: shorten(code, 40) }), serverMessage);
}

/** Codes des Sync-Servers (protocol.ts, `ErrorCode`). Vollständig: der Typ erzwingt jeden Code. */
const SYNC_TEXTS: Readonly<Record<ErrorCode, MessageKey>> = {
  bad_json: 'sync.bad_message',
  bad_message: 'sync.bad_message',
  unknown_type: 'sync.bad_message',
  rate_limited: 'sync.rate_limited',
  room_not_found: 'sync.room_not_found',
  room_full: 'room.full',
  banned: 'sync.banned',
  not_in_room: 'sync.not_in_room',
  not_host: 'sync.not_host',
  not_allowed: 'room.hostOnly',
  bad_position: 'common.invalidPosition',
  bad_member: 'sync.bad_member',
  host_unavailable: 'sync.host_unavailable',
  auth_unsupported: 'sync.auth_unsupported',
  auth_failed: 'sync.auth_failed',
  server_full: 'broker.server_full',
  maintenance: 'broker.maintenance',
  ticket_invalid: 'room.ticketInvalid',
};

export const SYNC_ERROR_CODES = Object.keys(SYNC_TEXTS) as ErrorCode[];

export function syncErrorMsg(code: string, serverMessage?: string | null): Msg {
  const key = Object.hasOwn(SYNC_TEXTS, code) ? SYNC_TEXTS[code as ErrorCode] : undefined;
  return key ? msg(key) : withDetail(msg('sync.unknown', { code: shorten(String(code), 40) }), serverMessage);
}
