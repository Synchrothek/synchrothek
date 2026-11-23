import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BrokerError, createBroker, isOfficialNodeUrl } from '../src/lib/broker.ts';
import { setLanguage, tr } from '../src/lib/i18n/index.ts';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('keine Antwort vorbereitet');
    return next();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const created = { code: 'ABC234', node: { id: 'n2', url: 'wss://n2.sync.synchrothek.de' }, ticket: 'eyJ.x.y', expiresAt: 1 };

async function rejects(p: Promise<unknown>, code: string): Promise<BrokerError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof BrokerError, String(err));
    assert.equal(err.code, code);
    return err;
  }
  assert.fail('kein Fehler');
}

test('Knoten-Adressen: nur wss://<etwas>.sync.synchrothek.de', () => {
  for (const ok of ['wss://n1.sync.synchrothek.de', 'wss://n12.sync.synchrothek.de/', 'wss://a.b.sync.synchrothek.de']) {
    assert.ok(isOfficialNodeUrl(ok), ok);
  }
  for (const bad of [
    'ws://n1.sync.synchrothek.de',
    'https://n1.sync.synchrothek.de',
    'wss://sync.synchrothek.de',
    'wss://n1.sync.synchrothek.de.evil.example',
    'wss://evilsync.synchrothek.de',
    'wss://n1.sync.synchrothek.de:8443',
    'wss://user:pw@n1.sync.synchrothek.de',
    'wss://n1.sync.synchrothek.de/pfad',
    'wss://n1.sync.synchrothek.de/?x=1',
    'wss://.sync.synchrothek.de',
    'wss://n1.sync.realtm.de',
    42,
    null,
  ]) {
    assert.ok(!isOfficialNodeUrl(bad), String(bad));
  }
});

test('Erstellen: POST mit JSON-Body und Token, Antwort geprüft', async () => {
  const { fetch, calls } = fakeFetch([() => json(201, created)]);
  const room = await createBroker({ fetch }).createRoom('tok');
  assert.deepEqual(room, { code: 'ABC234', node: { id: 'n2', url: 'wss://n2.sync.synchrothek.de' }, ticket: 'eyJ.x.y' });
  const call = calls[0]!;
  assert.equal(call.url, 'https://sync.synchrothek.de/v1/rooms');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.body, '{}');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.credentials, 'omit');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers.Authorization, 'Bearer tok');
});

test('Erstellen ohne Konto: kein Authorization-Header', async () => {
  const { fetch, calls } = fakeFetch([() => json(201, created)]);
  await createBroker({ fetch }).createRoom(null);
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, undefined);
});

test('Erstellen: Knoten außerhalb von *.sync.synchrothek.de wird abgelehnt', async () => {
  const { fetch } = fakeFetch([() => json(201, { ...created, node: { id: 'x', url: 'wss://evil.example' } })]);
  await rejects(createBroker({ fetch }).createRoom('tok'), 'unreachable');
});

test('Fehler des Vermittlers: Code zählt, Text kommt aus der Extension', async () => {
  setLanguage('de');
  const { fetch } = fakeFetch([
    () => json(503, { error: 'server_full', message: 'Gerade sind alle Plätze belegt.' }),
    () => json(503, { error: 'maintenance', message: 'Wartung bis 14 Uhr.' }),
    () => json(401, { error: 'auth_failed', message: 'Anmeldung ungültig.' }),
    () => json(503, { error: 'auth_unavailable', message: 'Anmeldung gerade nicht prüfbar.' }),
  ]);
  const broker = createBroker({ fetch });
  const full = await rejects(broker.createRoom(null), 'server_full');
  assert.equal(full.serverMessage, 'Gerade sind alle Plätze belegt.');
  assert.equal(tr(full.text()), 'Gerade sind alle Plätze belegt. Bitte versuch es später noch einmal.');
  const maintenance = await rejects(broker.createRoom(null), 'maintenance');
  setLanguage('en');
  // Meldung des Vermittlers wird nicht angezeigt, auch nicht als Zusatz (bekannter Code)
  assert.equal(tr(maintenance.text()), "New rooms can't be created right now due to maintenance. Please try again later.");
  assert.match(tr((await rejects(broker.createRoom('t'), 'auth_failed')).text()), /sign in again/);
  await rejects(broker.createRoom('t'), 'auth_unavailable');
  setLanguage('de');
});

test('Nicht erreichbar: Netzwerkfehler und fremde Fehlerseiten', async () => {
  const { fetch } = fakeFetch([
    () => Promise.reject(new TypeError('Failed to fetch')),
    () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
  ]);
  const broker = createBroker({ fetch });
  setLanguage('de');
  assert.equal(tr((await rejects(broker.createRoom(null), 'unreachable')).text()), 'Der Sync-Dienst ist gerade nicht erreichbar.');
  await rejects(broker.createRoom(null), 'unreachable');
});

test('429: Retry-After beachten, bis dahin keine Anfrage', async () => {
  let now = 1_000_000;
  const { fetch, calls } = fakeFetch([
    () => json(429, { error: 'rate_limited', message: 'Zu viele Räume.' }, { 'Retry-After': '30' }),
    () => json(200, { node: { id: 'n1', url: 'wss://n1.sync.synchrothek.de' } }),
  ]);
  const broker = createBroker({ fetch, now: () => now });
  const first = await rejects(broker.createRoom(null), 'rate_limited');
  assert.equal(first.retryAfterMs, 30_000);
  now += 10_000;
  const second = await rejects(broker.lookupRoom('ABC234'), 'rate_limited');
  assert.equal(second.code, 'rate_limited');
  assert.equal(second.retryAfterMs, 20_000);
  assert.equal(calls.length, 1);
  now += 21_000;
  assert.equal((await broker.lookupRoom('ABC234')).url, 'wss://n1.sync.synchrothek.de');
});

test('Beitreten: Knoten nachschlagen, 404 = Raum nicht gefunden', async () => {
  const { fetch, calls } = fakeFetch([
    () => json(200, { node: { id: 'sync-1', url: 'wss://n1.sync.synchrothek.de/' } }),
    () => json(404, { error: 'room_not_found', message: 'Raum nicht gefunden' }),
  ]);
  const broker = createBroker({ fetch });
  assert.deepEqual(await broker.lookupRoom('XYZ789'), { id: 'sync-1', url: 'wss://n1.sync.synchrothek.de' });
  assert.equal(calls[0]!.url, 'https://sync.synchrothek.de/v1/rooms/XYZ789');
  assert.equal(calls[0]!.init.method, 'GET');
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, undefined);
  await rejects(broker.lookupRoom('XYZ789'), 'room_not_found');
  // Ungültiger Code: gar nicht erst fragen
  await rejects(broker.lookupRoom('ABC10O'), 'room_not_found');
  assert.equal(calls.length, 2);
});

test('Unbekannter Code: allgemeiner Text in der Sprache, Meldung des Vermittlers gekürzt als Zusatz', async () => {
  const { fetch } = fakeFetch([() => json(418, { error: 'teapot', message: 'Ich bin eine Teekanne. '.repeat(20) })]);
  const err = await rejects(createBroker({ fetch }).createRoom(null), 'teapot');
  setLanguage('en');
  const text = tr(err.text());
  assert.ok(text.startsWith('The sync service reported an error (teapot). (server: “Ich bin eine Teekanne.'), text);
  assert.ok(text.length < 220, text);
  setLanguage('de');
  assert.ok(tr(err.text()).startsWith('Der Sync-Dienst hat einen Fehler gemeldet (teapot). (Server: „'));
});
