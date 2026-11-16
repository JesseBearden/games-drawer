import { barrelTip, hasMarker, spreadReady, TANK_COLORS, type GameConfig } from '@tank/shared';
import type { Camera } from './camera';
import type { Sprites } from './sprites';
import { colorCss, type ClientTank, type GameState } from './state';

const DEG = Math.PI / 180;

/** Turret sprite pivot (dome centre, on the barrel's axis) in sprite pixels. */
const TURRET_PIVOT = { x: 32, y: 24 };

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
    this.far = mountains(cfg.worldWidth * 1.3, 520, 3, ['#4d5fd6', '#5466da'], 0.55);
    this.near = mountains(cfg.worldWidth * 1.15, 460, 9, ['#3d4dc4', '#4555c9'], 0.7);
    for (let i = 0; i < 7; i++) {
      this.clouds.push({ x: Math.random() * cfg.worldWidth, y: 60 + Math.random() * 220, s: 0.6 + Math.random() * 0.8, v: 0.6 + Math.random() * 0.6 });
    }
  }

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
    // Sky
    const sky = ctx.createLinearGradient(0, 0, 0, vh);
    sky.addColorStop(0, '#2a55e6');
    sky.addColorStop(0.55, '#4f6ae6');
    sky.addColorStop(1, '#7a6fe0');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, vw, vh);

    // World transform
    const world = () => ctx.setTransform(this.dpr * S, 0, 0, this.dpr * S, -cam.x * S * this.dpr, -cam.y * S * this.dpr);
    world();

    // Clouds drift with the wind.
    ctx.globalAlpha = 0.18;
    for (const c of this.clouds) {
      c.x += (g.wind * 1.5 + 4) * c.v * (dt / 1000);
      if (c.x > cfg.worldWidth + 150) c.x = -150;
      if (c.x < -150) c.x = cfg.worldWidth + 150;
      const img = this.sprites.img.smoke;
      ctx.drawImage(img, c.x, c.y, img.width * c.s * 1.6, img.height * c.s);
    }
    ctx.globalAlpha = 1;

    // Parallax mountains
    const W = cfg.worldWidth;
    // Layers are rendered at half resolution, so draw them at 2x.
    ctx.drawImage(this.far, cam.x * 0.45 - W * 0.15, cfg.worldHeight * 0.16, this.far.width * 2, this.far.height * 2);
    ctx.drawImage(this.near, cam.x * 0.25 - W * 0.07, cfg.worldHeight * 0.3, this.near.width * 2, this.near.height * 2);

    // Terrain
    ctx.imageSmoothingEnabled = S < 1;
    ctx.drawImage(g.terrainView.canvas, 0, 0);
    ctx.imageSmoothingEnabled = true;

    const me = g.me;
    // Last shot marker (level 20 perk)
    if (me && hasMarker(me.info.level) && me.info.lastImpact) {
      const p = me.info.lastImpact;
      ctx.strokeStyle = colorCss(me.info.color);
      ctx.lineWidth = 2.5 / S;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.moveTo(p.x - 11, p.y);
      ctx.lineTo(p.x + 11, p.y);
      ctx.moveTo(p.x, p.y - 11);
      ctx.lineTo(p.x, p.y + 11);
      ctx.stroke();
    }

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
          ctx.strokeStyle = `rgba(255, 150, 70, ${(i / sh.trail.length) * 0.75})`;
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
          ctx.strokeStyle = `rgba(150, 230, 255, ${1 - t})`;
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
    ctx.font = `${labelSize}px 'Lilita One', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const t of g.tanks.values()) {
      if (t.phase === 'dead') continue;
      const p = cam.toScreen({ x: t.x, y: t.y - (t.phase === 'chute' ? 78 : 34) });
      const onScreen = p.x > -20 && p.x < vw + 20 && p.y > -20 && p.y < vh + 20;
      if (!onScreen) {
        this.drawOffscreen(t, p, vw, vh);
        continue;
      }
      const label = `${t.info.level}${t.info.away ? ' 💤' : ''}`;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(20, 16, 50, 0.85)';
      ctx.strokeText(label, p.x, p.y);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, p.x, p.y);
      if (t.info.id === g.myTankId) {
        // Local tank marker: a chevron that does not rely on colour.
        const cy = p.y - labelSize - 4 + Math.sin(now / 220) * 2;
        ctx.beginPath();
        ctx.moveTo(p.x - 8, cy - 5);
        ctx.lineTo(p.x, cy + 3);
        ctx.lineTo(p.x + 8, cy - 5);
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(20, 16, 50, 0.85)';
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
    }
    for (const e of g.effects) {
      if (e.kind !== 'float') continue;
      const t = (now - e.t0) / e.dur;
      const p = cam.toScreen({ x: e.x, y: e.y });
      ctx.globalAlpha = 1 - t * t;
      ctx.font = `18px 'Lilita One', system-ui, sans-serif`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(40, 20, 0, 0.8)';
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
        ctx.moveTo(h.x - 6, h.y + 10);
        ctx.lineTo(t.x - 10, t.y - bodyH);
        ctx.moveTo(h.x + 6, h.y + 10);
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
      ctx.strokeStyle = `rgba(160, 235, 255, ${0.45 + 0.35 * pulse})`;
      ctx.fillStyle = 'rgba(160, 235, 255, 0.12)';
      ctx.lineWidth = 2.5 / S;
      ctx.beginPath();
      ctx.arc(t.x, t.y - 13, 27, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Spread ready: three glowing pips at the barrel tip.
    if (spreadReady(t.info) && (t.phase === 'ground' || t.phase === 'slide')) {
      const tip = barrelTip(cfg, t.x, t.y, angle);
      for (let i = -1; i <= 1; i++) {
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
      const len = 14 + aim.power * 0.9;
      const dx = Math.cos(angle * DEG);
      const dy = -Math.sin(angle * DEG);
      ctx.setLineDash([4 / S, 5 / S]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = 2 / S;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x + dx * len, tip.y + dy * len);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

/** Muted background mountain silhouette, generated once. */
function mountains(width: number, height: number, seed: number, colors: [string, string], roughness: number) {
  const c = document.createElement('canvas');
  c.width = Math.round(width / 2);
  c.height = Math.round(height / 2);
  const ctx = c.getContext('2d')!;
  ctx.scale(0.5, 0.5);
  const pts: number[] = [];
  let r = seed * 9301 + 49297;
  const rand = () => {
    r = (r * 9301 + 49297) % 233280;
    return r / 233280;
  };
  const n = 60;
  const peaks: number[] = [];
  for (let i = 0; i <= n; i++) peaks.push(rand());
  for (let x = 0; x <= width; x += 6) {
    const f = (x / width) * n;
    const i = Math.floor(f);
    const t = f - i;
    const s = t * t * (3 - 2 * t);
    const v = peaks[i] + (peaks[Math.min(n, i + 1)] - peaks[i]) * s;
    const ridge = Math.abs(Math.sin(x * 0.004 + seed)) * 0.35;
    pts.push(height * (0.15 + (1 - v * roughness - ridge * 0.6) * 0.55));
  }
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, colors[0]);
  grad.addColorStop(1, colors[1]);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, height);
  pts.forEach((y, i) => ctx.lineTo(i * 6, y));
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();
  return c;
}
