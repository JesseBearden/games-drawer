import type { ClientMessage, RtcSignal, VoicePeer, VoiceSettings } from '@tank/shared';
import {
  answerWaitMs,
  enoughStep,
  LOST_WAIT_MS,
  nextStep,
  readAttempt,
  relayEnds,
  RETRY_MS,
  serversFor,
  SETTLE_MS,
  STEP_WAIT_MS,
  withAttempt,
  type Attempt,
  type RelayEnds,
  type RelayStep,
} from './voiceRelay';

/**
 * Peer-to-peer voice chat at the table.
 *
 * Every player in voice connects directly to every other (a "mesh"; fine for 4 players). The
 * game server only relays the WebRTC set-up messages between voice members of the same room;
 * audio never passes through it. The player with the smaller alias always makes the offer, so
 * two peers never both start negotiating at once.
 *
 * Noise handling (cheapest first):
 *   1. The browser's own echo cancellation, noise suppression and auto gain.
 *   2. A noise gate: we only transmit while your mic level is above a speech threshold.
 *   3. Self-mute, and per-player mute on the listening side.
 *
 * Voice belongs to the room, not a game: it keeps running when the room switches games, and
 * after a dropped connection it rejoins by itself (the mic stays open).
 *
 * Some networks can't connect two players directly; the server can hand out credentials for
 * our own TURN relay. A link tries without it first, and takes as few of its slots as will
 * connect (voiceRelay.ts). Add ?relay=1 to the page URL to force every link through the relay
 * (for testing it).
 */
export interface VoiceHooks {
  send(msg: ClientMessage): void;
  toast(text: string): void;
  /** The browser is blocking the mic: show how to allow it. */
  micHelp(): void;
  /** Membership, mute or connection state changed: redraw the voice UI. */
  changed(): void;
  /** Aliases of whoever is talking right now (including you). */
  speaking(aliases: Set<string>): void;
}

export type VoiceRoute = 'connecting' | 'direct' | 'relayed' | 'failed';

interface PeerLink {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  analyser: AnalyserNode | null;
  source: MediaStreamAudioSourceNode | null;
  /** ICE candidates that arrived before the remote description. */
  pending: RTCIceCandidateInit[];
  route: VoiceRoute;
  /** The route last reported to the server, so each is sent once. */
  reported: VoiceRoute | null;
  /** We make this link's offers (the smaller alias). */
  offers: boolean;
  attempt: Attempt | null;
  /** The other side's page is from before attempts: it gets every relay route, as it expects. */
  olderPeer: boolean;
  /** This attempt has connected at some point. */
  connected: boolean;
  /** UDP got out, the last time this link looked. */
  udp: boolean;
  /** This attempt: addresses were gathered, and one was our public address. */
  gathered: boolean;
  sawPublic: boolean;
  /** Times it was made again to give back slots it wasn't using (MAX_TRIMS). */
  trims: number;
  /** They've been told it can't connect (said once, until it does). */
  told: boolean;
  timer: number | undefined;
}

/** A link is made again to give back unused slots at most this often (each time is a blink of silence). */
const MAX_TRIMS = 3;

function forceRelay(): boolean {
  try {
    return new URLSearchParams(location.search).get('relay') === '1' || localStorage.getItem('tank.voiceRelay') === '1';
  } catch {
    return false;
  }
}

/** Mic level (RMS, 0..1) above which the gate opens; it stays open briefly after you stop. */
const GATE_OPEN = 0.012;
const GATE_HOLD_MS = 450;
const SPEAKING_LEVEL = 0.02;
/** Sound can refuse to start until a tap, and then says nothing: carry on after this long. */
const RESUME_WAIT_MS = 1000;
/** A mic that stops again this soon after being opened again isn't opened a third time. */
const MIC_STOPS_AGAIN_MS = 3000;

export function voiceSupported(): boolean {
  return typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
}

/** Why this page can't use the mic at all, in words for whoever is playing. */
export function micUnsupportedText(): string {
  return window.isSecureContext
    ? 'This browser can’t use the mic. Open the link in Safari or Chrome.'
    : 'The mic only works at an address that starts with https.';
}

