/**
 * Links auf Plattform und Website in der Sprache der Oberfläche.
 *
 * - Plattform (app.synchrothek.de): Pfade sind in beiden Sprachen gleich (deutsch); `?lang=de|en` setzt dort
 *   die Sprache.
 * - Website (synchrothek.de): deutsche Seiten unter `/`, englische unter `/en/` mit englischen Namen.
 */
import { getLanguage, type Lang } from './index.ts';

export const APP_ORIGIN = 'https://app.synchrothek.de';
export const SITE_ORIGIN = 'https://synchrothek.de';

export type SitePage = 'home' | 'privacy' | 'terms' | 'imprint' | 'contact';

const SITE_PATHS: Readonly<Record<Lang, Readonly<Record<SitePage, string>>>> = {
  de: { home: '/', privacy: '/datenschutz', terms: '/nutzungsbedingungen', imprint: '/impressum', contact: '/kontakt' },
  en: { home: '/en', privacy: '/en/privacy', terms: '/en/terms', imprint: '/en/imprint', contact: '/en/contact' },
};

export const isSitePage = (v: unknown): v is SitePage => typeof v === 'string' && Object.hasOwn(SITE_PATHS.de, v);

/** Seite der Plattform, z. B. appLink('/freunde') → https://app.synchrothek.de/freunde?lang=en. Fragment bleibt am Ende. */
export function appLink(path: string, lang: Lang = getLanguage()): string {
  const url = new URL(path, APP_ORIGIN);
  url.searchParams.set('lang', lang);
  return url.toString();
}

/** Anker, die auf den englischen Seiten anders heißen (deutscher Anker → englischer). */
const EN_HASHES: Readonly<Record<string, string>> = { schauverlauf: 'watch-history' };

/** Seite der Website in der Sprache, optional mit Anker (`hash` ohne „#“, deutscher Name). */
export function siteLink(page: SitePage, hash = '', lang: Lang = getLanguage()): string {
  const anchor = lang === 'en' ? (EN_HASHES[hash] ?? hash) : hash;
  return `${SITE_ORIGIN}${SITE_PATHS[lang][page]}${anchor ? `#${anchor}` : ''}`;
}
