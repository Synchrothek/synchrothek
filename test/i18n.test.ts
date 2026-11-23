/**
 * Tests für die Sprache der Oberfläche (src/lib/i18n): Sprachwahl, Wörterbücher, Fehlercodes, Links.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DICTIONARIES,
  detectLanguage,
  getLanguage,
  msg,
  parseLangSetting,
  resolveLanguage,
  setLanguage,
  t,
  translate,
  tr,
  type MessageKey,
} from '../src/lib/i18n/index.ts';
import { BROKER_ERROR_CODES, brokerErrorMsg, SYNC_ERROR_CODES, syncErrorMsg } from '../src/lib/i18n/errors.ts';
import { appLink, siteLink } from '../src/lib/i18n/links.ts';
import { formatDuration } from '../src/lib/time.ts';

const keys = (o: object) => Object.keys(o).sort();
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('Sprache nach Browser: Deutsch nur, wenn die bevorzugte Sprache mit de beginnt', () => {
  assert.equal(detectLanguage(['de-DE', 'en-US']), 'de');
  assert.equal(detectLanguage(['de']), 'de');
  assert.equal(detectLanguage(['DE-at']), 'de');
  assert.equal(detectLanguage(['de_CH']), 'de');
  assert.equal(detectLanguage(['en-GB', 'de-DE']), 'en');
  assert.equal(detectLanguage(['fr-FR']), 'en');
  assert.equal(detectLanguage(['dex']), 'en'); // kein Präfix-Zufall
  assert.equal(detectLanguage([]), 'en');
  assert.equal(detectLanguage(undefined), 'en');
  // ohne bevorzugte Sprachen: Sprache der Browser-Oberfläche
  assert.equal(detectLanguage([], 'de'), 'de');
  assert.equal(detectLanguage(['', null], 'de-DE'), 'de');
  assert.equal(detectLanguage(['en-US'], 'de'), 'en');
});

test('Einstellung im Popup überschreibt den Browser; Unbekanntes gilt als automatisch', () => {
  assert.equal(resolveLanguage('en', ['de-DE']), 'en');
  assert.equal(resolveLanguage('de', ['en-US']), 'de');
  assert.equal(resolveLanguage('auto', ['de-DE']), 'de');
  assert.equal(resolveLanguage(undefined, ['en-US']), 'en');
  assert.equal(resolveLanguage('fr', ['de-DE']), 'de');
  assert.equal(parseLangSetting('de'), 'de');
  assert.equal(parseLangSetting('en'), 'en');
  assert.equal(parseLangSetting('EN'), 'auto');
  assert.equal(parseLangSetting(null), 'auto');
});

test('Sprachwechsel wirkt sofort auf t()', () => {
  setLanguage('de');
  assert.equal(getLanguage(), 'de');
  assert.equal(t('lobby.create'), 'Raum erstellen');
  setLanguage('en');
  assert.equal(t('lobby.create'), 'Create room');
  // Aufgeschobener Text folgt der Sprache beim Anzeigen
  const later = msg('room.notFound', { code: 'ABC234' });
  assert.equal(tr(later), 'Room ABC234 not found.');
  setLanguage('de');
  assert.equal(tr(later), 'Raum ABC234 nicht gefunden.');
});

test('Wörterbücher: gleiche Schlüssel, gleiche Platzhalter, Plurale vollständig, nichts leer', () => {
  const { de, en } = DICTIONARIES;
  assert.deepEqual(keys(en), keys(de));
  for (const key of keys(de) as MessageKey[]) {
    const a = de[key];
    const b = en[key];
    assert.equal(typeof a, typeof b, key);
    if (typeof a === 'string' && typeof b === 'string') {
      assert.ok(a.trim() && b.trim(), `${key}: leer`);
      assert.deepEqual(placeholders(b), placeholders(a), `${key}: Platzhalter`);
    } else if (typeof a === 'object' && typeof b === 'object') {
      for (const form of ['one', 'other'] as const) {
        assert.ok(a[form].trim() && b[form].trim(), `${key}.${form}: leer`);
        assert.deepEqual(placeholders(b[form]), placeholders(a[form]), `${key}.${form}: Platzhalter`);
      }
      assert.ok(placeholders(a.other).includes('count'), `${key}: Plural ohne {count}`);
    }
  }
});

test('Popup: jeder Schlüssel in data-i18n* existiert, keine fest eingebauten Links mehr', () => {
  const html = readFileSync(new URL('../src/entrypoints/popup/index.html', import.meta.url), 'utf8');
  const used = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(used.length > 50);
  for (const key of used) assert.ok(Object.hasOwn(DICTIONARIES.de, key), `unbekannter Schlüssel ${key}`);
  assert.doesNotMatch(html, /href="https:\/\/(app\.)?synchrothek\.de/);
});

test('Plurale und Zahlen je Sprache', () => {
  assert.equal(translate('de', 'closing.idle', { count: 1 }), 'Der Raum schließt in 1 Minute wegen Inaktivität.');
  assert.equal(translate('de', 'closing.idle', { count: 5 }), 'Der Raum schließt in 5 Minuten wegen Inaktivität.');
  assert.equal(translate('en', 'closing.idle', { count: 1 }), 'The room closes in 1 minute due to inactivity.');
  assert.equal(translate('en', 'closing.idle', { count: 10 }), 'The room closes in 10 minutes due to inactivity.');
  assert.equal(translate('de', 'deleted.progress', { count: 1 }), '1 gespeicherter Stand');
  assert.equal(translate('en', 'deleted.markers', { count: 1200 }), '1,200 markers');
  assert.equal(translate('de', 'deleted.markers', { count: 1200 }), '1.200 Marker');
  // verschachtelte Texte in derselben Sprache
  const what = msg('deleted.solo', { what: msg('deleted.markers', { count: 2 }) });
  assert.equal(translate('en', 'deleted.done', { what }), '2 markers (alone) deleted.');
  assert.equal(translate('de', 'deleted.done', { what }), '2 Marker (allein) gelöscht.');
});

test('Dauer je Sprache', () => {
  setLanguage('de');
  assert.equal(formatDuration(45 * 60), '45 Min.');
  assert.equal(formatDuration(3 * 3600 + 30 * 60), '3 Std. 30 Min.');
  setLanguage('en');
  assert.equal(formatDuration(45 * 60), '45 min');
  assert.equal(formatDuration(2 * 3600), '2 h');
  setLanguage('de');
});

test('Sync-Server: jeder Code aus protocol.ts hat einen eigenen Text, die Meldung des Servers wird nicht gezeigt', () => {
  assert.equal(SYNC_ERROR_CODES.length, 18);
  for (const code of SYNC_ERROR_CODES) {
    const m = syncErrorMsg(code, 'Deutsche Servermeldung');
    for (const lang of ['de', 'en'] as const) {
      const text = translate(lang, m.key, m.params);
      assert.ok(text && !text.includes('Servermeldung'), `${code}/${lang}: ${text}`);
    }
  }
  assert.equal(translate('en', syncErrorMsg('room_full').key), 'The room is full.');
  assert.equal(translate('en', syncErrorMsg('ticket_invalid').key), "The room couldn't be created. Please try again.");
});

test('Sync-Server: unbekannter Code → allgemeiner Text, Meldung gekürzt als Zusatz', () => {
  const m = syncErrorMsg('future_code', 'x'.repeat(500));
  const text = translate('en', m.key, m.params);
  assert.ok(text.startsWith('The server reported an error (future_code). (server: “xxx'), text);
  assert.ok(text.includes('…'));
  assert.ok(text.length < 200);
  assert.equal(translate('de', syncErrorMsg('future_code').key, syncErrorMsg('future_code').params), 'Der Server hat einen Fehler gemeldet (future_code).');
});

test('Vermittler: alle Codes des Vermittlers bekannt', () => {
  // Fehlercodes aus synchrothek-admin (Vermittler, MELDUNGEN und fehler(...)), die die Extension sehen kann
  for (const code of [
    'server_full',
    'maintenance',
    'auth_failed',
    'auth_unavailable',
    'room_not_found',
    'rate_limited',
    'not_found',
    'method_not_allowed',
    'internal_error',
    'forbidden_origin',
    'unreachable',
  ]) {
    assert.ok(BROKER_ERROR_CODES.includes(code), code);
    const m = brokerErrorMsg(code, 'Deutsche Meldung');
    assert.ok(!translate('en', m.key, m.params).includes('Deutsche'), code);
  }
});

test('Links: Plattform mit ?lang=, Website mit den Seiten der Sprache', () => {
  assert.equal(appLink('/freunde', 'en'), 'https://app.synchrothek.de/freunde?lang=en');
  assert.equal(appLink('/einstellungen#konto', 'de'), 'https://app.synchrothek.de/einstellungen?lang=de#konto');
  assert.equal(siteLink('privacy', 'schauverlauf', 'de'), 'https://synchrothek.de/datenschutz#schauverlauf');
  assert.equal(siteLink('privacy', 'schauverlauf', 'en'), 'https://synchrothek.de/en/privacy#watch-history');
  assert.equal(siteLink('terms', '', 'en'), 'https://synchrothek.de/en/terms');
  assert.equal(siteLink('imprint', '', 'de'), 'https://synchrothek.de/impressum');
  assert.equal(siteLink('contact', '', 'en'), 'https://synchrothek.de/en/contact');
  assert.equal(siteLink('home', '', 'en'), 'https://synchrothek.de/en');
});

test('Manifest: Name und Beschreibung je Sprache, Beschreibung höchstens 132 Zeichen', () => {
  for (const lang of ['de', 'en']) {
    const messages = JSON.parse(readFileSync(new URL(`../public/_locales/${lang}/messages.json`, import.meta.url), 'utf8'));
    assert.equal(messages.extName.message, 'Synchrothek');
    const description: string = messages.extDescription.message;
    assert.ok([...description].length <= 132, `${lang}: ${[...description].length} Zeichen`);
    assert.doesNotMatch(description, /ARD|ZDF/);
  }
});
