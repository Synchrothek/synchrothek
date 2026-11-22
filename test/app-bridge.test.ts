/**
 * Tests für die Versionsabfrage auf app.synchrothek.de (src/lib/app-bridge.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerFor } from '../src/lib/app-bridge.ts';

const self = { name: 'window' };
const ORIGIN = 'https://app.synchrothek.de';
const INFO = { version: '0.2.0', browser: 'chrome' as const };
const NONCE = '0123456789abcdef0123456789abcdef';
const request = { source: 'synchrothek-app', type: 'extension-info-request', nonce: NONCE };
const ask = (over: Partial<{ source: unknown; origin: string; data: unknown }> = {}) =>
  answerFor({ source: self, origin: ORIGIN, data: request, ...over }, self, ORIGIN, INFO);

test('gültige Anfrage: Antwort mit derselben nonce, nur Version und Browser', () => {
  assert.deepEqual(ask(), { source: 'synchrothek-extension', type: 'extension-info', nonce: NONCE, version: '0.2.0', browser: 'chrome' });
});

test('keine Antwort aus anderen Fenstern oder iframes', () => {
  assert.equal(ask({ source: { name: 'iframe' } }), null);
  assert.equal(ask({ source: null }), null);
});

test('keine Antwort von fremder Origin', () => {
  assert.equal(ask({ origin: 'https://evil.example' }), null);
  assert.equal(ask({ origin: 'http://app.synchrothek.de' }), null);
});

test('keine Antwort auf andere Nachrichten', () => {
  assert.equal(ask({ data: { ...request, source: 'synchrothek-extension' } }), null);
  assert.equal(ask({ data: { ...request, type: 'extension-info' } }), null);
  assert.equal(ask({ data: { ...request, type: 'get-token' } }), null);
  assert.equal(ask({ data: 'extension-info-request' }), null);
  assert.equal(ask({ data: null }), null);
  assert.equal(ask({ data: [request] }), null);
});

test('nonce muss ^[A-Za-z0-9_-]{16,64}$ entsprechen', () => {
  for (const nonce of ['kurz', 'a'.repeat(15), 'a'.repeat(65), `${'a'.repeat(16)} `, `${'a'.repeat(16)}<script>`, 'ä'.repeat(16), 42, undefined]) {
    assert.equal(ask({ data: { ...request, nonce } }), null, String(nonce));
  }
  for (const nonce of ['a'.repeat(16), 'A-z_9'.repeat(12) + 'abcd']) {
    assert.equal(ask({ data: { ...request, nonce } })?.nonce, nonce);
  }
});