/** What we ask the browser for: its own echo cancellation, noise suppression and level control. */
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  video: false,
};

/**
 * A description as the other end sent it, asking us for mono at 32 kbit/s. That's what Chrome
 * sends of a voice anyway. Firefox would send stereo at more than twice that, which is wasted on
 * one mic and crowds the relay's cap on each slot (deploy/relay-firewall.sh).
 */
export function speechBitrate(sdp: string): string {
  const opus = /^a=rtpmap:(\d+) opus\//im.exec(sdp)?.[1];
  if (!opus) return sdp;
  const ask = ['maxaveragebitrate=32000', 'stereo=0'];
  const params = new RegExp(`^a=fmtp:${opus} ([^\\r\\n]*)`, 'm');
  if (!params.test(sdp)) return sdp.replace(new RegExp(`^(a=rtpmap:${opus} [^\\r\\n]*)`, 'm'), `$1\r\na=fmtp:${opus} ${ask.join(';')}`);
  return sdp.replace(params, (_, all: string) => {
    const kept = all.split(';').map((p) => p.trim()).filter((p) => p && !/^(maxaveragebitrate|stereo)=/i.test(p));
    return `a=fmtp:${opus} ${[...kept, ...ask].join(';')}`;
  });
}

export class Voice {
  inVoice = false;
  selfMuted = false;
  /** Why the mic didn't come on last time: the browser said no, or there's no mic at all. */
  micProblem: 'blocked' | 'missing' | null = null;
  peers: VoicePeer[] = [];
  private links = new Map<string, PeerLink>();
  private muted = new Set<string>();
  private mic: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private gate: GainNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private sendTrack: MediaStreamTrack | null = null;
  /** The page is hidden and peers get the plain mic (see onVisibility). */
  private rawMic = false;
  private gateOpenUntil = 0;
  private timer: number | undefined;
  private lastSpeaking = '';
  private joining = false;
  /** Counts teardowns, so an answer that comes after one (Allow, tapped late) is thrown away. */
  private teardowns = 0;
  /** The mic is being opened again after it stopped. */
  private reopening: Promise<void> | null = null;
  private reopenedAt = -Infinity;

  readonly relayOnly = forceRelay();

  constructor(
    readonly alias: string,
    public settings: VoiceSettings,
    private hooks: VoiceHooks,
  ) {}

  get available() {
    return this.settings.enabled;
  }

  get supported() {
    return voiceSupported();
  }

  /** The mic is on, or the browser is being asked for it: what a reload should come back to. */
  get micOn() {
    return this.inVoice || this.joining;
  }

  /** Any "Turn on mic" button: turn it on or, if the browser is blocking it, show how to allow it. */
  turnOn() {
    if (this.micProblem === 'blocked') this.hooks.micHelp();
    else void this.join();
  }

  isPeerMuted(alias: string) {
    return this.muted.has(alias);
  }

  isConnected(alias: string) {
    const s = this.links.get(alias)?.pc.connectionState;
    return s === 'connected';
  }

  routeTo(alias: string): VoiceRoute {
    return this.links.get(alias)?.route ?? 'connecting';
  }

  /**
   * After a reconnect the server has us outside voice and every peer link is dead. Keep the
   * mic and rejoin, with the fresh settings (relay credentials) from the new welcome.
   */
  rejoin(settings: VoiceSettings) {
    this.settings = settings;
    if (!this.inVoice) return;
    for (const alias of [...this.links.keys()]) this.dropLink(alias);
    this.peers = [];
    this.hooks.send({ t: 'voice', join: true });
    this.hooks.changed();
  }

