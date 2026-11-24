# Things to try

A running list of changes that need a hands-on check. Claude adds to it whenever something
changes and removes items once you've tried them. Tell me what was wrong (or just "all good")
and I'll update it.

_Last updated: 2026-11-23 (Mahjong)_

## Getting set up

- On the PC: `npm run dev`, then open http://localhost:5173.
- For phones (and anything with voice): `npm run dev:https`, open the **https** Network URL it
  prints, and accept the certificate warning once.
- Each browser tab is its own player, so two tabs (or a phone plus the PC) make a two-player table.

## Newest: Mahjong (2026-11-23)

- [ ] **Your table:** pick Mahjong. Points (No points / With points) and, with points, How long
      (One round / Full game) show above the seats, and the seats go round the other way (the
      next player on your right). Do the words make sense?
- [ ] **The opening** (a phone upright): on an empty table the tiles swirl round in rings without
      ever landing on each other, with a clatter (sound on); then they gather up and the wall
      is built from them; Roll the dice if you're East. Your tiles now
      appear one by one with a click, a short drop, never from above your name. Too long?
- [ ] **iPhone held sideways, in Safari:** swipe up on the table: Safari's tabs and address bar
      tuck away and the table grows. Your strip is one row (your name at the left, Discard at the
      right); Scores and the news line ("Botley threw away…") are on the table under See all discards. Are
      your tiles still big enough?
- [ ] **The deal:** four tiles at a time round the table (then one each, and one more for the
      dealer); the wall opens as it goes and everyone's tiles appear as they're dealt.
- [ ] **The wall on a laptop:** a pinwheel square like your photos, with each player's last 5
      discards inside it (the one on offer a little bigger). Nothing should overlap your tiles, the wall or anyone's
      tiles. Are the small discards readable? Every discard and set taken clicks.
- [ ] **No "Your turn" words:** whose turn it is shows only by the yellow tag; the line under
      your name (or under See all discards sideways) only has news: a discard you can take, "You
      can go Mahjong!", "Waiting for the others…".
- [ ] **Your tiles:** two rows of 7 upright, one row sideways (on an iPhone in Safari too: nothing should overlap, and the side players keep clear of the mic and caret tabs). Tap a tile to lift it, then
      Discard (or tap it twice). Drag one to move it. The tile you drew says New. Big enough?
- [ ] **Claims:** when a discard is yours to take, the buttons and a 15-second bar appear (it was
      5), with the tile beside "Robin threw away". Is 15 seconds right?
- [ ] **Claims stand out:** when anyone makes a Pung, Chow or Kong, the word pops up by their
      name, the tile slides from the middle into their set, and the set lifts for a moment; the
      computers wait 2.5 s meanwhile. Clear enough? Too slow?
