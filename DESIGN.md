# Games Drawer design rules: Felt

Games Drawer is for hanging out with family and friends, some of them not technical. It works on
phones, tablets and computers, and people should be able to jump in and out easily. Every screen has
to make sense to someone seeing it for the first time.

The look is **wool felt**, like a card table and a puzzle mat. These rules keep it consistent. When
a mock or a new screen disagrees with them, the rules win, or we change the rules on purpose.

## 1. Everything is felt

- **Every coloured shape is its own piece of felt.** It has a palette colour, the felt's grain, and
  a shadow that shows what it lies on. No flat boxes, gradients, glows, frosted glass, or outlines
  drawn as thin lines.
- **Warm, not kiddy.** It should feel inviting and easy, never like a site only for children.
- **Light comes from above.** Shadows fall downward and are warm and dark (`--shade`), never blue
  or black. A piece sits at one of five heights:
  - **Laid down** (`--laid`): felt that isn't a button (user, 2026-11-22): name tags, taken
    seats, the red "mic is off" strip, messages, status and score chips, the strips that hold
    buttons, the little green table on Your table. A thin piece of felt lying on what's under it:
    no rounded, lit edge, just a fine dark line where it meets the felt below. **Only buttons
    stand up** off the table (an open seat is a button: tap it to sit), so you can tell what to
    tap. Whose turn it is shows by colour, not by lifting the tag. Things that pop up over
    everything else (sheets, notices, Messages, the Ready strip) are still held up.
  - **Pressed** (`--lift-0`): a button while it's being pressed (it sinks into the felt).
  - **Resting** (`--lift-1`): buttons, cards, tiles.
  - **Lifted** (`--lift-2`): the thing you picked, hover.
  - **Held** (`--lift-3`): a card or piece you're dragging, and pop-up panels.
- **Depth comes from shadow**, like the user's mock: a lit top edge and a dark shadow hugging the
  piece, not a visible side band.
- **No blue outlines.** Something picked lifts or turns cobalt.
- **Words look pressed into the felt.** Words straight on a table (green or grey) are near-white.
- **A piece shouldn't lie on its own colour.** It needs to differ from what's under it, not just by
  its shadow. Treat this as a strong habit, not a law: if you do stack a colour on itself, decide
  that on purpose. Game tiles are each their game's colour.
- **Tap or type:** things you tap stand up and cast a shadow; boxes you type into are cut into the
  felt (`--cut-in`), so the shadow falls inside.
- **Pictures sit straight on the page, not in a box:** cut them out (a transparent image) rather
  than blending a white background away, which iPad Safari doesn't do inside scrolling pages.
  Never crop them; they keep their own shape.
- **Home and the join page fit one screen:** their main button shows without scrolling on every
  device, so sizes there follow the screen's height as well as its width.
- **Never rotate a piece to change its orientation**, because its shadow would turn with it. Draw the
  vertical version instead, as with dominoes. (Writing can run sideways: see Dominoes on a phone.)

## 2. Colours

Use as many felt colours as make sense. Only the **signal colours** are strict: each one means
exactly one thing, so nobody has to guess.

| Signal | It means |
| --- | --- |
| Cobalt | The main button (one per screen), the words on other buttons, links, something picked |
| Sunflower | Whose turn it is |
| Tomato | Something is off: mic muted, unread messages, mic blocked, leaving |

The rest: paper (cream, the page), white, mat (grey), the green card table (`--baize`), dove
(the light grey Jigsaw table), sky, mint, butter, lilac, peach, blush, kraft and grass. The exact
colours are the user's swatch sheet, in `felt.css`; `/felt-swatches.html` on the dev server lays
ours out like it. Add a colour when something needs it; each one needs its own felt sheet (see
"Where things live").

- **Each game has its own colour**, used for its tile: Jigsaw sky, Dominoes mint, Hearts butter,
  Spades lilac, Tanks peach, Three Thirteen blush, Mahjong kraft.
- **Ink on any felt needs a contrast ratio of at least 4.5:1.** On the deeper colours use full ink,
  even for small notes.
- **One cobalt main button per screen.** Other buttons are white felt with cobalt words.
- **Player colours** where you tell people apart on the board (Tanks, Jigsaw pointers) come from
  `packages/shared/src/palette.ts`: cobalt, tomato, sunflower and grass first. Names in the Tanks
  notes are ink, underlined in the tank's colour (coloured text is hard to read).
