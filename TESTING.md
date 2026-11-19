# Things to try

A running list of changes that need a hands-on check. Claude adds to it whenever something
changes and removes items once you've tried them. Tell me what was wrong (or just "all good")
and I'll update it.

_Last updated: 2026-11-18_

## Getting set up

- On the PC: `npm run dev`, then open http://localhost:5173.
- For phones (and anything with voice): `npm run dev:https`, open the **https** Network URL it
  prints, and accept the certificate warning once.
- Each browser tab is its own player, so two tabs (or a phone plus the PC) make a two-player room.

## Cut Paper, step 1: the way in (new)

The site now looks like cut paper, and the way in is new. The games themselves still have their
old look until steps 2–4.

- [ ] **Home** (`/`): the hands-and-puzzle picture (never cut off now, and no white box behind it on the iPad), and **Start a table** on screen without scrolling,, "Play a game together.", **Start a table**,
      and a box for a table code. Try it on the phone, the iPad and the computer.
- [ ] **Start a table** (and the join page): **Back to home** is a button under the others now,
      not a link at the top.
- [ ] **Start a table**: the five games on their own colors (Jigsaw picked to start), your name,
      then **Start with mic on** or **Start with mic off**. The first time, the name box is
      empty: tapping Start without a name asks for one right there. The dice picks a silly name.
      After that your name shows as a line with **Change**.
- [ ] A game's own address picks that game: `/dominoes`, `/tanks` (and
      `/tankyouforbeingafriend`).
- [ ] **A code**: type a table's 5 letters on Home and tap Join. A wrong or old code says "This
      table has closed" with just **Back to home**.
- [ ] **Who's there, before you join**: the join page's heading names everyone at the table
      ("Join Jesse, Sam and Mory for a puzzle"), so you can back out first. If whoever invited you
      has stepped away, it says "Jesse invited you to play" with who's there underneath. Leave it
      open while someone else joins or leaves: the list catches up within about 8 seconds.
