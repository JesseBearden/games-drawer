import type { ChatFilterMode, GameId, GameInput, GameServerMessage, MemberInfo, TableSetup } from '@tank/shared';
import type { PlayOptions, Sfx, SoundName } from './audio';
import type { Gamepads, PadPress } from './gamepad';

export interface Device {
  touch: boolean;
  small: boolean;
}

/** What the room shell offers the view on screen (lobby or a game). */
export interface ShellApi {
  readonly device: Device;
  readonly sfx: Sfx;
  /** Your alias in this room. */
  readonly alias: string;
  readonly roomCode: string;
  readonly isPrivate: boolean;
  members(): MemberInfo[];
  sendGame(input: GameInput): void;
  /** At the table between games: the game picked to play next, the seats, and who's ready. */
  table(): TableSetup;
  pickGame(game: GameId): void;
  sit(seat: number): void;
  /** How many play the picked game (2 to 4), for games that let the table choose. */
  setPlayers(n: number): void;
  setReady(ready: boolean): void;
  toLobby(): void;
  toast(text: string): void;
  /** They're still here, though they've sent nothing (the table stays open). Cheap to call often. */
  stillHere(): void;
  share(): void;
  /** Play a sound, ignoring names this build doesn't have. */
  play(name: SoundName | string, opts?: PlayOptions): void;
  voice: {
    available: boolean;
    inVoice: boolean;
    /** Why the mic didn't come on last time, if it didn't. */
    micProblem: 'blocked' | 'missing' | null;
    join(): void;
  };
  /** Game controllers (analog sticks for games that read them every frame). */
  readonly pads: Gamepads | null;
  /** How swearing in chat is handled in this room. */
  readonly chatFilter: ChatFilterMode;
}

/** The lobby or a game, mounted inside the room shell. Chat and voice live in the shell. */
/**
 * Safari's own pinch (an iPad's trackpad or mouse, a Mac's trackpad; also two fingers on an
 * iPhone or iPad): "gesturestart/change/end", with how far it has scaled. Left alone, Safari
 * zooms the whole page with it.
 */
export type SafariGesture = Event & { scale: number; clientX?: number; clientY?: number };

export interface View {
  /** Phone players should hold the phone sideways for this view. */
  readonly landscape: boolean;
  /** Shown in the menu. */
  readonly helpHtml: string;
  onGameMessage?(m: GameServerMessage): void;
  onMembers?(members: MemberInfo[]): void;
  /** Your own mic went on or off, or couldn't. */
  onVoiceChanged?(): void;
  /** The table's pick, seats or readiness changed (between games). */
  onTable?(table: TableSetup): void;
  /** Aliases of people talking in voice right now. */
  onSpeaking?(aliases: Set<string>): void;
  onPong?(at: number): void;
  /** A key the shell didn't use. Return true if handled. */
  onKey?(e: KeyboardEvent): boolean;
  /**
   * A controller button went down (or up). Return true if handled; otherwise the shell moves
   * between buttons with the d-pad and presses the highlighted one with A.
   */
  onPad?(p: PadPress, down: boolean): boolean;
  /** Where button-to-button movement starts from (e.g. the highlighted card). */
  padOrigin?(): { x: number; y: number } | null;
  /** A panel on top of the view (like the scores) that the controller should stay inside. */
  padScope?(): HTMLElement | null;
  /** Actions this game adds to the top of the menu (like Jigsaw's New puzzle). */
  menuItems?(): { id: string; label: string }[];
  onMenuItem?(id: string): void;
  /** Menu opened or closed: stop taking game input while it's open. */
  setPaused?(paused: boolean): void;
  resize?(): void;
  /**
   * A note for the table ("Your mic is on", a message while Messages is closed), as safe HTML.
   * Return true if the view shows it itself (Tanks on a sideways phone queues them in its own
   * spot); otherwise it pops up as usual.
   */
  showNote?(html: string): boolean;
  dispose(): void;
}
