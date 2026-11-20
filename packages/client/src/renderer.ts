import { barrelTip, HELI_TANK_OFFSET, levelsForKill, spreadReady, spreadSize, TANK_COLORS, type GameConfig } from '@tank/shared';
import type { Camera } from './camera';
import type { Sprites } from './sprites';
import { colorCss, type ClientTank, type Effect, type GameState } from './state';

const DEG = Math.PI / 180;

/** Turret sprite pivot (dome centre, on the barrel's axis) in sprite pixels (scripts/felt-sprites.cjs prints it). */
const TURRET_PIVOT = { x: 61, y: 29 };

export interface LocalAim {
  angle: number;
  power: number;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private far: HTMLCanvasElement;
  private near: HTMLCanvasElement;
  private clouds: { x: number; y: number; s: number; v: number }[] = [];
  private lastNow = performance.now();

  constructor(
    private canvas: HTMLCanvasElement,
    private sprites: Sprites,
    private cfg: GameConfig,
  ) {
    this.ctx = canvas.getContext('2d')!;
    // Felt mountains behind the battlefield, in slate blues: pale far away, deeper nearer.
    this.far = mountains(cfg.worldWidth * 1.3, 520, 3, sprites.paper.mist, 'rgba(255, 255, 255, 0.08)', 0.55);
    this.near = mountains(cfg.worldWidth * 1.15, 460, 9, sprites.paper.slate, null, 0.7);
    // The sky's pattern comes from a canvas copy of the felt, never the <img> itself: an image
    // pattern next to the canvases drawn each frame (hills, terrain, tanks) makes Chrome draw the
    // whole battlefield on the CPU, which stuttered badly on big screens (2026-11-21: 21 fps at
    // 1440x900 @2x, 104 fps with the copy).
    this.skyPattern = this.ctx.createPattern(canvasCopy(sprites.paper.air), 'repeat');
    for (let i = 0; i < 7; i++) {
      this.clouds.push({ x: Math.random() * cfg.worldWidth, y: 60 + Math.random() * 220, s: 0.6 + Math.random() * 0.8, v: 0.6 + Math.random() * 0.6 });
    }
  }

