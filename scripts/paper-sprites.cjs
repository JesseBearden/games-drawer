// Draw the Tanks sprites as cut paper (SVG -> PNG with sharp), with real paper grain multiplied in.
// Same names and aspect ratios as before, at 2x the old pixel size.
// The tank's player-coloured parts are drawn in cyan (hue ~186): sprites.ts recolours that hue.
// Usage: npm run sprites   (writes packages/client/public/sprites; DESIGN.md has the look)
const fs = require('node:fs');
const path = require('node:path');
const REPO = path.resolve(__dirname, '..');
const sharp = require('sharp');
const out = process.argv[2] ?? path.join(REPO, 'packages/client/public/sprites');
const GRAIN = REPO + '/packages/client/public/art/paper/cobalt.webp';

const INK = '#112875';
const NAVY = '#2b3150';
const CYAN = '#3ac8d6'; // tinted per player
const CYAN_LIGHT = '#8fe0e8';
const CYAN_DARK = '#2a9aa6';
const CREAM = '#f3dbbb';
const PAPER = '#fffcf5';
const TOMATO = '#ef5943';
const SUN = '#f6c12a';
const SKY = '#85bee3';

// A soft shadow under each paper piece (light from above, ink-tinted).
const SHADOW = (d = 2, blur = 1.6, a = 0.32) =>
  `<filter id="s" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur in="SourceAlpha" stdDeviation="${blur}"/><feOffset dy="${d}" result="b"/><feFlood flood-color="${INK}" flood-opacity="${a}"/><feComposite in2="b" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
const svg = (w, h, body, filter = SHADOW()) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${filter}</defs>${body}</svg>`;
const g = (inner) => `<g filter="url(#s)">${inner}</g>`;

function star(cx, cy, n, ro, ri, rot = 0) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? ri : ro;
    const a = rot + (i * Math.PI) / n - Math.PI / 2;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}

