# Things to try

A running list of changes that need a hands-on check. Claude adds to it whenever something
changes and removes items once you've tried them. Tell me what was wrong (or just "all good")
and I'll update it.

_Last updated: 2026-11-16_

## Getting set up

- On the PC: `npm run dev`, then open http://localhost:5173.
- For phones (and anything with voice): `npm run dev:https`, open the **https** Network URL it
  prints, and accept the certificate warning once.
- Each browser tab is its own player, so two tabs (or a phone plus the PC) make a two-player room.

## Tanks (Play → public battle)

Phone layout is confirmed good. Still worth noticing over a few games:

- [ ] Helicopters don't drop you right next to another tank.
- [ ] Driving climbs noticeably steeper hills than before.
- [ ] The ladder ends at level 10: 3 faster shells, 4 movement, 5 a triple every 3rd shot,
      6 extra life, 7 explode on death, 8 faster movement, 9 a quintuple every 3rd shot,
      10 nuke.
- [ ] Players with more than 3 / 6 / 9 kills show a gold +2 / +3 / +4 bounty tag.
- [ ] A win posts "X won!" in chat, the screen just says who won, and the nuke fills the whole screen.
- [ ] The iPhone lock-ups from last time don't come back.

## Private rooms and the lobby

Confirmed on the PC. Left to try:

- [ ] Invite opens the phone's share sheet, and a friend somewhere else can join from the link
      (needs the hosted site).

## Hearts

Confirmed on the PC. Left to try:

- [ ] Phone held upright: the other three players sit in a row along the top, and the cards
      are bigger than before.
- [ ] Phone held sideways: names are small chips, your name sits to the left of your hand, and
      the cards in the middle don't overlap.
- [ ] Turn the phone mid-hand, both ways: your hand stays centred instead of sliding to one side.
- [ ] On a phone, one tap lifts a card and a second tap plays it.
- [ ] At 100 the game ends with "New game" and "Back to lobby".
- [ ] Close the tab mid-hand: a bot plays your seat. Reopen it and you get your seat and cards back.
- [ ] The bots feel like a fair game (not too sharp, not too dumb).

## Voice (needs the https dev server; two devices)

Joining, speaking markers and switching games are confirmed. Left to try:

- [ ] Toggling Wi-Fi or briefly locking the phone: voice comes back by itself.
- [ ] "Mute me" and muting another player both work.
- [ ] The voice panel shows each person's link (connecting, relayed, or couldn't connect).
- [ ] Game sound or echo leaking into your mic: try with and without headphones.

## Sounds

- [ ] Open http://localhost:5173/sfx-lab.html. Every sound has the old generated version plus the
      new samples side by side. Picking one there changes it in the game in that browser. Use
      "Copy picks JSON" and send me the result to make your picks the defaults.
- [ ] Listen hardest to the shield, parachute, drop and wind sounds; they had the fewest options.
- [ ] In the game: the helicopter and wind loops, and the card sounds in Hearts.

## Later, once it's hosted

- [ ] Voice relay: open a private room link with `?relay=1` on the end on two phones using cell
      data. Each person in the voice panel should show "(relayed)".
- [ ] A friend in another house joins a private room and you talk while playing.
