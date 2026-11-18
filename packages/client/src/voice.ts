import type { ClientMessage, RtcSignal, VoicePeer, VoiceSettings } from '@tank/shared';

/**
 * Peer-to-peer voice chat for private rooms.
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
 * our own TURN relay. Add ?relay=1 to the page URL to force every link through the relay
 * (for testing it).
 */
export interface VoiceHooks {
  send(msg: ClientMessage): void;
  toast(text: string): void;
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
  /** ICE candidates that arrived before the remote description. */
  pending: RTCIceCandidateInit[];
  route: VoiceRoute;
  restarts: number;
}

/** Times we'll retry a failed link (ICE restart) before giving up. */
const MAX_RESTARTS = 2;

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

export function voiceSupported(): boolean {
  return typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
}

const PREF_KEY = 'gd.voice';

/**
 * Whether this browser wants voice: 'on' joins voice in every private room straight away,
 * 'off' stays out until you join yourself, null (never chosen) asks once with a welcome prompt.
 */
export function voicePreference(): 'on' | 'off' | null {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === 'on' || v === 'off' ? v : null;
  } catch {
    return null;
  }
}

export function setVoicePreference(v: 'on' | 'off') {
  try {
    localStorage.setItem(PREF_KEY, v);
  } catch {
    /* private mode: ask again next time */
  }
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
  private sendTrack: MediaStreamTrack | null = null;
  private gateOpenUntil = 0;
  private timer: number | undefined;
  private lastSpeaking = '';
  private joining = false;

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
   * Turn on the mic and join. Best from a tap (some browsers only allow sound after one);
   * `auto` is for rooms joined with voice already switched on, and quietly falls back to the
   * button if the browser says no.
   */
  async join(opts: { auto?: boolean } = {}) {
    if (this.inVoice || this.joining || !this.available) return;
    if (!this.supported) {
      this.hooks.toast('Voice needs a secure (https) page. Use the hosted game or npm run dev:https.');
      return;
    }
    this.joining = true;
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
    } catch (err) {
      this.joining = false;
      const name = (err as { name?: string } | null)?.name;
      this.micProblem = name === 'NotFoundError' || name === 'OverconstrainedError' ? 'missing' : 'blocked';
      this.hooks.toast(
        this.micProblem === 'missing'
          ? 'No microphone found, so you’re not in voice.'
          : opts.auto
            ? 'Couldn’t turn on your mic. Tap 🎙️ to try again.'
            : 'The browser blocked the microphone. Allow it for this site in the browser’s settings, then tap 🎙️.',
      );
      this.hooks.changed();
      return;
    }
    this.micProblem = null;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    await this.ctx.resume().catch(() => {});
    // mic -> analyser (level) and -> gate (gain 0/1) -> stream we actually send
    const src = this.ctx.createMediaStreamSource(this.mic);
    this.micAnalyser = this.ctx.createAnalyser();
    this.micAnalyser.fftSize = 512;
    this.gate = this.ctx.createGain();
    this.gate.gain.value = 0;
    const out = this.ctx.createMediaStreamDestination();
    src.connect(this.micAnalyser);
    src.connect(this.gate).connect(out);
    this.sendTrack = out.stream.getAudioTracks()[0];
    this.inVoice = true;
    this.joining = false;
    this.timer = window.setInterval(() => this.tick(), 60);
    this.hooks.send({ t: 'voice', join: true });
    this.hooks.toast(opts.auto ? 'Voice is on. Tap 🎙️ to mute or turn it off.' : 'Joined voice chat');
    setVoicePreference('on');
    this.hooks.changed();
    this.connectPeers();
    // Browsers may hold back sound until the page has been tapped; resume on the next tap.
    if (this.ctx && this.ctx.state !== 'running') this.resumeOnTap();
  }

  private resumeOnTap() {
    const resume = () => {
      document.removeEventListener('pointerdown', resume, true);
      void this.ctx?.resume().catch(() => {});
      for (const link of this.links.values()) if (link.audio.srcObject && link.audio.paused) void link.audio.play().catch(() => {});
    };
    document.addEventListener('pointerdown', resume, true);
  }

  /** Leave voice by choice; remembered, so the next room doesn't switch it back on. */
  leave() {
    if (!this.inVoice) return;
    setVoicePreference('off');
    this.hooks.send({ t: 'voice', join: false });
    this.teardown();
    this.hooks.toast('Left voice chat');
    this.hooks.changed();
  }

  /** Close everything without telling the server (it already knows, e.g. on reconnect). */
  teardown() {
    this.inVoice = false;
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
    const pc = link.pc;
    try {
      if ('sdp' in data) {
        await pc.setRemoteDescription(data.sdp);
        for (const c of link.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          const d = pc.localDescription!;
          this.hooks.send({ t: 'rtc', to: from, data: { sdp: { type: d.type as 'answer', sdp: d.sdp } } });
        }
      } else if (pc.remoteDescription) {
        await pc.addIceCandidate(data.candidate).catch(() => {});
      } else {
        link.pending.push(data.candidate);
      }
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
      if (this.alias < p.id) void this.offer(p.id, link);
    }
  }

  private async offer(alias: string, link: PeerLink) {
    try {
      await link.pc.setLocalDescription(await link.pc.createOffer());
      const d = link.pc.localDescription!;
      this.hooks.send({ t: 'rtc', to: alias, data: { sdp: { type: d.type as 'offer', sdp: d.sdp } } });
    } catch (err) {
      console.warn('Voice offer failed', err);
    }
  }

  private createLink(alias: string): PeerLink {
    const pc = new RTCPeerConnection({ iceServers: this.settings.iceServers, iceTransportPolicy: this.relayOnly ? 'relay' : 'all' });
    const audio = new Audio();
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.muted = this.muted.has(alias);
    const link: PeerLink = { pc, audio, analyser: null, pending: [], route: 'connecting', restarts: 0 };
    if (this.sendTrack) pc.addTrack(this.sendTrack, new MediaStream([this.sendTrack]));
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate.toJSON();
      this.hooks.send({
        t: 'rtc',
        to: alias,
        data: { candidate: { candidate: c.candidate ?? '', sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null } },
      });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      audio.srcObject = stream;
      audio.play().catch(() => {
        this.hooks.toast('Tap the screen to hear voice chat.');
        this.resumeOnTap();
      });
      if (this.ctx) {
        const a = this.ctx.createAnalyser();
        a.fftSize = 512;
        this.ctx.createMediaStreamSource(stream).connect(a);
        link.analyser = a;
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') void this.detectRoute(alias, link);
      else if (state === 'failed') this.onFailed(alias, link);
      else if (state === 'connecting' || state === 'new') link.route = 'connecting';
      this.hooks.changed();
    };
    this.links.set(alias, link);
    return link;
  }

  /** Retry a failed link with fresh network paths; the offering side drives it. */
  private onFailed(alias: string, link: PeerLink) {
    if (this.links.get(alias) !== link) return;
    if (link.restarts >= MAX_RESTARTS) {
      link.route = 'failed';
      const name = this.peers.find((p) => p.id === alias)?.name ?? 'one player';
      this.hooks.toast(`Couldn't connect voice with ${name} (their network or yours blocked it).`);
      return;
    }
    link.restarts++;
    link.route = 'connecting';
    if (this.alias < alias) {
      link.pc.restartIce();
      void this.offer(alias, link);
    }
  }

  /** Direct, or through the relay? Shown in the voice panel. */
  private async detectRoute(alias: string, link: PeerLink) {
    try {
      const stats = await link.pc.getStats();
      let pairId: string | undefined;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      let local: string | undefined;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && (r.id === pairId || (!pairId && r.nominated && r.state === 'succeeded'))) local = r.localCandidateId;
      });
      let relayed = false;
      stats.forEach((r) => {
        if (r.type === 'local-candidate' && r.id === local && r.candidateType === 'relay') relayed = true;
      });
      link.route = relayed ? 'relayed' : 'direct';
    } catch {
      link.route = 'direct';
    }
    if (this.links.get(alias) === link) this.hooks.changed();
  }

  private dropLink(alias: string) {
    const link = this.links.get(alias);
    if (!link) return;
    link.pc.close();
    link.audio.srcObject = null;
    this.links.delete(alias);
  }

  // ---------------------------------------------------------------- levels

  private level(a: AnalyserNode | null): number {
    if (!a) return 0;
    const buf = new Float32Array(a.fftSize);
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