- [ ] **Messages:** every Pung, Chow and Kong (yours and the computers') shows as a grey line,
      like "Sprocket took Jesse's 5 dots for a Pung." Easier to follow?
- [ ] **The felt tiles:** the blue sliver under each face, the kraft strip under face-up sets
      (kraft is the nearest felt to the rust I suggested). Do they look like real tiles?
- [ ] **With points:** the end of a hand lists what it scored and why. Readable for learning?

## Tanks on an iPhone held sideways, in Safari (2026-11-23)

- [ ] **Swipe to tuck Safari away** (works; it was a bit jittery): the battlefield now follows
      the screen frame by frame as Safari's bars slide away, instead of stretching and then
      zooming to catch up. Smoother? If it still shakes, is it the battlefield, the buttons and
      tags, or the whole page? Turn the phone upright and back: does everything still line up?
      From the home screen icon nothing should scroll.
- [ ] **"Swipe up for fullscreen":** start Tanks with the phone sideways and Safari's bars showing:
      the hint shows faintly across the middle for about 3 seconds (and goes as soon as you swipe).
      Readable but not in the way? It shouldn't show with the bars already tucked away, or from
      the home screen icon. Start upright, then turn the phone: it shows then instead.
- [ ] **The controls hold still:** tap Power + and − a few times: the box stays the same width as
      the ".5" comes and goes.
- [ ] **Only the Drop button drops you:** on the helicopter, tapping or swiping the battlefield
      no longer drops you; the Drop button does.
- [ ] **One row along the top:** the mic tab is a little shorter, with your hearts and "LV · kills"
      on one line beside it, and the wind beside the caret tab. Nothing overlaps (try "Turn on
      mic", and Mute once it's on). Is the text big enough to read?
- [ ] **One message at a time:** who knocked out whom, "Your mic is on" and chat messages take
      turns in the top row between your lives and the wind, a couple of seconds each (a long chat
      message a bit longer, on two lines). Nothing pops up anywhere else, except "Jesse wins!"
      in the middle. Too quick, too slow?
- [ ] **No "Protected" line** (every device): the blue bubble round a new tank blinks for its
      last 3 seconds, faster in the last one. Clear enough?
- [ ] **Controls closer to the edge:** hold the phone with the Dynamic Island on the left; the
      Angle / Power / Fire panel should sit near the right edge instead of a thumb's width in.
      Turned the other way it stays clear of the island. Nothing clipped by the rounded corner?
- [ ] **The battlefield fits:** it runs from the left edge to the controls, under the top row, with
      no hills behind the controls. Is any tank hidden under anything?
- [ ] **The aim line** (every device): short at low power, about four tank-widths at full. Does it
      feel right?
- [ ] **A very wide computer window:** the faint background mountains carry on across the greyed
      sides past the battlefield, with no straight edges where they used to stop.

## Talking ripples from every name tag (2026-11-23)

- [ ] **Two tabs (or a phone) with mics on, at Your table and in a game:** while someone talks,
      rings of their tag's colour ripple out from their name tag and their seat on Your table,
      and from their tag in Hearts, Spades, Three Thirteen and Dominoes (the three little bars
      are gone from tags). Easy to see who's talking? The Ready tick still sits on the corner.
      In Dominoes on a phone held upright, the side tags ripple too. The mic list in Menu still
      has the bars.

## Only buttons stand up, colours that stay with the name (2026-11-22)

- [ ] **Flat felt:** anything you can't tap lies flat on the table or page (a thin shadow, no
      rounded lit edge): name tags in every card game, the people and taken seats on Your table,
      the red "Your mic is off" strip, messages in Messages, Jigsaw's "how far along" chip and
      tools strip, Tanks' score panels, Three Thirteen's counters. Buttons still stand up. Does
      anything that IS a button now look flat, or the other way round?
- [ ] **Whose turn** no longer lifts the tag in Hearts, Spades and Three Thirteen (it just turns
      yellow). Still easy to spot?
- [ ] **Your table, two tabs:** each person's name tag at the top is in their own colour, and
      the seat they pick turns that colour too. Open seats are white buttons that stand up.
      "Ready" is a blue tick on the tag's corner. Start Dominoes: each person's tag in the game
      is the same colour as on Your table.

## Dominoes on a phone (trials, 2026-11-22)

- [ ] **Held upright:** the players on your left and right sit up the sides of the board on thin
      one-line tags ("Robo-Bob · 5 pts · 5 tiles"), the left reading upward, the right downward.
      The player across and your own tag are one line too, all four the same length. Yours says
      just your points. "Ends add up to …" sits just above your name and Scores. Is it easy to
      read, and is the board comfortable late in a hand?
- [ ] **A colour each:** every tag is its player's own light felt; the computers take the
      colours nobody has. Whose turn it is: a band of yellow round the tag. Talking: rings of
      their colour ripple out (now on every tag). Too busy, or nice?
- [ ] **Held sideways:** the player across is one line along the top; left and right are turned
      on their side halfway up the edges, the name on one line and "pts · tiles" beside it. Your
      tiles (a fifth smaller) run along the bottom, your name over Scores to their left and "Ends
      add up to" to their right. Are your tiles easy to tap? With Safari's address bar showing,
      your tiles, Scores and the total should all be on screen. At the end of a hand all four
      scores and both buttons fit.

## Your table

- [ ] **Start a table** asks only for your name and the mic. From `/dominoes` (or another game's
      page) it says "Your table opens with Dominoes picked".
- [ ] **Your table**: who's here (with Invite under them), the mic strip if your mic is off, the
      games, and for Hearts, Spades and Dominoes four seats around a little green table. Tap a
      seat to sit, another to move. Someone else's seat says "Liz is sitting there." Spades:
      "Partners sit across from each other…"
- [ ] **The Ready strip** stays on screen as you scroll: the game, who we're waiting for, I'm
      ready / Not ready. When the last person is ready everyone goes in where they sat, and
      Messages says "Everyone's ready: Spades is starting." A new pick starts Ready over; Menu →
      Switch game brings everyone back with nothing picked.
- [ ] **Someone whose phone drops** doesn't hold up the start. Leave table gives up the seat for
      good. Four at the table and one just closes the tab: a fifth person is turned away for 10
      seconds ("full"), then gets in, taking that seat. Leaving and coming back over and over
      never makes "Jesse 3" or a full table.
- [ ] **Someone who left a while ago** (over 20 seconds): pick Three Thirteen with 2 players and
      it's the two of you, not three. Hearts, Spades and Dominoes show a named computer instead.
- [ ] Every game name sits inside its tile on the iPad and a computer. The browser tab says
      "Table" and the code.
- [ ] **Tapping fast** (game, seats, ready, a dozen times in a few seconds): after about 12
      changes in 10 seconds a line says to give it a few seconds.

## The way in, invites and coming back

- [ ] **Home**: the felt hands-and-puzzle picture (never cut off), Start a table on screen without
      scrolling, the game tiles two across with felt icons, a clean white code box. On the iPad,
      phone and computer, nothing zooms or jumps going to Start a table or an invite page. On the
      iPad on its side, each of those pages fits on one screen; where a page does scroll, the
      felt moves with the words. The front picture looks sharp everywhere.
- [ ] **Names**: stop at 15 letters ("First name, like Mike or Mike B"); the dice gives a silly
      one. A name of only dots asks for a letter (emoji are fine), 'Admin' gets a made-up name,
      a look-alike of someone already there gets a 2, and accents work.
- [ ] **Codes**: a new table's code and link have 6 letters and Home says "6 letters". Typing one,
      or pasting a whole invite link, joins. A wrong or old code says "This table has closed",
      centred, with just Back to home.
- [ ] **Invite**, type a name (try your mom's), **Send the invite**: the share sheet opens with
      "Liz, come play a game with us!" (on a computer the link is copied). On another device the
      link shows "Jesse invited you to play" with Liz filled in. The sheet also shows the code.
- [ ] **Who's there, before you join**: the join page names everyone ("Join Jesse, Sam and Mory
      for a puzzle") and catches up within about 8 seconds as people come and go.
- [ ] **Back in a new tab**: close your tab at a table of four and open the link again. For a
      moment "You're already at this table", then "Welcome back, Jesse". Join: your own seat and
      cards, not "Mom 2". From a different device it works once the table has said you left
      (about 10 seconds). Someone else opening the link meanwhile sees "Jesse stepped away and
      may come back." Two tabs side by side are still two people. Tanks gives a fresh tank.
- [ ] **Another table's link** in a tab that's at a table gives the new table's join page; a plain
      reload puts you back in your seat. **Duplicate the tab**: the new one stays, the old says
      "Opened in another tab".
- [ ] **Back to home while it says Joining**: you stay home, even if the table answers late. On a
      dead network Joining gives up in about 10 seconds and says why.
- [ ] **Quiet tables**: after 9 minutes with nobody playing or talking, "Still playing?" comes up
      (Keep playing, or a tap, resets it; someone arriving closes it). Through the warning:
      home with "This table closed after 10 minutes…". Two people just talking keep it open.
- [ ] **A closed table**: alone at a puzzle, lock the phone 2 minutes, unlock: it says the table
      has closed, not "Reconnecting…" forever. After a deploy, an invite link to a table from
      before says closed within about 2 seconds.

## The bar, Menu and Messages

- [ ] **iPad and computer**: your mic on the left; Messages, Invite, Help and Menu on the right,
      each with a small icon. **Phones**: a red mic tab top-left and a caret tab top-right that
      drops the others as a stack; using one, touching the game or turning the phone folds it. A
      red dot on the caret means unread messages.
- [ ] **Menu**: Switch game and Leave table at the top, the Mic part, your name, the sound slider
      (a cobalt groove with a white knob, end to end), Full screen and the message filter, then
      Privacy and House rules (they open in a new tab). Menu, Help and Invite always open at the
      top. On a phone held sideways the felt scrolls with the words.
- [ ] **Full screen on an iPhone** opens "Play full screen" with the Add to Home Screen steps.
      From the home screen icon it's full screen and the button is gone.
- [ ] **iPhone home screen icon, turning the phone** (first delete the icon and add it again):
      the page sits below the time and reaches the bottom; after turning two or three times
      every button works where you tap; Jigsaw and Dominoes still take one finger to move and
      two to zoom; typing a message doesn't leave the page shifted.
- [ ] **Messages**: a cream felt sheet; others' notes white, yours cobalt. On a computer it starts
      closed when every mic is on, open when someone's is off; phones always start closed.
- [ ] **Pop-ups**: "Miranda is here." with the join sound when someone arrives (no red dot); a
      message while Messages is closed pops up with the name in bold.
- [ ] **Coming and going**: a reload or a few seconds asleep says nothing; away over 10 seconds:
      "Liz left.", then "Liz is back."; Leave table: "Liz left." at once.
- [ ] **After locking the phone**: Messages still has everything, with what came meanwhile marked
      unread. A new table starts with no unread mark.
- [ ] **Ctrl+F or Cmd+F** at a table only finds (no full screen).

## Mic and voice (two devices)

- [ ] **Mic on** asks inside the tap; Mute mic turns red as Unmute mic. **Mic off**: a red Turn on
      mic and a red strip at the table. **Don't Allow**: the table's Turn on mic and the Menu's
      both open the steps to allow it.
- [ ] **Through a reload**: a muted mic stays muted, mic off stays off, and someone muted just for
      you stays muted.
- [ ] **Unplug a headset** (or AirPods on an iPhone): the mic carries on with the device's own, or
      shows Unmute mic and one tap brings it back.
- [ ] **Leave while the browser is asking** for the mic, then Allow: the recording light goes off.
- [ ] **iPad in the background** a minute while someone talks: they still hear you. **iPhone**:
      do you hear people straight away, or only after a tap?
- [ ] **Connecting**: same Wi-Fi as quick as before; cell data against home Wi-Fi connects both
      ways (about 6 seconds if it needs the relay); Wi-Fi off and on mid-call comes back every
      time; a locked iPhone for a minute still works both ways.
- [ ] **Through the relay** (`?relay=1` on the page address): two phones on cell data, one an
      iPhone, still hear each other after 11 minutes. Three or more on one home Wi-Fi all connect.
      The admin page's Voice section says 100% relayed (0% on home Wi-Fi without it).
- [ ] **Firefox and Safari voice** sound clear. Echo or game sound in your mic, with and without
      headphones?
- [ ] **A friend in another house** joins your table and you talk while playing.

## The felt look

- [ ] Words look pressed into the felt; words straight on a table are near-white. Buttons lift
      under the pointer and sink when pressed, with no blue outlines. Scores, Menu and Invite dim
      the table under a warm shadow.
- [ ] White felt (Join on home, the Ready strip, others' messages) is calm: still felt, not dirty?
- [ ] **Names never wrap**, anywhere: name tags, score sheets, the mic list, Messages, Tanks
      scores, and lines like "takes the trick" and "wins!". A long one shrinks a little, then "…".
- [ ] **Reduce motion** (phone setting): cards and sheets don't slide, the nuke doesn't shake,
      talking still shows (a steady ring round the tag).
- [ ] **Quicker second visits**: reload at a table and the felt and card backs are there at once;
      a puzzle opened before starts quickly; new art after a deploy shows within ten minutes.
      "Łukasz" looks right on the join page and name tags.
- [ ] **Switching games**: each appears promptly the first time, also on cellular.
- [ ] **Link preview**: a fresh invite sent in Messages shows the felt share picture.

## Hearts and Spades

- [ ] Phone upright: the other three along the top, big cards. Sideways: small name chips, yours
      left of your hand, the middle cards don't overlap. Turning mid-hand keeps your hand centred.
- [ ] One tap lifts a card, a second plays it. Play one from the middle: the rest glide together.
      The cards look like thin card stock; a picked card and the winning card lift.
- [ ] Close the tab mid-hand: a computer plays your seat. Reopen and you get it back. Lock the
      phone on your turn 10 seconds: nothing played for you; over 20 seconds: the computer plays.
- [ ] Scores mid-hand covers all your cards, and Close works wherever you tap.
- [ ] Hearts: computers hold their passes until every person has passed; 100 ends the game with
      New game and Switch game; Menu → Leave works.
- [ ] Spades: the first two people are opponents, a third partners the first; bid buttons (Nil,
      1–13); spades can't be led until broken (tapping says why); Us and Them sit top-left ("Us 0
      · 2 of 5 tricks"); after a hand, bids, tricks, points, nils and bags.
- [ ] The computers feel fair (Spades bots make about 79% of bids; a game takes about 10 hands).
      Their robot names and small computer-screen mark: can your mom tell who's a person?
- [ ] **Score sheets** (all four games): one row per player, you first, a narrow bold Total; on a
      narrow phone (or Display Zoom, Larger Text) names readable and "Ready for round N" in sight.
- [ ] Card sounds, and the tile sounds in Dominoes.

## Three Thirteen

- [ ] **How many players?** 2 · 3 · 4. With two of you, pick 2: "just the people here, no
      computers", and you're across from each other.
- [ ] Round 1 deals 3, "3s are wild". Take from the pile or the discards, tap a card to lift it,
      tap again to throw. The card you took from the discards says "Taken".
- [ ] Drag cards into any order, phone and computer; a reload keeps it. Melds tint light green,
      wilds wear a star every round, "Left over: 7 pts" or "All in melds".
- [ ] **Go out** appears when you can; everyone else gets one last turn, then the hands and the
      score sheet. Still dragging a card when the round ends: the sheet appears when you let go.
- [ ] A late round (10+ cards) on an upright phone fits in one row. Lowest after 11 rounds wins.

## Dominoes

Your family's rules: double-six, 4 players, 7 tiles each (all 28 dealt), first to 250
(`DOMINOES_RULES` in packages/shared/src/dominoes.ts).

- [ ] The 6-6 leads hand 1; then the last hand's winner leads.
- [ ] Tap a tile: dashed spots show where it goes; tap a spot to play, tap the tile again to put
      it back. No text under the board while you play, only when it says something.
- [ ] Open ends adding to 5, 10, 15… score ("+10" floats up; two in a row both show). The
      spinner opens all four sides once both main sides have tiles. Tiles that don't fit go grey
      (in line, whole, on the iPad). Nothing fits: you pass. If there's drawing, the board may
      shrink but the lines don't fold differently.
- [ ] Going out scores the leftover pips rounded to 5 (the winner's total includes them); 250
      ends the game even mid-hand.
- [ ] Hand over: the scores stay until every person taps "Ready for hand 2", saying who you're
      waiting for. "See the board" turns Scores into a blue "Back to scores"; it works after the
      game too.
- [ ] **Zoom**: pinch or drag on a phone or iPad, the wheel on a computer, the shoulder buttons
      on a controller. Dragging never plays a tile. A new hand starts zoomed out. The tiles fade
      softly at the edges, under the side name tags.
- [ ] **Lines**: east and west bend down at the edges like a table's sides, a turn is an L just
      past the end, never at a double; the spinner's up line bends east at the top. Nothing
      overlaps, and never a pinwheel.
- [ ] Matte ceramic tiles: the one you pick lifts, ones you can't play are darker with faded pips.
- [ ] iPad and computer: every name tag the same width; yours lines up with Scores.
- [ ] Still guesses, worth asking the family: teams or everyone for themselves? Who leads after
      the first hand? What does a blocked hand score (now: the lowest scores the others' pips)?

## Jigsaw

- [ ] **Picker**: a new order each time, "Continue a puzzle" on top. Sizes 6 · 20 · 50 · 100 ·
      250 · 500; small pictures stop lower (Noodle at 100). Any of the 56 pictures you'd swap
      out? Sailboat (portrait) looks right at 100. On the iPhone only the tick moves as you tap.
- [ ] **Playing**: pieces all a bit different; your drag shows to others with your name; "X has
      that piece"; pieces snap together and lock into the frame; zooming and looking around stop
      at the table's edge; Picture, Edges, Tidy. Others' pointers move smoothly and ripple when
      they talk.
- [ ] **The felt**: light grey table, a small shadow under every loose piece, a cream felt frame;
      joined seams have no shadow; locked pieces lie flat; the cloth zooms with the pieces.
- [ ] **On a phone**: Picture, Edges, Magnifier, Tidy and Fit on one row; New puzzle is in the
      Menu. The starting view fits between the progress chip and the tools. 500 pieces: "Cutting
      pieces… 40%", then smooth dragging. Upright or sideways: which do you prefer?
- [ ] **Magnifier**: single pieces only; near the top it slides off rather than moving the table;
      the Magnifier button turns it off and on and is remembered. A piece held on an iPhone or
      iPad keeps its soft shadow, also in the magnifier.
- [ ] **Edges**: pull a joined strip off the side: the whole strip stops there. Holding a piece at
      the screen's edge scrolls the table.
- [ ] **iPad trackpad**: a pinch zooms the puzzle (and the domino board), not the page.
- [ ] **Wi-Fi off mid-drag**: once it reconnects, the piece rests where it was.
- [ ] **Tidy** tapped a few times: spreads once, one line in Messages; again after 3 seconds.
- [ ] **Saves**: leave or start a new puzzle and it's under Continue with its progress, back
      exactly as it was; still there after starting another. Nothing placed: not kept. Finished:
      not kept. The red bin removes it from your list only (asks first if started). 30 days
      untouched: deleted. The percentage counts pieces joined or in the frame.
- [ ] Not built yet: turning pieces, controller support for the puzzle.

## Your own photos in Jigsaw

On your computer the check is pretend: every photo passes except one exactly 404 pixels wide.
The real check (Amazon Rekognition) only runs on the site.

- [ ] **Your photo** (the first tile) explains that only this table sees it, it's deleted with the
      table and it's checked first. Choose a photo: the panel shows a small copy, "Getting your
      photo ready…", "Sending…" with a moving bar (on an iPhone too), "Checking it's family
      friendly…", then closes with it picked. Others get it in their picker, not picked.
- [ ] **Cancel** while sending and while checking: nobody gets it. **A turned-away photo** says
      why, with "Try another photo" and "Not now".
- [ ] Upright and sideways iPhone photos come out the right way up; a very wide panorama says
      it's too small. Putting it away warns it can't be continued. The table closing deletes it.
- [ ] **On the site**: an everyday family photo and a beach photo pass, on Wi-Fi and cell data.
      Tell me and I'll read the timings in the admin logs (`photo_added`) with you.

## Tanks

- [ ] **The felt battlefield**: muted sky, slate mountains, layered ground that craters cut
      through cleanly; past the map's edges the hills carry on faded. Tanks, helicopters,
      parachutes, hearts, windsock and clouds are your felt art, each tank its player's colour (a
      no-wind windsock is still the old paper one).
- [ ] **Controls**: one strip along the bottom; on a phone held sideways they run down the right
      edge (Angle, Power, Fire). Held upright it says "Turn your phone sideways" ("iPad" on an
      iPad), with Menu and Messages still opening on top.
- [ ] **Phone held sideways**: the whole battlefield fits; if it's too short the map shrinks; in
      the helicopter the view keeps it in sight.
- [ ] The ladder ends at 10 (3 faster shells, 4 movement, 5 triple every 3rd shot, 6 extra life,
      7 death blast, 8 faster movement, 9 quintuple, 10 nuke). More than 3 / 6 / 9 kills shows a
      +2 / +3 / +4 bounty. A win posts "X won!" and the nuke fills the screen. Knock-outs say
      "Liz hit Sam", names underlined in their colour.
- [ ] Helicopters don't drop you next to another tank; driving climbs steeper hills.
- [ ] Someone taps Leave: their tank gets a computer's name and drives itself.
- [ ] Back from another tab after a minute: no freeze, no pile of explosions. Nobody touching
      anything 10 seconds, then someone fires: it starts at once. Wind and helicopter sounds
      work and go quiet back at a card table.
- [ ] Tanks a second time (Switch game, Tanks again): no Move or TRIPLE READY until earned.
- [ ] A public Tanks game still starts and plays (no voice). No iPhone lock-ups.

## Chat, privacy and the admin page

- [ ] **Chat filter**: private tables start on Hide (****); Menu → message filter switches None,
      Hide, Block, and chat says who changed it; slurs stay blocked on None; names with swearing
      are refused; Send greys out for a caught word right after joining. Tell me any harmless
      message it stops.
- [ ] **Chat stays at the table**: `logs/chat-<date>.jsonl` lines say `delivered` or `blocked`
      with no words or names; a reported message's line has the words and sender.
- [ ] **Privacy and House rules**: linked under home, Start a table and invite pages, and in the
      Menu. Read both: anything wrong? (Recent changes: chat, voice, your own photos, the device
      number, and the address a table was started from.)
- [ ] **Admin** (`/admin`, locally and on the site from your phone): signs in the first time; a
      wrong password says so; five wrong locks 15 minutes; Today / 7 / 30 days; people counted
      by device, not tab; signed in for a week; Sign out works.

## Controller (an Xbox controller)

Press any button once the page is open.

- [ ] Home and Your table: the d-pad moves a green highlight, A presses, B goes back; Menu opens
      the menu anywhere. It can pick a game and get to I'm ready.
- [ ] Tanks: the left stick aims and sets power, the d-pad steps, A fires, bumpers drive, View
      shows scores. Hearts and Spades: left and right move through your hand, A plays, Y passes.
- [ ] It wakes on the first or second press, also after unplugging. Try it paired with the iPad.

## Deploys

- [ ] **Approve from your phone**: when a push is on staging, open CodePipeline's Approve there.
- [ ] **During the next deploy**: stay at a table with voice on; nobody gets knocked off. A Jigsaw
      table started before the deploy still takes a new photo afterwards.
