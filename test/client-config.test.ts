/**
 * Tests für GET /v1/client-config (src/lib/client-config.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, fetchClientConfig, needsUpdate, parseClientConfig } from '../src/lib/client-config.ts';
import { API_BASE_URL } from '../src/lib/config.ts';

test('Versionen numerisch je Stelle vergleichen', () => {
  assert.ok(compareVersions('0.10.0', '0.4.0') > 0);
  assert.ok(compareVersions('0.3.0', '0.4.0') < 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.4.0', '0.4.0'), 0);
  assert.ok(compareVersions('0.4.0-beta', '0.4.1') < 0);
});

test('Update nötig nur, wenn die eigene Version älter ist', () => {
  assert.equal(needsUpdate('0.3.0', { minExtensionVersion: '0.4.0', notice: null }), true);
  assert.equal(needsUpdate('0.4.0', { minExtensionVersion: '0.4.0', notice: null }), false);
  assert.equal(needsUpdate('0.10.0', { minExtensionVersion: '0.4.0', notice: null }), false);
  assert.equal(needsUpdate('0.3.0', { minExtensionVersion: null, notice: null }), false);
  assert.equal(needsUpdate('0.3.0', null), false);
});

test('Antwort prüfen: ungültige Version ignoriert, Hinweis einzeilig und gekürzt', () => {
  assert.deepEqual(parseClientConfig({ minExtensionVersion: '0.4.0', notice: 'Heute ab 22 Uhr kurze Wartung.' }), {
    minExtensionVersion: '0.4.0',
    notice: 'Heute ab 22 Uhr kurze Wartung.',
  });
  assert.deepEqual(parseClientConfig({ minExtensionVersion: null, notice: null }), { minExtensionVersion: null, notice: null });
  assert.equal(parseClientConfig({ minExtensionVersion: 'latest' })?.minExtensionVersion, null);
  assert.equal(parseClientConfig({ notice: '  zwei\nZeilen  ' })?.notice, 'zwei Zeilen');
  assert.equal(parseClientConfig({ notice: '   ' })?.notice, null);
  assert.equal([...(parseClientConfig({ notice: 'ä'.repeat(400) })?.notice ?? '')].length, 300);
  assert.equal(parseClientConfig('kaputt'), null);
  assert.equal(parseClientConfig([1]), null);
});

test('Abruf ohne Token und ohne Cookies; Fehler ergeben null', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ minExtensionVersion: '0.4.0', notice: null }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  assert.deepEqual(await fetchClientConfig(ok), { minExtensionVersion: '0.4.0', notice: null });
  assert.equal(calls[0]?.url, `${API_BASE_URL}/client-config`);
  assert.equal(new Headers(calls[0]?.init.headers).get('authorization'), null);
  assert.equal(calls[0]?.init.credentials, 'omit');

  const fails = [
    async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
    async () => {
      throw new TypeError('offline');
    },
  ];
  for (const f of fails) assert.equal(await fetchClientConfig(f as unknown as typeof fetch), null);
});
