/**
 * Tests für die Anmeldung im Tab (src/lib/login-flow.ts): offene Anmeldung, Absenderprüfung,
 * Zuordnung der Rückkehr, Fehlerarten, Autorisierungs-URL.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTH_CALLBACK_URL, AUTH_ISSUER } from '../src/lib/config.ts';
import {
  buildAuthorizeUrl,
  checkAnswer,
  classifyTokenError,
  createPendingStore,
  isLoginCallbackMessage,
  isRetryable,
  LOGIN_CALLBACK_MESSAGE,
  loginCallbackTabId,
  matchesPending,
  parseCallbackParams,
  parsePending,
  PENDING_LOGIN_KEY,
  PENDING_LOGIN_MAX_AGE_MS,
  withOneRetry,
  type PendingLogin,
  type SessionArea,
} from '../src/lib/login-flow.ts';

const STATE = 'Zs4H3zq0Wf0m0YkqQpRk5A';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const NOW = 1_800_000_000_000;
const pending = (over: Partial<PendingLogin> = {}): PendingLogin => ({
  mode: 'tab',
  state: STATE,
  verifier: VERIFIER,
  redirectUri: AUTH_CALLBACK_URL,
  tabId: 42,
  returnTabId: 7,
  createdAt: NOW,
  ...over,
});

function memoryArea(): SessionArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (items) => void Object.assign(data, structuredClone(items)),
    remove: async (key) => void delete data[key],
  };
}

// --- offene Anmeldung -----------------------------------------------------------

test('parsePending: gültig, abgelaufen, unbrauchbar', () => {
  assert.deepEqual(parsePending(pending(), NOW + 1000), pending());
  assert.equal(parsePending(pending(), NOW + PENDING_LOGIN_MAX_AGE_MS + 1), 'expired');
  assert.equal(parsePending(pending({ createdAt: NOW + 5 * 60_000 }), NOW), 'expired'); // Uhr zurückgestellt
  assert.equal(parsePending(null, NOW), null);
  assert.equal(parsePending({ ...pending(), mode: 'popup' }, NOW), null);
  assert.equal(parsePending({ ...pending(), state: 'kurz' }, NOW), null);
  assert.equal(parsePending({ ...pending(), verifier: 42 }, NOW), null);
  assert.equal(parsePending({ ...pending(), tabId: -1 }, NOW), null);
  assert.equal(parsePending({ ...pending(), tabId: '42' }, NOW), null);
  const win = pending({ mode: 'window', tabId: null, returnTabId: null });
  assert.deepEqual(parsePending(win, NOW), win);
});

test('PendingStore: take liefert genau einmal', async () => {
  const area = memoryArea();
  const store = createPendingStore(area, () => NOW);
  await store.save(pending());
  const [a, b] = await Promise.all([store.take(), store.take()]);
  assert.deepEqual(a, pending());
  assert.equal(b, null);
  assert.equal(PENDING_LOGIN_KEY in area.data, false);
});

test('PendingStore: abgelaufene Anmeldung wird beim Lesen gelöscht', async () => {
  const area = memoryArea();
  let now = NOW;
  const store = createPendingStore(area, () => now);
  await store.save(pending());
  now += PENDING_LOGIN_MAX_AGE_MS + 1;
  assert.equal(await store.load(), 'expired');
  assert.equal(PENDING_LOGIN_KEY in area.data, false);
  assert.equal(await store.load(), null);
});

test('PendingStore: takeIf verbraucht nur, wenn die Bedingung passt', async () => {
  const store = createPendingStore(memoryArea(), () => NOW);
  await store.save(pending());
  assert.equal(await store.takeIf((p) => p.tabId === 99), null);
  assert.deepEqual(await store.load(), pending());
  assert.deepEqual(await store.takeIf((p) => p.tabId === 42), pending());
  assert.equal(await store.load(), null);
});

test('PendingStore: neue Anmeldung ersetzt die alte', async () => {
  const store = createPendingStore(memoryArea(), () => NOW);
  await store.save(pending());
  await store.save(pending({ state: 'b'.repeat(22), tabId: 43 }));
  const current = await store.load();
  assert.equal(current !== null && current !== 'expired' && current.tabId, 43);
});

// --- Autorisierungs-URL ---------------------------------------------------------

test('buildAuthorizeUrl: alle Parameter, Ressourcen wiederholt, Sprache', () => {
  const url = new URL(
    buildAuthorizeUrl({
      authBaseUrl: 'https://app.synchrothek.de/api/auth',
      clientId: 'synchrothek-chrome',
      redirectUri: AUTH_CALLBACK_URL,
      scope: 'openid profile offline_access',
      state: STATE,
      codeChallenge: 'abc',
      resources: ['https://sync.synchrothek.de', 'https://api.synchrothek.de'],
      lang: 'en',
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://app.synchrothek.de/api/auth/oauth2/authorize');
  const p = url.searchParams;
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('client_id'), 'synchrothek-chrome');
  assert.equal(p.get('redirect_uri'), 'https://app.synchrothek.de/extension/verbunden');
  assert.equal(p.get('state'), STATE);
  assert.equal(p.get('code_challenge'), 'abc');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.deepEqual(p.getAll('resource'), ['https://sync.synchrothek.de', 'https://api.synchrothek.de']);
  assert.equal(p.get('lang'), 'en');
  assert.equal(p.get('ui_locales'), 'en');
});

// --- Rückkehr -------------------------------------------------------------------

test('parseCallbackParams: Query, Fragment, überlange Werte', () => {
  assert.deepEqual(parseCallbackParams(`${AUTH_CALLBACK_URL}?code=c1&state=${STATE}&iss=${encodeURIComponent(AUTH_ISSUER)}`), {
    code: 'c1',
    state: STATE,
    iss: AUTH_ISSUER,
    error: null,
  });
  assert.deepEqual(parseCallbackParams(`${AUTH_CALLBACK_URL}#error=access_denied&state=${STATE}`), {
    code: null,
    state: STATE,
    iss: null,
    error: 'access_denied',
  });
  assert.equal(parseCallbackParams(`${AUTH_CALLBACK_URL}?code=${'x'.repeat(3000)}`).code, null);
});

test('isLoginCallbackMessage: nur genau diese Form', () => {
  const ok = { type: LOGIN_CALLBACK_MESSAGE, code: 'c', state: STATE, iss: null, error: null };
  assert.equal(isLoginCallbackMessage(ok), true);
  assert.equal(isLoginCallbackMessage({ ...ok, type: 'other' }), false);
  assert.equal(isLoginCallbackMessage({ ...ok, extra: 1 }), false);
  assert.equal(isLoginCallbackMessage({ type: LOGIN_CALLBACK_MESSAGE, code: 'c', state: STATE }), false);
  assert.equal(isLoginCallbackMessage({ ...ok, code: 42 }), false);
  assert.equal(isLoginCallbackMessage({ ...ok, code: 'x'.repeat(3000) }), false);
  assert.equal(isLoginCallbackMessage([ok]), false);
  assert.equal(isLoginCallbackMessage(null), false);
  assert.equal(isLoginCallbackMessage('synchrothek-login-callback'), false);
});

test('loginCallbackTabId: eigenes Content-Script, oberster Frame, genau die Rückkehrseite', () => {
  const ID = 'ogecioeoilcegakfimcfnlojjnnponmn';
  const sender = { id: ID, url: `${AUTH_CALLBACK_URL}?code=c&state=s`, origin: 'https://app.synchrothek.de', frameId: 0, tab: { id: 42 } };
  assert.equal(loginCallbackTabId(sender, ID), 42);
  assert.equal(loginCallbackTabId({ ...sender, origin: undefined }, ID), 42); // Firefox ohne origin
  assert.equal(loginCallbackTabId({ ...sender, url: AUTH_CALLBACK_URL }, ID), 42);
  // fremde Extension, Frames, ohne Tab
  assert.equal(loginCallbackTabId({ ...sender, id: 'andere' }, ID), null);
  assert.equal(loginCallbackTabId(sender, ''), null);
  assert.equal(loginCallbackTabId({ ...sender, frameId: 3 }, ID), null);
  assert.equal(loginCallbackTabId({ ...sender, frameId: undefined }, ID), null);
  assert.equal(loginCallbackTabId({ ...sender, tab: undefined }, ID), null);
  assert.equal(loginCallbackTabId({ ...sender, tab: {} }, ID), null);
  // andere Seiten und Adressen
  for (const url of [
    'https://app.synchrothek.de/extension/verbundenX?code=c',
    'https://app.synchrothek.de/extension/verbunden/x',
    'https://app.synchrothek.de/anmelden?x=/extension/verbunden',
    'http://app.synchrothek.de/extension/verbunden',
    'https://app.synchrothek.de:8443/extension/verbunden',
    'https://evil.example/extension/verbunden',
    'https://app.synchrothek.de.evil.example/extension/verbunden',
    'https://user:pw@app.synchrothek.de/extension/verbunden',
    'kaputt',
  ]) {
    assert.equal(loginCallbackTabId({ ...sender, url }, ID), null, url);
  }
  assert.equal(loginCallbackTabId({ ...sender, url: undefined }, ID), null);
  assert.equal(loginCallbackTabId({ ...sender, origin: 'https://evil.example' }, ID), null);
  assert.equal(loginCallbackTabId(undefined, ID), null);
});

test('matchesPending: Tab und State müssen passen', () => {
  const params = { code: 'c', state: STATE, iss: AUTH_ISSUER, error: null };
  assert.equal(matchesPending(pending(), params, 42), true);
  assert.equal(matchesPending(pending(), params, 43), false); // anderer Tab
  assert.equal(matchesPending(pending({ tabId: null }), params, 42), false); // Tab noch nicht bekannt
  assert.equal(matchesPending(pending(), { ...params, state: 'x'.repeat(22) }, 42), false);
  assert.equal(matchesPending(pending(), { ...params, state: null }, 42), false);
  // Fenster (launchWebAuthFlow): ohne Tab
  const win = pending({ mode: 'window', tabId: null, returnTabId: null });
  assert.equal(matchesPending(win, params, null), true);
  assert.equal(matchesPending(win, params, 42), false);
});

test('checkAnswer: Aussteller, Fehler, Code', () => {
  const ok = { code: 'c', state: STATE, iss: AUTH_ISSUER, error: null };
  assert.deepEqual(checkAnswer(ok, AUTH_ISSUER, true), { ok: true, code: 'c' });
  assert.deepEqual(checkAnswer({ ...ok, iss: 'https://evil.example' }, AUTH_ISSUER, false), { ok: false, error: 'issuer' });
  assert.deepEqual(checkAnswer({ ...ok, iss: null }, AUTH_ISSUER, true), { ok: false, error: 'issuer' });
  assert.deepEqual(checkAnswer({ ...ok, iss: null }, AUTH_ISSUER, false), { ok: true, code: 'c' });
  assert.deepEqual(checkAnswer({ ...ok, code: null, error: 'access_denied' }, AUTH_ISSUER, true), { ok: false, error: 'cancelled' });
  assert.deepEqual(checkAnswer({ ...ok, code: null, error: 'server_error' }, AUTH_ISSUER, true), { ok: false, error: 'failed', detail: 'server_error' });
  assert.deepEqual(checkAnswer({ ...ok, code: null }, AUTH_ISSUER, true), { ok: false, error: 'failed', detail: 'no_code' });
});

// --- Fehler beim Token-Tausch ---------------------------------------------------

test('classifyTokenError: Netzwerk, Server, abgelaufen, gesperrt', () => {
  assert.equal(classifyTokenError(new TypeError('Failed to fetch')), 'network');
  assert.equal(classifyTokenError(Object.assign(new Error('t'), { name: 'TimeoutError' })), 'network');
  assert.equal(classifyTokenError(Object.assign(new Error('a'), { name: 'AbortError' })), 'network');
  assert.equal(classifyTokenError({ status: 502, code: undefined }), 'server');
  assert.equal(classifyTokenError({ status: 429, code: 'rate_limited' }), 'server');
  assert.equal(classifyTokenError({ status: 200, code: 'invalid_response' }), 'server');
  assert.equal(classifyTokenError({ status: 400, code: 'invalid_grant' }), 'expired');
  assert.equal(classifyTokenError({ status: 400, code: 'invalid_grant', errorCode: 'account_banned' }), 'banned');
  assert.equal(classifyTokenError({ status: 400, code: 'invalid_grant', description: 'Dieses Konto ist gesperrt.' }), 'banned');
  assert.equal(classifyTokenError({ status: 400, code: 'invalid_client' }), 'failed');
  assert.equal(classifyTokenError(new Error('?')), 'failed');
});

test('isRetryable / withOneRetry: genau ein Wiederholversuch bei Netzwerk- und Serverfehlern', async () => {
  assert.equal(isRetryable(new TypeError('offline')), true);
  assert.equal(isRetryable({ status: 503 }), true);
  assert.equal(isRetryable({ status: 400, code: 'invalid_grant' }), false);
  assert.equal(isRetryable({ status: 429 }), false);

  const sleep = async () => {};
  let calls = 0;
  assert.equal(
    await withOneRetry(async () => {
      if (++calls === 1) throw new TypeError('offline');
      return 'ok';
    }, 0, sleep),
    'ok',
  );
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    withOneRetry(async () => {
      calls++;
      throw { status: 500 };
    }, 0, sleep),
  );
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    withOneRetry(async () => {
      calls++;
      throw { status: 400, code: 'invalid_grant' };
    }, 0, sleep),
  );
  assert.equal(calls, 1);
});
