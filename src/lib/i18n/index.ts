/**
 * Sprache der Oberfläche (Deutsch/Englisch) für Popup, Hintergrund und Content-Script.
 *
 * - Automatisch: Deutsch, wenn die bevorzugte Sprache des Browsers mit `de` beginnt, sonst Englisch
 *   (wie Website und Plattform, die nach `Accept-Language` gehen).
 * - Im Popup überschreibbar (Einstellung „Sprache“, gespeichert in storage.local unter `language`).
 *   `browser.i18n.getMessage` kann nicht zur Laufzeit umschalten; deshalb eigene Wörterbücher
 *   (de.ts, en.ts mit genau denselben Schlüsseln). Nur Name und Beschreibung im Manifest kommen aus
 *   `public/_locales`.
 * - Jeder Teil der Extension (Hintergrund, Popup, Content-Script) hat seinen eigenen Stand; der
 *   Hintergrund entscheidet und teilt ihn Popup und Content-Scripts mit.
 *
 * Ohne Abhängigkeit von `browser`, damit sich das Modul unter Node testen lässt.
 */
import { de } from './de.ts';
import { en } from './en.ts';
import type { Dictionary, MessageKey, Plural } from './types.ts';

export type Lang = 'de' | 'en';
export type LangSetting = 'auto' | Lang;
export const LANGS: readonly Lang[] = ['de', 'en'];
export const LANG_SETTINGS: readonly LangSetting[] = ['auto', 'de', 'en'];
/** Schlüssel in storage.local. Fehlt er, gilt `auto`. */
export const LANG_STORAGE_KEY = 'language';

export type { Dictionary, MessageKey, Plural };

export const DICTIONARIES: Readonly<Record<Lang, Dictionary>> = { de, en };

/** Platzhalter `{name}`. Ein Text (`Msg`) als Wert wird in derselben Sprache eingesetzt. */
export type Params = Readonly<Record<string, string | number | Msg>>;

/** Text, der erst beim Anzeigen übersetzt wird (z. B. ein Hinweis, der einen Sprachwechsel überdauert). */
export interface Msg {
  readonly key: MessageKey;
  readonly params?: Params;
}

export const msg = (key: MessageKey, params?: Params): Msg => (params ? { key, params } : { key });

/** Gespeicherte Einstellung prüfen; Unbekanntes gilt als `auto`. */
export function parseLangSetting(raw: unknown): LangSetting {
  return raw === 'de' || raw === 'en' ? raw : 'auto';
}

/**
 * Sprache nach Browser: erste bevorzugte Sprache (navigator.languages), ersatzweise die Sprache der
 * Browser-Oberfläche. Deutsch, wenn sie mit `de` beginnt, sonst Englisch.
 */
export function detectLanguage(preferred: readonly (string | null | undefined)[] | null | undefined, uiLanguage?: string | null): Lang {
  const first = (preferred ?? []).find((l): l is string => typeof l === 'string' && l.trim() !== '') ?? uiLanguage ?? '';
  return /^de(?:[-_]|$)/i.test(first.trim()) ? 'de' : 'en';
}

/** Einstellung plus Browser ergeben die Sprache. */
export function resolveLanguage(
  setting: unknown,
  preferred: readonly (string | null | undefined)[] | null | undefined,
  uiLanguage?: string | null,
): Lang {
  const s = parseLangSetting(setting);
  return s === 'auto' ? detectLanguage(preferred, uiLanguage) : s;
}

/** Bevorzugte Sprachen des Browsers in diesem Kontext (Service Worker, Seite oder Node). */
export function browserLanguages(): readonly string[] {
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
  if (nav?.languages?.length) return nav.languages;
  return nav?.language ? [nav.language] : [];
}

let current: Lang = detectLanguage(browserLanguages());
const listeners = new Set<(lang: Lang) => void>();

export const getLanguage = (): Lang => current;

/** Sprache dieses Kontexts setzen. Liefert true, wenn sie sich geändert hat. */
export function setLanguage(lang: Lang): boolean {
  if (lang === current) return false;
  current = lang;
  for (const fn of listeners) fn(lang);
  return true;
}

export function onLanguageChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Locale für Intl (Datum, Zahlen). Englisch neutral-britisch: 24-Stunden-Uhr, Tag vor Monat. */
export const localeOf = (lang: Lang = current): string => (lang === 'de' ? 'de-DE' : 'en-GB');

const pluralRules = new Map<Lang, Intl.PluralRules>();
function pluralForm(lang: Lang, count: number): keyof Plural {
  let rules = pluralRules.get(lang);
  if (!rules) pluralRules.set(lang, (rules = new Intl.PluralRules(localeOf(lang))));
  return rules.select(count) === 'one' ? 'one' : 'other';
}

function format(value: string | number | Msg, lang: Lang): string {
  if (typeof value === 'number') return new Intl.NumberFormat(localeOf(lang)).format(value);
  if (typeof value === 'string') return value;
  return translate(lang, value.key, value.params);
}

/** Text in einer bestimmten Sprache. Plurale wählen ihre Form nach `params.count`. */
export function translate(lang: Lang, key: MessageKey, params?: Params): string {
  const entry: string | Plural | undefined = DICTIONARIES[lang][key] ?? DICTIONARIES.de[key];
  if (entry === undefined) return key;
  const count = params?.count;
  const template = typeof entry === 'string' ? entry : entry[pluralForm(lang, typeof count === 'number' ? count : 0)];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? format(params[name]!, lang) : all));
}

/** Text in der aktuellen Sprache. */
export function t(key: MessageKey, params?: Params): string {
  return translate(current, key, params);
}

/** Aufgeschobenen Text jetzt übersetzen. */
export const tr = (m: Msg): string => translate(current, m.key, m.params);

/** Datum, z. B. „23.11.2026“ bzw. „23/11/2026“. Leer bei ungültiger Angabe. */
export function formatDate(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(localeOf()) : '';
}

/** Uhrzeit, z. B. „14:05“. */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(localeOf(), { hour: '2-digit', minute: '2-digit' });
}

/** Text auf eine Länge in Zeichen kürzen (mit „…“), Leerraum zusammenfassen. */
export function shorten(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
}