const SPRITES = {
  // Hull on a tread with four wheels.
  'tank-body': [232, 120, svg(232, 120,
    g(`<rect x="8" y="60" width="216" height="52" rx="26" fill="${NAVY}"/>`) +
    g([46, 90, 134, 178].map((x) => `<circle cx="${x}" cy="86" r="15" fill="${CREAM}"/>`).join('')) +
    [46, 90, 134, 178].map((x) => `<circle cx="${x}" cy="86" r="5" fill="${NAVY}"/>`).join('') +
    g(`<path d="M18 70 L44 31 Q48 24 57 24 L175 24 Q184 24 188 31 L214 70 Z" fill="${CYAN}"/>`) +
    g(`<path d="M31 56 L201 56 L206 64 L26 64 Z" fill="${CYAN_LIGHT}"/>`) +
    `<rect x="66" y="32" width="36" height="10" rx="4" fill="${CYAN_LIGHT}"/>`)],
  // Dome on a band, with the barrel along y=48 from the pivot (64, 48).
  'tank-turret': [252, 106, svg(252, 106,
    g(`<rect x="84" y="39" width="150" height="18" rx="5" fill="${CYAN_DARK}"/><rect x="224" y="34" width="22" height="28" rx="5" fill="${CYAN_DARK}"/>`) +
    g(`<path d="M14 70 A50 44 0 0 1 114 70 Z" fill="${CYAN}"/>`) +
    `<ellipse cx="46" cy="44" rx="15" ry="7" fill="${CYAN_LIGHT}" transform="rotate(-24 46 44)"/>` +
    g(`<rect x="8" y="66" width="112" height="14" rx="5" fill="${CYAN_DARK}"/>`))],
  // Sunflower helicopter, nose to the right.
  helicopter: [274, 158, svg(274, 158,
    g(`<rect x="34" y="70" width="110" height="16" rx="6" fill="${SUN}"/>`) +
    g(`<path d="M10 42 L40 42 L52 78 L22 86 Z" fill="${TOMATO}"/>`) +
    g(`<path d="M118 112 Q110 56 168 50 L206 50 Q252 52 258 98 Q260 126 226 128 L142 128 Q122 126 118 112 Z" fill="${SUN}"/>`) +
    g(`<path d="M196 60 L210 60 Q240 64 246 96 L196 96 Z" fill="${SKY}"/>`) +
    `<path d="M124 108 L254 108 Q252 122 226 124 L142 124 Q126 122 124 108 Z" fill="${TOMATO}"/>` +
    g(`<rect x="132" y="128" width="8" height="18" fill="${NAVY}"/><rect x="214" y="128" width="8" height="18" fill="${NAVY}"/><rect x="112" y="142" width="132" height="8" rx="4" fill="${NAVY}"/>`) +
    g(`<rect x="174" y="30" width="10" height="22" fill="${NAVY}"/>`) +
    g(`<rect x="44" y="20" width="226" height="10" rx="5" fill="${CREAM}"/>`) +
    g(`<circle cx="179" cy="25" r="8" fill="${NAVY}"/>`))],
  // Canopy of tomato and paper panels, strings to a point.
  parachute: [220, 222, svg(220, 222,
    `<g stroke="${INK}" stroke-opacity=".55" stroke-width="2.4" fill="none">${[12, 61, 110, 159, 208].map((x) => `<path d="M${x} ${x === 110 ? 100 : x === 12 || x === 208 ? 92 : 98} L110 214"/>`).join('')}</g>` +
    `<defs><clipPath id="dome"><path d="M10 94 Q10 12 110 10 Q210 12 210 94 Q185 82 159 98 Q135 84 110 100 Q85 84 61 98 Q35 82 10 94 Z"/></clipPath></defs>` +
    g(`<g clip-path="url(#dome)">${[0, 1, 2, 3, 4].map((i) => `<rect x="${10 + i * 40}" y="0" width="40.5" height="110" fill="${i % 2 ? PAPER : TOMATO}"/>`).join('')}</g>`) +
    `<path d="M110 10 Q66 12 40 40" stroke="${PAPER}" stroke-opacity=".5" stroke-width="5" fill="none" stroke-linecap="round"/>`)],
  // A navy shell with a tomato band, nose to the right.
  shell: [92, 50, svg(92, 50,
    g(`<path d="M8 13 L62 13 Q86 13 88 25 Q86 37 62 37 L8 37 Q4 37 4 33 L4 17 Q4 13 8 13 Z" fill="${NAVY}"/>`) +
    `<rect x="16" y="13" width="9" height="24" fill="${TOMATO}"/>`, SHADOW(1.5, 1.2, 0.3))],
  // Three layers of paper stars: tomato, sunflower, paper.
  explosion: [254, 236, svg(254, 236,
    g(`<polygon points="${star(127, 118, 12, 112, 66)}" fill="${TOMATO}"/>`) +
    g(`<polygon points="${star(127, 118, 10, 80, 50, 0.3)}" fill="${SUN}"/>`) +
    g(`<polygon points="${star(127, 118, 8, 44, 28, 0.1)}" fill="${PAPER}"/>`), SHADOW(3, 2, 0.3))],
  // A puff of paper: a light layer over a slightly darker one.
  smoke: [190, 158, svg(190, 158,
    `<g fill="#ddd8cc" transform="translate(0 9)">${[[50, 98, 40], [96, 66, 52], [146, 94, 40], [120, 114, 34], [70, 116, 32]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g>` +
    g(`<g fill="#f6f3ec">${[[50, 98, 40], [96, 66, 52], [146, 94, 40], [120, 114, 34], [70, 116, 32]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g>`), SHADOW(2, 2, 0.18))],
  // A tomato paper heart with a lighter piece on top.
  heart: [138, 120, svg(138, 120,
    g(`<path d="M69 112 C30 84 6 62 6 36 C6 17 21 5 39 5 C52 5 62 12 69 23 C76 12 86 5 99 5 C117 5 132 17 132 36 C132 62 108 84 69 112 Z" fill="${TOMATO}"/>`) +
    `<ellipse cx="38" cy="32" rx="16" ry="10" fill="#f6907e" transform="rotate(-30 38 32)"/>`)],
  // Pole and a striped sock blowing to the right.
  windsock: [152, 122, svg(152, 122,
    g(`<rect x="8" y="10" width="8" height="108" rx="3" fill="${NAVY}"/><circle cx="12" cy="9" r="6" fill="${NAVY}"/>`) +
    g([0, 1, 2, 3].map((i) => {
      const x0 = 16 + i * 33;
      const x1 = x0 + 33;
      const h0 = 22 - i * 3.2;
      const h1 = 22 - (i + 1) * 3.2;
      return `<path d="M${x0} ${34 - h0} L${x1} ${34 - h1} L${x1} ${34 + h1} L${x0} ${34 + h0} Z" fill="${i % 2 ? PAPER : TOMATO}"/>`;
    }).join('')))],
  // No wind: the sock hangs down the pole.
  'windsock-calm': [92, 134, svg(92, 134,
    g(`<rect x="8" y="10" width="8" height="120" rx="3" fill="${NAVY}"/><circle cx="12" cy="9" r="6" fill="${NAVY}"/>`) +
    g([0, 1, 2, 3].map((i) => {
      const y0 = 16 + i * 22;
      const y1 = y0 + 22;
      const w0 = 22 - i * 3;
      const w1 = 22 - (i + 1) * 3;
      const c = 38;
      return `<path d="M${c - w0} ${y0} L${c + w0} ${y0} L${c + w1} ${y1} L${c - w1} ${y1} Z" fill="${i % 2 ? PAPER : TOMATO}"/>`;
    }).join('')))],
};

(async () => {
  fs.mkdirSync(out, { recursive: true });
  // Grain: the cobalt paper's light and dark, as a multiplier around 1.
  const G = await sharp(GRAIN).greyscale().raw().toBuffer({ resolveWithObject: true });
  let mean = 0;
  for (const v of G.data) mean += v;
  mean /= G.data.length;
  for (const [name, [w, h, s]] of Object.entries(SPRITES)) {
    const { data, info } = await sharp(Buffer.from(s)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * 4;
        if (!data[i + 3]) continue;
        const gv = G.data[(y % G.info.height) * G.info.width + (x % G.info.width)];
        const k = 1 + ((gv - mean) / 255) * 1.6;
        for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, Math.round(data[i + c] * k)));
      }
    }
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 9 }).toFile(path.join(out, `${name}.png`));
    console.log(name, `${w}x${h}`, (fs.statSync(path.join(out, `${name}.png`)).size / 1024).toFixed(1) + ' KB');
  }
})();
