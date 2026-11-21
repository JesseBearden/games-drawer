# Things to try

A running list of changes that need a hands-on check. Claude adds to it whenever something
changes and removes items once you've tried them. Tell me what was wrong (or just "all good")
and I'll update it.

_Last updated: 2026-11-21_

## Getting set up

- On the PC: `npm run dev`, then open http://localhost:5173.
- For phones (and anything with voice): `npm run dev:https`, open the **https** Network URL it
  prints, and accept the certificate warning once.
- Each browser tab is its own player, so two tabs (or a phone plus the PC) make a two-player room.

## Fixes from the code review (new)

- [ ] **A locked phone keeps its turn**: at a Hearts, Spades, Dominoes or Three Thirteen table,
      lock the phone on your turn for about 10 seconds and unlock it. Nothing was played for you.
      Lock it for over 20 seconds: the computer plays for you until you're back.
- [ ] **Coming back to a closed table**: alone at a puzzle, lock the phone for 2 minutes or more,
      then unlock. It says the table has closed (with a way home), not "Reconnecting…" forever.
- [ ] **A dead connection recovers by itself**: at a table on a phone, switch Wi-Fi off and on
      (or walk out of Wi-Fi range onto cellular). Within about 15 seconds it reconnects.
- [ ] **Two tabs**: at a table, duplicate the tab. The new tab stays at the table; the old one
      says "Opened in another tab".
- [ ] **Tanks**: in a room of people, someone taps Leave: their tank gets a computer's name and
      drives itself (no frozen tank), and a newcomer can still get in.
- [ ] **Joining is quicker**: joining a card or puzzle table no longer waits for the Tanks
      pictures. Tanks still looks right (felt ground, tanks, helicopters).
- [ ] **Next deploy**: stay at a table (with voice on) through the whole deploy. Nobody should get
      knocked off or have to reconnect.

## Security pass (new)

Small fixes from the security review. Nothing should look different; these check nothing broke.

- [ ] **Admin sign-in** (after the next deploy): `/admin` with the right password signs you in
      the first time. A wrong one says "That's not the password."
- [ ] **Jigsaw saves**: start a puzzle, place a piece, put it away, then start another. Back on
      the picker, **Continue a puzzle** still lists the first one, and bringing it back works.

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

## Felt look (trial, `felt` branch)

Same layout as Cut Paper, made of felt (`felt.css`). Dominoes is the first game done properly;
the rest pick up the felt colours and depth but haven't been looked at yet. The felt itself is
matched to your swatch sheet (`scripts/felt-textures.cjs`).

**The table comes first (new, 2026-11-20).** Nothing starts until everyone says they're ready.

