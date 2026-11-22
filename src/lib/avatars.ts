/**
 * Eigenes Konto (GET /v1/me) und Profilbilder (GET /v1/avatars/:id, API der offiziellen Plattform).
 * Nur im Background verwenden: Die Bilder gibt es nur mit Token.
 *
 * - Geladen wird per fetch mit Token und nur von Adressen unter AVATAR_URL_PREFIX (siehe api.ts).
 * - Eine `avatarUrl` mit `?v=…` ist unveränderlich: Bilder liegen dauerhaft im Cache der Extension
 *   (Cache API) unter genau dieser URL. Ändert sich die URL (neues Bild), fliegt die alte raus;
 *   Bilder, die niemand mehr braucht, ebenso. Beim Abmelden wird der Cache geleert.
 * - Das Popup bekommt das Bild als data:-URL (im Service Worker gibt es kein URL.createObjectURL)
 *   und macht daraus selbst eine Blob-URL.
 * - Höchstens wenige Bilder gleichzeitig laden; das Rate-Limit gilt für alle Endpunkte zusammen.
 */
import { ApiError, avatarUrlFrom, type Api, type Me } from './api.ts';

export const AVATAR_CACHE = 'synchrothek-avatars';
const ME_MIN_INTERVAL_MS = 30_000;
const CONCURRENCY = 3;

/** Teil der Cache API, der gebraucht wird (im Test nachgebildet). */
export interface AvatarCacheStorage {
  open(name: string): Promise<{
    match(url: string): Promise<Response | undefined>;
    put(url: string, res: Response): Promise<void>;
    delete(url: string): Promise<boolean>;
    keys(): Promise<readonly { url: string }[]>;
  }>;
  delete(name: string): Promise<boolean>;
}

export interface AvatarDeps {
  api: Api;
  isSignedIn(): boolean;
  /** Cache API (null: ohne dauerhaften Cache, nur im Speicher). */
  cache: AvatarCacheStorage | null;
  /** Eigenes Konto hat sich geändert (Benutzername oder Bild). */
  onMe(): void;
  /** Ein Bild ist bereit: data:-URL, oder null für „kein Bild“ (Platzhalter zeigen). */
  onAvatar(url: string, dataUrl: string | null): void;
  /** Die API lehnt auch ein frisches Token ab. */
  onReauth(): void;
}

async function toDataUrl(blob: Blob): Promise<string | null> {
  const type = blob.type || 'image/webp';
  if (!/^image\/(webp|png|jpeg)$/.test(type)) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}

export function createAvatars(deps: AvatarDeps) {
  const { api } = deps;

  let generation = 0;
  let me: Me | null = null;
  let meAt = 0;
  let meLoad: Promise<void> | null = null;
  const images = new Map<string, string | null>(); // avatarUrl → data:-URL oder null (kein Bild)
  const queued = new Set<string>();
  let active = 0;

  async function withCache<T>(fn: (cache: Awaited<ReturnType<AvatarCacheStorage['open']>>) => Promise<T>): Promise<T | undefined> {
    if (!deps.cache) return undefined;
    try {
      return await fn(await deps.cache.open(AVATAR_CACHE));
    } catch (err) {
      console.info('Synchrothek: Bild-Cache nicht nutzbar', err);
      return undefined;
    }
  }

  function forget(url: string) {
    images.delete(url);
    void withCache((c) => c.delete(url));
  }

  /** Eigenes Konto abrufen: nach dem Login und beim Öffnen des Popups (höchstens alle 30 s). */
  function loadMe({ force = false } = {}): Promise<void> {
    if (!deps.isSignedIn()) return Promise.resolve();
    if (meLoad) return meLoad;
    if (!force && me && Date.now() - meAt < ME_MIN_INTERVAL_MS) return Promise.resolve();
    const gen = generation;
    meLoad = (async () => {
      try {
        const next = await api.getMe();
        if (gen !== generation) return;
        const previous = me;
        me = next;
        meAt = Date.now();
        // Neues Bild = neue URL: das alte wird nicht mehr gebraucht
        if (previous?.avatarUrl && previous.avatarUrl !== next.avatarUrl) forget(previous.avatarUrl);
        if (previous?.username !== next.username || previous?.avatarUrl !== next.avatarUrl) deps.onMe();
      } catch (err) {
        if (gen !== generation) return;
        if (err instanceof ApiError && err.code === 'reauth') deps.onReauth();
        else console.info('Synchrothek: /v1/me nicht abrufbar', err);
      } finally {
        if (gen === generation) meLoad = null;
      }
    })();
    return meLoad;
  }

  /** Bilder für diese Adressen bereitstellen (aus Speicher, Cache oder per Anfrage). */
  function want(urls: readonly string[]) {
    for (const raw of urls) {
      const url = avatarUrlFrom(raw);
      if (!url) continue;
      if (images.has(url)) deps.onAvatar(url, images.get(url) ?? null);
      else queued.add(url);
    }
    pump();
  }

  function pump() {
    while (active < CONCURRENCY && queued.size) {
      const url = queued.values().next().value!;
      queued.delete(url);
      active++;
      void loadOne(url).finally(() => {
        active--;
        pump();
      });
    }
  }

  async function loadOne(url: string) {
    if (!deps.isSignedIn()) return;
    const gen = generation;
    // 1. dauerhafter Cache (gleiche URL = gleiches Bild)
    const cached = await withCache(async (c) => {
      const res = await c.match(url);
      return res ? toDataUrl(await res.blob()) : undefined;
    });
    if (gen !== generation) return;
    if (cached) {
      images.set(url, cached);
      deps.onAvatar(url, cached);
      return;
    }
    // 2. von der API (mit Token); 404 = kein Bild
    try {
      const blob = await api.fetchAvatar(url);
      if (gen !== generation) return;
      const dataUrl = blob ? await toDataUrl(blob) : null;
      if (blob && dataUrl) {
        await withCache((c) => c.put(url, new Response(blob, { headers: { 'Content-Type': blob.type || 'image/webp' } })));
      }
      if (gen !== generation) return;
      images.set(url, dataUrl);
      deps.onAvatar(url, dataUrl);
    } catch (err) {
      if (gen !== generation) return;
      // Nicht merken: beim nächsten Öffnen des Popups neuer Versuch (z. B. nach 429)
      if (err instanceof ApiError && err.code === 'reauth') deps.onReauth();
      else console.info('Synchrothek: Profilbild nicht geladen', err);
    }
  }

  /** Bilder entfernen, die weder zum eigenen Konto noch zu einem Freund gehören (nach dem Laden der Freundesliste). */
  async function prune(friendUrls: readonly (string | null)[]) {
    if (!me) return; // ohne eigenes Konto nicht sicher, was gebraucht wird
    const keep = new Set([me.avatarUrl, ...friendUrls].filter((u): u is string => !!u));
    for (const url of [...images.keys()]) if (!keep.has(url)) images.delete(url);
    await withCache(async (c) => {
      for (const req of await c.keys()) if (!keep.has(req.url)) await c.delete(req.url);
    });
  }

  /** Abmelden oder anderes Konto: alles vergessen, auch den dauerhaften Cache. */
  function reset() {
    generation++;
    me = null;
    meAt = 0;
    meLoad = null;
    images.clear();
    queued.clear();
    if (deps.cache) void deps.cache.delete(AVATAR_CACHE).catch(() => {});
  }

  return {
    loadMe,
    want,
    prune,
    reset,
    me: () => (deps.isSignedIn() ? me : null),
  };
}

export type Avatars = ReturnType<typeof createAvatars>;
