import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseClientMessage, type ClientMessage, type VoiceSettings } from '@tank/shared';
import { micUnsupportedText, speechBitrate, Voice } from '../src/voice';
import { answerWaitMs, enoughStep, readAttempt, relayEnds, RETRY_MS, serversFor, STEP_WAIT_MS, withAttempt } from '../src/voiceRelay';

// The real Voice, over a pretend network and relay: who can reach whom, and how many relay slots
// are open. Like browsers, a connection opens a slot for every relay address it's given and can
// reach, and keeps it until the connection closes.

const STUN = 'stun:relay.test:3478';
const UDP = 'turn:relay.test:3478?transport=udp';
const TCP = 'turn:relay.test:3478?transport=tcp';
const ICE: VoiceSettings['iceServers'] = [{ urls: [STUN] }, { urls: [UDP, TCP], username: 'u', credential: 'c' }];
/** What the live box's coturn has room for. */
const LIVE_SLOTS = 19;

interface Device {
  /** UDP gets out. */
  udp: boolean;
  /** A NAT no direct link gets through. */
  hard: boolean;
  /** Only a relay may be used (?relay=1). */
  relayOnly: boolean;
}

let device: Device;
let world: { cap: number; refused: number; directMs: number; pcs: Map<string, FakePc>; peak: number };
const slots = () => [...world.pcs.values()].reduce((n, pc) => n + pc.slots.length, 0);

