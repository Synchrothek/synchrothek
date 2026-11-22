/**
 * Gemeinsam oder allein: Kontext und Einwilligung für Weiterschauen, Marker und Statistik.
 *
 * - `room` („gemeinsam“): Der Tab ist der Raum-Tab eines Raums auf dem offiziellen Sync-Server.
 *   Senden mit der Haupteinwilligung (`watch_progress`, `markers`, `statistics`).
 * - `solo` („allein“): sonst (kein Raum, anderer Tab oder selbst gehosteter Server). Senden nur, wenn
 *   zusätzlich die Zusatz-Einwilligung `*_solo` erteilt ist; ohne sie wird nichts gesendet.
 * - Lesen braucht in beiden Kontexten nur die Haupteinwilligung, Löschen keine.
 *
 * Ohne Abhängigkeit von `browser`, damit sich das Modul unter Node testen lässt (test/watch-context.test.ts).
 */
import type { BasePurpose, Consent, Purpose, SoloPurpose } from './api.ts';

export type WatchContext = 'room' | 'solo';

export const BASE_PURPOSES: readonly BasePurpose[] = ['watch_progress', 'markers', 'statistics'];

export const soloPurposeOf = (base: BasePurpose): SoloPurpose => `${base}_solo`;

export function isSoloPurpose(p: Purpose): p is SoloPurpose {
  return p.endsWith('_solo');
}

/** Hauptzweck zu einem Zweck (für Zusatz-Einwilligungen der zugehörige, sonst er selbst). */
export function basePurposeOf(p: Purpose): BasePurpose {
  return (isSoloPurpose(p) ? p.slice(0, -'_solo'.length) : p) as BasePurpose;
}

export interface ContextInput {
  /** Vom Server bestätigt in einem Raum. */
  inRoom: boolean;
  /** Raum auf dem offiziellen Sync-Server (nur dafür gilt „gemeinsam“ laut Datenschutzerklärung). */
  official: boolean;
  /** Der Tab ist der Tab, der mit dem Raum synchronisiert wird. */
  roomTab: boolean;
}

export function contextFor({ inRoom, official, roomTab }: ContextInput): WatchContext {
  return inRoom && official && roomTab ? 'room' : 'solo';
}

const granted = (consent: Consent | null | undefined, p: Purpose) => consent?.[p]?.granted === true;

/** Darf für die Funktion im Kontext gesendet (gespeichert) werden? */
export function mayWrite(consent: Consent | null | undefined, base: BasePurpose, context: WatchContext): boolean {
  if (!granted(consent, base)) return false;
  return context === 'room' || granted(consent, soloPurposeOf(base));
}

/** Darf gelesen werden? Beide Sammlungen brauchen nur die Haupteinwilligung. */
export function mayRead(consent: Consent | null | undefined, base: BasePurpose): boolean {
  return granted(consent, base);
}

/**
 * Lohnt sich das Lesen der Sammlung? „allein“ ist ohne Zusatz-Einwilligung leer (Widerruf löscht sie),
 * deshalb dann gar nicht erst fragen.
 */
export function worthReading(consent: Consent | null | undefined, base: BasePurpose, context: WatchContext): boolean {
  return mayWrite(consent, base, context);
}

/** Die Zusatz-Einwilligung kann nur zusammen mit der Haupteinwilligung angeboten werden. */
export function canOfferSolo(consent: Consent | null | undefined, base: BasePurpose): boolean {
  return granted(consent, base) && !!consent?.[soloPurposeOf(base)];
}

/** Erteilte Einwilligung in älterer Fassung: neue Fassung anbieten. */
export function isOutdated(entry: { granted: boolean; version: string | null; currentVersion: string } | undefined): boolean {
  return !!entry?.granted && entry.version !== entry.currentVersion;
}
