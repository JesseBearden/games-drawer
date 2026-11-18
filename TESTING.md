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

## Home page and game pages (new)

- [ ] http://localhost:5173 is now the Games Drawer home page: your name, Start a private room,
      a room code box, and the list of games.
- [ ] Each game has its own page: `/tanks`, `/hearts`, `/spades`, `/dominoes`, `/jigsaw`.
      `/tankyouforbeingafriend` lands on `/tanks`. The phone's back button moves between them.
- [ ] Only **Tanks** and **Jigsaw** have **Play now** (a public game anyone can join). Hearts,
      Spades and Dominoes are private rooms only: their cards on the home page and in the room's
      game picker say "🚧 Under construction", and their pages have a caution-tape banner and
      only Play with friends.
- [ ] **Play now** on the Jigsaw page puts you at a shared public table (two browsers on Play
      now land on the same puzzle). Public games keep the strict chat filter and no voice.
- [ ] Leaving a public game returns you to that game's page; leaving a private room goes home.
- [ ] On the phone, type an old room code and tap Join (or open an old invite link and tap Join
      room): "That room has closed or the code is wrong." shows right under it, on screen.
      Changing the code clears it. (Long pop-up notes now wrap instead of running off a phone's
      screen too.)
- [ ] When a room closes on you (or you tap Join again): the message doesn't vanish and pop back
      any more. If the answer takes a moment, "Joining room ABCDE…" shows in that same spot and
      turns into the answer there; a longer answer grows smoothly instead of shoving the page.
- [ ] Reloading the page (or the dev server restarting) no longer flashes a plain white page
      first.
- [ ] New random names are a title and a snack ("Captain Pancake"). The dice picks a new one.
      Bots in Tanks keep the tank puns; card-game bots use the new names.
- [ ] Add to Home Screen on the phone: the icon says Games Drawer, and Hearts works upright.

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
- [ ] Bots hold their passes until every person has passed: start Hearts, have a friend join
      while you're still choosing, and they get to pick their own 3 cards. (You reported this.)
- [ ] On a phone, Menu → Leave works during Hearts (the cards used to cover it).

## Spades (new; private rooms only, under construction)

Pick it in a private room's lobby, or use Play with friends on gamesdrawer.com/spades. Once
you're happy with it, I'll open it to public games too (a one-word change).

- [ ] You and the player across are a team ("partner" on their name); the first two people in
      a room are opponents, and a third person partners the first.
- [ ] Bidding goes round the table; on your turn a row of buttons (Nil, 1–13) appears.
- [ ] Spades can't be led until one has been played; tapping a card you can't play says why.
- [ ] The middle shows each team's score and tricks won against its bid ("Us 120 3/6").
- [ ] After each hand: each team's bid, tricks and points, nils made or missed, and bag penalties.
- [ ] Phone upright and sideways both fit (sideways, the team scores sit in the top-left corner).
- [ ] The bots feel fair. In simulations they make their bids about 79% of the time, and a game
      to 500 takes about 10 hands.

## Voice (needs the https dev server; two devices)

New: voice is on by default in private rooms.

- [ ] The first time you're in a private room, a "Games Drawer is better with conversation"
      screen pops up. **Turn on voice** asks for the mic and joins.
- [ ] Next private room: no question, you're straight into voice (a note says how to mute).
- [ ] Leave voice (🎙️ → Leave voice), or answer **No thanks**: later rooms stay quiet and
      don't ask again. The 🎙️ button still joins whenever you want.
