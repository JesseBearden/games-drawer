import type { VoiceSettings } from '@tank/shared';

/**
 * When a voice link may ask our relay for a slot.
 *
 * coturn sets aside bandwidth for every slot as it opens, used or not (turnserver.conf), and a
 * browser opens one for every relay address it's given, at both ends of every link, keeping
 * them after the link connects directly. So a link asks only when it has to:
 *
 *   direct  no relay at all: most links connect this way within a second or two
 *   relay   one slot. The side making the offer asks, over UDP, or over TCP if it saw that UDP
 *           can't get out. The other side asks only if UDP can't get out for it.
 *   any     every relay route at both ends, for what's left
 *
 * Each attempt is a new RTCPeerConnection: restarting ICE on the old one doesn't give its slots
 * back, closing it does.
 */
export type RelayStep = 'direct' | 'relay' | 'any';

/** How long each attempt has to connect before the next is tried. */
export const STEP_WAIT_MS: Record<RelayStep, number> = { direct: 5000, relay: 8000, any: 14_000 };
/** How long a working link may be interrupted before it's made again (most recover by themselves). */
export const LOST_WAIT_MS = 6000;
/** A new link can switch paths for a moment; look at what it settled on after this long. */
export const SETTLE_MS = 3000;

/** A link that couldn't connect is tried again this often: networks come back, and slots free up. */
export const RETRY_MS = 60_000;

export function nextStep(step: RelayStep): RelayStep | null {
  return step === 'direct' ? 'relay' : step === 'relay' ? 'any' : null;
}

/** The answering side waits out this attempt and those after it, and a bit, before saying it couldn't connect. */
export function answerWaitMs(step: RelayStep): number {
  let ms = 5000;
  for (let s: RelayStep | null = step; s; s = nextStep(s)) ms += STEP_WAIT_MS[s];
  return ms;
}

export interface LinkSide {
  step: RelayStep;
  /** This side makes the offers. */
  offers: boolean;
  /** UDP got out last time: our STUN server told this device its public address. */
  udp: boolean;
  /** ?relay=1: only the relay may be used. */
  relayOnly: boolean;
}

type IceServers = VoiceSettings['iceServers'];

/** The STUN and relay servers one side of a link uses for one attempt. */
export function serversFor(all: IceServers, { step, offers, udp, relayOnly }: LinkSide): IceServers {
  if (step === 'any') return all;
  const asks = relayOnly || (step === 'relay' && (offers || !udp));
  return all.flatMap((server) => {
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    const turn = urls.filter((u) => /^turns?:/.test(u));
    const keep = urls.filter((u) => !turn.includes(u));
    if (asks && turn.length) keep.push(turn.find((u) => u.includes('transport=tcp') !== udp) ?? turn[0]);
    return keep.length ? [{ ...server, urls: keep }] : [];
  });
}

/** Which attempt an offer or answer belongs to. */
export interface Attempt {
  id: string;
  step: RelayStep;
}

// The attempt travels as a line in the session description rather than a field of its own, so a
// server from before this (a draining box) passes it on. Browsers skip lines they don't know.
const ATTEMPT_LINE = /^a=x-gd-attempt:([a-z0-9]{1,16}) (direct|relay|any)\r?\n/m;

export function withAttempt(sdp: string, { id, step }: Attempt): string {
  return `${sdp}a=x-gd-attempt:${id} ${step}\r\n`;
}

/** The attempt in a description, and the description without it. Null: from a page before this. */
export function readAttempt(sdp: string): { attempt: Attempt | null; sdp: string } {
  const m = ATTEMPT_LINE.exec(sdp);
  if (!m) return { attempt: null, sdp };
  return { attempt: { id: m[1], step: m[2] as RelayStep }, sdp: sdp.replace(m[0], '') };
}

/** Which ends of a link are using a relay slot. */
export type RelayEnds = 'neither' | 'here' | 'there' | 'both';

/**
 * Where the link's audio meets the relay. (With one slot, only one end's address is the relay's.)
 * Null if the browser doesn't say.
 */
export function relayEnds(stats: RTCStatsReport): RelayEnds | null {
  const all: any[] = [];
  stats.forEach((r) => all.push(r));
  const id = all.find((r) => r.type === 'transport' && r.selectedCandidatePairId)?.selectedCandidatePairId;
  const pairs = all.filter((r) => r.type === 'candidate-pair');
  // Firefox marks the pair itself; others may nominate several, so that's the last resort.
  const pair = pairs.find((r) => r.id === id) ?? pairs.find((r) => r.selected) ?? pairs.find((r) => r.nominated && r.state === 'succeeded');
  if (!pair) return null;
  const relay = (candidate: string) => all.some((r) => r.id === candidate && r.candidateType === 'relay');
  const here = relay(pair.localCandidateId);
  const there = relay(pair.remoteCandidateId);
  return here && there ? 'both' : here ? 'here' : there ? 'there' : 'neither';
}

/** The attempt that would have done, for a link that connected on `step` and meets the relay at `ends`. */
export function enoughStep(step: RelayStep, ends: RelayEnds | null): RelayStep {
  if (ends === 'neither') return 'direct';
  // Only our slot is in use, which is all the relay attempt asks for.
  return step === 'any' && ends === 'here' ? 'relay' : step;
}