- **Each person's own felt** (a trial, user 2026-11-22; `felts.ts`): a light felt that stays with
  the name. Their name tag on Your table, the seat they pick there, and their name tag in
  every card and tile game (Dominoes first; Hearts, Spades and Three Thirteen since 2026-11-25)
  are all in it; the computers take the colours nobody has. They're sky, lilac, peach and
  mint first, then blush, kraft, white and dove. Never sunflower or butter (whose turn it is),
  tomato (something's off), cobalt (a button) or grass (it vanishes into the green table). In
  a game whose turn it is shows as a band of sunflower round that person's tag. Ready on Your
  table is a cobalt tick on the tag's corner.
- **Talking shows as rings** of the tile's own colour rippling out from a person's tile: their
  name tag and seat on Your table and their name tag in every card game (user 2026-11-23), as
  round a Jigsaw pointer. With less motion asked for, it's one steady ring. Only a list (who's on
  the mic) uses the three little bars. Someone counts as talking until 0.4 s after their voice
  drops, so the rings carry on through the pauses between words instead of starting over, and
  each ring is its own layer, so it never redraws the felt under it (2026-11-24).
- **Playing cards are ivory card stock**, thin (a soft shadow close under them, no thick edge).
  - **Code draws everything that has to be exact:** corners, numbers, suit marks, the layouts of the
    number cards, and the layered Aces. Generated pictures get pips and corners wrong, so never
    take card mechanics from them.
  - **The Jacks, Queens and Kings** are the user's portraits, one per card, in
    `public/art/cards/`, with their shadows baked in. Don't put SVG filters on cards: they made
    frames slow enough to drop controller presses.
  - **Jokers** are the user's art, as whole card faces (`joker-black.webp`, `joker-red.webp`).
  - Suits are classic red and black.
  - **Backs are the user's felt card backs**: 30 of them, `public/art/backs/back-01` to
    `back-30.webp`. A game picks one at random for the whole table, a new one each new game
    (`CARD_BACK_COUNT`); maybe a chooser later.
- **Dominoes are matte ceramic**: clean warm white, pressed-in pips, a crisp middle line.
- **Illustrations** can use any colours they need, like skin tones.

## 3. Words

Use one word for each thing, everywhere.

| Say | Don't say |
| --- | --- |
| table | room, party, lobby, session |
| table code, or code for short | room code, PIN, ID |
| Start a table | create, host |
| Join | enter, connect |
| mic | voice, voice chat, audio. Exception: help for allowing the microphone says "microphone", because that's the word in the browser's own prompt. |
| Mute mic / Unmute mic | an icon on its own |
| Messages | chat |
| Invite | share, send link |
| Switch game | change game, back to lobby |
| Leave table | exit, quit, disconnect |
| the computer (in a sentence that needs it: "the computer plays the empty seats"). On a player's name tag, just a robot name and a small computer screen, since a word there takes room the tag doesn't have. | bot, AI, CPU |
| Away (someone who dropped out) | disconnected, offline |
| Your turn / Liz's turn | waiting for Liz… |
| Work in Progress | under construction, beta, still being built |

Game names are exactly as in the catalog: Tanks, Hearts, Spades, Dominoes, Jigsaw, Three Thirteen,
Mahjong.

**How to write:**
- **Buttons say what will happen, starting with a verb:** "Start with mic on", not "OK",
  "Submit" or "Continue".
- **Use sentence case.** No all-caps labels.
- **Use people's names:** "Jesse invited you to play."
- **A name never wraps onto a second line** (user, 2026-11-18). Wherever a name shows, it stays on
  one line, and a name too long for its room ends in "…" (`.pc-nm`). On name tags and score
  sheets it first shrinks a little to fit (`fitOneLine`, `fitScoreTable`), and names side by side
  share one size.
- **No technical words** (server, connection, permission, sync, host, guest). When something goes
  wrong, say what to do: "Your mic is blocked." with a button: "Show me how".
- **No emoji in the interface.** They look different on every device. People's own messages can
  have them.
- **No lone icon buttons:** a button has words (an icon beside them is fine).

## 4. Type and size

- **One font: Atkinson Hyperlegible Next**, served by the site itself. Use 400 for text and 800
  for headings, buttons and names. Letters that are easy to mix up (I l 1, O 0, b d) look
  different.
- **Text is 18 px on phones**, and small notes never go below 15 px.
- **Anything you can tap is at least 48 px tall**, with at least 8 px between tappable things.
- **Every screen works from a 360 px phone up to a desktop.** The page never scrolls sideways.
- **On a phone, the main button is visible without scrolling.**

## 5. Motion

- **Pieces slide and drop into place, with a tiny settle at the end.** No fading pieces in and
  out, no spinning, no endless bouncing.
- **Turn movement off when the device asks for less motion.**

## 6. Layout

- **Use one column on phones.** A desktop gets more room, not more things.
- **Never arrange four things in a rotating pinwheel** (it can look like a swastika). Mirror them
  instead, the way a domino cross has mirrored arms. The one exception is Mahjong's wall (user,
  2026-11-23): a closed square whose four sides interlock at the corners, like a real table's.

## At the table