- [ ] Public games never ask (voice is only in private rooms).
- [ ] Out of voice is hard to miss: whenever you're not in voice in a private room (No thanks, you
      left, or the browser blocked the mic), the 🎙️ button is red with a crossed-out mic and
      pulses a few times, and the lobby has a red "You're not in voice chat" card with Join.
      If the browser blocked the mic (tap Don't Allow to try it), the card and the voice panel
      say so and how to fix it. Joining voice turns it all back to normal. (On the plain http
      dev server a phone can't do voice at all, so it stays red there: use dev:https.)
- [ ] On the iPhone: after the automatic join, can you hear people straight away, or only after
      tapping the screen once? (Safari is the strictest about sound without a tap.)

Joining, speaking markers and switching games are confirmed. Left to try:

- [ ] Toggling Wi-Fi or briefly locking the phone: voice comes back by itself.
- [ ] "Mute me" and muting another player both work.
- [ ] The voice panel shows each person's link (connecting, relayed, or couldn't connect).
- [ ] Game sound or echo leaking into your mic: try with and without headphones.

## Dominoes (new; private rooms only, under construction)

Your family's rules: double-six set, 4 players, 7 tiles each (all 28 dealt, so no boneyard), and
first to 250. Those live in `DOMINOES_RULES` in packages/shared/src/dominoes.ts. Bigger sets
(double-nine, double-twelve), 5/6/7 tiles and other player counts are for later.

- [ ] Pick Dominoes in a private room (or Play with friends on gamesdrawer.com/dominoes).
- [ ] Whoever holds the 6-6 leads it in the first hand; after that the last hand's winner leads.
- [ ] Tap a tile: green spots show where it can go. Tap a spot to play it there, or tap the tile
      again when there's only one place.
- [ ] Scoring: after each play, if the open ends add up to 5, 10, 15… that player scores it
      ("+10" floats up). The line under the status shows the current total.
- [ ] The spinner (the first double) lets play go off all four sides once both of its main
      sides have tiles.
- [ ] On your turn, tiles that don't fit go grey. On the iPad (Safari) the grey tiles sit in line
      with the others, whole (you saw them jump to the left and get cut off; fixed).
- [ ] If nothing fits, you pass by yourself (there's nothing to draw).
- [ ] Going out scores everyone's leftover pips rounded to 5; reaching 250 ends the game, even
      mid-hand.
- [ ] When a hand ends, the scores come up and stay up: nothing moves on until every person at
      the table taps "Ready for hand 2" (bots and anyone who dropped out don't hold it up).
      "See the board" shows the finished board; "Back to scores" (or the Scores button) goes
      back. The scores say who's ready and who you're still waiting for. Try it with two people.
- [ ] After the game ends, "See the board" works there too.
- [ ] As the table fills up, everything shrinks to fit (phone held either way, and computer).
      The east and west lines both bend down at the edges, like the sides of a table, and the
      spinner's up and down lines run straight. Nothing overlaps (you saw an overlap after a
      double at a corner, and the old bends made a pinwheel shape; both are fixed).
- [ ] Still guesses, worth asking the family: teams or everyone for themselves? Who leads each
      hand after the first? What does a blocked hand (nobody can play) score? Right now the
      lowest hand scores everyone else's pips, rounded to 5.

## Jigsaw puzzle (public and private rooms)

Up to 4 people build one puzzle together; no bots. 50 pictures: Penny Pickles, your sailboat,
and 48 public-domain or CC0 photos and paintings.

- [ ] The picker shows all 50, with "Penny Pickles" (was "Happy pup") and "Sailboat" first.
      Scroll through the 28 new ones (monarch butterflies to plankton swirls at the end) and
      tell me any you'd rather swap out. Three spares are ready: a Bierstadt painting of
      Yosemite, a second carousel, and a Bahamas tidal-flats photo from space.
- [ ] Start a puzzle with Sailboat. It's portrait (taller than wide), unlike the rest, so check
      the pieces and the frame look right at 100 pieces.

- [ ] Pick Jigsaw in a private room (or Play with friends on gamesdrawer.com/jigsaw). Choose a
      picture and 6, 20, 50, 100, 250, 500 or 1000 pieces (6 and 20 are for little kids). The
      real count is sometimes a little off (54 for 50) so the pieces come out square; the line
      under the buttons says exactly.
- [ ] Pieces should look like real jigsaw pieces, every one a bit different: tabs in and out,
      bigger and smaller, not all in the middle of the edge.
- [ ] Drag a piece: it comes to the top, and the others see it move with your name on it.
      Two people can't hold the same piece; the second gets "X has that piece."
- [ ] Drop a piece close to one it fits with: it snaps into line and they move together after.
- [ ] Drop a piece or group near where it belongs in the dashed frame: it locks in and can't be
      moved again (so nobody knocks the finished part around).
- [ ] Scroll or pinch to zoom; drag the empty table to look around; Fit shows everything.
      Looking around stops at the table's edge, and zooming stops at about the whole table
      (out) or a big close-up of a piece (in), so you can't lose the puzzle off-screen.
- [ ] Picture shows the finished image in the corner. Edges hides the middle pieces (just on
      your screen). Tidy spreads loose pieces back around the edges for everyone.
- [ ] Other people's pointers show with their names (on a computer, as they move the mouse).
- [ ] Leave and come back, or press New puzzle: it's saved. Under "Continue a puzzle" it shows
      with its progress, and Continue brings it back exactly as it was. Saves untouched for 90
      days are deleted.
- [ ] A puzzle with nothing placed (no pieces joined, nothing in the frame) isn't kept: New
      puzzle says so, and it doesn't show up under Continue. Your old test puzzles with nothing
      placed disappear the next time the server starts.
- [ ] The ✕ next to a saved puzzle takes it off your list (it asks first if it's started). It's
      only your list: a friend who worked on it can still continue it.
- [ ] Magnifier, single pieces only: dragging a joined group (any size) gets no magnifier.
- [ ] Magnifier near the top: pick up a piece near the top of the screen. The magnifier stays
      straight above your finger and simply slides off the top (under the room's buttons) as you
      go higher; the table doesn't move by itself any more. Holding a piece right at the edge of
      the screen still scrolls the table, as before.
- [ ] The 🔍 button (only on phones and tablets) turns the magnifier off and on, and it stays
      that way next time. The very first time the magnifier shows, a note says what it is.
- [ ] Finish one (50 pieces is quick): "Finished!" with the time, and a message in chat.
- [ ] Try 1000 pieces on a computer: cutting takes a moment ("Cutting pieces… 40%"), then
      dragging should still feel smooth.
- [ ] Phone held upright: the table starts small (pinch to zoom). Sideways fills the screen
      better. Tell me which you'd rather have.
- [ ] Not built yet: uploading your own photos (needs AWS for the nudity scan), turning pieces,
      and controller support for the puzzle.

## Chat filter (new)

- [ ] Public games: the chat box says "keep it family friendly", and typing a swear word greys
      out Send with a "Keep Games Drawer chat family friendly" note. Clean words bring it back.
- [ ] Private rooms start on **Hide**: swear words reach everyone as ****.
- [ ] Menu → Chat filter switches between None, Hide and Block; anyone can change it, chat says
      who did, and the lobby shows the current setting.
- [ ] Slurs stay blocked even on None.
- [ ] Harmless words that used to be caught now go through: cockpit, cumin, shiitake, flame
      retardant, booby trap. Tell me any others you hit and I'll add them to the allow list.
- [ ] Names with swearing are refused in every room.

## Controller (new; an Xbox controller, by USB or Bluetooth)

Press any button on the controller once the page is open (browsers only show it after that).

- [ ] Home page: the d-pad or left stick moves a green highlight between buttons, A presses,
      B goes from a game page back to all games.
- [ ] Lobby and menus: same; **Menu** opens the room menu anywhere and B closes it.
- [ ] Tanks: the left stick aims (sideways) and sets power (up/down), with fine control for
      small pushes; the d-pad steps; A fires; bumpers or triggers drive; View shows scores; any
      button drops you from the helicopter.
- [ ] Hearts and Spades: left/right moves a highlight through your hand, A picks (passing) or
      plays the card, Y passes your three, up goes to the buttons and down comes back. In Spades
      the bid buttons light up on your turn.
- [ ] Try it on the iPad or iPhone with the controller paired too.

## Sounds

Tank sounds are confirmed good. Left to try:

- [ ] The card sounds in Hearts and Spades, and the tile sounds in Dominoes (they reuse the card
      sounds for now: a slide when a tile is played, a chime when someone scores).

## Admin page (new)

- [ ] With `npm run dev` running, open http://localhost:5173/admin and sign in with the password
      you chose. (Your password's hash is in `.env.local`, which git ignores; the password itself
      isn't stored anywhere.) A wrong password says so; five wrong in a row locks sign-in for 15
      minutes.
- [ ] Play a game in a private room for a few minutes with two tabs, chat a bit, go back to the
      lobby, then reload /admin (numbers refresh each minute): the game shows person-hours, time
      with 2+ people, and chat per person-hour. Today / 7 / 30 / 90 days switch the range.
- [ ] Sign out works, and the page stays signed in for a week otherwise.

## Later, once it's hosted

The deploy pipeline is built and tested here, but its first real run needs the AWS account.

- [ ] gamesdrawer.com and staging.gamesdrawer.com both load over HTTPS on a phone and the PC,
      and www.gamesdrawer.com lands on gamesdrawer.com.
- [ ] Start a game, then push a change: your game keeps going on the old version until it
      ends, and a room created after the deploy gets the new one.
- [ ] Voice relay: open a private room link with `?relay=1` on the end on two phones using cell
      data. Each person in the voice panel should show "(relayed)".
- [ ] A friend in another house joins a private room and you talk while playing.
- [ ] Admin page: put the password's hash in Parameter Store (command in deploy/README.md),
      deploy, then sign in at gamesdrawer.com/admin from your phone.
