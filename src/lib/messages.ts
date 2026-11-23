/** Nachrichten zwischen Background, Content-Script und Popup (intern, nicht über das Netz). */
import type { BasePurpose, DataContext, Friend, Marker, ProgressItem, Purpose, RoomInvite, StatsSummary } from './api';
import type { AccountStatus } from './auth';
import type { Lang, LangSetting } from './i18n/index.ts';
import type { ControlMode, MemberInfo, PlaybackAction, RoomSettings, ServerInfo } from './protocol';

/** Erwarteter Raumzustand für das Content-Script. `position` gilt zum Zeitpunkt `at` (lokale Uhr). */
export interface RoomPlayback {
  playing: boolean;
  position: number;
  at: number;
  urls: string[]; // URLs, die als „Sendung des Raums“ gelten
}

export type ControlCommand = { action: 'toggle' } | { action: 'seek'; delta: number };

// Background → Content
export type ToContent =
  | ({ type: 'state'; force?: boolean } & RoomPlayback)
  | { type: 'adopt' }
  | { type: 'room'; inRoom: false }
  | ({ type: 'control' } & ControlCommand)
  | { type: 'positionRequest' }
  | { type: 'lang'; lang: Lang } // Sprache der Hinweise im Player (beim Verbinden und bei jedem Wechsel)
  | { type: 'notice'; text: string } // schon übersetzt
  | { type: 'resume'; url: string; position: number | null } // Antwort auf resumeQuery (null = nichts anbieten)
  | { type: 'seekTo'; position: number }
  | { type: 'snapshotRequest'; id: number };

/** Was gerade läuft, für Weiterschauen und Marker. `title` leer: Background nimmt den Tab-Titel. */
export interface ShowSnapshot {
  url: string;
  title: string;
  position: number;
  duration: number | null;
  series?: string | null; // Formatname aus den strukturierten Daten der Seite, falls vorhanden
}

export type ProgressReason = 'tick' | 'pause' | 'ended' | 'leave';

// Content → Background
export type FromContent =
  | { type: 'hello'; url: string }
  | { type: 'video'; present: boolean }
  | { type: 'url'; url: string }
  | { type: 'local'; action: PlaybackAction; position: number; url?: string }
  | { type: 'position'; position: number; playing: boolean }
  | { type: 'heartbeat' }
  | ({ type: 'progress'; reason: ProgressReason } & ShowSnapshot)
  | { type: 'resumeQuery'; url: string }
  | ({ type: 'snapshot'; id: number } & ShowSnapshot);

// Popup → Background
export type PopupCommand =
  | { cmd: 'hello'; tabId: number | null }
  | { cmd: 'peek' } // aktuelle Position im Tab abfragen (Popup, etwa jede Sekunde)
  | { cmd: 'avatars'; urls: string[] } // Profilbilder anfordern (Antwort einzeln als ToPopup 'avatar')
  | { cmd: 'create' }
  | { cmd: 'join'; code: string }
  | { cmd: 'cancel' }
  | { cmd: 'leave' }
  | { cmd: 'bindTab' }
  | { cmd: 'openRoomUrl' }
  | { cmd: 'shareContent' }
  | { cmd: 'setAutoFollow'; value: boolean }
  | { cmd: 'setServer'; url: string }
  | { cmd: 'resetServer' }
  | { cmd: 'setName'; name: string }
  | { cmd: 'setLanguage'; value: LangSetting } // wirkt sofort in Popup, Hintergrund und Content-Scripts
  | { cmd: 'useAccountName' } // wieder den Namen aus dem Konto verwenden
  | ({ cmd: 'control' } & ControlCommand)
  | { cmd: 'sync' }
  | { cmd: 'kick'; memberId: string; ban: boolean }
  | { cmd: 'transferHost'; memberId: string }
  | { cmd: 'updateSettings'; maxMembers?: number; controlMode?: ControlMode }
  | { cmd: 'dismissNotice' }
  | { cmd: 'login' }
  | { cmd: 'logout' }
  | { cmd: 'relogin' }
  | { cmd: 'featuresRefresh' } // z. B. nachdem das Popup eine Berechtigung angefordert hat
  | { cmd: 'grantConsent'; purpose: Purpose; version: string }
  | { cmd: 'revokeConsent'; purpose: Purpose }
  | { cmd: 'deleteSoloData'; purpose: BasePurpose } // „Allein-Daten löschen“ ohne Widerruf
  | { cmd: 'addMarker'; text: string }
  | { cmd: 'deleteMarker'; id: string }
  | { cmd: 'seekTo'; position: number }
  | { cmd: 'loadProgressList' }
  | { cmd: 'deleteProgress'; url: string; context: DataContext }
  | { cmd: 'openShow'; url: string }
  | { cmd: 'acceptInvite'; id: string }
  | { cmd: 'declineInvite'; id: string }
  | { cmd: 'loadFriends' }
  | { cmd: 'inviteFriend'; friendId: string };