- **The table comes before the game** (user, 2026-11-20). Starting a table asks only for a name
  and the mic; everyone gathers at **Your table** first: who's here (with Invite), the mic, the
  games (anyone picks or changes the pick), and for Hearts, Spades and Dominoes four seats round
  a small piece of green table (tap to sit; nearest you at the bottom, then round the way play
  goes). A strip that stays at the bottom says who we're waiting for, with **I'm ready**. The
  game starts when everyone here is ready: someone away doesn't hold it up, and the computer
  plays the empty seats. A game's own page (`/dominoes`) opens the table with that game picked.
  Switch game brings everyone back here with nothing picked. Home → Start a table → Your table
  stays three pages (user, 2026-11-20).
- **Six at a table, for Jigsaw** (user, 2026-11-25). A table holds as many as the game being
  played takes (`maxPeople` in shared/games.ts: Jigsaw 6, the rest 4 so far), and six while it's
  picking a game. So a fifth or sixth person can only come in while the table is picking or doing
  a puzzle; mid-game the join page says the table is playing that game, which is for up to 4, and
  lets them in by itself once there's room. With more here than a game takes, its tile is laid
  flat and faded with "Up to 4" on it, and the line under Pick a game says which games fit. A
  fifth person arriving lets go of a four-person game the table had picked (a line in chat says
  so). Voice is a mesh, so six people means five streams each way per phone; the relay holds 60
  slots, 20 per household (deploy/turnserver.conf).
- **The way in keeps still from page to page** (user, 2026-11-20): home, Start a table and a
  table's invite page show the hands-and-puzzle picture at exactly the same size, and their buttons
  at the same width, so going from one to the next doesn't zoom. Each fits one screen, down to an
  iPad mini on its side in Safari. Where a page scrolls, its felt moves with it, and it stops at
  its ends instead of stretching past them: a phone shows black in that gap (2026-11-23), and a
  still felt behind it looked off.
- **Typing on an iPad with a keyboard attached** (user, 2026-11-23): nothing moves, as in an
  app. Safari slides the whole page up whenever the box you pick sits where its little hovering
  bar comes or within 50 points above it, and a page can't stop that (we tried; putting it back
  afterwards jumps). So on a tablet the message box sits about 130 points up, clear of all that. With a whole keyboard on the
  screen, the box still slides up into view.
- **The bar** (user, 2026-11-25), the same on every screen: your mic as a felt tab hanging from
  the top-left corner, and two paper tabs the same size in the top-right corner, Messages (a
  speech bubble; a tomato dot means unread messages) and the menu (three lines). **Invite and Help
  are in the menu**: once a game is going, few people invite anyone or look at Help. The game sits
  below the tabs, except on a phone held sideways, where it runs to the top and keeps its top
  corners clear for them. A window under 500 px either way is as small as a phone, so it's laid
  out exactly as a phone is, every phone style included (Tanks' slim top row and side controls
  held sideways, Messages over the game and closing after you send). Real phones and full-size
  screens are unchanged: what decides is touch only where touch matters (tapping a card to lift
  it, Tanks' touch hints, hover effects, the keyboard, Safari's bars).
- **The mic button says what it will do:** Mute mic, or Unmute mic / Turn on mic (tomato).
- **Everything else opens as a felt sheet over the dimmed table** (a warm shadow), one at a time:
  the menu, the invite, help. Tapping the dimmed table closes it. Sheets always open scrolled to
  the top.