class FakePc {
  id = `pc${world.pcs.size}`;
  device = device;
  slots: string[] = [];
  connectionState = 'new';
  signalingState = 'stable';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  candidates: string[] = [];
  onicecandidate: ((e: object) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: object) => void) | null = null;
  relayed = false;
  peer: FakePc | null = null;
  urls: string[];
  relayPolicy: boolean;
  private linking: ReturnType<typeof setTimeout> | undefined;

  constructor(config: RTCConfiguration) {
    this.urls = (config.iceServers ?? []).flatMap((s) => s.urls);
    this.relayPolicy = config.iceTransportPolicy === 'relay';
    world.pcs.set(this.id, this);
  }
  addTrack() {}
  getSenders() {
    return [];
  }
  async createOffer() {
    return { type: 'offer', sdp: `v=0\r\na=pc:${this.id}\r\n` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: `v=0\r\na=pc:${this.id}\r\n` };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    if (this.signalingState === 'closed') throw new Error('closed');
    const first = !this.localDescription;
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
    if (first) {
      for (const u of this.urls) {
        if (!u.startsWith('turn') || (!this.device.udp && !u.includes('tcp'))) continue;
        if (slots() >= world.cap) world.refused++;
        else this.slots.push(u);
      }
      world.peak = Math.max(world.peak, slots());
      // Addresses follow the description, never come before it.
      setTimeout(() => {
        const types = this.relayPolicy ? [] : ['host', ...(this.device.udp && this.urls.some((u) => u.startsWith('stun')) ? ['srflx'] : [])];
        if (this.slots.length) types.push('relay');
        for (const t of types) this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: `candidate:1 1 udp 1 ${this.id} 9 typ ${t}` }) } });
      }, 1);
    }
    this.link();
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    if (this.signalingState === 'closed') throw new Error('closed');
    if (d.type === 'answer' && this.signalingState !== 'have-local-offer') throw new Error('no offer');
    expect(d.sdp).not.toContain('x-gd-attempt'); // the browser never sees our line
    this.remoteDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
    this.link();
  }
  async addIceCandidate(c: RTCIceCandidateInit) {
    this.candidates.push(c.candidate ?? '');
  }
  private link() {
    const other = world.pcs.get(/a=pc:(\w+)/.exec(this.remoteDescription?.sdp ?? '')?.[1] ?? '');
    if (!other || !this.localDescription || !other.remoteDescription?.sdp.includes(`a=pc:${this.id}\r`)) return;
    const open = (a: FakePc, b: FakePc) => a.device.udp && !a.device.hard && !a.relayPolicy && b.device.udp && !b.device.hard && !b.relayPolicy;
    // One end's relay carries both ways, if the other end can send UDP to it or has its own.
    const through = (a: FakePc, b: FakePc) => a.slots.length > 0 && (b.slots.length > 0 || (b.device.udp && !b.relayPolicy));
    const direct = open(this, other);
    if (!direct && !through(this, other) && !through(other, this)) return;
    clearTimeout(this.linking);
    this.linking = setTimeout(() => {
      if (this.signalingState === 'closed' || other.signalingState === 'closed') return;
      for (const [pc, peer] of [[this, other], [other, this]] as const) {
        pc.relayed = !direct;
        pc.peer = peer;
        if (pc.connectionState !== 'connected') pc.setState('connected');
      }
    }, direct ? world.directMs : 300);
  }
  setState(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  async getStats() {
    return new Map<string, object>([
      ['t', { type: 'transport', selectedCandidatePairId: 'p' }],
      ['p', { type: 'candidate-pair', id: 'p', localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['l', { type: 'local-candidate', id: 'l', candidateType: this.relayed && this.slots.length ? 'relay' : 'host' }],
      ['r', { type: 'remote-candidate', id: 'r', candidateType: this.relayed && !this.slots.length ? 'relay' : 'host' }],
    ]);
  }
  close() {
    clearTimeout(this.linking);
    this.slots = [];
    this.signalingState = 'closed';
    this.connectionState = 'closed';
  }
}

interface Person {
  id: string;
  voice: Voice;
  device: Device;
  sent: ClientMessage[];
  toasts: string[];
}
type Wire = { from: string; to: string; m: Extract<ClientMessage, { t: 'rtc' }> };

/** People at one table, with the server passing their signals on as it does (parsed, in order). */
function table(devices: Partial<Device>[], onWire: (w: Wire) => boolean = () => true) {
  const people: Person[] = devices.map((d, i) => {
    const p = { id: `p${i}`, device: { udp: true, hard: false, relayOnly: false, ...d }, sent: [], toasts: [] } as unknown as Person;
    vi.stubGlobal('location', { search: p.device.relayOnly ? '?relay=1' : '' });
    const inPerson = <T>(f: () => T) => {
      device = p.device;
      return f();
    };
    p.voice = new Voice(p.id, { enabled: true, iceServers: ICE }, {
      send: (msg) => {
        p.sent.push(msg);
        if (msg.t !== 'rtc') return;
        const m = parseClientMessage(JSON.stringify(msg)) as Wire['m'];
        if (!onWire({ from: p.id, to: m.to, m })) return;
        setTimeout(() => deliver(p.id, m), 20);
      },
      toast: (t) => p.toasts.push(t),
      micHelp: () => {},
      changed: () => {},
      speaking: () => {},
    });
    // Connections are made inside Voice; each belongs to that person's device.
    const own = p.voice as unknown as { newConnection: (s: VoiceSettings['iceServers']) => unknown };
    const make = own.newConnection.bind(p.voice);
    own.newConnection = (s) => inPerson(() => make(s));
    p.voice.inVoice = true;
    return p;
  });
  function deliver(from: string, m: Wire['m']) {
    const to = people.find((p) => p.id === m.to);
    if (to) void to.voice.onSignal(from, m.data);
  }
  const peers = people.map((p) => ({ id: p.id, name: p.id.toUpperCase() }));
  for (const p of people) p.voice.onPeers(peers);
  const routes = () => people.flatMap((p) => people.filter((o) => o !== p).map((o) => p.voice.routeTo(o.id)));
  const reports = () => people.flatMap((p) => p.sent.flatMap((m) => (m.t === 'voice-route' ? [m.route] : [])));
  const pcs = (p: Person) => [...world.pcs.values()].filter((pc) => pc.device === p.device && pc.signalingState !== 'closed');
  const leave = () => people.forEach((p) => p.voice.leave());
  return { people, routes, reports, pcs, deliver, leave };
}

const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const DIRECT = STEP_WAIT_MS.direct;

beforeEach(() => {
  vi.useFakeTimers();
  world = { cap: Infinity, refused: 0, directMs: 400, pcs: new Map(), peak: 0 };
  vi.stubGlobal('RTCPeerConnection', FakePc);
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('window', {
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
  });
  vi.stubGlobal('Audio', class {
    setAttribute() {}
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('voice asks for relay slots only when a link needs one', () => {
  it('four people who connect directly never take a slot', async () => {
    const t = table([{}, {}, {}, {}]);
    await wait(60_000);
    expect(world.peak).toBe(0);
    expect(t.routes()).toEqual(Array(12).fill('direct'));
    expect(t.reports()).toEqual(Array(12).fill('direct'));
  });

  it('four people who can’t connect directly take one slot a link, not four', async () => {
    const t = table([{ hard: true }, { hard: true }, { hard: true }, { hard: true }]);
    await wait(DIRECT - 100);
    expect(world.peak).toBe(0);
    await wait(10_000);
    expect(slots()).toBe(6);
    expect(world.peak).toBe(6);
    expect(t.routes()).toEqual(Array(12).fill('relayed'));
    // Both ends say so, though only one holds the slot.
    expect(t.reports()).toEqual(Array(12).fill('relayed'));
  });

  it('one person on a hard network costs slots only for their own links', async () => {
    const t = table([{}, { hard: true }, {}, {}]);
    await wait(15_000);
    expect(slots()).toBe(3);
    expect(t.routes().filter((r) => r === 'relayed')).toHaveLength(6);
    expect(t.routes().filter((r) => r === 'direct')).toHaveLength(6);
  });

  it('UDP blocked for the one offering: its slot is over TCP', async () => {
    const t = table([{ udp: false }, {}]);
    await wait(15_000);
    expect(t.pcs(t.people[0]).flatMap((pc) => pc.slots)).toEqual([TCP]);
    expect(slots()).toBe(1);
    expect(t.routes()).toEqual(['relayed', 'relayed']);
  });

  it('UDP blocked for the one answering: it takes a slot over TCP too', async () => {
    const t = table([{}, { udp: false }]);
    await wait(15_000);
    expect(t.pcs(t.people[0]).flatMap((pc) => pc.slots)).toEqual([UDP]);
    expect(t.pcs(t.people[1]).flatMap((pc) => pc.slots)).toEqual([TCP]);
    expect(t.routes()).toEqual(['relayed', 'relayed']);
  });

  it('?relay=1 starts on the relay, from either side', async () => {
    const a = table([{ relayOnly: true }, {}]);
    const b = table([{}, { relayOnly: true }]);
    await wait(2000);
    expect(slots()).toBe(2);
    expect([...a.routes(), ...b.routes()]).toEqual(Array(4).fill('relayed'));
  });

  it('when direct was only slow, the slot is given back', async () => {
    world.directMs = DIRECT + 500;
    const t = table([{}, {}]);
    await wait(DIRECT + 1000);
    expect(slots()).toBe(1);
    world.directMs = 400; // the path is known good now
    await wait(20_000);
    expect(slots()).toBe(0);
    expect(t.routes()).toEqual(['direct', 'direct']);
    expect(t.reports()).toEqual(['direct', 'direct']);
  });

  it('giving a slot back stops after three goes, if direct is always slow', async () => {
    world.directMs = DIRECT + 500;
    const t = table([{}, {}]);
    await wait(300_000);
    // The first two attempts, then three more times round.
    expect(t.people[0].sent.filter((m) => m.t === 'rtc' && 'sdp' in m.data)).toHaveLength(8);
    expect(t.routes()).toEqual(['direct', 'direct']);
  });

  it('leaving gives every slot back', async () => {
    const t = table([{ hard: true }, { hard: true }]);
    await wait(15_000);
    expect(slots()).toBe(1);
    vi.stubGlobal('clearInterval', () => {});
    t.leave();
    expect(slots()).toBe(0);
  });
});

describe('with the live box’s room for slots', () => {
  beforeEach(() => {
    world.cap = LIVE_SLOTS;
  });

  it('ten tables talking directly leave all of it for a pair who need the relay', async () => {
    for (let i = 0; i < 10; i++) table([{}, {}, {}, {}]);
    await wait(10_000);
    expect(slots()).toBe(0);
    const pair = table([{ hard: true }, { hard: true }]);
    await wait(10_000);
    expect(pair.routes()).toEqual(['relayed', 'relayed']);
    expect(world.refused).toBe(0);
  });

  it('three whole tables that all need the relay fit, and a pair besides', async () => {
    const all = [0, 1, 2].map(() => table([{ hard: true }, { hard: true }, { hard: true }, { hard: true }]));
    all.push(table([{ hard: true }, { hard: true }]));
    await wait(20_000);
    expect(slots()).toBe(LIVE_SLOTS);
    expect(world.refused).toBe(0);
    for (const t of all) expect(new Set(t.routes())).toEqual(new Set(['relayed']));
  });

  it('a full relay is said out loud, not left connecting', async () => {
    world.cap = 0;
    const t = table([{ hard: true }, { hard: true }]);
    await wait(answerWaitMs('direct') + 1000);
    expect(t.routes()).toEqual(['failed', 'failed']);
    for (const p of t.people) expect(p.toasts.join()).toContain("Couldn't connect voice");
    expect(t.reports()).toEqual(['failed', 'failed']);
  });
});

describe('when nothing connects', () => {
  it('says so once, holds no slots, and connects by itself when the relay has room', async () => {
    world.cap = 0;
    const t = table([{ hard: true }, { hard: true }]);
    await wait(4 * RETRY_MS);
    for (const p of t.people) expect(p.toasts).toHaveLength(1);
    expect(slots()).toBe(0);
    world.cap = LIVE_SLOTS;
    await wait(2 * RETRY_MS);
    expect(t.routes()).toEqual(['relayed', 'relayed']);
    expect(slots()).toBe(1);
  });
});

describe('links that drop', () => {
  async function up(devices: Partial<Device>[] = [{}, {}]) {
    const t = table(devices);
    await wait(15_000);
    return t;
  }

  it('a short interruption is left to heal by itself', async () => {
    const t = await up();
    const before = t.pcs(t.people[0])[0];
    before.setState('disconnected');
    await wait(3000);
    before.setState('connected');
    await wait(20_000);
    expect(t.pcs(t.people[0])[0]).toBe(before);
  });

  it('a longer one is made again, still without a slot', async () => {
    const t = await up();
    const before = t.pcs(t.people[0])[0];
    before.setState('disconnected');
    before.peer!.setState('disconnected');
    await wait(9000);
    expect(t.pcs(t.people[0])[0]).not.toBe(before);
    expect(t.routes()).toEqual(['direct', 'direct']);
    expect(world.peak).toBe(0);
  });

  it('keeps recovering all evening (it used to stop after two drops)', async () => {
    const t = await up();
    for (let i = 0; i < 8; i++) {
      t.pcs(t.people[0])[0].setState('failed');
      await wait(5000);
      expect(t.routes()).toEqual(['direct', 'direct']);
    }
    expect(t.people.flatMap((p) => p.toasts)).toEqual([]);
  });

  it('moving to a network that needs the relay gets one slot', async () => {
    const t = await up();
    t.people[0].device.hard = true;
    t.pcs(t.people[0])[0].setState('failed');
    await wait(15_000);
    expect(slots()).toBe(1);
    expect(t.routes()).toEqual(['relayed', 'relayed']);
  });

  it('a relayed link that drops takes one slot again, not two', async () => {
    const t = await up([{ hard: true }, { hard: true }]);
    for (let i = 0; i < 4; i++) {
      t.pcs(t.people[0])[0].setState('failed');
      await wait(5000);
    }
    expect(slots()).toBe(1);
    expect(world.peak).toBe(1);
  });
});

describe('signals out of step', () => {
  it('an answer to an attempt already given up on is ignored', async () => {
    let held: Wire | null = null;
    const t = table([{ hard: true }, { hard: true }], (w) => {
      if (!held && 'sdp' in w.m.data && w.m.data.sdp.type === 'answer') {
        held = w;
        return false;
      }
      return true;
    });
    await wait(DIRECT + 5); // the relay attempt's offer is out, unanswered
    const late = held as Wire | null;
    t.deliver(late!.from, late!.m);
    await wait(5000);
    expect(t.routes()).toEqual(['relayed', 'relayed']);
  });

  it('every attempt’s addresses reach that attempt’s connection', async () => {
    const t = table([{ hard: true }, { hard: true }]);
    await wait(15_000);
    for (const p of t.people) {
      const [pc] = t.pcs(p);
      expect(pc.candidates.length).toBeGreaterThan(0);
      for (const c of pc.candidates) expect(c).toContain(` ${pc.peer!.id} `);
    }
  });

  it('an offer from an older page gets every relay route, and its restarts keep one connection', async () => {
    const t = table([{}, {}], (w) => w.from === 'p1');
    const b = t.people[1];
    const offer = { t: 'rtc' as const, to: 'p1', data: { sdp: { type: 'offer' as const, sdp: 'v=0\r\na=pc:old\r\n' } } };
    t.deliver('p0', offer);
    await wait(50);
    const [pc] = t.pcs(b);
    expect(pc.urls).toEqual([STUN, UDP, TCP]);
    t.deliver('p0', offer);
    await wait(50);
    expect(t.pcs(b)).toEqual([pc]);
    const answer = b.sent.find((m) => m.t === 'rtc' && 'sdp' in m.data) as Wire['m'];
    expect('sdp' in answer.data && answer.data.sdp.sdp).not.toContain('x-gd-attempt');
  });

  it('an answer from an older page, with no attempt in it, is taken', async () => {
    const t = table([{}, {}], (w) => {
      if ('sdp' in w.m.data && w.m.data.sdp.type === 'answer') w.m.data.sdp.sdp = readAttempt(w.m.data.sdp.sdp).sdp;
      return true;
    });
    await wait(5000);
    expect(t.routes()).toEqual(['direct', 'direct']);
  });
});

describe('the pieces', () => {
  it('picks the servers for each attempt', () => {
    const urls = (o: Partial<Parameters<typeof serversFor>[1]>) =>
      serversFor(ICE, { step: 'direct', offers: true, udp: true, relayOnly: false, ...o }).flatMap((s) => s.urls);
    expect(urls({})).toEqual([STUN]);
    expect(urls({ udp: false })).toEqual([STUN]);
    expect(urls({ step: 'relay' })).toEqual([STUN, UDP]);
    expect(urls({ step: 'relay', udp: false })).toEqual([STUN, TCP]);
    expect(urls({ step: 'relay', offers: false })).toEqual([STUN]);
    expect(urls({ step: 'relay', offers: false, udp: false })).toEqual([STUN, TCP]);
    expect(urls({ step: 'any' })).toEqual([STUN, UDP, TCP]);
    expect(urls({ relayOnly: true })).toEqual([STUN, UDP]);
    const one = [{ urls: 'turn:only.test:3478' }];
    expect(serversFor(one, { step: 'relay', offers: true, udp: false, relayOnly: false })).toEqual([{ urls: ['turn:only.test:3478'] }]);
    expect(serversFor([{ urls: STUN }], { step: 'relay', offers: true, udp: true, relayOnly: false })).toEqual([{ urls: [STUN] }]);
  });

  it('knows which attempt would have done', () => {
    expect(enoughStep('any', 'here')).toBe('relay');
    expect(enoughStep('any', 'there')).toBe('any');
    expect(enoughStep('any', 'both')).toBe('any');
    expect(enoughStep('any', 'neither')).toBe('direct');
    expect(enoughStep('relay', 'both')).toBe('relay');
    expect(enoughStep('any', null)).toBe('any');
  });

  it('the attempt survives the server (older ones too) and comes out of the description', () => {
    const plain = 'v=0\r\na=rtcp-mux\r\n';
    const sdp = withAttempt(plain, { id: 'k3j9', step: 'relay' });
    const passed = parseClientMessage(JSON.stringify({ t: 'rtc', to: 'x', data: { sdp: { type: 'offer', sdp } } })) as Wire['m'];
    expect(passed.data).toEqual({ sdp: { type: 'offer', sdp } });
    expect(readAttempt(sdp)).toEqual({ attempt: { id: 'k3j9', step: 'relay' }, sdp: plain });
    expect(readAttempt(plain)).toEqual({ attempt: null, sdp: plain });
  });

  it('asks the other end’s codec for mono at 32 kbit/s, however the browser lists it', () => {
    const sdp = (fmtp: string) => `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 109 0\r\na=rtpmap:109 opus/48000/2\r\n${fmtp}a=rtcp-mux\r\n`;
    const asked = 'maxaveragebitrate=32000;stereo=0';
    const firefox = speechBitrate(sdp('a=fmtp:109 maxplaybackrate=48000;stereo=1;useinbandfec=1\r\n'));
    expect(firefox).toBe(sdp(`a=fmtp:109 maxplaybackrate=48000;useinbandfec=1;${asked}\r\n`));
    expect(speechBitrate(firefox)).toBe(firefox);
    expect(speechBitrate(sdp('a=fmtp:109 minptime=10;useinbandfec=1\r\n'))).toBe(sdp(`a=fmtp:109 minptime=10;useinbandfec=1;${asked}\r\n`));
    expect(speechBitrate(sdp(''))).toBe(sdp(`a=fmtp:109 ${asked}\r\n`));
    const other = 'v=0\r\na=rtpmap:0 PCMU/8000\r\n';
    expect(speechBitrate(other)).toBe(other);
  });

  it('reads the route however the browser reports it', () => {
    const stats = (pair: object, remote: string) =>
      new Map<string, object>([
        ['p', { type: 'candidate-pair', id: 'p', localCandidateId: 'l', remoteCandidateId: 'r', ...pair }],
        ['l', { id: 'l', candidateType: 'srflx' }],
        ['r', { id: 'r', candidateType: remote }],
      ]) as unknown as RTCStatsReport;
    expect(relayEnds(stats({ selected: true }, 'relay'))).toBe('there'); // Firefox
    expect(relayEnds(stats({ nominated: true, state: 'succeeded' }, 'host'))).toBe('neither');
    expect(relayEnds(stats({}, 'relay'))).toBe(null);
  });
});

describe('the mic itself', () => {
  class Track {
    enabled = true;
    readyState = 'live';
    onended: (() => void) | null = null;
    stop() {
      this.readyState = 'ended';
    }
    /** The browser ends it: unplugged, or taken. */
    end() {
      this.readyState = 'ended';
      this.onended?.();
    }
  }
  class Stream {
    track = new Track();
    getTracks() {
      return [this.track];
    }
    getAudioTracks() {
      return [this.track];
    }
  }
  const node = () => ({ connect: (x: unknown) => x, disconnect() {}, fftSize: 512, getFloatTimeDomainData() {}, gain: { value: 0, setTargetAtTime() {} } });
  let asked: Stream[];
  let refuse: boolean;
  let resumeHangs: boolean;
  let out: Stream;
  let doc: { visibilityState: string; onVisibility?: () => void };

  beforeEach(() => {
    asked = [];
    refuse = false;
    resumeHangs = false;
    doc = { visibilityState: 'visible' };
    class Ctx {
      state = 'running';
      currentTime = 0;
      resume = () => (resumeHangs ? new Promise<void>(() => {}) : Promise.resolve());
      close = async () => void (this.state = 'closed');
      createMediaStreamSource = node;
      createAnalyser = node;
      createGain = node;
      createMediaStreamDestination = () => ({ stream: (out = new Stream()) });
    }
    vi.stubGlobal('window', { isSecureContext: true, AudioContext: Ctx, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), setInterval: (f: () => void, ms: number) => setInterval(f, ms) });
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('document', {
      get visibilityState() {
        return doc.visibilityState;
      },
      addEventListener: (type: string, f: () => void) => void (type === 'visibilitychange' && (doc.onVisibility = f)),
      removeEventListener: () => {},
    });
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => {
          if (refuse) throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
          const s = new Stream();
          asked.push(s);
          return s;
        },
      },
    });
  });

  function make() {
    const toasts: string[] = [];
    const sent: ClientMessage[] = [];
    let help = 0;
    const v = new Voice('me', { enabled: true, iceServers: [] }, { send: (m) => sent.push(m), toast: (t) => toasts.push(t), micHelp: () => help++, changed: () => {}, speaking: () => {} });
    return { v, toasts, sent, helpShown: () => help };
  }
  const pending = () => {
    let allow!: (s: Stream) => void;
    const stream = new Promise<Stream>((r) => (allow = r)) as unknown as Promise<MediaStream>;
    return { stream, allow };
  };

  it('comes back muted after a reload, and a tap on Turn on mic is never muted', async () => {
    const { v } = make();
    await v.join({ auto: true, muted: true });
    expect([v.inVoice, v.selfMuted, out.track.enabled]).toEqual([true, true, false]);
    v.leave();
    expect(v.micOn).toBe(false);
    await v.join();
    expect([v.selfMuted, out.track.enabled]).toEqual([false, true]);
    v.teardown();
  });

  it('counts as on while the browser is still asking, muted or not as it was', async () => {
    const { v } = make();
    const { stream, allow } = pending();
    const joining = v.join({ stream, muted: true });
    expect([v.micOn, v.selfMuted]).toEqual([true, true]);
    allow(new Stream());
    await joining;
    v.teardown();
  });

  it('leaving while the browser is still asking lets go of the mic when Allow comes', async () => {
    const { v, toasts, sent } = make();
    const { stream, allow } = pending();
    const joining = v.join({ stream });
    v.teardown();
    const mic = new Stream();
    allow(mic);
    await joining;
    expect([v.inVoice, v.micOn, mic.track.readyState]).toEqual([false, false, 'ended']);
    expect([toasts, sent]).toEqual([[], []]);
  });

  it('leaving while a stopped mic is being opened again lets go of the new one', async () => {
    const { v, toasts } = make();
    await v.join();
    const { stream, allow } = pending();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => stream } });
    asked[0].track.end();
    v.teardown();
    const late = new Stream();
    allow(late);
    await wait(1);
    expect(late.track.readyState).toBe('ended');
    expect(toasts).toEqual(['Your mic is on.']);
  });

  it('a mic that stops is opened again by itself', async () => {
    const { v } = make();
    await v.join();
    asked[0].track.end();
    await wait(1);
    expect(asked).toHaveLength(2);
    expect([asked[1].track.readyState, v.selfMuted, out.track.enabled]).toEqual(['live', false, true]);
    v.teardown();
  });

  it('a mic that can’t be opened again shows as muted, and one tap on Unmute mic tries again', async () => {
    const { v, toasts } = make();
    await v.join();
    refuse = true;
    asked[0].track.end();
    await wait(1);
    expect([v.selfMuted, out.track.enabled]).toEqual([true, false]);
    expect(toasts.at(-1)).toContain('tap Unmute mic');
    refuse = false;
    v.setSelfMuted(false);
    await wait(1);
    expect(asked).toHaveLength(2);
    expect([v.selfMuted, out.track.enabled]).toEqual([false, true]);
    v.teardown();
  });

  it('a mic that keeps stopping isn’t opened over and over', async () => {
    const { v } = make();
    await v.join();
    asked[0].track.end();
    await wait(1);
    asked[1].track.end();
    await wait(1);
    expect([asked.length, v.selfMuted]).toEqual([2, true]);
    v.teardown();
  });

  it('one that stops while the page is hidden waits until it’s back, and stays muted if it was', async () => {
    const { v } = make();
    await v.join();
    v.setSelfMuted(true);
    doc.visibilityState = 'hidden';
    doc.onVisibility!();
    asked[0].track.end();
    await wait(1);
    expect(asked).toHaveLength(1);
    doc.visibilityState = 'visible';
    doc.onVisibility!();
    await wait(1);
    expect(asked).toHaveLength(2);
    expect([v.selfMuted, out.track.enabled]).toEqual([true, false]);
    v.teardown();
  });

  it('sound that won’t start until a tap doesn’t leave Turn on mic dead', async () => {
    resumeHangs = true;
    const { v } = make();
    void v.join();
    await wait(1100);
    expect(v.inVoice).toBe(true);
    v.teardown();
  });

  it('Turn on mic with the mic blocked shows how to allow it, every time', async () => {
    const { v, helpShown } = make();
    refuse = true;
    v.turnOn();
    await wait(1);
    expect([v.micProblem, helpShown()]).toEqual(['blocked', 0]);
    v.turnOn();
    v.turnOn();
    expect(helpShown()).toBe(2);
  });

  it('says what to do in words for players, never developer steps', () => {
    expect(micUnsupportedText()).toContain('Safari or Chrome');
    vi.stubGlobal('window', { isSecureContext: false });
    expect(micUnsupportedText()).toContain('https');
    expect(micUnsupportedText()).not.toMatch(/npm|dev:/);
  });
});