/** Knopf „Erneut versuchen“: Raum erstellen (neues Ticket) bzw. dem Raum mit diesem Code beitreten. */
export type NoticeRetry = { action: 'create' } | { action: 'join'; code: string };

export interface Notice {
  kind: 'error' | 'info';
  text: string; // in der aktuellen Sprache
  retry?: NoticeRetry;
}

/** Einwilligung für die Anzeige. Titel und Text kommen unverändert von der Plattform. */
export interface ConsentView {
  granted: boolean;
  grantedAt: string | null;
  version: string | null; // erteilte Fassung
  currentVersion: string;
  outdated: boolean; // erteilt, aber in älterer Fassung: neue Fassung anbieten
  title: string;
  text: string;
  requires: BasePurpose | null; // Zusatz-Einwilligung: setzt diesen Hauptzweck voraus
}

/** Weiterschauen und Marker (Plattform-API). Nur im Speicher des Background, nie dauerhaft lokal. */
export interface FeaturesStatus {
  state: 'signedOut' | 'noPermission' | 'reauth' | 'loading' | 'error' | 'ready';
  error: string | null; // Meldung zur letzten Aktion bzw. warum gerade nichts geht
  busy: boolean;
  consent: Partial<Record<Purpose, ConsentView>> | null; // fehlende Zwecke kennt die Plattform nicht
  show: { url: string } | null; // Sendung im Tab des Popups
  context: DataContext; // gemeinsam (Raum-Tab eines offiziellen Raums) oder allein, für den Tab des Popups
  markers: Marker[] | null; // Marker dieser Sendung im Kontext des Tabs (null = nicht geladen)
  progressList: ProgressItem[] | null; // gemeinsam und allein, null = nicht geladen
  stats: StatsSummary | null; // Überblick der letzten 30 Tage (nur mit Einwilligung)
}

/** Freunde und Raum-Einladungen (nur mit Konto). Freunde sehen voneinander nur den Benutzernamen. */
export interface SocialStatus {
  invites: RoomInvite[]; // offene, nicht abgelaufene Einladungen an mich
  canInvite: boolean; // Host eines Raums auf dem offiziellen Server, angemeldet
  friends: Friend[] | null; // null = nicht geladen
  invited: string[]; // Konto-IDs, die in den aktuellen Raum eingeladen wurden
  error: string | null;
  busy: boolean;
}

export interface PopupStatus {
  lang: Lang; // Sprache der Oberfläche (aufgelöst)
  langSetting: LangSetting; // Einstellung: automatisch (Browser) oder fest
  serverUrl: string;
  isDefaultServer: boolean;
  server: ServerInfo | null;
  autoFollow: boolean;
  name: string; // Name im Raum
  nameSuggestion: string | null; // Benutzername des Kontos (Vorschlag, solange kein eigener Name gewählt ist)
  nameChosen: boolean; // selbst gewählter Name statt des Vorschlags aus dem Konto
  conn: 'idle' | 'connecting' | 'open';
  notice: Notice | null;
  account: AccountStatus; // nur Status und Anzeigename, nie Tokens
  profile: { username: string; avatarUrl: string | null } | null; // eigenes Konto aus GET /v1/me (aktueller als der Token)
  /** Aus GET /v1/client-config: Wartungshinweis (nur Text) und Aufforderung zum Update. */
  platform: { notice: string | null; update: { current: string; minimum: string } | null };
  /** Store-Installation (automatische Updates) oder selbst geladen (Entwicklung). */
  installType: 'normal' | 'development' | 'other';
  features: FeaturesStatus;
  social: SocialStatus;
  code: string | null;
  inRoom: boolean;
  pending: boolean;
  me: string | null;
  isHost: boolean;
  canControl: boolean;
  room: {
    hostId: string | null;
    members: MemberInfo[];
    settings: RoomSettings;
    memberLimit: number;
    closesAt: number | null; // lokale Uhrzeit
    playing: boolean;
    url: string | null;
    title: string | null; // Titel des Raum-Tabs, wenn dort die Sendung des Raums läuft
    createdWithAccount: boolean; // selbst mit Konto erstellt (nur für Hinweise)
  } | null;
  tab: {
    hasVideo: boolean;
    onRoomContent: boolean;
    isBound: boolean;
    title: string | null; // Titel der Seite mit Video in diesem Tab
    position: number | null; // aktuelle Position des Videos (nur solange das Popup offen ist)
    duration: number | null;
  };
}

// Background → Popup
export type ToPopup =
  | { type: 'status'; status: PopupStatus }
  // Profilbild als data:-URL (das Popup macht daraus eine Blob-URL), null = kein Bild
  | { type: 'avatar'; url: string; dataUrl: string | null };
