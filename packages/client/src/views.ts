import type { ChatFilterMode, GameId, GameInput, GameServerMessage, MemberInfo } from '@tank/shared';
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
  pickGame(game: GameId): void;
  toLobby(): void;
  toast(text: string): void;
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
export interface View {
  /** Phone players should hold the phone sideways for this view. */
  readonly landscape: boolean;
  /** Shown in the menu. */
  readonly helpHtml: string;
  onGameMessage?(m: GameServerMessage): void;
  onMembers?(members: MemberInfo[]): void;
  /** The room's chat filter setting changed. */
  onChatFilter?(): void;
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
  /** Menu opened or closed: stop taking game input while it's open. */
  setPaused?(paused: boolean): void;
  resize?(): void;
  dispose(): void;
}