- **The menu is the same at every game:** the game's own "change what we're doing" actions (like
  Jigsaw's New puzzle) go at its top, above Switch game and Leave table, not in the game's tools.
  Under them, with no heading (user, 2026-11-25): everyone's name tag as on Your table, in their
  own felt, you included, rippling while they talk, wrapping onto more rows on a phone. Each tag
  has a mic mark (on, or struck through: grey when off, tomato when it's your own and muted), so
  who's on the mic is part of who's here, not a second list. **Tap your own tag to change your
  name** (it's a button there, standing up, with a pencil before the mic mark). **Invite is the
  next tag along**: an empty white one with a big cobalt +, here and on Your table. Then turning
  your mic on or off; then sound; then full screen and **Game Rules** (it was Help). No headings
  for those: **a thin strip of kraft felt** lies between the menu's parts. Muting someone else
  just for you isn't offered there (user: it might confuse); it's still in a message's Mute.
- **The menu and Game Rules have a header:** the title and Close on a raised strip of kraft felt.
  Only the body under it scrolls, and on computers its scroll bar is a strip of kraft felt you
  can drag, in a groove (Firefox gets plain kraft; phones and iPads show no bar).
- **The message filter is in Messages:** a funnel beside its Close opens None / Hide / Block under
  the heading (user, 2026-11-25).
- **Game tools stay on one row**, even on a 360 px phone (smaller text before a second row).
- **Messages is a cream felt sheet.** Others' notes are white felt, yours are cobalt.
- **Messages starts closed when everyone at the table has their mic on** (user, 2026-11-20):
  talking, nobody needs it. Otherwise it starts open where there's room beside the game and
  closed on phones. Once you open or close it yourself, it stays as you left it.
- **Little notes pop up over the game** and go by themselves: someone arriving ("Miranda is
  here.", with the join sound), and other people's messages while Messages is closed, which also
  count on the red dot. Arrivals and leavings are never counted as unread, and leavings don't pop
  up.
- **Before you join, the join page names everyone at the table:** "Join Jesse, Sam and Mory for a
  puzzle." That way you can back out first. The list refreshes while the page is open.
- **Invite links name who sent them, and optionally who they're for.** The server keeps those
  names, and the link only carries a random token, so a link can't claim to be from someone it
  isn't.
- **Privacy and House rules** (user, 2026-11-20) are plain reading pages at /privacy and /rules,
  linked under every way-in page and in the menu. Keep the privacy page true to the code: change
  it in the same commit as anything it describes (what's kept, for how long, who else is
  involved), and update its date. **Before every push, read both pages against what's being
  pushed**; `packages/server/test/privacy.test.ts` catches the numbers and outside servers, the
  rest needs reading.

## The games

- **Card and tile games (Hearts, Spades, Dominoes, Three Thirteen)** are played on the green card
  table.
  - **Name tags** are felt laid flat on the table (they aren't buttons); whose turn it is gets
    sunflower. **Every tag is the same size, whatever the name** (user, 2026-11-20): a long name
    shrinks a little, then ends in "…". Tags never grow a third line: someone who dropped out
    gets a small "zzz" after their name, and computer players a small computer screen; both stay
    in view when a long name is cut, and score sheets leave them off.
  - **Computer players** have made-up robot names (`ROBOT_NAMES`; never robots from films, shows
    or toys, and no two that look alike). No "Computer" or "Partner" label on the tag.
  - **Spades:** every tag is its player's own colour (the team colour went, user 2026-11-25:
    your partner is always the one across). On a phone, Us and Them sit in the middle's top-left
    corner, under the player across.
  - **Other players' hands** aren't shown; the tags keep just the name and score.
  - **Your name and Scores** sit side by side, the same height. There's only ever one Scores
    button: after a hand, while you look at the board, it becomes a cobalt "Back to scores".
  - **Score sheets** have one row per player (you first): the name with all the room it needs,
    then the points each hand scored, then a narrow, bold Total. The hand just ended is darker.
    Phones show the last 3 hands, bigger screens 8 (`scoreSheet.ts`).
- **Dominoes**: the places you can play are dashed (they don't pulse). Lines turn at the edge of
  the table as an L (the turning tile just past the end of the line), but never at a double or
  right after one, which would look like a spinner: those run on a little past the edge instead.
  East and west mirror each other (never a pinwheel).
  - **Two, three or four players** (user, 2026-11-25): the table picks how many, as in
    Three Thirteen (two sit across from each other; the empty seats don't show, and aren't on the
    score sheet). Everyone always gets 7, so two leave 14 in the boneyard and three leave 7; four
    take all 28. Nothing fits: "Nothing fits: draw a tile" and a Draw a tile (13 left) button, one
    tile a tap, until something fits; with nothing left to draw, you pass. The boneyard shows
    only as its count under the board ("Boneyard: 13"): no pile, the phone has no room for one.
  - **Playing:** tap a tile, then tap its spot. Tapping the picked tile again puts it back. No
    hint text while you play: the yellow shows whose turn it is, the dashed spots where a tile
    can go. The line under the board appears only when there's news ("Nothing fits: you pass").
    "Ends add up to" sits under your tiles.
  - **The board zooms** with a pinch, the mouse wheel (or a trackpad pinch), or a controller's
    shoulder buttons; no zoom buttons. Drag to look around; a drag is never a tap. The green
    cloth zooms with the tiles, and tiles fade near the screen's edges, under the side tags.
  - **On a phone, every card and tile game** (user, 2026-11-22 for Dominoes, 2026-11-25 for
    Hearts, Spades and Three Thirteen): everyone sits on their own side of the table.
    The players on your left and right have their tags turned on their side up the edges (the
    tops of the letters toward the screen's edge, so left reads upward and right downward:
    mirror images, never a pinwheel), the player across is one line along the top, and your own
    tag (in Dominoes) leaves out your tile count. Held upright, every tag is one line, and in
    Dominoes "Ends add up to" sits above your name; held sideways, the side tags are two lines
    (name, then the score), your hand runs along the bottom, with your name over Scores on its
    left (Three Thirteen adds what's left over between them). Dominoes' tiles are a fifth
    smaller there, with the total on their right. On tablets and computers the side players' tags
    lie flat at the sides, as before.
- **Three Thirteen** (user, 2026-11-20), with the user's family rules: two decks with their
  jokers, 11 rounds (3 cards up to 13), jokers and the round's own rank wild, Ace low with no
  wrapping, any number of wilds in a meld, one last turn each after someone goes out, no adding to
  other people's melds. Unmelded cards: Ace 1, number cards their number, J/Q/K 10, jokers 20;
  lowest total wins. You can't throw back the card you just took from the discards.
  - **The table picks how many play**, 2 to 4 (never fewer than the people there), so two people
    can play without a computer going out on them. Seats come into play across first.
  - **The middle:** the round and what's wild, the pile (with its count) and the top discard; the
    one you can take from glows sunflower.
  - **Your hand:** drag cards into any order (no sort buttons; the server keeps your order). Tap
    a card to lift it, tap it again (or the discards) to throw it. Cards in a meld are tinted
    light green all over; this round's wild rank wears a small sunflower star; the card you just
    took says "Taken". A tag says "Left over: 7 pts". **Go out** appears only when you can, and
    the card that does it is outlined.
  - **Between rounds:** everyone's hand, melds first, then the score sheet (headed Round), and
    Ready for the next round.
- **Mahjong** (user, 2026-11-22/23; the user's phone mockups): Hong Kong style, 144 tiles, always
  four (computers fill in), no passing and no card. **The table picks a Game type** (user,
  2026-11-24: one choice of three, not two): Learning, No points or Points. Without points
  (Learning too) any four sets and a pair wins and the table counts wins; with points it's Hong Kong faan (3
  to win, limit hands allowed), the dealer keeps the deal on a win, and the table picks one round
  or a full game. Points are play points, never money. Seats come from Your table, which shows
  them counter-clockwise (the next player is on your right).
  - **Tiles are the one exception to "only buttons stand up"** (user): every tile is a real tile
    with depth, its face on a sliver of its own back (blue under a face, cream under a back). The
    faces are the user's felt set (`scripts/art/mahjong/`, cut by `scripts/mahjong-tiles.cjs`);
    the Tile and Paper sets may become a choice later.
  - **A fixed design, scaled** (user, 2026-11-25, trying it on Mahjong first): the table is laid
    out at one of five fixed sizes and scaled to fit the screen, rather than reflowing for every
    screen: an upright phone (390 × 660), an upright window with a little more room (560 × 680),
    a phone on its side (760 × 350), and the whole table with its wall for tablets and computers
    (900 × 640, or 780 × 980 upright). Tablets and computers get the whole table whenever it fits
    at 85% of its size or more; otherwise the other design that fills more of the screen. Never
    more than 1.4 times its size. The green felt runs to the screen's edges around it. Your
    strip runs to the screen's sides only when the design (nearly) fills the width, as on most
    phones; with felt beside the design it stops at the design's edges, a card with rounded
    corners, on every design alike (user, 2026-11-25); height to spare goes half above the table and half below, so the table sits
    in the middle of the green above your strip (`mahjongView.ts`, `MJ_DESIGNS`).
  - **Your strip** (user, 2026-11-25): your name tag sits on the green just above it, like the top
    player's above their tiles (on a phone held sideways, at the strip's left end). Scores is with
    your buttons, beside Discard. Upright on a phone the strip is three rows: two of tiles and the
    buttons (Mahjong, Kong, Scores, Discard). Otherwise the buttons are a **block of four** beside
    your tiles, Mahjong and Kong over Discard (by your tiles) and Scores. The block keeps room for
    both rows, a row of tiles' height, so your strip never changes height; when Mahjong and Kong
    aren't showing (outside Learning Mode), Discard and Scores sit in its middle. The claims take
    the whole block, three to a row (two on a phone held sideways). The line saying what's
    happening is in the middle, under the tiles left.
  - **The table:** your tiles on a cream felt strip at the bottom (two rows of 7 upright, one row
    on tablets, computers and a phone held sideways), the buttons beside or under them. Everyone else's tiles are small backs
    along their edge, all one size (the side players' no thinner than the top's: user), up the
    sides in one column or two when one won't fit (on a phone held sideways always one column,
    every player's tiles smaller instead: user, 2026-11-25). The side players have the whole height
    of their edge, beside the top player too (except on a phone held sideways, where the tabs sit
    in the top corners), so their column only wraps when it truly must. Their name tags run up the sides like
    Dominoes (mirrored), all three the same thickness (never squeezed thinner on a narrow edge:
    user), and the wind letter turns with the name. **Face-up sets lie on
    kraft felt** everywhere, yours at the front of your hand (your flowers sit by your name); tap
    someone's tiles to see their sets big. The side players' sets lie sideways like their tiles
    (user, 2026-11-24), each set a column, faces turned and in order the way their name reads,
    when their edge has room; if not, they lie upright in rows. Each person's discards lie in front of them, mirrored
    (not a pinwheel), the one on offer lifted and bigger; "All discards" shows everything,
    taken ones faded. The round's wind ("East round") only shows on the table with points, where a Pung of it scores: after the tiles left, "88 tiles left · East round". Without points it changes nothing, so it's only in the Scores sheet, which always names it (user, 2026-11-25). Each tag has its seat's wind letter.
  - **The wall** is four sides of 18 stacks round a square, each running from one corner on past
    the next, so every end sticks out beyond the side it meets by about one and a half stacks (a
    pinwheel, like the user's photos of real tables). A stack of two stands one tile's thickness
    higher than a lone tile, so taking the top tile leaves the lower one a step down. Tablets and computers keep it all hand
    with each player's last 5 discards inside it (a row of 5 top and bottom, a column of 5 up each
    side running the full height inside the wall), as big as the room allows; All discards has the rest. A phone shows the
    wall only for the opening, then the tiles left, and the last few discards of each player.
  - **A phone held sideways** (user, 2026-11-23): in the phone's browser a swipe up on the table
    tucks the browser's tabs and address bar away, as in Tanks (the same hint, and the same care
    that a swipe up always works, even after turning the phone). Your strip is one row: your tag
    (name and wind, your flowers hanging small under it) at the left end, your tiles, then the
    block of four (smaller), always the same width so the tiles never jump. Tag, tiles and
    buttons sit in the middle of the cream, the home bar's band shared top and bottom, and the
    block reaches into that band for taller buttons (user, 2026-11-25). The players at the sides
    keep to the lower part of their edges, clear of the tabs, with their sets beside their tiles;
    the player across is one line along the top with bigger tiles, a little room between their
    tag and tiles. The side tags are centred on their columns, which keep a full hand's room (tiles
    from the top) so the tag never moves. The discards make a square round the middle as upright,
    the side ones in columns with room either side of All discards (user, 2026-11-25), and All
    discards has the tiles left and the line saying what's happening stacked under it.
  - **Even gaps down the side columns** (user, 2026-11-25): each tile's step is rounded to whole
    screen pixels for the table's scale (`--side-gap`), so no gap comes out thicker than another.
  - **No turn words** (user, 2026-11-23): whose turn it is shows only by the yellow tag. The
    status line carries news only: a discard you can take, "You can go Mahjong!", "Waiting for
    the others…", and the opening. One exception (user, 2026-11-25): when the deal ends and
    you're the dealer, a yellow note over your tiles says "It's your turn. Choose a tile to
    discard." for about 2 s, then fades (with so many buttons it wasn't obvious what the first
    move is). Every note over your tiles fades away now, rather than vanishing.
  - **Kongs** are three tiles with the fourth on top of the middle one (a concealed Kong shows its
    ends face down); every strip and close-up leaves room above for it. Upright, your face-up sets
    always fit one row, up to four Kongs: the set tiles shrink (your own don't).
  - **Upright, your tiles are always two rows** (user, 2026-11-23): if they wouldn't fit (a new
    tile's gap, sets at the front, a wider or narrower phone) they shrink a little rather than run
    onto a third row.
  - **Your turn:** the tile you drew sits a little apart, marked New. Tap a tile to lift it, then
    Discard (or tap it again, but not within half a second: a quick double tap from habit only
    lifts it, user 2026-11-24). Drag tiles into any order; a new hand starts sorted, and your
    order stays through the phone locking or the page reloading.
  - **Claims:** after every discard everyone waits 1.5-2 s, a little different each time, so a
    pause never gives away that someone could have taken it. Whoever can take it gets the buttons
    (the real words: Mahjong, Kong, Pung, Chow, and Pass) with a bar that runs down over 15 s (5
    was far too short: user, 2026-11-23), or a whole minute when you're the only person at the
    table (user, 2026-11-24); the tile on offer shows in the line above. Two possible
    Chows show both. If you take your winning tile as a Pung or Chow instead of Mahjong, Mahjong is
    still there on your turn (user, 2026-11-23): it counts as winning on that discard, the set's
    tiles go back in your hand, and the discarder pays.
  - **Your strip is always one size** (user, 2026-11-24): whatever buttons show (none, Discard,
    Mahjong and Kong, the claims), they fit the room it has. Mahjong and Kong are seldom used, so
    they sit side by side above a big Discard on tablets and computers, in one row with it on an
    upright phone (whose button row is kept even when empty), and stacked small beside it on a
    phone held sideways. The button column narrows with the window (about four tiles wide), so
    narrowing an iPad window shrinks the buttons along with your tiles. Your strip is never more
    than three rows (your name, one row of tiles, the buttons) unless the screen is much taller
    than wide, as an upright phone is, which gets two rows of tiles (user, 2026-11-24). A phone held
    sideways keeps its single row with the buttons beside the tiles.
    The Learning Mode card goes compact whenever the space over the table is short, so it never
    scrolls.
  - **Learning Mode** (user, 2026-11-24), the Learning game type (always without points: the
    reasons a hand can't win with points were left out until they can be tried). Every tile
    someone else throws away (or adds to a Pung) puts a card over the table, never over your own
    tiles (laid out again from the user's mockup, 2026-11-25). At the top a small tile and, on
    one line, "Sparky discarded" and its name, big. Then Pung, Chow, Kong and Mahjong, two by
    two, just their names (picking one explains it). Under those, what the play you pick
    takes, in a space that keeps its height ("Make a play or pass to continue" until you pick
    one): "To make a Pung" near the top, a picture of the tiles it takes from your hand in a
    bracket close round them, "Your hand" over it and "Need 2 · You have 1" on one line under
    it (the ones you're missing dashed and faint) + the discard (the + in line with the tiles), and a
    sentence ("A Pung is three of a kind: you need one more Red dragon in your hand."). A Chow
    shows the run you're closest to; Mahjong, and anything a rule rules out (a Chow only from the
    player right before you; winds and dragons make no runs), are a sentence only. The tiles in
    your hand it's about are lit up. The play you picked wears a blue felt ring: tap it again to
    put it down, or pick another. A play you can make shows the same, all there, and Pass gives
    way to Confirm (put the play down to pass). With more than one run you can make, each run is
    a button: pick one (it wears the ring), then Confirm. All discards is a link at the foot.
    Every sentence on the card is two lines at most (80 letters, with the longest names: a test
    in shared/mahjongLearn checks every case), and the card keeps room for just that. The card
    never scrolls: where its space is short the whole card is scaled down to fit (`fitLearn`). Upright on a phone it covers the player across and your name (neither needs
    to show while it's open);
    sideways, a tablet or a computer the tile (smaller sideways), "Sparky discarded" and its
    name run along one line across the top over a divider, then two columns with a line down between them: the
    picture on the left (its tiles a little bigger), the plays, Pass or Confirm and All discards
    on the right; sideways it starts below the mic and menu tabs. The plays keep a little room
    round them for the ring. No
    timer: the game waits for everyone, and a person stalling it is fine. Pass on your winning
    tile asks first ("This tile wins you the hand": Mahjong, or Pass anyway); passing on a set
    you could have made says so afterwards in a note over your tiles, as
    does losing a Chow to someone's Pung. On your own turn there's no card: Mahjong and Kong are
    always beside Discard and explain themselves, throwing away a finished hand asks first, and a
    Kong you could have made is noted. The explanations work from your own tiles only.
  - **A Pung, Chow or Kong is made obvious** (user, 2026-11-23): the word ("Pung!") pops up on a
    sunflower chip beside the player's name, the tile they took slides from the middle into their
    set, and the set sits lifted until it settles. Play waits 2.5 s meanwhile (a Kong declared on
    someone's own turn too).
  - **Messages keeps a log of the claims** (user, 2026-11-23): a grey line for every Pung, Chow and
    Kong ("Sam took Liz's 5 dots for a Pung."), as well as wins. They show as they happen but
    aren't kept for people who arrive later, so they never push the table's own messages out.
    Ordinary discards aren't logged (All discards has them).
  - **The opening:** on an empty table the tiles swirl round on three rings, each its own way at
    its own speed, so they keep changing places but never land on each other (each stays upright:
    no spinning), with a clatter of tiles knocking together. They gather up and the wall is built
    from them, a stack at a time along every side at once. The dealer taps Roll the dice (they
    roll by themselves after 6 s). Then the deal, as at a real table: from the dealer round the
    table, four tiles each, three times over, then one each and the dealer's extra; the wall
    opens handful by handful, everyone's tiles appear as they're dealt, each handful clicks, and
    yours drop in from out of sight (never from above your name). The table holds still through
    it all (user, 2026-11-24): every hand's room is kept from the start, tiles not dealt yet there
    but unseen. Only flowers, shown once the deal is done, can still nudge a side player.
  - **The table holds still in play too** (user, 2026-11-25). Everyone's hidden tiles keep room
    for the most they can hold (14, less 3 a set), so their size and place don't change as they
    draw and throw away. A player with no sets keeps an unseen set's room, so the first flower or
    set doesn't push the middle (and everyone's tiles are sized with that room from the shuffle
    on, so the wall keeps one size from the shuffle through the deal). On tablets and computers
    each row and column of discards inside the wall keeps a tile's room from the start, so All
    discards doesn't move as the first ones land. On a phone the discards keep room for the 6 or 4 they show from
    the first one, filling from the left or the top (sideways, the side rows start by the middle),
    and the line saying what's happening keeps two lines. Your tag stays in the middle with your
    flowers beside it (sideways: under it, their row kept). Sideways the side tags sit at the
    foot of their edge. Only a set being laid down changes sizes now, as it must.
  - **Sounds:** tiles clack (made in code, `tileClack`, `tileShuffle` in audio.ts): every
    discard, three for a set taken, one per tile dealt, and the shuffle.
  - **After a hand:** the winner's tiles face up, and with points each item it scored with a
    plain explanation, then the score sheet and Ready for the next hand.
- **Jigsaw** is played on calm light-grey felt. Every loose piece casts a small shadow; joined
  seams have none; pieces locked into the frame lie flat. The frame is a patch of cream felt sunk
  a touch below the table (a soft shadow inside its top edge), with no edge line. The tools are a strip along the bottom, one row on phones. Chosen options are
  cobalt.
  - **Everyone else's pointer** is a dot in their colour with their name beside it. It fades a
    few seconds after they stop. **While they talk, rings ripple out from it** and it stays, so
    you can see who's talking and where. With less motion asked for, it's a steady ring. The
    pointers are page elements over the table, so the pulse doesn't redraw the puzzle.
  - **The magnifier** (touch screens) shows a single piece straight above the finger and slides
    off the top rather than moving the table. Nothing auto-scrolls except the screen-edge scroll.
  - **The picker**: sizes 6 to 500, the pictures in a new order each time with the first picked,
    and picking only moves the tick. Finished puzzles leave "Continue a puzzle".
  - **Smaller pictures offer fewer pieces**: every piece keeps at least 60 of the picture's pixels
    across (`MIN_PIECE_PX`). Bigger sizes are greyed out. The server holds to it too.
  - **Your own photos**: a "Your photo" tile first in the grid opens a note (only this table sees
    it, deleted when the table closes, checked first), then the file picker. The phone shrinks it
    to 2048 px and re-saves it, which leaves location and camera details behind; the server
    strips any that remain, has Amazon Rekognition check it, and keeps it in the table's memory
    only. Anyone at the table can add one (4 a table). Puzzles of photos are never saved. Off
    unless the server has a check (`PHOTO_CHECK`).
- **Tanks** is a felt scene: a muted blue sky, slate felt mountains, and ground in layers of olive,
  tan, orange and rust over charcoal; craters cut cleanly through the layers. Past the map's edges
  the hills carry on as a faded mirror.
  - **Sprites** are the user's felt art (`scripts/art/felt-sprite-sheet.webp`, cut by
    `scripts/felt-sprites.cjs`). The tank's player-coloured parts are recoloured per player.
  - **Controls** are one felt strip along the bottom; on a phone held sideways they run down the
    right edge instead.
  - **A phone held sideways** (user, 2026-11-23): one slim row across the top. The mic and caret
    tabs are a fifth shorter than in other games; your lives tag (small hearts, then level and
    knock-outs on the same line) sits beside the mic tab, and the wind beside the caret tab, above
    the controls. In the phone's browser a swipe up on the battlefield tucks the browser's tabs
    and address bar away; on an iPhone with them showing, "Swipe up for fullscreen" shows for a
    few seconds across the middle of the battlefield, faint, and taps go through it. Whenever the
    bars come back (the phone turned upright and back, say), the page quietly returns to the top
    once no finger is down, so the next swipe up always works (tuckBars.ts). So a swipe
    can't drop you, on a touch screen only the Drop button drops you from the helicopter (not a
    tap on the battlefield). Messages (knock-outs, the table's notes, chat) take turns one at a
    time in the row's gap between lives and wind, a couple of seconds each; only the winner's
    banner takes the middle. The controls hug the right edge when the notch is on the left.
  - **Spawn protection** is shown only by the bubble round the tank, which blinks in its last 3
    seconds and faster in the last one; there's no "Protected" line.
  - **Framing:** the whole battlefield always fits from a little sky above the highest hill down
    past the deepest valley, clear of the controls (and, on a sideways phone, under the top row):
    better smaller than covered. On short, wide screens the map shrinks and the ground past its
    edges shows dimmed, but never behind the controls. Your helicopter stays in view while you
    ride it.
  - **The aim line** grows with power in step with the tank: about a tank's width at the lowest
    power, four at full.

## Where things live

- **`packages/client/src/felt.css`** (loaded last): the felt colours, sheets, shadows and heights,
  and each person's felt. It restyles the shared pieces from **`paper.css`** (buttons, fields,
  name tags, cards, dominoes, messages), the Cut Paper look felt replaced, which still holds their
  shapes.
- **`packages/client/src/paperArt.ts`:** suits, playing cards and dominoes, drawn as SVG.
- **`entry.css`** lays out the way in (home, Start a table, join). **`table.css`** styles the table
  around the games: the bar, sheets, Messages and Your table. **`cards.css`**, **`jigsaw.css`**
  and **`tanks.css`** style each game. They override the older `room.css` and `styles.css`, which
  still hold some layout.
- **`packages/client/public/art/felt/`:** one seamless felt sheet per colour, made by
  `scripts/felt-textures.cjs` to match the user's swatch sheet. Don't recompress them: it smooths
  the grain away.
- **`packages/client/public/art/`:** the card royals and backs, the hero picture, game icons, app
  icons and the link-preview card.
  - The hero picture is cut out of its background (transparent WebP).
  - The game icons (`art/games/<id>.webp`, 176 px) come from the user's felt icon sheet,
    `scripts/art/game-icons.webp`. Icons for games not built yet are in
    `scripts/art/future-icons/`; copy one to `art/games/<id>.webp` when its game is built.