  /**
   * Turn on the mic and join. Best from a tap (some browsers only allow sound after one).
   * The entry page's "with mic on" buttons ask for the mic during the tap itself and hand the
   * request over here (`stream`), along with an audio context made in the same tap (`ctx`), so
   * iPhones and iPads let it play. `auto` is for joining straight from that choice. `muted` is
   * for coming back after a reload, muted as you were; a tap on Turn on mic is never muted.
   */
  async join(opts: { auto?: boolean; stream?: Promise<MediaStream> | null; ctx?: AudioContext | null; muted?: boolean } = {}) {
    if (this.inVoice || this.joining || !this.available) return;
    if (!this.supported) {
      this.hooks.toast(micUnsupportedText());
      return;
    }
    const teardowns = this.teardowns;
    this.joining = true;
    this.selfMuted = !!opts.muted;
    let mic: MediaStream;
    try {
      mic = await (opts.stream ?? navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS));
    } catch (err) {
      if (teardowns !== this.teardowns) {
        opts.ctx?.close().catch(() => {});
        return;
      }
      this.joining = false;
      const name = (err as { name?: string } | null)?.name;
      this.micProblem = name === 'NotFoundError' || name === 'OverconstrainedError' ? 'missing' : 'blocked';
      this.hooks.toast(this.micProblem === 'missing' ? 'No microphone found on this device.' : 'Your mic is blocked. Tap Turn on mic to see how to allow it.');
      opts.ctx?.close().catch(() => {});
      this.hooks.changed();
      return;
    }
    // Left the table while the browser was still asking: whatever the answer, the mic isn't kept.
    if (teardowns !== this.teardowns) {
      mic.getTracks().forEach((t) => t.stop());
      opts.ctx?.close().catch(() => {});
      return;
    }
    this.mic = mic;
    this.micProblem = null;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    this.ctx = opts.ctx && opts.ctx.state !== 'closed' ? opts.ctx : new Ctor();
    await this.wakeSound();
    if (teardowns !== this.teardowns) return; // (teardown let go of the mic and the sound)
    // mic -> analyser (level) and -> gate (gain 0/1) -> stream we actually send
    this.micSource = this.ctx.createMediaStreamSource(this.mic);
    this.micAnalyser = this.ctx.createAnalyser();
    this.micAnalyser.fftSize = 512;
    this.gate = this.ctx.createGain();
    this.gate.gain.value = 0;
    const out = this.ctx.createMediaStreamDestination();
    this.micSource.connect(this.micAnalyser);
    this.micSource.connect(this.gate).connect(out);
    this.sendTrack = out.stream.getAudioTracks()[0];
    this.sendTrack.enabled = !this.selfMuted;
    this.inVoice = true;
    this.joining = false;
    this.timer = window.setInterval(() => this.tick(), 60);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.hooks.send({ t: 'voice', join: true });
    this.hooks.toast(this.selfMuted ? 'Your mic is muted, as you left it.' : 'Your mic is on.');
    this.hooks.changed();
    this.connectPeers();
    this.watchMic(mic);
    // Browsers may hold back sound until the page has been tapped; resume on the next tap.
    if (this.ctx && this.ctx.state !== 'running') this.resumeOnTap();
  }

  // ---------------------------------------------------------------- in the background

  /**
   * iPhones and iPads pause timers and Web Audio a few seconds after the page goes to the
   * background, which froze the noise gate shut: you could still hear everyone, but they
   * stopped hearing you. While the page is hidden we send the plain mic instead (the browser's
   * own noise suppression still applies), and switch back to the gate when it's showing again.
   */
  private onVisibility = () => {
    if (!this.inVoice || !this.mic) return;
    if (document.visibilityState === 'hidden') this.sendRawMic(true);
    else void this.backInFront();
  };

  /** Which track the peers get: the plain mic (page hidden) or the gated one. */
  private sendRawMic(raw: boolean) {
    const micTrack = this.mic?.getAudioTracks()[0] ?? null;
    if (!micTrack || !this.sendTrack) return;
    this.rawMic = raw;
    // The plain mic also feeds the level meter, so it's only switched off while it's what we send.
    micTrack.enabled = raw ? !this.selfMuted : true;
    const track = raw ? micTrack : this.sendTrack;
    for (const link of this.links.values()) {
      for (const sender of link.pc.getSenders()) {
        if (sender.track !== track && (sender.track?.kind ?? 'audio') === 'audio') void sender.replaceTrack(track).catch(() => {});
      }
    }
  }

  private async backInFront() {
    await this.wakeSound();
    // The system can end the mic while the page is away (another app took it): open it again.
    if (this.micEnded()) await this.reopenMic();
    if (!this.inVoice || document.visibilityState === 'hidden') return; // left, or away again
    this.sendRawMic(false);
    for (const link of this.links.values()) if (link.audio.srcObject && link.audio.paused) void link.audio.play().catch(() => {});
  }

  private async wakeSound() {
    const resumed = this.ctx?.resume().catch(() => {});
    if (resumed) await Promise.race([resumed, new Promise<void>((done) => window.setTimeout(done, RESUME_WAIT_MS))]);
  }

  // ---------------------------------------------------------------- a mic that stops

  private micEnded() {
    return this.mic?.getAudioTracks()[0]?.readyState === 'ended';
  }

  /**
   * A mic can stop by itself: a headset unplugged or out of battery, or the system took it. Open
   * it again (the browser picks whichever mic is there now). While the page is hidden that waits
   * until it's back in front, as browsers don't give a hidden page the mic.
   */
  private watchMic(stream: MediaStream) {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const stopped = () => {
      if (this.mic !== stream || !this.inVoice || document.visibilityState === 'hidden') return;
      if (Date.now() - this.reopenedAt < MIC_STOPS_AGAIN_MS) this.micStopped();
      else void this.reopenMic();
    };
    track.onended = stopped;
    if (track.readyState === 'ended') stopped();
  }

  /** It couldn't be opened again: show it as muted (which it is), so one tap tries again. */
  private micStopped() {
    this.setSelfMuted(true);
    this.hooks.toast('Your mic stopped. Check it’s plugged in, then tap Unmute mic.');
  }

  private reopenMic() {
    return (this.reopening ??= this.openMicAgain().finally(() => (this.reopening = null)));
  }

  private async openMicAgain() {
    const teardowns = this.teardowns;
    let fresh: MediaStream;
    try {
      fresh = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch {
      if (teardowns === this.teardowns) this.micStopped();
      return;
    }
    if (teardowns !== this.teardowns) {
      fresh.getTracks().forEach((t) => t.stop());
      return;
    }
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = fresh;
    this.reopenedAt = Date.now();
    this.micSource?.disconnect();
    if (this.ctx && this.micAnalyser && this.gate) {
      this.micSource = this.ctx.createMediaStreamSource(fresh);
      this.micSource.connect(this.micAnalyser);
      this.micSource.connect(this.gate);
    }
    // If the plain mic is what's being sent (the page is hidden), it's the new one now, muted or not.
    if (this.rawMic) this.sendRawMic(true);
    this.watchMic(fresh);
  }

  private resumeOnTap() {
    const resume = () => {
      document.removeEventListener('pointerdown', resume, true);
      void this.ctx?.resume().catch(() => {});
      for (const link of this.links.values()) if (link.audio.srcObject && link.audio.paused) void link.audio.play().catch(() => {});
    };
    document.addEventListener('pointerdown', resume, true);
  }

  /** Turn the mic off completely (leave voice). Muting is setSelfMuted. */
  leave() {
    if (!this.inVoice) return;
    this.hooks.send({ t: 'voice', join: false });
    this.teardown();
    this.hooks.toast('Your mic is off.');
    this.hooks.changed();
  }

  /** Close everything without telling the server (it already knows, e.g. on reconnect). */
  teardown() {
    this.teardowns++;
    this.joining = false;
    this.inVoice = false;
    this.rawMic = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    clearInterval(this.timer);
    for (const alias of [...this.links.keys()]) this.dropLink(alias);
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.sendTrack = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.hooks.speaking(new Set());
    this.lastSpeaking = '';
  }

  setSelfMuted(muted: boolean) {
    this.selfMuted = muted;
    if (this.sendTrack) this.sendTrack.enabled = !muted;
    // Unmuting a mic that has stopped opens it again (this is the tap browsers want for that).
    if (!muted && this.inVoice && this.micEnded()) {
      void this.wakeSound();
      void this.reopenMic();
    }
    // In the background the plain mic is what's sent, so mute that too.
    if (this.rawMic) {
      const micTrack = this.mic?.getAudioTracks()[0];
      if (micTrack) micTrack.enabled = !muted;
    }
    this.hooks.changed();
  }

  setPeerMuted(alias: string, muted: boolean) {
    if (muted) this.muted.add(alias);
    else this.muted.delete(alias);
    const link = this.links.get(alias);
    if (link) link.audio.muted = muted;
  }

  /** Server says who is in voice now. */
  onPeers(peers: VoicePeer[]) {
    this.peers = peers;
    if (this.inVoice) {
      for (const alias of [...this.links.keys()]) if (!peers.some((p) => p.id === alias)) this.dropLink(alias);
      this.connectPeers();
    }
    this.hooks.changed();
  }

  async onSignal(from: string, data: RtcSignal) {
    if (!this.inVoice || !this.peers.some((p) => p.id === from)) return;
    const link = this.links.get(from) ?? this.createLink(from);
    try {
      if (!('sdp' in data)) {
        if (link.pc.remoteDescription) await link.pc.addIceCandidate(data.candidate).catch(() => {});
        else link.pending.push(data.candidate);
        return;
      }
      const { type } = data.sdp;
      const { attempt, sdp } = readAttempt(data.sdp.sdp);
      // Nothing is awaited before the new connection exists, so candidates behind the offer find it.
      if (type === 'offer') this.takeOffer(from, link, attempt);
      // An answer to an attempt we've since given up on.
      else if (!link.attempt || (attempt && attempt.id !== link.attempt.id)) return;

      const pc = link.pc;
      await pc.setRemoteDescription({ type, sdp: speechBitrate(sdp) });
      if (link.pc !== pc) return;
      for (const c of link.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (type !== 'offer') return;
      await pc.setLocalDescription(await pc.createAnswer());
      if (link.pc !== pc || this.links.get(from) !== link) return;
      link.gathered = true;
      const answer = pc.localDescription!.sdp;
      this.hooks.send({ t: 'rtc', to: from, data: { sdp: { type: 'answer', sdp: attempt ? withAttempt(answer, attempt) : answer } } });
    } catch (err) {
      console.warn('Voice negotiation failed with', from, err);
    }
  }

  // ---------------------------------------------------------------- connections

  private connectPeers() {
    for (const p of this.peers) {
      if (p.id === this.alias || this.links.has(p.id)) continue;
      const link = this.createLink(p.id);
      // Only one side starts, so offers never collide.
      if (link.offers) void this.tryLink(p.id, link, this.relayOnly ? 'relay' : 'direct');
    }
  }

  private createLink(alias: string): PeerLink {
    const audio = new Audio();
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.muted = this.muted.has(alias);
    const link: PeerLink = {
      pc: this.newConnection([]),
      audio,
      analyser: null,
      source: null,
      pending: [],
      route: 'connecting',
      reported: null,
      offers: this.alias < alias,
      attempt: null,
      olderPeer: false,
      connected: false,
      udp: true,
      gathered: false,
      sawPublic: false,
      trims: 0,
      told: false,
      timer: undefined,
    };
    this.links.set(alias, link);
    if (!link.offers) this.waitForOffers(alias, link);
    return link;
  }

  private newConnection(iceServers: VoiceSettings['iceServers']) {
    return new RTCPeerConnection({ iceServers, iceTransportPolicy: this.relayOnly ? 'relay' : 'all' });
  }

  /** The offering side: make one attempt, and move on to the next if it doesn't connect in time. */
  private async tryLink(alias: string, link: PeerLink, step: RelayStep) {
    const attempt = { id: Math.random().toString(36).slice(2, 10) || '0', step };
    link.attempt = attempt;
    link.route = 'connecting';
    this.replaceConnection(alias, link, step);
    clearTimeout(link.timer);
    link.timer = window.setTimeout(() => this.tryNext(alias, link), STEP_WAIT_MS[step]);
    this.hooks.changed();
    const pc = link.pc;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      if (link.pc !== pc || this.links.get(alias) !== link) return;
      link.gathered = true;
      this.hooks.send({ t: 'rtc', to: alias, data: { sdp: { type: 'offer', sdp: withAttempt(pc.localDescription!.sdp, attempt) } } });
    } catch (err) {
      console.warn('Voice offer failed', err);
    }
  }

  private tryNext(alias: string, link: PeerLink) {
    const next = link.attempt && nextStep(link.attempt.step);
    if (next) void this.tryLink(alias, link, next);
    else this.giveUp(alias, link);
  }

  /** The answering side: a new attempt gets a new connection, with the relay only as it needs. */
  private takeOffer(alias: string, link: PeerLink, attempt: Attempt | null) {
    if (!attempt) {
      // An older page restarts ICE on one connection, and expects every relay route here.
      if (!link.olderPeer || link.pc.signalingState === 'closed') this.replaceConnection(alias, link, 'any');
      link.olderPeer = true;
    } else if (attempt.id !== link.attempt?.id) {
      link.olderPeer = false;
      link.attempt = attempt;
      link.route = 'connecting';
      this.replaceConnection(alias, link, attempt.step);
    }
    this.waitForOffers(alias, link);
  }

  private waitForOffers(alias: string, link: PeerLink) {
    clearTimeout(link.timer);
    link.timer = window.setTimeout(() => this.giveUp(alias, link), answerWaitMs(link.attempt?.step ?? 'direct'));
  }

  /** Close this link's connection (which gives back any relay slots) and make the next one. */
  private replaceConnection(alias: string, link: PeerLink, step: RelayStep) {
    // With the relay forced there's no public address to see, so assume UDP works.
    if (link.gathered && !this.relayOnly) link.udp = link.sawPublic;
    this.closeConnection(link);
    link.pending = [];
    link.connected = false;
    link.gathered = false;
    link.sawPublic = false;
    const servers = serversFor(this.settings.iceServers, { step, offers: link.offers, udp: link.udp, relayOnly: this.relayOnly });
    const pc = this.newConnection(servers);
    link.pc = pc;
    // Whatever we're sending right now: the gated mic, or the plain one while the page is hidden.
    const micTrack = this.mic?.getAudioTracks()[0];
    const out = this.rawMic && micTrack ? micTrack : this.sendTrack;
    if (out) pc.addTrack(out, new MediaStream([out]));
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate.toJSON();
      if (c.candidate?.includes(' typ srflx')) link.sawPublic = true;
      this.hooks.send({
        t: 'rtc',
        to: alias,
        data: { candidate: { candidate: c.candidate ?? '', sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null } },
      });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      link.audio.srcObject = stream;
      link.audio.play().catch((err: { name?: string } | null) => {
        // A newer attempt's sound replacing this one isn't the browser holding sound back.
        if (err?.name === 'AbortError') return;
        this.hooks.toast('Tap the screen to hear voice chat.');
        this.resumeOnTap();
      });
      if (this.ctx) {
        link.source?.disconnect();
        const a = this.ctx.createAnalyser();
        a.fftSize = 512;
        link.source = this.ctx.createMediaStreamSource(stream);
        link.source.connect(a);
        link.analyser = a;
      }
    };
    pc.onconnectionstatechange = () => this.onState(alias, link, pc);
  }

  private closeConnection(link: PeerLink) {
    const { pc } = link;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.close();
    link.source?.disconnect();
    link.source = null;
    link.analyser = null;
  }

  private onState(alias: string, link: PeerLink, pc: RTCPeerConnection) {
    if (link.pc !== pc || this.links.get(alias) !== link) return;
    const state = pc.connectionState;
    if (state === 'connected') {
      link.connected = true;
      link.told = false;
      clearTimeout(link.timer);
      void this.detectRoute(alias, link, pc);
      link.timer = window.setTimeout(() => void this.settle(alias, link, pc), SETTLE_MS);
    } else if (state === 'failed') {
      link.route = 'connecting';
      if (!link.offers) {
        // The other side makes the next attempt. (One that was already waited for keeps its deadline.)
        if (link.connected) this.waitForOffers(alias, link);
      } else if (link.connected) {
        // It was working: try the same way again, with every step after it still to come.
        void this.tryLink(alias, link, link.attempt?.step ?? 'direct');
      } else this.tryNext(alias, link);
    } else if (state === 'disconnected') {
      if (link.connected) {
        if (!link.offers) this.waitForOffers(alias, link);
        else {
          clearTimeout(link.timer);
          link.timer = window.setTimeout(() => void this.tryLink(alias, link, link.attempt?.step ?? 'direct'), LOST_WAIT_MS);
        }
      }
    } else if (state === 'connecting' || state === 'new') link.route = 'connecting';
    this.hooks.changed();
  }

  /** Every attempt failed: say so, don't sit on relay slots, and try again in a while. */
  private giveUp(alias: string, link: PeerLink) {
    if (this.links.get(alias) !== link) return;
    clearTimeout(link.timer);
    link.route = 'failed';
    this.reportRoute(alias, link);
    // An older page may still be trying on this connection.
    if (!link.olderPeer) {
      this.closeConnection(link);
      link.attempt = null;
    }
    if (link.offers) link.timer = window.setTimeout(() => void this.tryLink(alias, link, this.relayOnly ? 'relay' : 'direct'), RETRY_MS);
    if (!link.told) {
      link.told = true;
      const name = this.peers.find((p) => p.id === alias)?.name ?? 'one player';
      this.hooks.toast(`Couldn't connect voice with ${name} (their network or yours blocked it).`);
    }
    this.hooks.changed();
  }

  /** Tell the server how this link connected (the admin page counts how often voice needs the relay). */
  private reportRoute(alias: string, link: PeerLink) {
    if (this.links.get(alias) !== link || link.reported === link.route) return;
    if (link.route !== 'direct' && link.route !== 'relayed' && link.route !== 'failed') return;
    link.reported = link.route;
    this.hooks.send({ t: 'voice-route', to: alias, route: link.route });
  }

  /** Direct, or through the relay (and at which end)? Null if the browser wouldn't say. */
  private async detectRoute(alias: string, link: PeerLink, pc: RTCPeerConnection): Promise<RelayEnds | null> {
    let ends: RelayEnds | null = null;
    try {
      ends = relayEnds(await pc.getStats());
    } catch {
      /* counted as direct */
    }
    if (this.links.get(alias) !== link || link.pc !== pc || pc.connectionState !== 'connected') return null;
    link.route = !ends || ends === 'neither' ? 'direct' : 'relayed';
    this.hooks.changed();
    return ends;
  }

  /**
   * The link has been up a moment. If it's holding more slots than it uses (direct was only slow,
   * or an outage pushed it on to the last attempt), make it again on the attempt that would do.
   */
  private async settle(alias: string, link: PeerLink, pc: RTCPeerConnection) {
    const ends = await this.detectRoute(alias, link, pc);
    if (this.links.get(alias) !== link || link.pc !== pc || pc.connectionState !== 'connected') return;
    const step = link.attempt?.step;
    if (step && link.offers && !this.relayOnly && link.trims < MAX_TRIMS) {
      const enough = enoughStep(step, ends);
      if (enough !== step) {
        link.trims++;
        void this.tryLink(alias, link, enough);
        return;
      }
    }
    this.reportRoute(alias, link);
  }

  private dropLink(alias: string) {
    const link = this.links.get(alias);
    if (!link) return;
    clearTimeout(link.timer);
    this.closeConnection(link);
    link.audio.srcObject = null;
    this.links.delete(alias);
  }

  // ---------------------------------------------------------------- levels

  private samples: Float32Array<ArrayBuffer> | null = null;

  private level(a: AnalyserNode | null): number {
    if (!a) return 0;
    // One buffer for every meter (they run 16 times a second, for hours).
    if (this.samples?.length !== a.fftSize) this.samples = new Float32Array(a.fftSize);
    const buf = this.samples;
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  /** Noise gate + speaking indicators, ~16 times a second. */
  private tick() {
    if (!this.ctx || !this.gate) return;
    const now = performance.now();
    const mine = this.level(this.micAnalyser);
    if (mine > GATE_OPEN) this.gateOpenUntil = now + GATE_HOLD_MS;
    const open = now < this.gateOpenUntil && !this.selfMuted;
    this.gate.gain.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, open ? 0.01 : 0.08);

    const talking = new Set<string>();
    if (open && mine > SPEAKING_LEVEL) talking.add(this.alias);
    for (const [alias, link] of this.links) {
      if (this.muted.has(alias)) continue;
      if (this.level(link.analyser) > SPEAKING_LEVEL) talking.add(alias);
    }
    const key = [...talking].sort().join(',');
    if (key !== this.lastSpeaking) {
      this.lastSpeaking = key;
      this.hooks.speaking(talking);
    }
  }
}
