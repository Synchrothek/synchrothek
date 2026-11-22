/**
 * Tests für den API-Client (src/lib/api.ts) mit nachgebildetem fetch.
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createApi } from '../src/lib/api.ts';
import { API_BASE_URL } from '../src/lib/config.ts';

interface Call {
  url: string;
  init: RequestInit;
  body: unknown;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

const CONSENT = {
  watch_progress: { granted: true, version: 'v1', grantedAt: '2026-11-18T19:20:00.000Z', currentVersion: 'v1', title: 'Weiterschauen', text: 'Text A' },
  markers: { granted: false, version: null, grantedAt: null, currentVersion: 'v1', title: 'Marker', text: 'Text B' },
};

function setup(responses: Array<Response | (() => Response)>, { token = 'tok-1' as string | null } = {}) {
  const calls: Call[] = [];
  const tokenRequests: Array<{ forceRefresh?: boolean }> = [];
  let clock = 1_000_000;
  let refreshed = 0;
  const api = createApi({
    getAccessToken: async (options = {}) => {
      tokenRequests.push(options);
      if (options.forceRefresh) refreshed++;
      return token && (refreshed ? `tok-${refreshed + 1}` : token);
    },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const next = responses.shift();
      if (!next) throw new Error('unerwarteter Aufruf');
      return typeof next === 'function' ? next() : next;
    }) as typeof fetch,
    now: () => clock,
  });
  return { api, calls, tokenRequests, advance: (ms: number) => (clock += ms) };
}

/** n-ter Aufruf (bricht ab, wenn es ihn nicht gibt). */
function nth(calls: Call[], n: number): Call {
  const c = calls[n];
  assert.ok(c, `Aufruf ${n} fehlt`);
  return c;
}

const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);

async function rejects(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => assert.fail('kein Fehler'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof ApiError, `ApiError erwartet, bekam ${err}`);
  assert.equal(err.code, code);
  return err;
}

test('schickt das Token nur an die feste API-Adresse, ohne Cookies und ohne Weiterleitung', async () => {
  const { api, calls } = setup([json(200, CONSENT)]);
  const consent = await api.getConsent();
  assert.equal(consent.markers?.text, 'Text B');
  assert.equal(consent.statistics, undefined); // Zweck unbekannt: nicht angeboten
  assert.equal(calls.length, 1);
  assert.equal(nth(calls, 0).url, `${API_BASE_URL}/consent`);
  assert.ok(nth(calls, 0).url.startsWith('https://api.synchrothek.de/v1/'));
  assert.equal(header(nth(calls, 0), 'authorization'), 'Bearer tok-1');
  assert.equal(nth(calls, 0).init.credentials, 'omit');
  assert.equal(nth(calls, 0).init.redirect, 'error');
});

test('ohne Anmeldung keine Anfrage', async () => {
  const { api, calls } = setup([], { token: null });
  await rejects(api.getConsent(), 'signed_out');
  assert.equal(calls.length, 0);
});

test('401 token_expired: erneuert und wiederholt genau einmal', async () => {
  const { api, calls, tokenRequests } = setup([
    json(401, { error: 'token_expired', message: 'abgelaufen' }),
    json(200, { item: null }),
  ]);
  assert.equal(await api.getProgress('https://www.zdf.de/a'), null);
  assert.equal(calls.length, 2);
  assert.deepEqual(tokenRequests, [{ forceRefresh: false }, { forceRefresh: true }]);
  assert.equal(header(nth(calls, 1), 'authorization'), 'Bearer tok-2');
});

test('401 auch nach Erneuerung: neu anmelden, keine weiteren Versuche', async () => {
  const { api, calls } = setup([
    json(401, { error: 'invalid_token', message: 'x' }),
    json(401, { error: 'invalid_token', message: 'x' }),
  ]);
  await rejects(api.getConsent(), 'reauth');
  assert.equal(calls.length, 2);
});

test('401 unauthorized: ohne Erneuerung neu anmelden', async () => {
  const { api, calls, tokenRequests } = setup([json(401, { error: 'unauthorized', message: 'x' })]);
  await rejects(api.getConsent(), 'reauth');
  assert.equal(calls.length, 1);
  assert.equal(tokenRequests.length, 1);
});

test('401 ohne JSON (vorgeschaltetes Gate): nicht erreichbar, keine Abmeldung', async () => {
  const { api, calls } = setup([new Response('<html>Gate</html>', { status: 401, headers: { 'content-type': 'text/html' } })]);
  await rejects(api.getConsent(), 'unavailable');
  assert.equal(calls.length, 1);
});

