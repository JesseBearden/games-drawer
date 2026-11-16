// Dev helper: print size, alpha histogram and occupied row/column runs of a PNG.
import { PNG } from 'pngjs';
import fs from 'node:fs';

const file = process.argv[2];
const png = PNG.sync.read(fs.readFileSync(file));
const { width, height, data } = png;
console.log({ width, height });
const hist = new Array(16).fill(0);
for (let i = 3; i < data.length; i += 4) hist[data[i] >> 4]++;
console.log('alpha histogram (16 buckets)', hist.join(' '));
const colOcc = new Array(width).fill(0);
const rowOcc = new Array(height).fill(0);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  if (data[(y * width + x) * 4 + 3] > 40) { colOcc[x]++; rowOcc[y]++; }
}
function runs(arr: number[]) {
  const out: [number, number][] = [];
  let start = -1;
  arr.forEach((v, i) => {
    if (v > 0 && start < 0) start = i;
    if (v === 0 && start >= 0) { out.push([start, i - 1]); start = -1; }
  });
  if (start >= 0) out.push([start, arr.length - 1]);
  return out;
}
console.log('cols', JSON.stringify(runs(colOcc)));
console.log('rows', JSON.stringify(runs(rowOcc)));
