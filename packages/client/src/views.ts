import type { GameInput, GameServerMessage, MemberInfo } from '@tank/shared';
import type { PlayOptions, Sfx, SoundName } from './audio';

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
  pickGame(game: 'tanks' | 'hearts'): void;
  toLobby(): void;
  toast(text: string): void;
  share(): void;
  /** Play a sound, ignoring names this build doesn't have. */
  play(name: SoundName | string, opts?: PlayOptions): void;
  voice: {
    available: boolean;
    inVoice: boolean;
    join(): void;
  };
}

/** The lobby or a game, mounted inside the room shell. Chat and voice live in the shell. */
export interface View {
  /** Phone players should hold the phone sideways for this view. */
  readonly landscape: boolean;
  /** Shown in the menu. */
  readonly helpHtml: string;
  onGameMessage?(m: GameServerMessage): void;
  onMembers?(members: MemberInfo[]): void;
  /** Aliases of people talking in voice right now. */
  onSpeaking?(aliases: Set<string>): void;
  onPong?(at: number): void;
  /** A key the shell didn't use. Return true if handled. */
  onKey?(e: KeyboardEvent): boolean;
  /** Menu opened or closed: stop taking game input while it's open. */
  setPaused?(paused: boolean): void;
  resize?(): void;
  dispose(): void;
}
