# Games Drawer design rules: Felt

Games Drawer is for hanging out with family and friends, some of them not technical. It works on
phones, tablets and computers, and people should be able to jump in and out easily. Every screen has
to make sense to someone seeing it for the first time.

The look is **wool felt**, like a card table and a puzzle mat. These rules keep it consistent. When
a mock or a new screen disagrees with them, the rules win, or we change the rules on purpose.

**Being adopted (from 2026-11-27, on the `design-system` branch):** the short lists below (five
text sizes, three corners, one shadow colour, colours by name, four layouts) are agreed, and the
code is being moved onto them. Until that's done some screens still use older values; the design
page on the dev server (`/design.html`) shows the lists and every shared piece as built.

## 1. Everything is felt

- **Every coloured shape is its own piece of felt.** It has a palette colour, the felt's grain, and
  a shadow that shows what it lies on. No flat boxes, gradients, glows, frosted glass, or outlines
  drawn as thin lines.
- **Warm, not kiddy.** It should feel inviting and easy, never like a site only for children.
- **Light comes from above, and there is one shadow colour.** Shadows fall downward. Every
  shadow, shaded edge and dimmed table uses `--shade` (the warm dark measured from the user's
  felt mock) at whatever strength it needs; no other shadow colour is typed in by hand (user,
  2026-11-27: one type of shadow). A piece sits at one of five heights:
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
- **Three corners** (user, 2026-11-27), so pieces of a kind are cut alike:

  | Corner | Size | For |
  | --- | --- | --- |
  | Small, `--corner-s` | 6 px | marks and the smallest pieces |
  | Medium, `--corner-m` | 12 px | buttons, boxes you type into, name tags, chips, game tiles, the bar's tabs |
  | Large, `--corner-l` | 18 px | sheets and strips |

  A piece takes the nearest of the three to what it had (up to 8 px small, 9 to 14 medium, 15
  and over large), which is what the user picked from pictures as "tidy today". A tab hanging
  from an edge is rounded on its free side only. Dots and pills are fully round
  (`--corner-round`). Cards, dominoes and Mahjong tiles keep a corner that is a share of their own
  width, so it grows and shrinks with the piece.

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
- **A colour is used by its name** (user, 2026-11-27). Nothing is typed in as a hex or rgb value
  outside the palette in `felt.css`, apart from the black and white of a cut-out mask. Two
  colours a hair apart are one colour: use the named one, or name it once if it's new.

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
  sheets it first shrinks a little to fit (`fitOneLine`, `fitScoreTable`), from Text down to Note
  and no further, and names side by side share one size. Where a tag is too narrow for the name
  and what follows it (your own tag on a phone held sideways, for one), the tag takes two lines,
  the name on the first (user, 2026-11-27); the name itself still never wraps.
- **No technical words** (server, connection, permission, sync, host, guest). When something goes
  wrong, say what to do: "Your mic is blocked." with a button: "Show me how".
- **No emoji in the interface.** They look different on every device. People's own messages can
  have them.

## 4. Type and size

- **One font: Atkinson Hyperlegible Next**, served by the site itself. Use 400 for text and 800
  for headings, buttons and names. Letters that are easy to mix up (I l 1, O 0, b d) look
  different.
- **Five text sizes** (user, 2026-11-27), the same on every device apart from a page's heading,
  and one headline that grows:

  | Size | Pixels | For |
  | --- | --- | --- |
  | Note, `--type-note` | 15 | a name tag's second line (points, You, Ready), scores, counts, times, small notes |
  | Text, `--type-text` | 16 | sentences (on the way in too: a trial, user 2026-11-27), messages, boxes you type into, buttons, the name on a name tag |
  | Strong, `--type-strong` | 18 | the big main button, a game's name on its tile, the line over a game, the label beside a box |
  | Subheading, `--type-sub` | 22 | a sheet's title, a section's heading |
  | Heading, `--type-head` | 28, and 40 on a large layout | a page's heading (Your table, Start a table) |
  | Headline, `--type-headline` | grows with the window's width and height | the home page's title only |

- **Nothing is smaller than Note.** A board drawn at a fixed size and scaled to the screen (see
  Layout) counts at its own size, so on a phone narrower than its design the text comes out a
  little under: a 360 px phone shows Mahjong's 15 as about 14. A board always shrinks to fit the
  phone, however small (user, 2026-11-27: there's no alternative), but work to avoid it: draw a
  new small design for the narrowest phone, 360 px wide, so it only ever scales up.
- **Things you tap are comfortable for a thumb:** about 44 px tall where there's room, with a
  little space between them. A guide, not a rule (user, 2026-11-27: the old "at least 48 px"
  wasn't something they asked for).
- **Every screen works from a 360 px phone up to a desktop.** The page never scrolls sideways.
- **On a phone, the main button is visible without scrolling.**

## 5. Motion

- **Pieces slide and drop into place, with a tiny settle at the end.** No fading pieces in and
  out, no spinning, no endless bouncing.
- **Turn movement off when the device asks for less motion.**

## 6. Layout

- **Four layouts** (user, 2026-11-27): small or large, each upright or sideways. Small is a phone,
  or a window as small as one; large is a tablet, laptop or desktop. Upright means taller than
  wide, so an iPad held upright is large upright. Where small ends isn't settled: three numbers
  decide it today (600 px in `main.ts`, 500 in `shell.ts`, 600 and 460 in the stylesheets), to
  become one (suggested: the window's shorter side under about 540 px) once it's been tried on
  real phones and tablets. Touch is a separate matter: it decides how tapping, hovering and the
  keyboard behave, never the layout.
- **A board too tight to reflow is drawn at a fixed size and scaled** to the screen, one design
  for each layout, as Mahjong is (user, 2026-11-27: it has been good there). Which other games
  move to this is decided game by game. Ordinary pages (home, Your table, sheets) stretch.
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

Each game's own decisions are in its own file, so this one stays about what the games share:
[Dominoes](docs/design/dominoes.md), [Three Thirteen](docs/design/three-thirteen.md),
[Mahjong](docs/design/mahjong.md), [Jigsaw](docs/design/jigsaw.md) and
[Tanks](docs/design/tanks.md). Hearts and Spades have nothing of their own beyond the card table
below. A rule two or more games share belongs here; a rule only one game has belongs in that
game's file, and so does anything where a game departs from these rules on purpose.

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
## Where things live

- **`packages/client/src/felt.css`** (loaded last): the felt colours, sheets, shadows and heights,
  and each person's felt. It restyles the shared pieces from **`paper.css`** (buttons, fields,
  name tags, cards, dominoes, messages), the Cut Paper look felt replaced, which still holds their
  shapes.
- **`packages/client/src/paperArt.ts`:** suits and playing cards, drawn as SVG. Dominoes are
  drawn by `tileSvg` in `dominoLayout.ts`.
- **`packages/client/design.html`** (dev server only, like the sound lab): the design page. It
  shows the colours, text sizes, corners and heights, and every shared piece as built, with a
  mark on each one that is off the lists.
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
- **`docs/design/`:** one file per game, for that game's own decisions.