- [ ] **Start a table** asks only for your name and the mic now (no game list). From `/dominoes`
      (or another game's page) it says "Your table opens with Dominoes picked".
- [ ] You land at **Your table**: who's here (with Invite someone right under them), the mic
      strip if your mic is off, the games, and (for Hearts, Spades and Dominoes) **Pick your
      seat**: four seats around a little piece of green table. Nothing is dealt yet.
- [ ] Invite someone from a second device. They land at the table too, seeing the same pick.
- [ ] Tap a seat: it turns sunflower with your name. Tap another: you move. Someone else's seat
      can't be taken ("Liz is sitting there."). Empty seats say "Tap to sit" (the computer plays them).
- [ ] Spades: "Partners sit across from each other. Jesse and Mom play against the computer."
- [ ] The strip at the bottom stays on screen as you scroll: the game's name, who we're waiting
      for, and **I'm ready**. Tap it: your name turns mint with "✓ Ready", and the others see
      "Everyone else is ready." once only they are left. **Not ready** takes it back.
- [ ] When the last person taps Ready, everyone goes into the game, sitting where they picked
      (partners across from each other in Spades). Messages says "Everyone's ready: Spades is starting."
- [ ] Anyone can pick a different game at the table; everyone's Ready starts over.
- [ ] Someone whose phone drops at the table doesn't hold up the start (their seat is played for
      them until they're back, or until someone new needs their place once the table is full).
      Someone who taps Leave table gives up their seat.
- [ ] Menu, Switch game: everyone goes back to the table, nothing picked.
- [ ] A controller can do it all: move to a game, A to pick it, down to I'm ready, A.
- [ ] No "Message filter" line at the bottom of the table any more (it's still in the Menu).

**Fixes from your walk-through (new, 2026-11-20, later):**

- [ ] **Leave and come back over and over** (say a phone, with a computer already at the table under
      the same name): the phone is "Jesse 2" every time, never 3 or 4, and the table never says
      it's full. Leave table now gives up your place for good; coming back is joining again.
- [ ] Four at the table, then one phone just closes its tab (no Leave table). A fifth person is
      turned away for the first 10 seconds ("full"), then gets in, taking the seat that was being
      played for the one who left.
- [ ] Jigsaw on a touch screen: dragging a piece shows the magnifier with no popup explaining it.
- [ ] White felt (Join on home, the Ready strip, others' messages, the sound knob) is calmer:
      finer grain, fewer dark flecks. Does it still read as felt? Does it still look dirty?
- [ ] Phone, with the bar's dropdown open: turn the phone and the dropdown folds itself.
- [ ] Dominoes, zoomed in: the tiles fade softly on all four sides, in Safari too. On a phone
      held sideways they fade at the board's own sides (clear of the names and your tiles); on
      an iPad or computer they carry on under the side name tags and fade near the screen's edges.
- [ ] **Name tags all one size** (Hearts, Spades, Dominoes; phone, iPad, computer): the tags
      across the top of a phone split the width evenly, yours matches them, and a long name
      shrinks a little then ends in "…". Someone who dropped out shows a small "zzz" after
      their name, and their tag stays two lines like everyone's.
- [ ] No "Bleep Bloop" any more (too like Beep Boop).
- [ ] No "Work in Progress" under Hearts, Spades or Dominoes at the table (turned off for now).
- [ ] Hearts and Spades: the cards look like thin card stock (a soft shadow close under them, no
      thick lower edge), not tiles. A picked card and the winning card still lift off the table.
- [ ] Open an invite link for a table that has closed (or come back to one, say after your phone
      slept a long time): "This table has closed", centred under the picture, with just Back to
      home. No red note under it saying the same thing again.
- [ ] Dominoes: when a line reaches the edge it turns as an L, the turning tile just past the
      end of the line (not tucked beside the last tile). A line never turns at a double or
      right after one: it runs on a little past the edge, so no double looks like a spinner.
- [ ] Jigsaw, "Continue a puzzle": each saved puzzle is on white felt (easy to read), with a red
      bin button instead of "Remove". Each is one row, even on a phone: picture, name, Continue and
      the bin (the details wrap under the name; on the narrowest phones the little picture goes).
      The bin still asks first if the puzzle is part done.
- [ ] **iPhone home screen icon, turning the phone** (your bug: after turning sideways and back,
      taps landed a status bar's height below your finger, and one finger zoomed the puzzle).
      **First delete the Games Drawer icon and add it to the home screen again** (an iPhone keeps
      the old status bar setting for an icon it already has). Then:
  - [ ] The page sits below the time and battery, as it first did, and reaches all the way to
        the bottom of the screen: no dark band, nothing cut off (Start puzzle, Jigsaw's tools).
  - [ ] Turn sideways and back two or three times: every button still works where you tap it
        (the dropdown, Help, Jigsaw's tools at the bottom), and the page settles back in place
        within a moment: not pushed up under the time with a dark band at the bottom. (A small
        jump as it settles is expected: we tried to remove it and let it go, 2026-11-20.)
  - [ ] Jigsaw and Dominoes: after turning, one finger moves the table and two fingers zoom.
  - [ ] Start, join and the table page still scroll where they should, and typing a message
        doesn't leave the page shifted after the keyboard closes.
  (Tried and dropped: running the page under the status bar. iOS 26 then leaves a status
  bar's height empty at the bottom and cuts the page off there.)

- [ ] **New (2026-11-21):** home has your felt hands-and-puzzle picture and felt drawer icon; the
      game tiles have your felt icons, two across, with bigger names.
- [ ] The table-code box on home is clean white (no felt grain).
- [ ] Names stop at 15 letters as you type (the box says "First name, like Mike or Mike B").
- [ ] Reload the page at a table (or let a phone sleep a few seconds): Messages says nothing. Stay
      away more than 10 seconds: "Liz left.", then "Liz is back." when you return. Leave table
      on purpose: "Liz left." straight away.
- [ ] iPad and computer: the bar has your mic on the left, and Messages, Invite, Help and Menu
      together on the right, each with a small icon.
- [ ] Phones: the bar is folded. Your mic is a red tab in the top-left corner; a caret tab in the
      top-right drops Messages, Invite, Help and Menu down as a stack of buttons. Using one, or
      touching the game, folds it again. A red dot on the caret means unread messages.
- [ ] Dominoes are matte ceramic (clean warm white, pressed-in pips, crisp middle line).
- [ ] Tanks on a phone held sideways: the controls run down the right edge (Angle, Power, Fire),
      and the battlefield gets the full height to their left.
- [ ] Tanks: the tanks, helicopters, parachutes, hearts, windsock and clouds are your felt art.
      Each tank is its player's colour. (A no-wind windsock is still the old paper one.)
- [ ] `/felt-swatches.html` on the dev server: our felt laid out like your swatch sheet. Look at
      it on the iPad, where it's sharper than any screenshot.
- [ ] Dominoes on the iPad and a phone: green card-table felt (from your mock), cream felt bar,
      tags and buttons with a lit top edge, a visible side (a darker edge of their own colour)
      and a soft shadow, like layers of felt. "Ends add up to" is near-white on the green.
- [ ] Pieces look laid on top, like the mock: a lit top edge and a dark shadow hugging them, no
      visible side. No blue outlines on buttons anywhere; something picked lifts or turns cobalt.
- [ ] Zoom the Dominoes board (pinch or wheel): the green cloth zooms and pans with the tiles.
      Tiles carry on sideways out to near the screen's edges and fade there (under the side name
      tags), not at the board's narrower box. The dashed "play here" spot keeps a tile's
      corners (not a pill) and thin dashes however far you zoom.
- [ ] Hearts, Spades and Dominoes are all on the green card table.
- [ ] Jigsaw: the table is a calm light grey felt, every loose piece casts a small shadow (so
      light pieces still stand out), and the frame for the finished picture is a sheet of cream
      felt with a shadow and the dashed edge. Joined pieces have no shadow across their seams, and
      pieces locked into the frame lie flat. Zoom and drag around: the cloth and the
      frame's felt zoom and move with the pieces.
- [ ] On a computer, buttons (the bar, Menu, Jigsaw's tools at the bottom) lift when the
      pointer is over them and sink when pressed.
- [ ] Words look pressed into the felt. Words straight on a table (green or grey) are
      near-white; "Pick a game" sits on the cream felt, like home.
- [ ] Messages is a cream felt sheet: "Liz joined." in dark ink, others' notes white felt, yours
      cobalt. Between Dominoes hands, "Everyone else is ready." is dark ink on the score sheet.
- [ ] On a phone held sideways, open the Menu and scroll it: the felt moves with the words.
- [ ] The Menu has no thin lines between its parts. The sound slider is a groove in the felt,
      filled with cobalt up to the volume, with a white felt knob; it goes all the way to both
      ends.
- [ ] Pressing a button pushes it down into the felt.
- [ ] Tiles are satin ivory (no shine): warm cream with a faint grain along their length, a
      softly rounded edge, dark painted pips, a cut-in middle line, a thick
      side and a dark shadow. The one you pick lifts higher (no blue glow); the ones you can't
      play are a darker, warm ivory with faded pips.
- [ ] Scores, Menu and Invite dim the table under a warm shadow, not a blue one.

- [ ] Tanks: a felt battlefield (muted blue sky, slate felt mountains, ground in layers of olive,
      tan, orange and rust over charcoal). Craters cut cleanly through the layers. All the controls
      are one felt strip along the bottom (move from level 4, Angle with its number, Power with its
      number, Fire), on every device; there's no Angle / Power tag in the top right any more. The
      whole battlefield sits above the strip. On a wide phone, past the map's edges the hills carry
      on as a faded mirror (no smeared streaks).
- [ ] Spades: Us and Them sit in the table's top-left corner and read "Us 0 · 2 of 5 tricks".
- [ ] A phone held sideways, end of a Dominoes hand: all four scores and both buttons fit.
- [ ] Tanks held upright: the Menu and Messages open on top of "Turn your phone sideways".

## Cut Paper, steps 2–4: the games (new)

Every game now has the paper look. Try each one on the phone (both ways up), the iPad and the
computer:

- [ ] **Hearts and Spades**: ivory card stock (lighter than before) with the cut-paper royals, on the blue mat. Name
      tags are paper; whose turn it is turns yellow and lifts.
      The other players' tags show just their name and score (no pile of cards). On a phone held upright
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
- [ ] Tap a tile: dashed blue spots show where it can go. Tap a spot to play it there. Tapping
      the tile again now puts it back down instead of playing it (even when there's only one
      place).
- [ ] No line of text under the board while you play ("Your turn", "Waiting for…" and "Tap where
      it goes" are gone): the yellow name tag shows whose turn it is, and the board gets the
      room. The line only comes back to say something ("Nothing fits: you pass", "Hand 1 is
      over").
- [ ] Scoring: after each play, if the open ends add up to 5, 10, 15… that player scores it
      ("+10" floats up). "Ends add up to" sits under your tiles (sideways: under the block of
      tiles on the right).
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
- [ ] Phone held upright: every name is on one line. A long name shrinks to fit (the other
      players' names share one size, so they match), and only past a small size is it cut off
      with "…".
- [ ] Phone held sideways (new layout): everyone's names down the left, yours first, in turn
      order, with Scores under them; the board in the middle; your tiles in rows of four on the
      right. Try it with Safari's address bar showing too: Scores and the "Ends add up to" line
      should both be on screen. Tell me if the tiles are too small, or if Scores belongs
      somewhere else.
- [ ] Hearts and Spades upright: your name and Scores are the same height there too.
- [ ] iPad and computer (all three card games): every name tag is the same width (changed
      2026-11-20; they used to be as wide as each name). Your tag and Scores line up exactly,
      top and bottom, even on your turn (your tag no longer lifts there; the yellow says it's
      your turn).
- [ ] **Zoom**: there are no zoom buttons. On the phone and iPad, pinch the board to zoom, and
      drag with one finger to look around. Dragging never
      plays a tile; tapping a spot while zoomed in still plays it. On the computer, the mouse
      wheel (or a trackpad pinch) zooms around the pointer, and you can drag the board. A new
      hand starts zoomed all the way out. Safari shouldn't zoom the whole page when you pinch the
      board. Controller: the shoulder buttons zoom.
- [ ] **Names never wrap, anywhere** (all games): on the name tags in Hearts, Spades and
      Dominoes, the score sheets, who's at the table on Pick a game, the mic list, Messages and
      the Tanks scores, every name is on one line. A long one shrinks a little on the name tags
      and score sheets, then ends in "…".
- [ ] **Computer players** (Hearts, Spades, Dominoes) have made-up robot names (Robo-Bob, Beep
      Boop, Sprocket, Tin Can Tom…), never two the same at a table, and a small computer screen
      after their name on the name tag. A long name gives way to "…" but the screen stays. The
      score sheets leave the screen off. No "Computer" label on the name tags, and no "Partner" in Spades
      (your partner is the one across from you, on lilac). Tanks keeps its tank-pun names, and
      its scores no longer say "(computer)". Someone who dropped out gets a small "zzz" after
      their name (no longer an "Away" line). Does it make it clear to your mom who's a person?
- [ ] **Score sheets flipped** (all three): one row per player (Spades: Us and Them), you first,
      the name on the left with all the room it needs. Across: the points each hand scored
      ("Hand 1", "Hand 2"…), then a narrow, bold Total. The hand that just ended is darker. On a
      phone only the last 3 hands show (8 on bigger screens); older ones drop off the left.
      Before any hand is over it's just names and totals.
- [ ] As the table fills up, everything shrinks to fit (phone held either way, and computer).
      The east and west lines both bend down at the edges, like the sides of a table, and step
      outward again at the bottom edge. The spinner's up line bends east at the top edge instead
      of growing into a tall column (new); its down line runs straight between the two sides.
      Nothing overlaps, and the bends never make a pinwheel shape.
- [ ] Still guesses, worth asking the family: teams or everyone for themselves? Who leads each
      hand after the first? What does a blocked hand (nobody can play) score? Right now the
      lowest hand scores everyone else's pips, rounded to 5.

## Three Thirteen (new)

- [ ] At the table, pick Three Thirteen (the blush tile). **How many players?** shows 2 · 3 · 4.
      With two of you, pick 2: the line under it says "just the people here, no computers", and
      the side seats say "Not playing". Start: only the two of you are at the green table, across
      from each other.
- [ ] Round 1 deals 3 cards, "3s are wild". On your turn the pile and the top discard glow: tap
      one to take it. Then tap a card to lift it, and tap it again (or tap the discards) to throw
      it away. The card you took from the discards says "Taken" and can't go straight back.
- [ ] **Drag** cards in your hand to put them in any order, on the phone and the computer. Reload
      the page: your order is kept.
- [ ] Cards in a meld are tinted light green (nothing looks cut off at the bottom any more); wild
      cards a star; the tag beside your name says "Left over: 7 pts" (what the cards outside your
      melds would cost), or "All in melds" when nothing is left over.
- [ ] When you can go out, **Go out** appears (and the card to throw is outlined). Everyone else
      then gets one last turn, then everyone's hand is shown with the points, and the score sheet
      says "Round 1".
- [ ] A late round (10+ cards) on an upright phone: the hand fits in one row and every corner
      is readable.
- [ ] Play to the end (or with computers): lowest total after 11 rounds wins.

## Your own photos in Jigsaw (new)

On your computer the check is pretend: every photo passes except one exactly 404 pixels wide.
The real check (Amazon Rekognition) only runs on the site. For the phone, use `npm run dev:https`.

- [ ] At a Jigsaw table the first tile is **Your photo** (a dashed space with a camera). Tap it:
      a note says only this table sees it, it's deleted when the table closes (so it can't be
      continued another day), and it's checked first. **Choose a photo** opens your photos;
      **Not now** closes the note.
- [ ] Pick a photo: the tile says "Checking…", then your photo shows next to it as "Jesse's
      photo", picked, and chat says "Jesse added a photo for a puzzle." Someone else at the table
      gets it in their picker too (not picked for them).
- [ ] On the iPhone, try one taken upright and one sideways: both puzzles come out the right way
      up. A screenshot or a very wide panorama says it's too small if it's under 300 pixels high.
- [ ] Start a puzzle of it: the status says "20 pieces · Jesse's photo". Put it away from the
      Menu: it asks first and says it can't be continued later, and it isn't under "Continue a
      puzzle".
- [ ] Everyone leaves the table and it closes (a minute later): the photo is gone with it.
- [ ] **Before the first push with this** (see deploy/README.md, "Your own photos"): run
      `npm run infra -- deploy` so the boxes may call Rekognition, and turn on the AWS AI
      services opt-out policy (the privacy page says Amazon doesn't keep the photos). Then on
      the site: an everyday family photo passes, and so does a beach photo.
- [ ] Read the new **Privacy** section "Your own photos" and the new **House rules** line ("Only
      add photos you're allowed to share"). Both pages are dated November 21.

## Jigsaw puzzle

Up to 4 people build one puzzle together; no bots. 51 pictures: Penny Pickles, your sailboat, Judy Jalapeño,
and 48 public-domain or CC0 photos and paintings.

- [ ] **iPad with a trackpad or mouse** (new fix): pinching on the trackpad zooms the puzzle around the
      pointer, not the whole page (you saw the page zoom). Two-finger scrolling zooms too. The same pinch
      zooms the domino board. Pinching anywhere else at the table does nothing; the home and join
      pages still zoom like any web page.

- [ ] **On the iPhone** (new fix): tap a few pictures and piece counts. Only the tick moves;
      the other pictures stay put instead of all blinking and redrawing.
- [ ] **New order each time** (new): the pictures come in a different order every time the
      picker opens (open /jigsaw twice, or finish or put away a puzzle), and the first one is
      picked. Your "Continue a puzzle" list stays on top, newest first.
- [ ] **No 1000** (new): the sizes are 6 · 20 · 50 · 100 · 250 · 500. A puzzle you saved at
      1000 pieces still shows under "Continue a puzzle" and still opens.
- [ ] **Fewer pieces for small pictures** (new): pick Noodle: 250 and 500 are greyed out, and
      the line under the buttons says "up to 100". Pick 250 on a big picture, then Noodle: it
      drops to 100; back to the big one: 250 again. Penny Pickles, Sailboat, Milli and Leeloo go
      up to 250, the rest to 500. A small photo of your own works the same way.
- [ ] The picker shows all 56 pictures (51 then, plus Milli, Sucia, Cricket, Leeloo and Noodle).
- [ ] **Pictures only on this computer**: with `npm run dev`, "Tree House" and
      "Nephews" are mixed in with the rest, and play like any other. They're in
      `local-puzzles/`, which git ignores: `git status` never lists them, and the hosted site
      won't have them. Add more with `npm run local-puzzle -- photo.jpg "Title"` (see README).
      Scroll through the 28 new ones (monarch butterflies to plankton swirls at the end) and
      tell me any you'd rather swap out. Three spares are ready: a Bierstadt painting of
      Yosemite, a second carousel, and a Bahamas tidal-flats photo from space.
- [ ] Start a puzzle with Sailboat. It's portrait (taller than wide), unlike the rest, so check
      the pieces and the frame look right at 100 pieces.

- [ ] Pick Jigsaw on Start a table (or open /jigsaw). Choose a
      picture and 6, 20, 50, 100, 250 or 500 pieces (6 and 20 are for little kids). The
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
      with its progress, and Continue brings it back exactly as it was. Saves untouched for 30
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
      Then press New puzzle: the finished one isn't under "Continue a puzzle" (no more "Look
      again"; new). Finished puzzles already on your list drop off too.
- [ ] Try 500 pieces on a phone: cutting takes a moment ("Cutting pieces… 40%"), then
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

## Chat stays at the table (new)

What people type lives only with the table (the last 10 messages, so someone who joins late
sees them) and is gone when the table closes. The server's daily chat log just counts messages
for the admin page: no words, no names. The one exception is a message someone reports, which
is saved with the sender's name so it can be looked at later.

- [ ] Send a few messages at a table, then open `logs/chat-<today's date>.jsonl`: the new lines
      say `delivered` (or `blocked` for a caught one) with no words or names in them.
- [ ] Tap someone else's message → Report: its line in that file (`reported`) has the words
      and who sent them.
- [ ] The admin page's chat numbers (messages sent, blocked, reported) still count up.

## Privacy, House rules, fonts and logs (new)

- [ ] Under home, Start a table and an invite page: "Chat messages are erased with the table.
      Privacy · House rules". Each link opens its page (gamesdrawer.com/privacy, /rules) with
      Back to home at the bottom. Read both: anything wrong or missing?
- [ ] At a table, the Menu has Privacy and House rules under Close; they open in a new tab, so
      you stay at the table.
- [ ] The site looks the same as before (same letters): the fonts now come from the site
      itself, not Google.
- [ ] After a deploy, the admin page offers Today, 7 days and 30 days (no 90).
- [ ] **People are counted by device now:** after a deploy, open a few tabs on the computer and
      join tables; Today's "people who played" goes up by one for the computer, not one per tab.
      (Days before the deploy still read high.)

## The way in keeps still (new)

- [ ] On the iPad (either way up), the phone and the computer: tap **Start a table** on home. The
      picture stays the same size and the buttons the same width; nothing zooms. The same going
      to a table's invite link. **Start with mic on** shows without scrolling (on a phone held
      sideways it may need a little scroll).
- [ ] **Nothing to scroll on the iPad:** on its side in Safari, home, Start a table and an invite
      page each fit on one screen (logo to "Chat messages are erased…"), so scrolling with a
      finger or the mouse moves nothing and the logo never slides off the top. (The very first
      time, with an empty name box, Start a table may be a little taller on an iPad mini.)
- [ ] **Where a page does scroll** (a phone held sideways, or bigger text in the iPad's
      settings), the felt moves with the words instead of staying still behind them.
- [ ] Tapping into the table-code box on the iPad still brings up the iPad's keyboard bar, and
      Safari slides the page up for it; that part is the iPad's.

## Who's here, and Messages (new)

- [ ] **Someone arrives:** when Miranda joins your table, "Miranda is here." pops up over the
      game for a few seconds, with the little join sound. It doesn't put a red dot on Messages.
      Leaving doesn't pop up.
- [ ] **A message while Messages is closed** pops up too, with their name in bold ("Sammy: I
      can't hear you"), and the red dot still shows on Messages. A long message is cut short in
      the pop-up; Messages has all of it.
- [ ] **Messages starts closed when every mic is on:** on the computer, start a table with your
      mic on and Messages starts closed; with your mic off it starts open. Join a table where
      someone has their mic off (with yours on): it starts open. On phones it always starts
      closed. Once you open or close it, it stays that way.
- [ ] **Puzzle: who's talking.** On two devices with mics on, the other person's pointer and
      name ripple with rings while they talk, and stay on the table while they do, even if they
      hold still. When they stop, it fades a few seconds later. If their pointer had already
      faded, talking brings it back where they left it.

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
      with 2+ people, and chat per person-hour. Today / 7 / 30 days switch the range.
- [ ] Sign out works, and the page stays signed in for a week otherwise.
- [ ] **Voice** (new): after two people talk at a table (mic on, two devices), the admin page's
      Voice section shows people who talked, the share of voice links that went through the
      relay, how many people needed it, and links that never connected. On home Wi-Fi expect
      0% relayed; with `?relay=1` on the page address it should say 100%.

## Pick a game at a table

- [ ] On the iPad (either way up) and a computer, every game name sits inside its tile on Pick a
      game (you saw "Dominoes" run off the edge). Narrow tiles get a slightly smaller picture and
      name. The browser tab says "Table BXNKZ" (it said "Room").

## Idle tables (new)

A table closes after 10 minutes with nobody playing or talking (someone who left a game open
and walked away), so it doesn't hold one of the 50 table spots forever. Tapping, typing, a
controller button or talking (mic on) all count as someone being there.

- [ ] Leave a table alone for 9 minutes (on a computer you can leave the tab open): a "Still
      playing?" sheet comes up for everyone at the table. "Keep playing" (or tapping anywhere)
      makes it go away, and the 10 minutes start again.
- [ ] Leave it alone through the warning: everyone lands on the home page with "This table
      closed after 10 minutes with nobody playing or talking."
- [ ] Talking counts: two people with mics on who just chat (no taps) for 20 minutes keep the
      table.

## Later, once it's hosted

The deploy pipeline is built and tested here, but its first real run needs the AWS account.

- [ ] gamesdrawer.com and staging.gamesdrawer.com both load over HTTPS on a phone and the PC,
      and www.gamesdrawer.com lands on gamesdrawer.com.
- [ ] Start a game, then push a change: your game keeps going on the old version until it
      ends, and a room created after the deploy gets the new one.
- [ ] Voice relay: open a table link with `?relay=1` on the end on two phones using cell
      data. Each person in the voice panel should show "(relayed)".
- [ ] A friend in another house joins your table and you talk while playing.
- [ ] **Link preview** (after the next push): send a new invite in Messages. The picture is felt
      now (felt hands with a yellow and a red piece, "Play a game together."), not the paper
      one. A link you sent before keeps its old picture, so send a fresh one.
- [ ] Admin page: put the password's hash in Parameter Store (command in deploy/README.md),
      deploy, then sign in at gamesdrawer.com/admin from your phone.
