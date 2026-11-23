/**
 * Weiterschauen, Marker und Statistik über die Plattform-API. Nur im Background verwenden.
 *
 * Grundsätze (Vorgaben der API der offiziellen Plattform):
 * - Ohne Anmeldung, ohne Berechtigung oder ohne Einwilligung des jeweiligen Zwecks wird nichts gesendet.
 * - Gemeinsam (`room`) reicht die Haupteinwilligung, allein (`solo`) braucht es zusätzlich die
 *   Zusatz-Einwilligung `*_solo` (Entscheidung in watch-context.ts). Den Kontext bestimmt der Background.
 * - Der Einwilligungsstand wird nur kurz im Speicher gehalten, nie dauerhaft lokal: Er kann sich über
 *   die Konto-Seite ändern. `403 consent_required` schaltet die Funktion sofort ab.
 * - Schauverlauf und Marker liegen nur im Speicher (für die Anzeige im Popup), nicht in storage.*.
 * - Automatische Vorgänge (Speichern des Stands) melden Fehler nicht in der Oberfläche, um nicht zu nerven.
 */
import {
  ApiError,
  PURPOSES,
  type Api,
  type BasePurpose,
  type Consent,
  type DataContext,
  type Marker,
  type ProgressItem,
  type Purpose,
  type SoloStatsReport,
  type StatsSummary,
} from './api';
import { t } from './i18n/index.ts';
import type { ConsentView, FeaturesStatus, ProgressReason, ShowSnapshot } from './messages';
import { basePurposeOf, isOutdated, isSoloPurpose, mayRead, mayWrite, soloPurposeOf, worthReading } from './watch-context';

const CONSENT_MAX_AGE_MS = 5 * 60_000; // für automatisches Speichern
const CONSENT_POPUP_MAX_AGE_MS = 30_000; // beim Öffnen des Popups
const MARKERS_MAX_AGE_MS = 30_000;
const PROGRESS_MIN_INTERVAL_MS = 15_000; // während der Wiedergabe höchstens so oft speichern
const PROGRESS_MIN_POSITION = 10; // s – erst ab hier speichern (Seite nur kurz geöffnet)
const RESUME_MIN_POSITION = 30; // s – erst ab hier „Weiterschauen“ anbieten
const RESUME_END_MARGIN = 30; // s – so kurz vor Schluss gilt die Sendung als zu Ende geschaut
const SENT_CACHE_SIZE = 50;
const PROGRESS_LIST_LIMIT = 20;
const STATS_MAX_AGE_MS = 5 * 60_000;
const STATS_DAYS = 30;

export interface WatchFeaturesDeps {
  /** Gemeinsame API-Instanz (das Rate-Limit gilt für alle Endpunkte zusammen). */
  api: Api;
  isSignedIn(): boolean;
  /** Host-Berechtigung für die API (in Firefox entziehbar). */
  hasPermission(): Promise<boolean>;
  onChange(): void;
}