test('403 consent_required liefert den Zweck', async () => {
  const { api } = setup([json(403, { error: 'consent_required', message: 'Einwilligung fehlt', purpose: 'markers' })]);
  const err = await rejects(api.listMarkers('https://www.zdf.de/a'), 'consent_required');
  assert.equal(err.extra.purpose, 'markers');
});

test('409 consent_version_mismatch und limit_reached', async () => {
  const { api } = setup([
    json(409, { error: 'consent_version_mismatch', message: 'x', purpose: 'markers', currentVersion: 'v2' }),
    json(409, { error: 'limit_reached', message: 'x', limit: 2000 }),
  ]);
  await rejects(api.setConsent('markers', true, 'v1'), 'consent_version_mismatch');
  const err = await rejects(api.addMarker({ url: 'https://www.zdf.de/a', title: 'A', position: 1 }), 'limit_reached');
  assert.equal(err.extra.limit, 2000);
});

test('429: bis Retry-After nichts mehr senden', async () => {
  const { api, calls, advance } = setup([
    json(429, { error: 'rate_limited', message: 'x', retryAfter: 30 }, { 'retry-after': '30' }),
    json(200, CONSENT),
  ]);
  await rejects(api.getConsent(), 'rate_limited');
  await rejects(api.getConsent(), 'rate_limited');
  assert.equal(calls.length, 1);
  advance(30_001);
  await api.getConsent();
  assert.equal(calls.length, 2);
});

test('Einwilligung: erteilen mit Fassung, widerrufen ohne, gelöschte Einträge', async () => {
  const { api, calls } = setup([
    json(200, CONSENT),
    json(200, { ...CONSENT, deleted: { markers: 12 } }),
  ]);
  await api.setConsent('markers', true, 'v1');
  const { deleted } = await api.setConsent('markers', false);
  assert.equal(nth(calls, 0).init.method, 'PUT');
  assert.equal(header(nth(calls, 0), 'content-type'), 'application/json');
  assert.deepEqual(nth(calls, 0).body, { markers: { granted: true, version: 'v1' } });
  assert.deepEqual(nth(calls, 1).body, { markers: { granted: false } });
  assert.equal(deleted, 12);
});

test('Weiterschauen: Adresse ohne Fragment, Titel gekürzt, Dauer nur wenn bekannt', async () => {
  const item = { url: 'https://www.zdf.de/a', title: 'A', position: 1834.2, duration: null, updatedAt: '' };
  const { api, calls } = setup([json(200, { item }), json(200, { item })]);
  await api.saveProgress({ url: 'https://www.zdf.de/a#x', title: `  ${'T'.repeat(400)}  `, position: 1834.23456, duration: null });
  await api.saveProgress({ url: 'https://www.zdf.de/a', title: 'A', position: 10, duration: 5400 });
  const first = nth(calls, 0).body as Record<string, unknown>;
  assert.equal(first.url, 'https://www.zdf.de/a');
  assert.equal((first.title as string).length, 300);
  assert.equal(first.position, 1834.235);
  assert.ok(!('duration' in first));
  assert.equal((nth(calls, 1).body as Record<string, unknown>).duration, 5400);
});

test('nur https-Adressen, sonst gar keine Anfrage', async () => {
  const { api, calls } = setup([]);
  await rejects(api.saveProgress({ url: 'http://www.zdf.de/a', title: 'A', position: 20 }), 'invalid');
  assert.equal(await api.getProgress('javascript:alert(1)'), null);
  assert.equal(calls.length, 0);
});

test('Marker: Text höchstens 200 Zeichen, leerer Text wird nicht gesendet, Adresse kodiert', async () => {
  const item = { id: 'm1', url: 'https://www.zdf.de/a', title: 'A', position: 1, text: null, createdAt: '' };
  const { api, calls } = setup([json(201, { item }), json(201, { item }), json(200, { items: [item, { bad: true }] })]);
  await api.addMarker({ url: 'https://www.zdf.de/a', title: 'A', position: 1, text: '😀'.repeat(250) });
  await api.addMarker({ url: 'https://www.zdf.de/a', title: 'A', position: 1, text: '   ' });
  const list = await api.listMarkers('https://www.zdf.de/a?x=1&y=2');
  assert.equal([...(nth(calls, 0).body as { text: string }).text].length, 200);
  assert.ok(!('text' in (nth(calls, 1).body as object)));
  assert.equal(nth(calls, 2).url, `${API_BASE_URL}/markers?url=${encodeURIComponent('https://www.zdf.de/a?x=1&y=2')}&context=room`);
  assert.equal(list.length, 1); // ungültige Einträge verworfen
});

