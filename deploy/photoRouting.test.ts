import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { photoUploadUrl, photoUrl, ROOM_CODE_ALPHABET, SLOTS, slotOfCode, type Slot } from '@tank/shared';
import { routesSnippet, type FleetMap } from './fleetMap';

const IPS: Record<Slot, string> = { a: '10.0.0.11', b: '10.0.0.12', c: '10.0.0.13', d: '10.0.0.14' };
/** A code for a table on that box. */
const codeFor = (slot: Slot) => `BBBB${[...ROOM_CODE_ALPHABET].find((c) => slotOfCode(`BBBB${c}`) === slot)}`;

/** The first upstream of the handle a request with this query gets. */
function upstream(routes: string, url: string) {
  const slot = new URL(url, 'https://games.example').searchParams.get('slot');
  const own = slot && routes.split(`handle @slot_${slot} {`)[1];
  const block = own || routes.split('# Everything else')[1];
  return /reverse_proxy (\S+)/.exec(block)![1];
}

describe('photos reach the box their table is on', () => {
  for (const slot of SLOTS) {
    const code = codeFor(slot);
    const urls = [photoUploadUrl(code), photoUrl(code, 'AAAAAAAAAAAAAAAAAAAAAA')];
    for (const current of SLOTS) {
      it(`a table on box ${slot} while box ${current} takes new tables`, () => {
        const map: FleetMap = { boxes: IPS, newTables: [[current, 100]], staging: null };
        // Whichever box the request lands on.
        for (const self of SLOTS) {
          const want = self === slot ? '127.0.0.1:8801' : `${IPS[slot]}:8080`;
          for (const url of urls) expect(upstream(routesSnippet(map, self, 'games.example'), url)).toBe(want);
        }
      });
    }
  }

  it('keeps what the server reads: the table, and the photo’s path', () => {
    const up = new URL(photoUploadUrl('BCDFG'), 'https://games.example');
    expect([up.pathname, up.searchParams.get('table')]).toEqual(['/api/photo', 'BCDFG']);
    expect(new URL(photoUrl('BCDFG', 'x'), 'https://games.example').pathname).toBe('/api/photo/BCDFG/x.jpg');
  });

  it('the page never writes a photo address itself', () => {
    const src = fileURLToPath(new URL('../packages/client/src/', import.meta.url));
    const files = fs.readdirSync(src).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((f) => fs.readFileSync(`${src}${f}`, 'utf8').includes('/api/photo'))).toEqual([]);
  });
});
