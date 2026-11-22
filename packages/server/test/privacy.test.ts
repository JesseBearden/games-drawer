import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOG_KEEP_DAYS } from '../src/eventlog';
import { PUZZLE_KEEP_DAYS } from '../src/puzzleStore';
import { RECENT_MESSAGES } from '../src/room';
import { CHAT_HISTORY_SIZE, DEFAULT_ICE_SERVERS, stunFromTurn } from '../src/server';
import { securityHeaders } from '../src/static';

/**
 * The privacy page and house rules (in index.html) make promises the code has to keep. If one of
 * these fails, change the page in the same commit as the code, and update its date (DESIGN.md).
 */
const html = fs.readFileSync(new URL('../../client/index.html', import.meta.url), 'utf8');
const page = (id: string) => {
  const m = new RegExp(`<section id="${id}"[\\s\\S]*?</section>`).exec(html);
  if (!m) throw new Error(`no #${id} in index.html`);
  return m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
};
const privacy = page('page-privacy');
const rules = page('page-rules');

describe('the privacy page and house rules match the code', () => {
  it('says how long logs, reported messages and saved puzzles are kept', () => {
    expect(privacy).toContain(`Logs are deleted after ${LOG_KEEP_DAYS} days`);
    expect(privacy).toContain(`It’s deleted after ${LOG_KEEP_DAYS} days`); // a reported message lives in the chat log
    expect(privacy).toContain(`deleted after ${LOG_KEEP_DAYS} days too`); // the boxes' own logs (deploy/setup.sh)
    expect(rules).toContain(`kept for ${LOG_KEEP_DAYS} days`);
    expect(privacy).toContain(`nobody has played for ${PUZZLE_KEEP_DAYS} days is deleted`);
  });

  it('says how many messages a table keeps', () => {
    expect(privacy).toContain(`keeps the last ${CHAT_HISTORY_SIZE} while the table is open`);
    expect(privacy).toContain(`up to ${RECENT_MESSAGES} recent ones so a message that gets reported can be found`);
    expect(privacy).toContain('All of them are erased when the table closes');
  });

  it('only involves our own servers: no outside fonts, and voice set-up through our relay', () => {
    expect(privacy).toContain('Only Amazon Web Services');
    // Nothing on the page itself loads from anywhere else.
    expect(html).not.toMatch(/googleapis|gstatic|<script[^>]+src="https?:/);
    const csp = securityHeaders('gamesdrawer.com')['content-security-policy'];
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain('google');
    // With the relay set up (the hosted site), STUN is ours; Google's is only the no-relay fallback.
    expect(JSON.stringify(stunFromTurn(['turn:203.0.113.7:3478?transport=udp']))).not.toContain('google');
    expect(JSON.stringify(DEFAULT_ICE_SERVERS)).toContain('google');
  });

  it('says what happens to your own photos: checked by Rekognition, never saved, gone with the table', () => {
    expect(privacy).toContain('checked automatically for nudity, violence and the like by Amazon Rekognition');
    expect(privacy).toContain('kept only in our server’s memory, never saved, and it’s deleted when the table closes');
    expect(privacy).toContain('location, date and camera details behind on your device');
    expect(privacy).toContain('A finished puzzle is deleted');
    expect(rules).toContain('Only add photos you’re allowed to share');
    // Reading the chosen photo on the device (blob:) is the one extra the page needs.
    expect(securityHeaders('gamesdrawer.com')['content-security-policy']).toContain("img-src 'self' data: blob:");
  });

  it('carries a date', () => {
    expect(privacy).toMatch(/Last updated [A-Z][a-z]+ \d{1,2}, \d{4}/);
    expect(rules).toMatch(/Last updated [A-Z][a-z]+ \d{1,2}, \d{4}/);
  });
});