- [ ] **Invite**, then type a name (the box suggests Penny; try your mom's), then **Send the invite**: the phone's share
      sheet opens with "Liz, come play a game with us!" and the link. On a computer the link is
      copied. Opening that link on another device shows "Jesse invited you to play" with **Liz**
      already filled in, so it's one tap to join. A link with no name works too (they type theirs).
- [ ] The invite sheet also shows the table code, for reading out over the phone.
- [ ] **The bar**: Mute mic, Invite, Help and Menu in the middle; **Messages** at the right end.
      Messages only shows while the Messages panel is closed (the panel has its own Close). On a
      computer Messages starts open; on a phone or an iPad held upright it starts closed.
- [ ] **Help**: how to play the game on screen, in plain paragraphs, plus the keyboard keys.
- [ ] **Menu** (no "Menu" heading now): Switch game and Leave table at the top, then the Mic part (who's talking, mute
      someone just for you, turn your mic off), your name, sound, **Full screen** on its own,
      and the message filter (three separate buttons now). The table code is no longer in the
      menu; it's in the Invite sheet, for reading out over the phone.
- [ ] **Messages** are easier to read: a lighter sheet of sky paper and bigger text.
- [ ] **Switch game** shows the game picker on the blue mat, with who's at the table. Picking one
      takes everyone there.
- [ ] **Messages**: little paper notes on a blue sheet. Yours are blue on the right.
- [ ] Leaving the table goes back Home.
- [ ] Public play is set aside for now: no Play now anywhere.
- [ ] Link previews (iMessage etc.) use the new share card. Add to Home Screen uses the drawer icon.

## Cut Paper, steps 2–4: the games (new)

Every game now has the paper look. Try each one on the phone (both ways up), the iPad and the
computer:

- [ ] **Hearts and Spades**: ivory card stock (lighter than before) with the cut-paper royals, on the blue mat. Name
      tags are paper; whose turn it is turns yellow and lifts. Computer players say "Computer".
      The others' hands show a little pile of card backs and "13 cards". On a phone held upright
      the cards are bigger than before; tell me if they're too big or too small.
- [ ] **Spades**: your team's tags are lilac; the bid buttons are paper; "Us" and "Them" are
      little paper tags.
- [ ] **Dominoes**: the tiles are card stock with navy pips, your hand sits straight on the
      blue (the brown rack is gone), the tile just played has a yellow edge, and where you can play is a dashed blue
      outline (it doesn't pulse any more). Points scored pop up on a yellow paper chip.
- [ ] **Score sheets** (all three): paper sheets; "Back to lobby" is now **Switch game**.
- [ ] **Jigsaw tools on a phone**: Picture, Edges, Magnifier, Tidy and Fit on one row. **New
      puzzle** moved to the top of the Menu (above Switch game) while a puzzle is out.
- [ ] **Full screen on a phone**: on the iPhone, Menu → Full screen opens "Play full screen" with the
      steps to add Games Drawer to your home screen (Android shows its own steps). Open it from the
      new home screen icon: it's full screen, and the Full screen button is gone from the menu.
- [ ] **Menu, Help and Invite** always open at the top, even if you scrolled down last time.
- [ ] **Jigsaw percentage**: a piece set in its spot in the frame counts now (it showed 0% before).
      The percentage is pieces in place: joined to another, or set in the frame.
- [ ] **Jigsaw starting view**: the whole table fits between the progress tag and the tools strip,
      so no pieces start hidden under the tools (on the iPad with Messages open, too).
- [ ] **Jigsaw**: the setup is a paper sheet with paper picture tiles; the board is the blue mat
      with a cream frame where the picture goes; the tools are a paper strip. On a phone the
      tools wrap onto two rows instead of running off the screen. Other people's pointers show
      their names in ink.
- [ ] **Tanks**: paper sky and clouds, torn-paper hills, and ground made of thick strips of red
      clay paper under a thicker strip of grass, each strip shadowed by the one above. Craters show pale torn edges. The tanks, helicopter,
      parachute, shells, explosions and smoke are all paper now, and the player colors are the
      site's paper colors (blue, red, yellow, green first).
- [ ] **Tanks screen**: lives, wind and aim are paper tags; Fire is a red paper button (yellow
      for Spread and Drop); the labels say "Angle", "Power", "Fire" instead of capitals. On a
      sideways phone the wind tag sits under the lives tag.
- [ ] **Tanks on a phone held sideways** (new): the whole battlefield fits, from the hilltops to
      the deepest valley. Your tank never sits below the bottom edge any more (it did in Safari
      with its address bar showing). When the screen is too short to show it all at full width,
      the map shrinks to fit and the ground past its edges shows, dimmed, at the sides. While
      you're riding in the helicopter, the view keeps the helicopter in sight so you can pick
      your drop. Tell me if the tanks get too small.
- [ ] Tanks held upright says "Turn your iPad sideways to play" on the iPad ("phone" on a
      phone, "tablet" on other tablets).
- [ ] **The folding bar** (Tanks, phone held sideways): the bar is folded away and the battle
      runs to the top of the screen. The little tab with a down arrow in the top right corner
      pulls the bar down; the tab then hangs under it, pointing up, to push it back. Using
      anything on the bar folds it again (Mute mic waits a moment so you see it change), and so
      does touching the battlefield. A red dot on the tab means a new message. iPad and computer
      keep the bar as it was. While folded, you can't see at a glance whether your mic is on;
      tell me if that's a problem.
- [ ] The knock-out notes say it in words ("Liz hit Sam") instead of emoji, with each name
      underlined in its tank's color.

## Mic (new; needs the https dev server; two devices)

The mic is chosen on the way in now, so the old "Games Drawer is better with conversation"
pop-up is gone.

- [ ] **Start/Join with mic on**: the browser asks for the mic right when you tap it, and you're
      at the table with the mic on. The bar's first button says **Mute mic**; tap it and it
      turns red: **Unmute mic**.
- [ ] **With mic off**: the button is red, **Turn on mic**. The game picker has a red "Your mic
      is off" strip too.
- [ ] Tap **Don't Allow** when the browser asks: the button stays **Turn on mic**, and tapping
      it opens "Your mic is blocked", with steps for iPhone/iPad, Android and computers.
- [ ] **The iPad fix**: with the mic on, switch to another app (or the home screen) for a
      minute while someone else talks to you. Before, they stopped hearing you after a few
      seconds. Now they should still hear you while you're away, and everything should carry on
      when you come back. Please try this one and tell me how it goes.
- [ ] On the iPhone: with the mic on, can you hear people straight away, or only after tapping
      the screen once?

Still to try from before:

- [ ] Toggling Wi-Fi or briefly locking the phone: voice comes back by itself.
- [ ] Game sound or echo leaking into your mic: try with and without headphones.

## Tanks

Phone layout is confirmed good. Still worth noticing over a few games:

- [ ] Helicopters don't drop you right next to another tank.
- [ ] Driving climbs noticeably steeper hills than before.
- [ ] The ladder ends at level 10: 3 faster shells, 4 movement, 5 a triple every 3rd shot,
      6 extra life, 7 explode on death, 8 faster movement, 9 a quintuple every 3rd shot,
      10 nuke.
- [ ] Players with more than 3 / 6 / 9 kills show a gold +2 / +3 / +4 bounty tag.
- [ ] A win posts "X won!" in chat, the screen just says who won, and the nuke fills the whole screen.
- [ ] The iPhone lock-ups from last time don't come back.

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

## Spades (work in progress)

Pick it on Start a table (or open /spades).

- [ ] You and the player across are a team ("partner" on their name); the first two people in
      a room are opponents, and a third person partners the first.
- [ ] Bidding goes round the table; on your turn a row of buttons (Nil, 1–13) appears.
- [ ] Spades can't be led until one has been played; tapping a card you can't play says why.
- [ ] The middle shows each team's score and tricks won against its bid ("Us 120 3/6").
- [ ] After each hand: each team's bid, tricks and points, nils made or missed, and bag penalties.
- [ ] Phone upright and sideways both fit (sideways, the team scores sit in the top-left corner).
- [ ] The bots feel fair. In simulations they make their bids about 79% of the time, and a game
      to 500 takes about 10 hands.

## Dominoes (work in progress)

Your family's rules: double-six set, 4 players, 7 tiles each (all 28 dealt, so no boneyard), and
first to 250. Those live in `DOMINOES_RULES` in packages/shared/src/dominoes.ts. Bigger sets
(double-nine, double-twelve), 5/6/7 tiles and other player counts are for later.

- [ ] Pick Dominoes on Start a table (or open /dominoes).
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
      "See the board" shows the finished board, and the Scores button next to your name
      turns into a blue "Back to scores" (just the one button, on that line). The scores say who's ready and who you're still waiting for. Try it with two people.
- [ ] After the game ends, "See the board" works there too.
- [ ] Phone held upright: your name and Scores are side by side, the same height.
- [ ] Phone held sideways (new layout): everyone's names down the left, yours first, in turn
      order, with Scores under them; the board in the middle; your tiles in rows of four on the
      right. Try it with Safari's address bar showing too: Scores and the "Ends add up to" line
      should both be on screen. The computer players lose their "Computer" line here to make
      room. Tell me if the tiles are too small, or if Scores belongs somewhere else.
- [ ] Hearts and Spades upright: your name and Scores are the same height there too.
- [ ] **Zoom** (new): once there's a tile on the board, **Zoom in** shows under it, with
      "Ends add up to" in the middle; **Zoom out** appears once you've zoomed. Try on the phone
      and iPad: pinch the board to zoom, and drag with one finger to look around. Dragging never
      plays a tile; tapping a spot while zoomed in still plays it. On the computer, the mouse
      wheel (or a trackpad pinch) zooms around the pointer, and you can drag the board. A new
      hand starts zoomed all the way out. Safari shouldn't zoom the whole page when you pinch the
      board. Controller: the shoulder buttons zoom.
- [ ] **Score sheets on a phone** (all three games): names stay whole ("Jesse" no longer splits
      into "Jes / se"); two-word names wrap at the space. Only a very long single word (like a
      20-letter name) breaks, and only that one.
- [ ] As the table fills up, everything shrinks to fit (phone held either way, and computer).
      The east and west lines both bend down at the edges, like the sides of a table, and the
      spinner's up and down lines run straight. Nothing overlaps (you saw an overlap after a
      double at a corner, and the old bends made a pinwheel shape; both are fixed).
- [ ] Still guesses, worth asking the family: teams or everyone for themselves? Who leads each
      hand after the first? What does a blocked hand (nobody can play) score? Right now the
      lowest hand scores everyone else's pips, rounded to 5.

## Jigsaw puzzle

Up to 4 people build one puzzle together; no bots. 50 pictures: Penny Pickles, your sailboat,
and 48 public-domain or CC0 photos and paintings.

- [ ] The picker shows all 50, with "Penny Pickles" (was "Happy pup") and "Sailboat" first.
      Scroll through the 28 new ones (monarch butterflies to plankton swirls at the end) and
      tell me any you'd rather swap out. Three spares are ready: a Bierstadt painting of
      Yosemite, a second carousel, and a Bahamas tidal-flats photo from space.
- [ ] Start a puzzle with Sailboat. It's portrait (taller than wide), unlike the rest, so check
      the pieces and the frame look right at 100 pieces.

- [ ] Pick Jigsaw on Start a table (or open /jigsaw). Choose a
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
      who did, and the Menu shows the current setting.
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
- [ ] Play a game at a table for a few minutes with two tabs, chat a bit, Switch game, then reload /admin (numbers refresh each minute): the game shows person-hours, time
      with 2+ people, and chat per person-hour. Today / 7 / 30 / 90 days switch the range.
- [ ] Sign out works, and the page stays signed in for a week otherwise.

## Later, once it's hosted

The deploy pipeline is built and tested here, but its first real run needs the AWS account.

- [ ] gamesdrawer.com and staging.gamesdrawer.com both load over HTTPS on a phone and the PC,
      and www.gamesdrawer.com lands on gamesdrawer.com.
- [ ] Start a game, then push a change: your game keeps going on the old version until it
      ends, and a room created after the deploy gets the new one.
- [ ] Voice relay: open a table link with `?relay=1` on the end on two phones using cell
      data. Each person in the voice panel should show "(relayed)".
- [ ] A friend in another house joins your table and you talk while playing.
- [ ] Admin page: put the password's hash in Parameter Store (command in deploy/README.md),
      deploy, then sign in at gamesdrawer.com/admin from your phone.
