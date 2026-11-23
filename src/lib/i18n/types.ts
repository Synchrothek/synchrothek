/** Typen der Wörterbücher: Das deutsche gibt die Schlüssel vor, das englische muss genau dieselben haben. */
import type { de } from './de.ts';

/** Text mit Einzahl und Mehrzahl (Auswahl über Intl.PluralRules und `count`). */
export interface Plural {
  readonly one: string;
  readonly other: string;
}

export type MessageKey = keyof typeof de;

/** Gleiche Schlüssel wie `de`; Plurale bleiben Plurale, Texte bleiben Texte. */
export type Dictionary = { readonly [K in MessageKey]: (typeof de)[K] extends string ? string : Plural };
