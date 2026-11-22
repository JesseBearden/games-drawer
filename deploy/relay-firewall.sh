#!/usr/bin/env bash
# relay-firewall.sh [private ip]
#
# What may reach the voice relay (coturn, user "turnserver"), and what it may send. setup.sh
# installs this as /usr/local/sbin/games-drawer-relay-firewall, and systemd runs it before every
# start of the relay: after a reboot or a package update too. If it fails, the relay doesn't start
# (voice still connects directly on the same network). The table is replaced in one go, which
# forgets who has a slot, so only run it when the relay is starting anyway.
#
# Whatever the relay can meet in use is dropped on the way in, never on the way out: a blocked
# send fails, and coturn answers a failed send by ending that player's relayed call.
#
# On the way in, to the relay's port:
#   - members: whoever coturn gave a slot (it said so in an answer, which needs a password and
#     the real address). Only their requests are limited, each on their own.
#   - players: addresses this box's web server has an open connection with (that can't be faked).
#     They may ask for their address and for a slot, in a lane of their own.
#   - everyone else may ask for the same two things, in a smaller lane. A busy one can't slow
#     the players' lane, or anyone with a slot.
#   - anything else is dropped before coturn sees it, so it keeps nothing and logs nothing.
#   - TCP (for networks that block UDP): new connections and bytes are limited for each address.
# From the relay's ports to this box: only other relayed links' audio ports (both ends of a call
# can be relayed).
# On the way out, the turnserver user only, behind coturn's own lists: nothing to private
# addresses or over IPv6, and no new TCP connections.
#
# Where packets leave the box (table netdev gd_relay_bill, which is what AWS bills): each slot
# sends at most 14 KB/s each way (room for the hungriest browser's voice), and all of them
# together at most 620 KB/s, which is the spending cap. coturn's own (max-bps) has to stay off:
# with it on, coturn stops answering a long call's renewals. A drop here is the one kind on the
# way out that's safe, because the kernel doesn't report it to coturn as a failed send.
set -euo pipefail

private_ip="${1:-}"
if [ -z "$private_ip" ]; then
  private_ip="$(sed -n 's/^PRIVATE_IP=//p' /etc/games-drawer/box.env)"