export function createWatchFeatures(deps: WatchFeaturesDeps) {
  const { api } = deps;

  let generation = 0; // wechselt bei An-/Abmeldung, ältere Antworten werden verworfen
  let consent: Consent | null = null;
  let consentAt = 0;
  let consentLoad: Promise<Consent | null> | null = null;
  let permission = true;
  let reauth = false;
  let error: string | null = null;
  let busy = false;
  const sent = new Map<string, { at: number; position: number }>(); // zuletzt gespeicherter Stand je Kontext und Adresse
  const markers = new Map<string, { items: Marker[]; at: number }>(); // je Kontext und Adresse
  let progressList: ProgressItem[] | null = null;
  let stats: { summary: StatsSummary; at: number } | null = null;

  /** Bei An- oder Abmeldung alles vergessen. */
  function reset() {
    generation++;
    consent = null;
    consentAt = 0;
    consentLoad = null;
    reauth = false;
    error = null;
    busy = false;
    sent.clear();
    markers.clear();
    progressList = null;
    stats = null;
  }

  const granted = (p: Purpose) => consent?.[p]?.granted === true;
  const key = (context: DataContext, url: string) => `${context}|${url}`;

  /** Zwischengespeicherte Daten eines Zwecks vergessen (nach Widerruf oder 403). */
  function forget(purpose: Purpose) {
    const base = basePurposeOf(purpose);
    if (base === 'markers') markers.clear();
    else if (base === 'statistics') stats = null;
    else {
      sent.clear();
      progressList = null;
    }
  }

  /** Einwilligung lokal als nicht erteilt markieren (Hauptzweck: die Zusatz-Einwilligung endet mit). */
  function markRevoked(p: Purpose) {
    if (!consent) return;
    const next: Consent = { ...consent };
    const purposes = isSoloPurpose(p) ? [p] : [p, soloPurposeOf(p)];
    for (const q of purposes) {
      const entry = next[q];
      if (entry) next[q] = { ...entry, granted: false, version: null, grantedAt: null };
    }
    consent = next;
    forget(p);
  }

  /** Fehler auswerten. `report`: Meldung im Popup zeigen (nur bei Aktionen der Person). */
  function handle(err: unknown, report: boolean) {
    if (!(err instanceof ApiError)) {
      console.warn('Synchrothek: API', err);
      if (report) error = t('error.unexpected');
      return;
    }
    switch (err.code) {
      case 'consent_required': {
        // Einwilligung fehlt (z. B. auf der Konto-Seite widerrufen): Funktion aus, im Popup wieder anbieten
        const p = err.extra.purpose;
        if (p && consent?.[p]) markRevoked(p);
        else consentAt = 0;
        break;
      }
      case 'base_consent_required':
        // Zusatz-Einwilligung ohne Haupteinwilligung (z. B. inzwischen auf der Webseite widerrufen)
        consentAt = 0;
        void loadConsent(0);
        if (report) error = t('consent.baseFirst');
        break;
      case 'consent_version_mismatch':
        consentAt = 0;
        void loadConsent(0);
        if (report) error = t('consent.textChanged');
        break;
      case 'reauth':
        reauth = true;
        break;
      case 'signed_out':
      case 'banned': // Hinweis und Abmeldung kommen einmal aus dem Background
        break;
      default:
        if (report) error = err.message;
        else console.info(`Synchrothek: API ${err.code}: ${err.message}`);
    }
  }

  /** Einwilligungsstand, höchstens `maxAgeMs` alt. null, wenn (noch) unbekannt oder nicht abrufbar. */
  function loadConsent(maxAgeMs: number): Promise<Consent | null> {
    if (!deps.isSignedIn() || reauth) return Promise.resolve(null);
    if (consent && Date.now() - consentAt < maxAgeMs) return Promise.resolve(consent);
    const gen = generation;
    consentLoad ??= (async () => {
      try {
        permission = await deps.hasPermission();
        if (!permission) return null;
        const next = await api.getConsent();
        if (gen !== generation) return null;
        consent = next;
        consentAt = Date.now();
        if (error && !busy) error = null;
        return consent;
      } catch (err) {
        if (gen === generation) handle(err, true); // nur im Bereich des Popups sichtbar
        return gen === generation ? consent : null;
      } finally {
        if (gen === generation) consentLoad = null;
        deps.onChange();
      }
    })();
    return consentLoad;
  }

  /** Darf im Kontext gesendet werden? Lädt den Einwilligungsstand, wenn er älter als `maxAgeMs` ist. */
  async function canWrite(base: BasePurpose, context: DataContext, maxAgeMs = CONSENT_MAX_AGE_MS): Promise<boolean> {
    if (!deps.isSignedIn() || reauth) return false;
    await loadConsent(maxAgeMs);
    return permission && mayWrite(consent, base, context);
  }

  async function canRead(base: BasePurpose, maxAgeMs = CONSENT_MAX_AGE_MS): Promise<boolean> {
    if (!deps.isSignedIn() || reauth) return false;
    await loadConsent(maxAgeMs);
    return permission && mayRead(consent, base);
  }

  /** Aktion aus dem Popup: zeigt „beschäftigt“ und meldet Fehler. */
  async function action<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const gen = generation;
    busy = true;
    error = null;
    deps.onChange();
    try {
      return await fn();
    } catch (err) {
      if (gen === generation) handle(err, true);
      return undefined;
    } finally {
      if (gen === generation) busy = false;
      deps.onChange();
    }
  }

  // ---------------------------------------------------------------------------
  // Weiterschauen
  // ---------------------------------------------------------------------------

  /**
   * Stand speichern, gedrosselt: während der Wiedergabe höchstens alle 15 s, sonst bei Pause/Ende/Verlassen.
   * Allein nur mit Zusatz-Einwilligung, sonst wird nichts gesendet.
   */
  async function reportProgress(snap: ShowSnapshot, reason: ProgressReason, context: DataContext) {
    if (!Number.isFinite(snap.position)) return;
    if (snap.position < PROGRESS_MIN_POSITION && reason !== 'ended') return;
    if (!(await canWrite('watch_progress', context))) return;

    const now = Date.now();
    const k = key(context, snap.url);
    const last = sent.get(k);
    if (last && Math.abs(last.position - snap.position) < 1) return; // nichts Neues
    if (reason === 'tick' && last && now - last.at < PROGRESS_MIN_INTERVAL_MS) return;

    sent.delete(k);
    sent.set(k, { at: now, position: snap.position });
    if (sent.size > SENT_CACHE_SIZE) sent.delete(sent.keys().next().value!);

    const gen = generation;
    try {
      await api.saveProgress(snap, context);
      if (gen === generation && progressList) progressList = null; // Liste beim nächsten Öffnen neu laden
    } catch (err) {
      if (gen !== generation) return;
      sent.delete(k);
      handle(err, false);
      deps.onChange();
    }
  }

  /** Gespeicherte Position für „Weiterschauen ab …?“ aus der Sammlung des Kontexts, oder null. */
  async function resumePosition(url: string, context: DataContext): Promise<number | null> {
    // „allein“ ist ohne Zusatz-Einwilligung leer: dann gar nicht fragen
    if (!(await canRead('watch_progress')) || !worthReading(consent, 'watch_progress', context)) return null;
    try {
      const item = await api.getProgress(url, context);
      if (!item || item.position < RESUME_MIN_POSITION) return null;
      if (item.duration && item.position > item.duration - RESUME_END_MARGIN) return null;
      return item.position;
    } catch (err) {
      handle(err, false);
      return null;
    }
  }

  /** Gemeinsam und allein in einer Liste (jeder Eintrag mit `context`). */
  function loadProgressList() {
    return action(async () => {
      if (!(await canRead('watch_progress'))) return;
      const gen = generation;
      const items = await api.listProgress(PROGRESS_LIST_LIMIT, 'all');
      if (gen === generation) progressList = items;
    });
  }

  function deleteProgress(url: string, context: DataContext) {
    return action(async () => {
      await api.deleteProgress(url, context);
      progressList = progressList?.filter((i) => !(i.url === url && i.context === context)) ?? null;
      sent.delete(key(context, url));
    });
  }

  // ---------------------------------------------------------------------------
  // Marker
  // ---------------------------------------------------------------------------

  /** Marker der Sendung aus der Sammlung des Kontexts (allein ohne Zusatz-Einwilligung: leer, nicht fragen). */
  async function loadMarkers(url: string, context: DataContext, force = false) {
    if (!(await canRead('markers', CONSENT_POPUP_MAX_AGE_MS))) return;
    const k = key(context, url);
    if (!worthReading(consent, 'markers', context)) {
      markers.set(k, { items: [], at: Date.now() });
      return;
    }
    const cached = markers.get(k);
    if (!force && cached && Date.now() - cached.at < MARKERS_MAX_AGE_MS) return;
    const gen = generation;
    try {
      const items = await api.listMarkers(url, context);
      if (gen === generation) markers.set(k, { items, at: Date.now() });
    } catch (err) {
      if (gen === generation) handle(err, true);
    }
    deps.onChange();
  }

  function addMarker(snap: ShowSnapshot, text: string, context: DataContext) {
    return action(async () => {
      if (!mayWrite(consent, 'markers', context)) {
        error =
          context === 'solo' && granted('markers')
            ? t('markers.soloHint')
            : t('markers.noConsent');
        return;
      }
      const item = await api.addMarker({ ...snap, text }, context);
      const list = markers.get(key(context, snap.url));
      if (item && list) {
        list.items = [...list.items, item].sort((a, b) => a.position - b.position);
      } else await loadMarkers(snap.url, context, true);
      return item;
    });
  }

  function deleteMarker(id: string) {
    return action(async () => {
      try {
        await api.deleteMarker(id);
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'not_found')) throw err; // schon weg: auch gut
      }
      for (const list of markers.values()) list.items = list.items.filter((m) => m.id !== id);
    });
  }

  // ---------------------------------------------------------------------------
  // Statistik: gemeinsam meldet der Sync-Server, allein die Extension (solo-stats.ts)
  // ---------------------------------------------------------------------------

  /**
   * Gesammelte Zuschauzeit beim alleine Schauen melden. Prüft vorher frisch, ob `statistics` und
   * `statistics_solo` erteilt sind; sonst wird nichts gesendet.
   */
  async function reportSoloStats(report: SoloStatsReport): Promise<void> {
    if (!(await canWrite('statistics', 'solo'))) return;
    const gen = generation;
    try {
      await api.reportSoloStats(report);
      if (gen === generation) stats = null; // Überblick beim nächsten Öffnen neu laden
    } catch (err) {
      if (gen === generation) handle(err, false);
    }
  }

  async function loadStats(force = false) {
    if (!mayRead(consent, 'statistics')) return;
    if (!force && stats && Date.now() - stats.at < STATS_MAX_AGE_MS) return;
    const gen = generation;
    try {
      const summary = await api.getStatsSummary(STATS_DAYS);
      if (gen === generation) stats = { summary, at: Date.now() };
    } catch (err) {
      if (gen === generation) handle(err, false); // optionaler Überblick: Fehler nicht anzeigen
    }
    deps.onChange();
  }

  // ---------------------------------------------------------------------------
  // Einwilligung
  // ---------------------------------------------------------------------------

  /**
   * Mit der angezeigten Fassung einwilligen. Passt sie nicht mehr, wird der Text neu geladen (409).
   * Zusatz-Einwilligungen nur, wenn die Haupteinwilligung besteht. Liefert true bei Erfolg.
   */
  async function grant(purpose: Purpose, version: string): Promise<boolean> {
    const ok = await action(async () => {
      if (isSoloPurpose(purpose) && !granted(basePurposeOf(purpose))) {
        error = t('consent.baseFirst');
        return false;
      }
      const gen = generation;
      const { consent: next } = await api.setConsent(purpose, true, version);
      if (gen !== generation) return false;
      consent = next;
      consentAt = Date.now();
      return true;
    });
    return ok === true;
  }

  /**
   * Widerruf. Die Plattform löscht dabei sofort alle Daten des Zwecks (Zusatz-Einwilligung: nur die
   * „allein“-Sammlung). Liefert die Zahl gelöschter Einträge.
   */
  function revoke(purpose: Purpose) {
    return action(async () => {
      const gen = generation;
      const { consent: next, deleted } = await api.setConsent(purpose, false);
      if (gen !== generation) return;
      consent = next;
      consentAt = Date.now();
      forget(purpose);
      return deleted;
    });
  }

  /** „Allein-Daten löschen“ ohne Widerruf. Liefert die Zahl gelöschter Einträge. */
  function deleteSoloData(base: BasePurpose) {
    return action(async () => {
      const gen = generation;
      const deleted = await api.deleteSoloData(base);
      if (gen !== generation) return;
      forget(base);
      return deleted;
    });
  }

  // ---------------------------------------------------------------------------

  /** Popup geöffnet bzw. aktualisiert: Stand auffrischen und Marker der Sendung im Tab laden. */
  async function refresh(showUrl: string | null, context: DataContext, { force = false } = {}) {
    if (force) {
      reauth = false;
      consentAt = 0;
    }
    await loadConsent(force ? 0 : CONSENT_POPUP_MAX_AGE_MS);
    await Promise.all([showUrl && granted('markers') ? loadMarkers(showUrl, context) : null, loadStats()]);
  }

  function status(showUrl: string | null, context: DataContext): FeaturesStatus {
    const base = { error, busy, show: showUrl ? { url: showUrl } : null, context };
    const empty = { consent: null, markers: null, progressList: null, stats: null };
    if (!deps.isSignedIn()) return { state: 'signedOut', ...base, ...empty, error: null };
    if (reauth) return { state: 'reauth', ...base, ...empty };
    if (!permission) return { state: 'noPermission', ...base, ...empty };
    if (!consent) return { state: consentLoad || !error ? 'loading' : 'error', ...base, ...empty };
    const views: Partial<Record<Purpose, ConsentView>> = {};
    for (const p of PURPOSES) {
      const c = consent[p];
      if (!c) continue;
      views[p] = {
        granted: c.granted,
        grantedAt: c.grantedAt,
        version: c.version,
        currentVersion: c.currentVersion,
        outdated: isOutdated(c),
        title: c.title,
        text: c.text,
        requires: c.requires,
      };
    }
    return {
      state: 'ready',
      ...base,
      consent: views,
      markers: showUrl && granted('markers') ? (markers.get(key(context, showUrl))?.items ?? null) : null,
      progressList: granted('watch_progress') ? progressList : null,
      stats: granted('statistics') ? (stats?.summary ?? null) : null,
    };
  }

  return {
    reset,
    refresh,
    status,
    reportProgress,
    resumePosition,
    loadProgressList,
    deleteProgress,
    addMarker,
    deleteMarker,
    grant,
    revoke,
    deleteSoloData,
    reportSoloStats,
    /**
     * Darf im Kontext jetzt gesendet werden (nach dem zuletzt bekannten Stand, ohne Anfrage)?
     * Unbekannter oder veralteter Stand wird im Hintergrund nachgeladen; bis dahin false.
     */
    mayWriteNow(base: BasePurpose, context: DataContext): boolean {
      if (!deps.isSignedIn() || reauth || !permission) return false;
      if (!consent || Date.now() - consentAt > CONSENT_MAX_AGE_MS) void loadConsent(CONSENT_MAX_AGE_MS);
      return mayWrite(consent, base, context);
    },
    dismissError: () => {
      error = null;
    },
    /**
     * Sprache gewechselt: Einwilligungstexte kommen in der Sprache aus Accept-Language, also neu laden.
     * Eine alte Fehlermeldung (in der vorigen Sprache) verschwindet.
     */
    languageChanged() {
      error = null;
      consentAt = 0;
      if (deps.isSignedIn() && !reauth) void loadConsent(0);
    },
    /** Die API lehnt auch ein frisches Token ab (z. B. aus einem anderen Modul gemeldet). */
    markReauth: () => {
      reauth = true;
      deps.onChange();
    },
  };
}

export type WatchFeatures = ReturnType<typeof createWatchFeatures>;
