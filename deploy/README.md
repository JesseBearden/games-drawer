# Deploy notes

Nothing here is automated yet. These are the pieces to set up when we host the game.

## Voice relay (TURN)

Voice chat connects players directly. Some networks (strict routers, some mobile carriers,
work Wi-Fi) block direct connections; for those players the audio goes through a relay
(coturn) on our server instead. Without it, those players can't hear or be heard.

1. Install coturn on the game server: `sudo apt install coturn`.
2. Copy [turnserver.conf](turnserver.conf) to `/etc/turnserver.conf` and fill in the
   `CHANGE_ME` values (public/private IP, a long random secret, the domain).
3. Open these ports in the Lightsail/EC2 firewall:
   - UDP and TCP 3478
   - TCP 5349 (encrypted)
   - UDP 49152–49352 (relayed audio)
4. Give the game server the same secret:

   ```bash
   TURN_URLS="turn:example.com:3478?transport=udp,turn:example.com:3478?transport=tcp,turns:example.com:5349?transport=tcp"
   TURN_SECRET="<same secret as static-auth-secret>"
   ```

5. Start coturn: `sudo systemctl enable --now coturn`.

**Testing it:** open a private room with `?relay=1` on the end of the URL (for example
`https://example.com/r/BCDFG?relay=1`) on two phones on cell data. That forces every voice
link through the relay. The voice panel shows "(relayed)" next to each person when it works.

**Not covered:** some school or office networks only allow port 443, which Caddy already
uses. Reaching those would need a second IP address for the relay.

**Security:** each player gets their own credentials that expire (24 hours by default,
`TURN_TTL_SECONDS`). The config refuses to relay to private and internal addresses
(including the AWS metadata service) and caps bandwidth per player and in total. Never put
the secret in client code or in `VOICE_ICE_SERVERS`.