fi
[[ "$private_ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || { echo "relay-firewall: no private address." >&2; exit 1; }

# These must match turnserver.conf (relay.test.ts checks).
port=3478
audio=49152-49352

devices=
for link in /sys/class/net/*; do
  [ -e "$link/ifindex" ] && [ "${link##*/}" != lo ] && devices="${devices:+$devices, }\"${link##*/}\""
done
[ -n "$devices" ] || { echo "relay-firewall: no network device." >&2; exit 1; }

# The first lines and the deletes are what make loading this twice replace it.
nft -f - <<RULES
table inet gd_relay {}
delete table inet gd_relay
table netdev gd_relay_bill {}
delete table netdev gd_relay_bill

table inet gd_relay {
  set private {
    type ipv4_addr
    flags interval
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 }
  }

  set members {
    type ipv4_addr . inet_service
    flags dynamic,timeout
    timeout 20m
    size 4096
  }
  set players {
    type ipv4_addr
    flags dynamic,timeout
    timeout 10m
    size 65536
  }

  set member_asks {
    type ipv4_addr . inet_service
    flags dynamic,timeout
    timeout 1m
    size 4096
  }
  set player_asks {
    type ipv4_addr
    flags dynamic,timeout
    timeout 1m
    size 65536
  }
  set other_asks {
    type ipv4_addr
    flags dynamic,timeout
    timeout 1m
    size 65536
  }
  set member_bytes {
    type ipv4_addr . inet_service
    flags dynamic,timeout
    timeout 1m
    size 4096
  }
  set peer_bytes {
    type ipv4_addr . inet_service
    flags dynamic,timeout
    timeout 1m
    size 65536
  }
  set tcp_connects {
    type ipv4_addr
    flags dynamic,timeout
    timeout 1m
    size 65536
  }
  set tcp_bytes {
    type ipv4_addr
    flags dynamic,timeout
    timeout 1m
    size 65536
  }

  chain incoming {
    type filter hook input priority -5; policy accept;
    iifname "lo" ip daddr $private_ip udp sport $audio udp dport != $audio counter drop comment "relay to this box"
    iifname != "lo" udp dport $audio meta nfproto ipv4 update @peer_bytes { ip saddr . udp dport limit rate over 32 kbytes/second burst 96 kbytes } counter drop comment "one sender to a slot"
    udp dport $port jump relay_udp
    tcp dport $port jump relay_tcp
  }

  chain relay_udp {
    meta nfproto != ipv4 drop
    ip saddr @private counter drop
    udp sport 0 drop
    ip saddr . udp sport @members jump member

    # Everyone without a slot: a STUN Binding or Allocate request, and nothing else.
    @th,96,32 != 0x2112a442 counter drop comment "not STUN"
    @th,64,16 != { 0x0001, 0x0003 } counter drop comment "needs a slot"
    ip saddr @players jump player
    update @other_asks { ip saddr limit rate over 20/second burst 200 packets } counter drop comment "one address"
    limit rate over 300/second burst 1000 packets counter drop comment "all others"
    accept
  }

  chain member {
    @th,64,16 & 0xc110 == 0x0000 update @member_asks { ip saddr . udp sport limit rate over 30/second burst 150 packets } counter drop comment "one slot"
    update @member_bytes { ip saddr . udp sport limit rate over 32 kbytes/second burst 96 kbytes } counter drop comment "one slot"
    accept
  }

  chain player {
    update @player_asks { ip saddr limit rate over 40/second burst 400 packets } counter drop comment "one player"
    limit rate over 1000/second burst 2000 packets counter drop comment "all players"
    accept
  }

  chain relay_tcp {
    meta nfproto != ipv4 drop
    ip saddr @private counter drop
    tcp flags & (fin|syn|rst|ack) == syn update @tcp_connects { ip saddr limit rate over 3/second burst 40 packets } counter drop comment "one address"
    tcp flags & (fin|syn|rst|ack) == syn limit rate over 50/second burst 300 packets counter drop comment "all connections"
    update @tcp_bytes { ip saddr limit rate over 200 kbytes/second burst 256 kbytes } counter drop comment "one address"
    accept
  }

  chain outgoing {
    type filter hook output priority -5; policy accept;
    tcp sport 443 tcp flags & (psh|ack) == (psh|ack) update @players { ip daddr }
    meta skuid "turnserver" jump from_relay
  }

  chain from_relay {
    meta nfproto ipv6 counter reject
    # (Lets those sends leave, to be dropped quietly on the way in.)
    ip daddr $private_ip udp sport $audio accept
    ip daddr @private counter reject
    tcp flags & (fin|syn|rst|ack) == syn counter reject
    udp sport $port @th,96,32 0x2112a442 @th,64,16 { 0x0103, 0x0104, 0x0108, 0x0109 } update @members { ip daddr . udp dport }
  }
}

table netdev gd_relay_bill {
  set to_peers {
    type inet_service
    flags dynamic,timeout
    timeout 1m
    size 4096
  }
  set to_players {
    type ipv4_addr . inet_service
    flags dynamic,timeout
    timeout 1m
    size 65536
  }
  set to_tcp_players {
    type ipv4_addr . inet_service
    flags dynamic,timeout
    timeout 1m
    size 65536
  }

  chain billed {
    type filter hook egress devices = { $devices } priority 0; policy accept;
    # (coturn's answers aren't audio, and the lanes on the way in already limit them.)
    meta protocol ip udp sport $port @th,64,16 & 0xc100 == 0x0100 accept
    meta protocol ip udp sport $audio update @to_peers { udp sport limit rate over 14 kbytes/second burst 64 kbytes } counter drop comment "one slot, to the other end"
    meta protocol ip udp sport $port update @to_players { ip daddr . udp dport limit rate over 14 kbytes/second burst 64 kbytes } counter drop comment "one slot, to its player"
    meta protocol ip tcp sport $port update @to_tcp_players { ip daddr . tcp dport limit rate over 14 kbytes/second burst 64 kbytes } counter drop comment "one connection"
    meta protocol ip udp sport { $port, $audio } jump spending
    meta protocol ip tcp sport $port jump spending
  }

  chain spending {
    limit rate over 620 kbytes/second burst 2 mbytes counter drop comment "the whole relay"
  }
}
RULES