test('Netzwerkfehler und 5xx: nicht erreichbar', async () => {
  const { api } = setup([
    () => {
      throw new TypeError('Failed to fetch');
    },
    json(500, { error: 'internal_error', message: 'x' }),
  ]);
  await rejects(api.getConsent(), 'unavailable');
  await rejects(api.getConsent(), 'unavailable');
});

test('Einwilligung Statistik wird erkannt, unvollständige Einträge fehlen', async () => {
  const statistics = { granted: false, version: null, grantedAt: null, currentVersion: 'v3', title: 'Statistik', text: 'Text C' };
  const { api } = setup([json(200, { ...CONSENT, statistics }), json(200, { ...CONSENT, statistics: { granted: true } })]);
  assert.equal((await api.getConsent()).statistics?.text, 'Text C');
  assert.equal((await api.getConsent()).statistics, undefined);
});

test('Statistik-Überblick', async () => {
  const { api, calls } = setup([
    json(200, { from: '2026-10-21', to: '2026-11-19', totalSeconds: 12600, togetherSeconds: 9000, aloneSeconds: 3600, top: [{ url: 'https://www.zdf.de/a', title: null, seconds: 5400 }, { x: 1 }] }),
  ]);
  const summary = await api.getStatsSummary(30);
  assert.equal(nth(calls, 0).url, `${API_BASE_URL}/stats/summary?days=30&context=all`);
  assert.equal(summary.togetherSeconds, 9000);
  assert.deepEqual(summary.top, [{ url: 'https://www.zdf.de/a', title: null, seconds: 5400 }]);
});

test('Raum-Einladungen: Liste ohne ungültige Einträge, Einladen, Löschen', async () => {
  const invite = { id: 'i1', from: { id: 'a1', username: 'Anna_A' }, roomCode: 'xy7k2m', title: null, createdAt: '', expiresAt: '2026-11-19T20:15:00.000Z' };
  const { api, calls } = setup([
    json(200, { items: [invite, { ...invite, id: 'i2', roomCode: 'XY7K0O' }, { ...invite, id: 'i3', from: null }] }),
    json(201, { item: {} }),
    json(200, { deleted: true }),
  ]);
  const items = await api.listRoomInvites();
  assert.deepEqual(items.map((i) => [i.id, i.roomCode]), [['i1', 'XY7K2M']]); // 0 und O gibt es in Codes nicht
  await api.createRoomInvite('f1', 'xy7k2m', '  Tatort:   Folge 1 ');
  assert.equal(nth(calls, 1).init.method, 'POST');
  assert.deepEqual(nth(calls, 1).body, { friend: 'f1', roomCode: 'XY7K2M', title: 'Tatort: Folge 1' });
  await api.deleteRoomInvite('i/1');
  assert.equal(nth(calls, 2).url, `${API_BASE_URL}/room-invites/i%2F1`);
  assert.equal(nth(calls, 2).init.method, 'DELETE');
});

test('Raum-Einladung: ungültiger Code ohne Anfrage, nicht befreundet als eigener Fehler', async () => {
  const { api, calls } = setup([json(404, { error: 'not_friends', message: 'Keine Freunde' })]);
  await rejects(api.createRoomInvite('f1', 'ABC'), 'invalid');
  assert.equal(calls.length, 0);
  await rejects(api.createRoomInvite('f1', 'XY7K2M'), 'not_friends');
});

test('Freunde: id, Benutzername, Profilbild nur von der API-Adresse', async () => {
  const avatar = `${API_BASE_URL}/avatars/f1?v=abc`;
  const { api } = setup([
    json(200, {
      items: [
        { id: 'f1', username: 'Bert_B', since: '2026-11-19T10:00:00.000Z', avatarUrl: avatar },
        { id: 'f3', username: 'dora', since: '', avatarUrl: 'https://evil.example/v1/avatars/f3?v=1' },
        { id: 'f4', username: 'eve', since: '', avatarUrl: 'https://api.synchrothek.de.evil.example/v1/avatars/x' },
        { id: 'f2' },
      ],
    }),
  ]);
  assert.deepEqual(await api.listFriends(), [
    { id: 'f1', username: 'Bert_B', since: '2026-11-19T10:00:00.000Z', avatarUrl: avatar },
    { id: 'f3', username: 'dora', since: '', avatarUrl: null },
    { id: 'f4', username: 'eve', since: '', avatarUrl: null },
  ]);
});

