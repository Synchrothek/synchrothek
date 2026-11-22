/**
 * Tests für eigenes Konto und Profilbilder (src/lib/avatars.ts) mit nachgebildeter API und Cache.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_BASE_URL } from '../src/lib/config.ts';
import { ApiError, type Api, type Me } from '../src/lib/api.ts';
import { AVATAR_CACHE, createAvatars, type AvatarCacheStorage } from '../src/lib/avatars.ts';

const A = (id: string, v: string) => `${API_BASE_URL}/avatars/${id}?v=${v}`;
const WEBP = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]);
const tick = () => new Promise((r) => setTimeout(r, 10));
/** Warten, bis die Bedingung gilt (höchstens 1 s). */
async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await tick();
  assert.ok(cond(), 'Bedingung nicht erfüllt');
}

/** Cache API im Speicher; überlebt wie die echte einen Neustart des Moduls. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Blob>>();
  const storage: AvatarCacheStorage = {
    async open(name) {
      const store = stores.get(name) ?? new Map<string, Blob>();
      stores.set(name, store);
      return {
        match: async (url) => (store.has(url) ? new Response(store.get(url)) : undefined),
        put: async (url, res) => void store.set(url, await res.blob()),
        delete: async (url) => store.delete(url),
        keys: async () => [...store.keys()].map((url) => ({ url })),
      };
    },
    delete: async (name) => stores.delete(name),
  };
  return { storage, urls: () => [...(stores.get(AVATAR_CACHE)?.keys() ?? [])] };
}

function setup(cache = fakeCaches(), options: { me?: Me; fail?: () => ApiError | null } = {}) {
  const fetched: string[] = [];
  const shown: [string, string | null][] = [];
  let me: Me = options.me ?? { id: 'me1', username: 'anna', avatarUrl: A('me1', '1') };
  let meChanges = 0;
  let reauth = 0;
  const api = {
    getMe: async () => me,
    fetchAvatar: async (url: string) => {
      fetched.push(url);
      const err = options.fail?.();
      if (err) throw err;
      return url.includes('nobody') ? null : new Blob([WEBP], { type: 'image/webp' });
    },
  } as unknown as Api;
  const avatars = createAvatars({
    api,
    isSignedIn: () => true,
    cache: cache.storage,
    onMe: () => meChanges++,
    onAvatar: (url, dataUrl) => shown.push([url, dataUrl]),
    onReauth: () => reauth++,
  });
  return { avatars, cache, fetched, shown, setMe: (m: Me) => (me = m), meChanges: () => meChanges, reauth: () => reauth };
}

test('eigenes Konto: /v1/me, Bild mit Token geladen und als data:-URL bereitgestellt', async () => {
  const { avatars, fetched, shown, meChanges } = setup();
  await avatars.loadMe();
  assert.equal(avatars.me()?.username, 'anna');
  assert.equal(meChanges(), 1);
  avatars.want([A('me1', '1')]);
  await until(() => shown.length > 0);
  assert.deepEqual(fetched, [A('me1', '1')]);
  assert.equal(shown[0]?.[0], A('me1', '1'));
  assert.ok(shown[0]?.[1]?.startsWith('data:image/webp;base64,'));
});

test('dauerhaft zwischengespeichert: zweites Mal und nach Neustart ohne Anfrage', async () => {
  const cache = fakeCaches();
  const first = setup(cache);
  first.avatars.want([A('f1', '7')]);
  await tick();
  first.avatars.want([A('f1', '7')]);
  await tick();
  assert.equal(first.fetched.length, 1);
  assert.equal(first.shown.length, 2);
  // neuer Service Worker, gleicher Cache
  const second = setup(cache);
  second.avatars.want([A('f1', '7')]);
  await tick();
  assert.equal(second.fetched.length, 0);
  assert.ok(second.shown[0]?.[1]?.startsWith('data:image/webp'));
});

test('404 = kein Bild: Platzhalter, nichts im Cache', async () => {
  const { avatars, cache, shown } = setup();
  avatars.want([A('nobody', '1')]);
  await tick();
  assert.deepEqual(shown, [[A('nobody', '1'), null]]);
  assert.deepEqual(cache.urls(), []);
});

test('neues eigenes Bild (neue URL): altes fliegt aus dem Cache', async () => {
  const s = setup();
  await s.avatars.loadMe();
  s.avatars.want([A('me1', '1')]);
  await tick();
  assert.deepEqual(s.cache.urls(), [A('me1', '1')]);
  s.setMe({ id: 'me1', username: 'anna', avatarUrl: A('me1', '2') });
  await s.avatars.loadMe({ force: true });
  await tick();
  assert.deepEqual(s.cache.urls(), []);
  assert.equal(s.meChanges(), 2);
});

test('Aufräumen: nur eigenes Bild und Bilder aktueller Freunde bleiben', async () => {
  const s = setup();
  await s.avatars.loadMe();
  s.avatars.want([A('me1', '1'), A('f1', '1'), A('f2', '1')]);
  await tick();
  await s.avatars.prune([A('f1', '1'), null]);
  assert.deepEqual(s.cache.urls().sort(), [A('f1', '1'), A('me1', '1')].sort());
});

test('Abmelden leert den Cache', async () => {
  const s = setup();
  s.avatars.want([A('f1', '1')]);
  await tick();
  s.avatars.reset();
  await tick();
  assert.deepEqual(s.cache.urls(), []);
  assert.equal(s.avatars.me(), null);
});

test('fremde Adressen werden nie angefragt', async () => {
  const s = setup();
  s.avatars.want(['https://evil.example/v1/avatars/x?v=1', 'javascript:alert(1)', `${API_BASE_URL}/me`]);
  await tick();
  assert.deepEqual(s.fetched, []);
});

test('Fehler (z. B. 429) wird nicht gemerkt: später neuer Versuch; 401 → neu anmelden', async () => {
  let error: ApiError | null = new ApiError('rate_limited', 'x');
  const s = setup(fakeCaches(), { fail: () => error });
  s.avatars.want([A('f1', '1')]);
  await tick();
  assert.deepEqual(s.shown, []);
  error = null;
  s.avatars.want([A('f1', '1')]);
  await tick();
  assert.equal(s.fetched.length, 2);
  assert.equal(s.shown.length, 1);
  error = new ApiError('reauth', 'x');
  s.avatars.want([A('f9', '1')]);
  await tick();
  assert.equal(s.reauth(), 1);
});