describe('who’s talking', () => {
  it('stays talking through a short pause between words, and stops soon after', () => {
    const said: string[][] = [];
    const v = new Voice('me', { enabled: true, iceServers: [] }, { send: () => {}, toast: () => {}, micHelp: () => {}, changed: () => {}, speaking: (s) => said.push([...s].sort()) });
    // Just enough of a running call for the meter: levels by analyser.
    const levels: Record<string, number> = { mic: 0, bob: 0 };
    const inner = v as unknown as { ctx: unknown; gate: unknown; micAnalyser: unknown; links: Map<string, unknown>; level(a: string): number; tick(): void };
    inner.ctx = { currentTime: 0 };
    inner.gate = { gain: { setTargetAtTime() {} } };
    inner.micAnalyser = 'mic';
    inner.links.set('bob', { analyser: 'bob' });
    inner.level = (a) => levels[a];
    let now = 1000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const tick = (ms: number) => {
      now += ms;
      inner.tick();
    };
    levels.bob = 0.1;
    tick(60);
    expect(said).toEqual([['bob']]);
    // A pause between words: still talking, so the rings round the name carry on.
    levels.bob = 0;
    tick(60);
    tick(250);
    levels.bob = 0.1;
    tick(60);
    expect(said).toEqual([['bob']]);
    // Done talking: the rings stop well under a second later.
    levels.bob = 0;
    for (let i = 0; i < 8; i++) tick(60);
    expect(said).toEqual([['bob'], []]);
    // Your own voice too, but never while you're muted.
    levels.mic = 0.1;
    tick(60);
    expect(said.at(-1)).toEqual(['me']);
    v.selfMuted = true;
    tick(60);
    expect(said.at(-1)).toEqual([]);
    clock.mockRestore();
  });
});
