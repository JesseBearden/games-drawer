import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const conf = read('turnserver.conf');
const setup = read('setup.sh');
const firewall = read('relay-firewall.sh');
const setting = (name: string) => new RegExp(`^${name}=(.+)$`, 'm').exec(conf)?.[1];
const at = (text: string) => {
  const i = setup.indexOf(text);
  expect(i, text).toBeGreaterThanOrEqual(0);
  return i;
};
/** The lines of one chain in the firewall. */
const chain = (name: string) => firewall.split(`  chain ${name} {\n`)[1].split('\n  }')[0].split('\n');

describe('the voice relay on a box', () => {
  it('keeps the firewall and the config on the same ports', () => {
    expect(firewall).toContain(`audio=${setting('min-port')}-${setting('max-port')}\n`);
    expect(firewall).toContain(`port=${setting('listening-port')}\n`);
  });

  it('only ever drops on the way in (a failed send ends that player’s call)', () => {
    for (const name of ['outgoing', 'from_relay']) {
      expect(chain(name).filter((l) => / drop\b|limit rate/.test(l))).toEqual([]);
    }
  });

  it('lets calls already up past the lanes that a busy relay fills', () => {
    const udp = chain('relay_udp');
    const members = udp.findIndex((l) => l.includes('@members jump member'));
    expect(members).toBeGreaterThanOrEqual(0);
    for (const [i, line] of udp.entries()) if (/limit rate|0x0001|jump player/.test(line)) expect(i, line).toBeGreaterThan(members);
    expect(chain('member').join('\n')).not.toMatch(/^\s*limit rate/m); // only each slot's own limit
  });

  it('lets nothing out in pieces, or too big to be voice, before anything reads a port', () => {
    const rules = chain('billed').filter((l) => /^\s+meta protocol/.test(l));
    expect(rules[0]).toContain('ip frag-off & 0x3fff != 0 counter drop');
    expect(rules[1]).toContain('udp length > $largest counter drop');
    // One internet packet, less the IP header, and room for a browser's handshake (about 1300).
    const largest = Number(/^largest=(\d+)$/m.exec(firewall)?.[1]);
    expect(largest).toBeGreaterThanOrEqual(1400);
    expect(largest).toBeLessThanOrEqual(1500 - 20);
    expect(chain('incoming').join('\n')).toContain('udp dport $audio udp length > $largest counter drop');
    const udp = chain('relay_udp').join('\n');
    expect(udp.indexOf('udp length > $largest')).toBeGreaterThanOrEqual(0);
    expect(udp.indexOf('udp length > $largest')).toBeLessThan(udp.indexOf('@members'));
  });

  it('forgets whoever gives a slot up, so the members list can’t be filled', () => {
    const out = chain('from_relay');
    const gone = out.findIndex((l) => l.includes('@th,256,32 0 update @members { ip daddr . udp dport timeout 5s } accept'));
    const joins = out.findIndex((l) => l.includes('{ 0x0103'));
    expect(gone).toBeGreaterThanOrEqual(0);
    expect(joins).toBeGreaterThan(gone); // or it would put them straight back for 20 minutes
    const set = (name: string) => firewall.split(`  set ${name} {\n`)[1].split('\n  }')[0];
    for (const name of ['members', 'member_asks', 'member_bytes']) expect(set(name)).toContain('size 65536');
    // A full set limits nobody, so the slots' limits forget quickly too.
    for (const name of ['member_asks', 'member_bytes']) expect(set(name)).toContain('timeout 10s');
  });

  it('keeps players out of the limit on everyone’s TCP connections', () => {
    expect(chain('relay_tcp').join('\n')).toContain('ip saddr != @players limit rate over 50/second');
  });

  it('gives players their own lane, ahead of everyone else’s', () => {
    const udp = chain('relay_udp').join('\n');
    expect(udp.indexOf('@players jump player')).toBeLessThan(udp.indexOf('@other_asks'));
    expect(chain('outgoing').join('\n')).toContain('tcp sport 443');
  });

  it('waits for its config and firewall before anything can start it', () => {
    const installed = at('apt-get install -y -q caddy coturn nftables');
    expect(at('ConditionPathExists=/etc/games-drawer/relay-ready')).toBeLessThan(installed);
    expect(at('ExecStartPre=+/usr/local/sbin/games-drawer-relay-firewall')).toBeLessThan(installed);
    expect(at('mv /etc/turnserver.conf.new')).toBeLessThan(at('> /etc/games-drawer/relay-ready'));
    expect(at('> /etc/games-drawer/relay-ready')).toBeLessThan(at('systemctl restart coturn'));
  });

  it('loads the firewall only as the relay starts (loading forgets who has a slot)', () => {
    expect(setup).not.toMatch(/^\/usr\/local\/sbin\/games-drawer-relay-firewall/m);
  });

  it('caps the relay’s memory, and always restarts it', () => {
    expect(setup).toMatch(/^MemoryMax=\d+M$/m);
    expect(setup).toMatch(/^StartLimitIntervalSec=0$/m);
    expect(Number(setting('max-allocate-timeout'))).toBeLessThanOrEqual(5);
  });

  it('logs only to its own journal, with a size limit', () => {
    expect(setting('log-file')).toBe('stdout');
    expect(setup).toContain('LogNamespace=gd-relay\n');
    const journal = setup.split(`<<'JOURNAL'\n`)[1].split('\nJOURNAL')[0];
    expect(journal).toMatch(/^SystemMaxUse=50M$/m);
    expect(setup).not.toContain('/var/log/turnserver.log');
  });

  it('deletes the box’s own logs within 30 days, as the privacy page says', () => {
    const days = [...setup.matchAll(/MaxRetentionSec=(\d+)day/g)].map((m) => Number(m[1]));
    expect(days).toHaveLength(2);
    // Whole files go, and a file holds up to a day.
    for (const d of days) expect(d + 1).toBeLessThanOrEqual(30);
    expect(setup.match(/MaxFileSec=1day/g)).toHaveLength(2);
  });

  it('reads the secrets as values, never as commands', () => {
    expect(setup).not.toMatch(/^\s*(source|\.)\s+\S*secrets/m);
    expect(setup).toContain('=~ ^[0-9a-f]{32,128}$ ]]');
  });

  it('never turns on coturn’s own speed cap (it stops a long call’s renewals)', () => {
    expect(setting('max-bps')).toBeUndefined();
    expect(setting('bps-capacity')).toBeUndefined();
  });

  it('caps spending where packets leave, with room for every browser’s voice', () => {
    const slots = Number(setting('total-quota'));
    expect(slots).toBe(40);
    const household = Number(setting('user-quota'));
    // A table of four all relayed in Firefox: 6 links, 2 slots where it's made and 1 where it's answered.
    expect(household).toBeGreaterThanOrEqual(6 * 3);
    expect(household * 2).toBeLessThan(slots);
    expect(Number(setting('max-port')) - Number(setting('min-port')) + 1).toBeGreaterThan(slots * 2);
    const billed = chain('billed').join('\n');
    expect(billed).toContain('hook egress');
    const each = [...billed.matchAll(/limit rate over (\d+) kbytes\/second/g)].map((m) => Number(m[1]));
    expect(each).toEqual([14, 14, 14]); // out of a slot's port, to its player over UDP, and over TCP
    // Firefox unasked (stereo) is the most any browser was measured sending: 240 bytes, 51 times a second.
    expect(each[0] * 1024).toBeGreaterThan(240 * 51);
    const all = Number(/limit rate over (\d+) kbytes\/second/.exec(chain('spending').join('\n'))![1]);
    // Every slot full of voice fits (7.4 KB/s up, 8.3 down)...
    expect(all * 1024).toBeGreaterThan(slots * (7_400 + 8_300));
    // ...and a month flat out stays under 1.7 TB.
    expect(all * 1024 * 86_400 * 30).toBeLessThan(1.7e12);
  });

  it('relays audio only: UDP, over IPv4', () => {
    expect(conf).toMatch(/^no-tcp-relay$/m);
    expect(setting('relay-ip')).toBe('@PRIVATE_IP@');
  });

  it('ships its firewall in the release', () => {
    expect(read('../scripts/release.ts')).toContain("'relay-firewall.sh'");
  });
});
