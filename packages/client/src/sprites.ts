import { TANK_COLORS } from '@tank/shared';

export type SpriteName =
  | 'tank-body'
  | 'tank-turret'
  | 'helicopter'
  | 'parachute'
  | 'shell'
  | 'explosion'
  | 'smoke'
  | 'heart'
  | 'windsock'
  | 'windsock-calm';

const NAMES: SpriteName[] = [
  'tank-body',
  'tank-turret',
  'helicopter',
  'parachute',
  'shell',
  'explosion',
  'smoke',
  'heart',
  'windsock',
  'windsock-calm',
];

export interface Sprites {
  img: Record<SpriteName, HTMLImageElement>;
  /** Tinted tank body and turret per palette colour. */
  bodies: HTMLCanvasElement[];
  turrets: HTMLCanvasElement[];
}

function load(name: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load sprite ${name}`));
    img.src = `/sprites/${name}.png`;
  });
}

export async function loadSprites(): Promise<Sprites> {
  const imgs = await Promise.all(NAMES.map(load));
  const img = Object.fromEntries(NAMES.map((n, i) => [n, imgs[i]])) as Record<SpriteName, HTMLImageElement>;
  return {
    img,
    bodies: TANK_COLORS.map((_, i) => tint(img['tank-body'], i)),
    turrets: TANK_COLORS.map((_, i) => tint(img['tank-turret'], i)),
  };
}

/**
 * Recolour the cyan parts of a tank sprite. Saturated cyan pixels take the palette hue;
 * dark outlines and grey wheels (low saturation) are left alone.
 */
function tint(src: HTMLImageElement, colorIndex: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.naturalWidth;
  c.height = src.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  if (colorIndex === 0) return c;
  const target = TANK_COLORS[colorIndex];
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const d = data.data;
  const BASE_LIGHT = 0.56;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    if (s < 0.3 || h < 150 || h > 215) continue;
    const nl = Math.min(0.97, Math.max(0.05, (l / BASE_LIGHT) * target.light));
    const ns = Math.min(1, s * target.sat);
    const [r, g, b] = hslToRgb(target.hue, ns, nl);
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