test('GET /v1/me', async () => {
  const { api, calls } = setup([
    json(200, { id: 'me1', username: 'anna', avatarUrl: `${API_BASE_URL}/avatars/me1?v=q3` }),
    json(200, { id: 'me1', username: 'anna', avatarUrl: null }),
  ]);
  assert.deepEqual(await api.getMe(), { id: 'me1', username: 'anna', avatarUrl: `${API_BASE_URL}/avatars/me1?v=q3` });
  assert.equal(nth(calls, 0).url, `${API_BASE_URL}/me`);
  assert.equal((await api.getMe()).avatarUrl, null);
});

test('Profilbild: mit Token geladen, 404 = kein Bild, fremde Adresse ohne Anfrage', async () => {
  const webp = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
  const { api, calls } = setup([
    new Response(webp, { status: 200, headers: { 'content-type': 'image/webp' } }),
    json(404, { error: 'not_found', message: 'x' }),
    json(401, { error: 'token_expired', message: 'x' }),
    new Response(webp, { status: 200, headers: { 'content-type': 'image/webp' } }),
  ]);
  const url = `${API_BASE_URL}/avatars/f1?v=abc`;
  const blob = await api.fetchAvatar(url);
  assert.equal(blob?.type, 'image/webp');
  assert.equal(blob?.size, webp.length);
  assert.equal(nth(calls, 0).url, url);
  assert.equal(header(nth(calls, 0), 'authorization'), 'Bearer tok-1');
  assert.equal(nth(calls, 0).init.redirect, 'error');
  assert.equal(await api.fetchAvatar(url), null);
  assert.ok(await api.fetchAvatar(url)); // 401 → erneuert → zweiter Versuch
  assert.equal(header(nth(calls, 3), 'authorization'), 'Bearer tok-2');
  assert.equal(await api.fetchAvatar('https://evil.example/v1/avatars/f1'), null);
  assert.equal(calls.length, 4); // an fremde Adresse ging nichts
});

test('403 account_banned: Sperre melden, kein Refresh, kein zweiter Versuch', async () => {
  let banned = 0;
  const calls: string[] = [];
  const api = createApi({
    getAccessToken: async () => 'tok',
    fetch: (async (url: string) => {
      calls.push(url);
      return json(403, { error: 'account_banned', message: 'Dieses Konto ist gesperrt.' });
    }) as typeof fetch,
    onAccountBanned: () => banned++,
  });
  const err = await rejects(api.getConsent(), 'banned');
  assert.equal(err.message, 'Dieses Konto ist gesperrt.');
  assert.equal(banned, 1);
  assert.equal(calls.length, 1);
});

// --- Gemeinsam und allein ----------------------------------------------------

test('Einwilligungen: Zusatz-Einwilligungen *_solo mit requires werden erkannt', async () => {
  const solo = { granted: false, version: null, grantedAt: null, currentVersion: 'v1', title: 'Auch allein', text: 'Text S', requires: 'watch_progress' };
  const { api } = setup([json(200, { ...CONSENT, watch_progress_solo: solo, markers_solo: { ...solo, requires: 'unbekannt' } })]);
  const consent = await api.getConsent();
  assert.equal(consent.watch_progress_solo?.requires, 'watch_progress');
  assert.equal(consent.watch_progress_solo?.granted, false);
  assert.equal(consent.markers_solo?.requires, null);
  assert.equal(consent.watch_progress?.requires, null);
});

test('Zusatz-Einwilligung erteilen; Widerruf des Hauptzwecks zählt beide Sammlungen', async () => {
  const { api, calls } = setup([
    json(200, CONSENT),
    json(200, { ...CONSENT, deleted: { watch_progress: 4, watch_progress_solo: 2, markers: 9 } }),
  ]);
  await api.setConsent('watch_progress_solo', true, 'v1');
  assert.deepEqual(nth(calls, 0).body, { watch_progress_solo: { granted: true, version: 'v1' } });
  const { deleted } = await api.setConsent('watch_progress', false);
  assert.equal(deleted, 6);
});

test('409 base_consent_required mit purpose und requires', async () => {
  const { api } = setup([
    json(409, { error: 'base_consent_required', message: 'Erst die Haupteinwilligung.', purpose: 'markers_solo', requires: 'markers' }),
  ]);
  const err = await rejects(api.setConsent('markers_solo', true, 'v1'), 'base_consent_required');
  assert.equal(err.extra.purpose, 'markers_solo');
  assert.equal(err.extra.requires, 'markers');
});