  private skyPattern: CanvasPattern | null;

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
  }

  get viewW() {
    return this.canvas.width / this.dpr;
  }
  get viewH() {
    return this.canvas.height / this.dpr;
  }

  draw(g: GameState, cam: Camera, aim: LocalAim, now: number) {
    const dt = Math.min(100, now - this.lastNow);
    this.lastNow = now;
    const ctx = this.ctx;
    const cfg = this.cfg;
    const vw = this.viewW;
    const vh = this.viewH;
    const S = cam.scale;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Sky: a sheet of muted blue felt (shown at half its pixels, like the page's felt), washed a touch lighter.
    ctx.fillStyle = '#a3bfd9';
    ctx.fillRect(0, 0, vw, vh);
    if (this.skyPattern) {
      this.skyPattern.setTransform(new DOMMatrix([0.5, 0, 0, 0.5, 0, 0]));
      ctx.fillStyle = this.skyPattern;
      ctx.fillRect(0, 0, vw, vh);
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(0, 0, vw, vh);

    // World transform
    // Screen shake while a nuke goes off.
    const nuke = g.effects.find((e) => e.kind === 'nuke');
    let shakeX = 0;
    let shakeY = 0;
    if (nuke) {
      const t = (now - nuke.t0) / nuke.dur;
      const amp = 14 * Math.max(0, 1 - t) * Math.min(1, t * 6);
      shakeX = (Math.random() * 2 - 1) * amp;
      shakeY = (Math.random() * 2 - 1) * amp;
    }
    const world = () =>
      ctx.setTransform(this.dpr * S, 0, 0, this.dpr * S, (-cam.x * S + shakeX) * this.dpr, (-cam.y * S + shakeY) * this.dpr);
    world();

    // Paper clouds drift with the wind (the smoke puff, at the old sprite's size).
    for (const c of this.clouds) {
      c.x += (g.wind * 1.5 + 4) * c.v * (dt / 1000);
      if (c.x > cfg.worldWidth + 150) c.x = -150;
      if (c.x < -150) c.x = cfg.worldWidth + 150;
      const img = this.sprites.img.smoke;
      ctx.drawImage(img, c.x, c.y, img.width * 0.5 * c.s * 1.6, img.height * 0.5 * c.s);
    }

    // Parallax mountains
    const W = cfg.worldWidth;
    // Layers are rendered at half resolution, so draw them at 2x.
    ctx.drawImage(this.far, cam.x * 0.45 - W * 0.15, cfg.worldHeight * 0.16, this.far.width * 2, this.far.height * 2);
    ctx.drawImage(this.near, cam.x * 0.25 - W * 0.07, cfg.worldHeight * 0.3, this.near.width * 2, this.near.height * 2);

    // Terrain
    ctx.imageSmoothingEnabled = S < 1;
    ctx.drawImage(g.terrainView.canvas, 0, 0);
    // Past the map edges (seen when zoomed in near an edge, or on short, wide screens) the hills
    // carry on as a mirror of the map, faded into the sky so they read as out of bounds.
    const W2 = cfg.worldWidth;
    const H2 = cfg.worldHeight;
    const pastLeft = cam.x < 0;
    const pastRight = cam.x + this.viewW / S > W2;
    if (pastLeft || pastRight) {
      const tv = g.terrainView.canvas;
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.scale(-1, 1);
      if (pastLeft) ctx.drawImage(tv, 0, 0); // mirrored: x from -W2 to 0
      if (pastRight) ctx.drawImage(tv, -2 * W2, 0); // mirrored: x from W2 to 2 * W2
      ctx.restore();
    }
    if (cam.y + this.viewH / S > H2) {
      // Below the map: the deepest ground (charcoal felt) carries on, faded past the sides too.
      ctx.fillStyle = '#3e3d43';
      ctx.fillRect(0, H2, W2, 3000);
      ctx.globalAlpha = 0.55;
      ctx.fillRect(-W2, H2, W2, 3000);
      ctx.fillRect(W2, H2, W2, 3000);
      ctx.globalAlpha = 1;
    }
    ctx.imageSmoothingEnabled = true;


    // Helicopters
    for (const h of g.helis.values()) {
      const img = this.sprites.img.helicopter;
      const w = 62;
      const hh = (img.height / img.width) * w;
      ctx.save();
      ctx.translate(h.x, h.y);
      if (h.dir < 0) ctx.scale(-1, 1);
      // Rotor wobble
      ctx.rotate(Math.sin(now / 90) * 0.03);
      ctx.drawImage(img, -w / 2, -hh / 2, w, hh);
      ctx.restore();
    }

    // Tanks
    for (const t of g.tanks.values()) this.drawTank(g, t, now, t.info.id === g.myTankId ? aim : null);

    // Pending death blasts
    for (const b of g.blastWarnings) {
      const k = Math.min(1, (g.renderTick - b.from) / Math.max(1, b.at - b.from));
      ctx.strokeStyle = `rgba(255, 70, 50, ${0.4 + 0.5 * Math.abs(Math.sin(now / 70))})`;
      ctx.lineWidth = 3 / S;
      ctx.beginPath();
      ctx.arc(b.x, b.y - 8, cfg.deathBlastRadius * (0.3 + 0.7 * k), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 80, 40, 0.12)';
      ctx.fill();
    }

    // Shells
    for (const sh of g.shells.values()) {
      const p = g.shellRenderPos(sh);
      if (sh.trail.length > 1) {
        ctx.lineCap = 'round';
        for (let i = 1; i < sh.trail.length; i++) {
          const a = sh.trail[i - 1];
          const b = sh.trail[i];
          ctx.strokeStyle = `rgba(239, 89, 67, ${(i / sh.trail.length) * 0.6})`;
          ctx.lineWidth = (1 + (i / sh.trail.length) * 2.5) / Math.max(0.6, S);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      const img = this.sprites.img.shell;
      const len = 12 / Math.min(1, Math.max(0.6, S));
      const h = (img.height / img.width) * len;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(sh.s.vy, sh.s.vx));
      ctx.drawImage(img, -len / 2, -h / 2, len, h);
      ctx.restore();
    }

    // Effects
    for (const e of g.effects) {
      const t = (now - e.t0) / e.dur;
      switch (e.kind) {
        case 'explosion': {
          const img = this.sprites.img.explosion;
          const grow = Math.min(1, t / 0.25);
          const size = e.r * (0.8 + 1.6 * grow) * (e.big ? 1.3 : 1);
          ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - 0.35) / 0.65);
          ctx.fillStyle = 'rgba(255, 210, 90, 0.35)';
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r * (0.6 + grow * 0.5), 0, Math.PI * 2);
          ctx.fill();
          ctx.save();
          ctx.translate(e.x, e.y);
          ctx.rotate(t * 0.6);
          ctx.drawImage(img, -size / 2, -size / 2, size, size);
          ctx.restore();
          ctx.globalAlpha = 1;
          break;
        }
        case 'muzzle': {
          const img = this.sprites.img.explosion;
          ctx.globalAlpha = 1 - t;
          const size = 14 * (1 - t * 0.4);
          ctx.drawImage(img, e.x - size / 2, e.y - size / 2, size, size);
          ctx.globalAlpha = 1;
          break;
        }
        case 'smoke': {
          const img = this.sprites.img.smoke;
          const size = 26 + 40 * t;
          ctx.globalAlpha = 0.55 * (1 - t);
          ctx.drawImage(img, e.x - size / 2 + e.drift * t * 2, e.y - size / 2 - 40 * t, size, size * 0.83);
          ctx.globalAlpha = 1;
          break;
        }
        case 'debris': {
          const secs = (now - e.t0) / 1000;
          ctx.globalAlpha = 1 - t * t;
          for (const p of e.parts) {
            const x = p.x + p.vx * secs;
            const y = p.y + p.vy * secs + 0.5 * 900 * secs * secs;
            ctx.fillStyle = p.c;
            ctx.fillRect(x - p.s / 2, y - p.s / 2, p.s, p.s);
          }
          ctx.globalAlpha = 1;
          break;
        }
        case 'shield': {
          const tank = g.tanks.get(e.tank);
          if (!tank) break;
          ctx.strokeStyle = `rgba(16, 61, 182, ${0.8 * (1 - t)})`;
          ctx.lineWidth = 4 / S;
          ctx.beginPath();
          ctx.arc(tank.x, tank.y - 12, 28 + t * 10, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'heliWreck': {
          const secs = (now - e.t0) / 1000;
          const img = this.sprites.img.helicopter;
          const x = e.x + e.vx * secs;
          const y = e.y + e.vy * secs + 0.5 * 700 * secs * secs;
          ctx.save();
          ctx.globalAlpha = 1 - t * t;
          ctx.translate(x, y);
          ctx.rotate(secs * 4);
          ctx.filter = 'brightness(0.5)';
          ctx.drawImage(img, -31, -18, 62, 36);
          ctx.filter = 'none';
          ctx.restore();
          break;
        }
        default:
          break;
      }
    }

    // ---------------------------------------------------------------- screen space
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const labelSize = Math.round(Math.max(12, Math.min(16, 15 * Math.sqrt(S))));
    ctx.font = `800 ${labelSize}px 'Atkinson Hyperlegible Next', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    // Work out every label first, then nudge overlapping ones upward so tanks parked close
    // together don't print their numbers on top of each other.
    type Label = { t: ClientTank; x: number; y: number; label: string; tag: string; lw: number; tw: number };
    const labels: Label[] = [];
    for (const t of g.tanks.values()) {
      if (t.phase === 'dead') continue;
      // Carried tanks hang under the helicopter, so their label goes above it.
      const labelOffset = t.phase === 'chute' ? 78 : t.phase === 'carried' ? HELI_TANK_OFFSET + 26 : 34;
      const p = cam.toScreen({ x: t.x, y: t.y - labelOffset });
      const onScreen = p.x > -20 && p.x < vw + 20 && p.y > -20 && p.y < vh + 20;
      if (!onScreen) {
        this.drawOffscreen(t, p, vw, vh);
        continue;
      }
      // The level; "away" when they've dropped out. (Talking shows as bars beside it.)
      const label = `${t.info.level}${t.info.away ? ' away' : ''}`;
      // Bounty: a gold "+N" when killing this tank is worth more than one level.
      const bounty = levelsForKill(cfg, t.info.kills);
      const tag = bounty > 1 ? ` +${bounty}` : '';
      labels.push({ t, x: p.x, y: p.y, label, tag, lw: ctx.measureText(label).width, tw: tag ? ctx.measureText(tag).width : 0 });
    }
    labels.sort((a, b) => b.y - a.y || a.x - b.x);
    const placed: Label[] = [];
    for (const l of labels) {
      for (let guard = 0; guard < 8; guard++) {
        const hit = placed.find((o) => Math.abs(o.x - l.x) < (o.lw + o.tw + l.lw + l.tw) / 2 + 4 && Math.abs(o.y - l.y) < labelSize + 2);
        if (!hit) break;
        l.y = hit.y - labelSize - 3;
      }
      placed.push(l);
    }
    ctx.lineJoin = 'round';
    for (const { t, x, y, label, tag, lw, tw } of placed) {
      const p = { x, y };
      const lx = p.x - tw / 2;
      // Ink on a paper-coloured edge: readable on the sky and on the hills.
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255, 252, 245, 0.95)';
      ctx.strokeText(label, lx, p.y);
      ctx.fillStyle = '#112875';
      ctx.fillText(label, lx, p.y);
      if (tag) {
        // Bounty: ink on a sunflower edge.
        ctx.textAlign = 'left';
        ctx.lineWidth = 5;
        ctx.strokeStyle = '#ffcb2d';
        ctx.strokeText(tag, lx + lw / 2, p.y);
        ctx.fillStyle = '#112875';
        ctx.fillText(tag, lx + lw / 2, p.y);
        ctx.textAlign = 'center';
      }
      if (g.speaking.has(t.info.id)) {
        // Talking: three small cobalt bars to the left of the label.
        const bx = lx - lw / 2 - 12;
        for (let i = 0; i < 3; i++) {
          const h = 5 + 6 * Math.abs(Math.sin(now / 140 + i * 1.3));
          ctx.fillStyle = 'rgba(255, 252, 245, 0.95)';
          ctx.fillRect(bx + i * 4 - 1, p.y - labelSize * 0.4 - h / 2 - 1, 4, h + 2);
          ctx.fillStyle = '#103db6';
          ctx.fillRect(bx + i * 4, p.y - labelSize * 0.4 - h / 2, 2.5, h);
        }
      }
      if (t.info.id === g.myTankId) {
        // Your tank: a cobalt chevron on a paper edge (doesn't rely on the tank's colour).
        const cy = p.y - labelSize - 4 + Math.sin(now / 220) * 2;
        ctx.beginPath();
        ctx.moveTo(p.x - 8, cy - 5);
        ctx.lineTo(p.x, cy + 3);
        ctx.lineTo(p.x + 8, cy - 5);
        ctx.lineWidth = 7;
        ctx.strokeStyle = 'rgba(255, 252, 245, 0.95)';
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = '#103db6';
        ctx.stroke();
      }
    }

    // Shells lobbed above the top of the screen: a small marker at the top edge where they are.
    for (const sh of g.shells.values()) {
      const p = cam.toScreen(g.shellRenderPos(sh));
      if (p.y >= -4 || p.x < 0 || p.x > vw) continue;
      const owner = g.tanks.get(sh.owner);
      ctx.fillStyle = owner ? colorCss(owner.info.color) : '#ffb347';
      ctx.strokeStyle = 'rgba(20, 16, 50, 0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x, 16);
      ctx.lineTo(p.x - 6, 5);
      ctx.lineTo(p.x + 6, 5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    for (const e of g.effects) {
      if (e.kind !== 'float') continue;
      const t = (now - e.t0) / e.dur;
      const p = cam.toScreen({ x: e.x, y: e.y });
      ctx.globalAlpha = 1 - t * t;
      ctx.font = `800 18px 'Atkinson Hyperlegible Next', system-ui, sans-serif`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(17, 40, 117, 0.85)';
      ctx.strokeText(e.text, p.x, p.y - 30 * t);
      ctx.fillStyle = e.color;
      ctx.fillText(e.text, p.x, p.y - 30 * t);
      ctx.globalAlpha = 1;
    }
    for (const e of g.effects) {
      if (e.kind !== 'flash') continue;
      const t = (now - e.t0) / e.dur;
      ctx.fillStyle = `rgba(255, 250, 230, ${1 - t})`;
      ctx.fillRect(0, 0, vw, vh);
    }
    if (nuke) this.drawNuke(nuke, now, vw, vh);
  }

  /** The whole screen explodes, then whites out while the new battlefield swaps in. */
  private drawNuke(e: Extract<Effect, { kind: 'nuke' }>, now: number, vw: number, vh: number) {
    const ctx = this.ctx;
    const t = (now - e.t0) / e.dur;
    const img = this.sprites.img.explosion;
    const span = Math.max(vw, vh);
    // Orange glow building up behind the blasts.
    ctx.fillStyle = `rgba(255, 120, 30, ${0.35 * Math.min(1, t / 0.3) * Math.max(0, 1 - t)})`;
    ctx.fillRect(0, 0, vw, vh);
    for (const b of e.blasts) {
      const bt = (t - b.delay) / 0.2;
      if (bt < 0 || bt > 1) continue;
      const size = span * b.size * (0.4 + bt * 0.9);
      ctx.globalAlpha = Math.min(1, (1 - bt) * 1.6);
      ctx.save();
      ctx.translate(b.x * vw, b.y * vh);
      ctx.rotate(b.delay * 20 + bt);
      ctx.drawImage(img, -size / 2, -size / 2, size, size);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    // White-out peaks as the server swaps in the new terrain (about 45% through), then fades.
    const white = t < 0.3 ? 0 : t < 0.45 ? (t - 0.3) / 0.15 : Math.max(0, 1 - (t - 0.45) / 0.55);
    if (white > 0) {
      ctx.fillStyle = `rgba(255, 250, 235, ${white})`;
      ctx.fillRect(0, 0, vw, vh);
    }
  }

  private drawOffscreen(t: ClientTank, p: { x: number; y: number }, vw: number, vh: number) {
    const ctx = this.ctx;
    const m = 18;
    const x = Math.max(m, Math.min(vw - m, p.x));
    const y = Math.max(m + 40, Math.min(vh - m, p.y));
    const a = Math.atan2(p.y - y, p.x - x);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = TANK_COLORS[t.info.color]?.css ?? '#fff';
    ctx.strokeStyle = 'rgba(20, 16, 50, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(-6, -8);
    ctx.lineTo(-6, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawTank(g: GameState, t: ClientTank, now: number, aim: LocalAim | null) {
    if (t.phase === 'dead') return;
    const ctx = this.ctx;
    const cfg = this.cfg;
    const S = this.ctx.getTransform().a / this.dpr;
    const body = this.sprites.bodies[t.info.color] ?? this.sprites.bodies[0];
    const turret = this.sprites.turrets[t.info.color] ?? this.sprites.turrets[0];
    const k = cfg.tankWidth / body.width;
    const bodyH = body.height * k;
    const angle = aim ? aim.angle : t.angle;
    const isMe = !!aim;

    // Helicopter rope
    if (t.phase === 'carried') {
      // An earlier, empty helicopter for this tank may still be flying off-screen.
      const h = [...g.helis.values()].find((x) => x.tankId === t.info.id && x.carrying);
      if (h) {
        ctx.strokeStyle = 'rgba(30, 30, 50, 0.8)';
        ctx.lineWidth = 1.5 / S;
        ctx.beginPath();
        ctx.moveTo(h.x - 6, h.y + 14);
        ctx.lineTo(t.x - 10, t.y - bodyH);
        ctx.moveTo(h.x + 6, h.y + 14);
        ctx.lineTo(t.x + 10, t.y - bodyH);
        ctx.stroke();
      }
    }
    // Parachute
    if (t.phase === 'chute') {
      const img = this.sprites.img.parachute;
      const w = 46;
      const h = (img.height / img.width) * w;
      ctx.save();
      ctx.translate(t.x, t.y - bodyH - 4);
      ctx.rotate(Math.sin(now / 300 + t.info.id) * 0.08);
      ctx.drawImage(img, -w / 2, -h, w, h);
      ctx.restore();
    }

    // Local tank: soft ground glow so it stands out without relying on colour.
    if (isMe) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.beginPath();
      ctx.ellipse(t.x, t.y - 2, 26, 7, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Turret first so the body covers the dome base.
    const pivotLocal = { x: 0, y: -cfg.turretPivotHeight };
    const px = t.x + pivotLocal.x * Math.cos(t.tilt) - pivotLocal.y * Math.sin(t.tilt);
    const py = t.y + pivotLocal.x * Math.sin(t.tilt) + pivotLocal.y * Math.cos(t.tilt);
    ctx.save();
    ctx.translate(px, py);
    if (angle > 90) {
      ctx.scale(-1, 1);
      ctx.rotate(-(180 - angle) * DEG);
    } else {
      ctx.rotate(-angle * DEG);
    }
    ctx.drawImage(turret, -TURRET_PIVOT.x * k, -TURRET_PIVOT.y * k, turret.width * k, turret.height * k);
    ctx.restore();

    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.tilt);
    ctx.drawImage(body, -cfg.tankWidth / 2, -bodyH, cfg.tankWidth, bodyH);
    ctx.restore();

    // Spawn protection bubble
    // (Carried and parachuting tanks are protected too; the helicopter and chute signal that.)
    if (t.info.protectedUntil > g.renderTick && (t.phase === 'ground' || t.phase === 'slide' || t.phase === 'air')) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 200);
      // A cobalt bubble (the old pale cyan disappeared against the paper sky).
      ctx.strokeStyle = `rgba(16, 61, 182, ${0.35 + 0.3 * pulse})`;
      ctx.fillStyle = 'rgba(16, 61, 182, 0.08)';
      ctx.lineWidth = 2.5 / S;
      ctx.beginPath();
      ctx.arc(t.x, t.y - 13, 27, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Spread ready: a glowing pip per shell (3 or 5) fanned at the barrel tip.
    if (spreadReady(t.info) && (t.phase === 'ground' || t.phase === 'slide')) {
      const tip = barrelTip(cfg, t.x, t.y, angle);
      const n = spreadSize(t.info.level);
      for (let k = 0; k < n; k++) {
        const i = k - (n - 1) / 2;
        const a = (angle + i * 14) * DEG;
        ctx.fillStyle = `rgba(255, 200, 40, ${0.7 + 0.3 * Math.sin(now / 120 + i)})`;
        ctx.beginPath();
        ctx.arc(tip.x + Math.cos(a) * 6, tip.y - Math.sin(a) * 6, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Aim guide for your own tank.
    if (aim && (t.phase === 'ground' || t.phase === 'slide') && t.info.shellsInFlight === 0) {
      const tip = barrelTip(cfg, t.x, t.y, angle);
      // Sized in screen pixels (about 40-110 px) so it stays readable when zoomed out.
      const len = (40 + aim.power * 0.7) / S;
      const dx = Math.cos(angle * DEG);
      const dy = -Math.sin(angle * DEG);
      ctx.setLineDash([4 / S, 5 / S]);
      ctx.strokeStyle = 'rgba(17, 40, 117, 0.7)';
      ctx.lineWidth = 2 / S;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x + dx * len, tip.y + dy * len);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

/**
 * A felt mountain line behind the battlefield, generated once: soft, rounded peaks cut from a
 * sheet of felt (optionally washed lighter for distance), its top edge catching a little light,
 * and a soft warm shadow so it sits in front of what's behind it.
 */
function mountains(width: number, height: number, seed: number, paper: HTMLImageElement, wash: string | null, roughness: number) {
  const c = document.createElement('canvas');
  c.width = Math.round(width / 2);
  // The paper carries on well below the hill line, so the ground never dips below its bottom.
  const bottom = height + 900;
  c.height = Math.round(bottom / 2);
  const ctx = c.getContext('2d')!;
  ctx.scale(0.5, 0.5);
  const pts: number[] = [];
  let r = seed * 9301 + 49297;
  const rand = () => {
    r = (r * 9301 + 49297) % 233280;
    return r / 233280;
  };
  const n = 34;
  const peaks: number[] = [];
  for (let i = 0; i <= n; i++) peaks.push(rand());
  for (let x = 0; x <= width; x += 6) {
    const f = (x / width) * n;
    const i = Math.floor(f);
    const t = f - i;
    const s = t * t * (3 - 2 * t);
    const v = peaks[i] + (peaks[Math.min(n, i + 1)] - peaks[i]) * s;
    const ridge = Math.abs(Math.sin(x * 0.004 + seed)) * 0.35;
    // Cut felt: the edge wanders very slightly, it isn't ragged.
    const tear = (rand() - 0.5) * 1.5;
    pts.push(height * (0.15 + (1 - v * roughness - ridge * 0.6) * 0.55) + tear);
  }
  const shape = () => {
    ctx.beginPath();
    ctx.moveTo(0, bottom);
    pts.forEach((y, i) => ctx.lineTo(i * 6, y));
    ctx.lineTo(width, bottom);
    ctx.closePath();
  };
  // Paper: the sheet drawn at its own scale (this canvas is half size, drawn back at 2x).
  const pattern = ctx.createPattern(paper, 'repeat');
  shape();
  ctx.save();
  ctx.shadowColor = 'rgba(34, 26, 18, 0.3)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = -2;
  ctx.fillStyle = pattern ?? '#8ea6c0';
  ctx.fill();
  ctx.restore();
  if (wash) {
    shape();
    ctx.fillStyle = wash;
    ctx.fill();
  }
  // The felt's top edge catches a little light.
  ctx.beginPath();
  pts.forEach((y, i) => (i ? ctx.lineTo(i * 6, y + 2) : ctx.moveTo(0, y + 2)));
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
  return c;
}

/** A canvas copy of an image (patterns made from canvases keep the battlefield drawn on the GPU). */
function canvasCopy(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c;
}