test('403 consent_required mit Zusatz-Zweck', async () => {
  const { api } = setup([json(403, { error: 'consent_required', message: 'x', purpose: 'watch_progress_solo' })]);
  const err = await rejects(api.saveProgress({ url: 'https://www.zdf.de/a', title: 'A', position: 20 }, 'solo'), 'consent_required');
  assert.equal(err.extra.purpose, 'watch_progress_solo');
});

test('Weiterschauen und Marker mit context; room ist Standard und wird nicht mitgeschickt', async () => {
  const item = { url: 'https://www.zdf.de/a', title: 'A', position: 20, duration: null, updatedAt: '', context: 'solo' };
  const { api, calls } = setup([
    json(200, { item }),
    json(200, { item: { ...item, context: undefined } }),
    json(200, { item }),
    json(200, { items: [item, { ...item, context: 'room' }] }),
    json(200, { deleted: 1 }),
    json(201, { item: { id: 'm1', url: 'https://www.zdf.de/a', title: 'A', position: 1, text: null, createdAt: '', context: 'solo' } }),
    json(200, { items: [] }),
  ]);
  const saved = await api.saveProgress({ url: 'https://www.zdf.de/a', title: 'A', series: '  Beispiel ', position: 20 }, 'solo');
  assert.equal(saved?.context, 'solo');
  assert.deepEqual(nth(calls, 0).body, { url: 'https://www.zdf.de/a', title: 'A', position: 20, series: 'Beispiel', context: 'solo' });
  const roomItem = await api.saveProgress({ url: 'https://www.zdf.de/a', title: 'A', position: 20 });
  assert.equal(roomItem?.context, 'room'); // fehlt context: gemeinsam
  assert.ok(!('context' in (nth(calls, 1).body as object)));
  assert.ok(!('series' in (nth(calls, 1).body as object)));
  await api.getProgress('https://www.zdf.de/a', 'solo');
  assert.equal(nth(calls, 2).url, `${API_BASE_URL}/progress?url=${encodeURIComponent('https://www.zdf.de/a')}&context=solo`);
  const list = await api.listProgress(20, 'all');
  assert.equal(nth(calls, 3).url, `${API_BASE_URL}/progress?limit=20&context=all`);
  assert.deepEqual(list.map((i) => i.context), ['solo', 'room']);
  await api.deleteProgress('https://www.zdf.de/a', 'solo');
  assert.equal(nth(calls, 4).url, `${API_BASE_URL}/progress?url=${encodeURIComponent('https://www.zdf.de/a')}&context=solo`);
  assert.equal(nth(calls, 4).init.method, 'DELETE');
  const marker = await api.addMarker({ url: 'https://www.zdf.de/a', title: 'A', position: 1 }, 'solo');
  assert.equal(marker?.context, 'solo');
  assert.equal((nth(calls, 5).body as Record<string, unknown>).context, 'solo');
  await api.listMarkers('https://www.zdf.de/a', 'solo');
  assert.ok(nth(calls, 6).url.endsWith('&context=solo'));
});

test('Statistik allein: Meldung mit gerundeten Sekunden, unter 30 s ohne Anfrage', async () => {
  const { api, calls } = setup([json(200, { item: { day: '2026-11-21', url: 'https://www.zdf.de/a', seconds: 95, context: 'solo' } })]);
  assert.equal(await api.reportSoloStats({ url: 'https://www.zdf.de/a#t=1', seconds: 29.4, startedAt: '2026-11-21T19:00:00.000Z' }), false);
  assert.equal(await api.reportSoloStats({ url: 'http://www.zdf.de/a', seconds: 95, startedAt: '2026-11-21T19:00:00.000Z' }), false);
  assert.equal(calls.length, 0);
  assert.equal(await api.reportSoloStats({ url: 'https://www.zdf.de/a#t=1', seconds: 94.6, startedAt: '2026-11-21T19:00:00Z' }), true);
  assert.equal(nth(calls, 0).url, `${API_BASE_URL}/stats/solo`);
  assert.equal(nth(calls, 0).init.method, 'POST');
  assert.deepEqual(nth(calls, 0).body, { url: 'https://www.zdf.de/a', seconds: 95, startedAt: '2026-11-21T19:00:00.000Z' });
});

test('Allein-Daten löschen ohne Widerruf', async () => {
  const { api, calls } = setup([json(200, { deleted: 12 })]);
  assert.equal(await api.deleteSoloData('markers'), 12);
  assert.equal(nth(calls, 0).url, `${API_BASE_URL}/solo-data?purpose=markers`);
  assert.equal(nth(calls, 0).init.method, 'DELETE');
});
