# Games Drawer design rules: Cut Paper

Games Drawer is for hanging out with family and friends, some of them not technical. It works on
phones, tablets and computers, and people should be able to jump in and out easily. Every screen has
to make sense to someone seeing it for the first time.

The look is **cut construction paper**. These rules keep it consistent. When a mock or a new screen
disagrees with them, the rules win, or we change the rules on purpose.

See every piece in one place at `/paper.html` on the dev server (`npm run dev`). Check a change there
first.

## 1. Everything is paper

- **Every colored shape is its own piece of paper.** It has a palette color, the paper grain, and a
  shadow that shows what it sits on.
  - Don't use flat boxes, gradients, glows, frosted glass, or outlines drawn as thin lines.
- **Light comes from above.** Shadows fall downward and are tinted ink, never black. A piece sits at
  one of four heights:
  - **Pressed** (`--lift-0`): a button while it's being pressed.
  - **Lying flat** (`--lift-1`): buttons, name tags, cards, tiles.
  - **Lifted** (`--lift-2`): whose turn it is, the thing you picked, hover.
  - **Held** (`--lift-3`): a card or piece you're dragging, and pop-up panels.
- **A piece shouldn't sit on its own color.** It needs to differ from what's under it, not just by
  its shadow, because the same color stacked on itself reads oddly. Treat this as a strong habit,
  not a law: if you do stack a color on itself, decide that on purpose. Examples:
  - **Name tags** on the light blue mat are ivory.
  - **Messages** sit on a sheet of sky paper: ivory notes from others, cobalt notes for yours.
  - **Outlined buttons** are white, not page ivory.
  - **Ivory dominoes** sit straight on the blue mat (no rack under them).
  - **The in-game buttons** sit straight on the mat, not on an ivory strip.
  - **Game tiles** are each tinted with their game's color.
- **An outline is a bigger piece of paper underneath:** cobalt, at least 2 px.
- **Tap or type:**
  - Things you tap are stuck on top, so they cast a shadow.
  - Things you type into are cut out of the page, so the shadow falls inside.
- **Cut or torn:**
  - Anything you tap or read has clean, scissor-cut edges with rounded corners.
  - Torn edges belong only to illustrations and scenery, like the hero picture and the Tanks hills.
- **Pictures sit straight on the page, not in a box:** cut them out (a transparent image) rather
  than blending a white background away, which iPad Safari doesn't do inside scrolling pages.
  Never crop them; they keep their own shape.
- **Home and the join page fit one screen:** their main button shows without scrolling on every
  device, so sizes there follow the screen's height as well as its width.
- **Never rotate a piece to change its orientation**, because its shadow would turn with it. Draw the
  vertical version instead, as with dominoes.

## 2. Colors

Use as many paper colors as make sense. Only the **signal colors** below are strict: each one
means exactly one thing in the interface, so nobody has to guess.

| Signal | Hex | It means |
| --- | --- | --- |
| Cobalt | `#103db6` | The main button (one per screen), outlines of other buttons, links |
| Sunflower | `#ffcb2d` | Whose turn it is |
| Tomato | `#ef5943` | Something is off: mic muted, unread messages, mic blocked, leaving |

Base colors:

| Color | Hex | Use |
| --- | --- | --- |
| Paper | `#fffcf5` | The page and most pieces |
| Ink | `#112875` | Text |
| Mat | `#e5eff6` | The table a game is played on |

**More paper, used freely:**
- sky `#85bee3`
- mint `#b7ddc8`
- butter `#f7e3a2`
- lilac `#c6b5dc`
- peach `#f2bd96`
- blush `#ebb7bf`
- kraft `#bb926a`
- grass `#478653`

There's also a white paper (`#fefefd`) for outlined buttons. Add more colors when something needs
them; each one needs its own paper sheet (see "Where things live").

**On the deeper papers, use full ink for text**, including small notes. Soft ink is for the
lighter papers: paper, white and mat.

- **Each game has its own paper color**, used for its tile and its page: Jigsaw sky, Dominoes mint,
  Hearts butter, Spades lilac, Tanks peach.
- **A piece and what it sits on must differ in color.** Ink text on any paper needs a contrast
  ratio of at least 4.5:1, and the light tints above all pass.
- **One cobalt main button per screen.** Everything else is an ivory button with a cobalt outline.
- **Player colors.** In games where you tell people apart on the board (Tanks, Jigsaw hands),
  players are cobalt, tomato, sunflower and grass, in seat order. Turn-based games don't use player
  colors, so sunflower never means two things on one screen.
- **Playing cards are ivory card stock.** The grain comes straight from the card mock, lightened from its cream (2026-11-18: cream read too dark on the mat).
  `art/card-stock.webp` is quilted from plain patches of that mock's cards, and it's sized to each
  card, so the grain looks the same at any card size.
  - **Code draws everything that has to be exact:** corners, numbers, suit marks, the layouts of the
    number cards, and the layered Aces (a smaller, lighter suit stuck on a big one).
  - **The Jacks, Queens and Kings are cut-paper portraits,** our own art, one per card, in
    `public/art/cards/`. All 12 share one scale, sit left of center so the upside-down corner stays
    clear, and cast a small paper shadow.
  - **Jokers** (the user's felt art, 2026-11-20): a black one and a red one, as whole card faces
    (`public/art/cards/joker-black.webp`, `joker-red.webp`, 420 x 588, the same shape as a card's
    250 x 350). No game deals them yet; one that does shows the picture as the card's whole face.
  - Suits are classic red (`#d4351f`, deeper than tomato so small corner numbers stay readable) and
    black (`#1e1e26`).
  - Backs have a white border around a cobalt panel, like a real deck.
  - Dominoes stay ivory.
- **Illustrations** can use any colors they need, like skin tones.

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

Game names are exactly as in the catalog: Tanks, Hearts, Spades, Dominoes, Jigsaw.

**How to write:**
- **Buttons say what will happen, starting with a verb:** "Start with mic on", not "OK",
  "Submit" or "Continue".
- **Use sentence case.** No all-caps labels.
- **Use people's names:** "Jesse invited you to play."
- **A name never wraps onto a second line** (user, 2026-11-18). Wherever a name shows (name
  tags, score sheets, who's at the table, the mic list, Messages, the Tanks scores), it stays on
  one line, and a name too long for its room ends in "…" (`.pc-nm`). On the card games' name
  tags and score sheets it first shrinks to fit (`fitSeatText`, `fitScoreTable`), and names
  side by side share one size so they match.
- **No technical words** (server, connection, permission, sync, host, guest). When something goes
  wrong, say what to do: "Your mic is blocked." with a button: "Show me how".
- **No emoji in the interface.** They look different on every device, and they aren't paper.
  People's own messages can have them.

## 4. Type and size

- **One font: Atkinson Hyperlegible Next.** Use 400 for text and 800 for headings, buttons and
  names. The Braille Institute designed it for readers with low vision, and letters that are easy to
  mix up (I l 1, O 0, b d) are drawn to look different.
- **Text is 18 px on phones**, and small notes never go below 15 px.
- **Anything you can tap is at least 48 px tall**, with at least 8 px between tappable things.
- **Every screen works from a 360 px phone up to a desktop.** The page never scrolls sideways.
- **On a phone, the main button is visible without scrolling.**

## 5. Motion

- **Paper slides and drops into place, with a tiny settle at the end.**
  - No fading pieces in and out, no spinning, no endless bouncing.
- **Turn movement off when the device asks for less motion.**

## 6. Layout

- **Use one column on phones.** A desktop gets more room, not more things.
- **Never arrange four things in a rotating pinwheel** (it can look like a swastika). Mirror them
  instead, the way a domino cross has mirrored arms.

## At the table

- **The table comes before the game** (user, 2026-11-20). Starting a table asks only for a name
  and the mic; everyone gathers at **Your table** first: who's here (with Invite), the mic, the
  games (anyone picks or changes the pick), and for Hearts, Spades and Dominoes four seats round
  a small piece of green table (tap to sit; nearest you at the bottom, then round the way play
  goes). A strip that stays at the bottom says who we're waiting for, with **I'm ready**. The
  game starts when everyone here is ready: someone away doesn't hold it up, and the computer
  plays the empty seats. A game's own page (`/dominoes`) opens the table with that game picked.
  Switch game brings everyone back here with nothing picked.
- **The way in keeps still from page to page** (user, 2026-11-20): home, Start a table and a
  table's invite page show the hands-and-puzzle picture at exactly the same size, and their buttons
  at the same width, so going from one to the next doesn't zoom. Each fits one screen, down to an
  iPad mini on its side in Safari: on shorter screens the picture and the spacing shrink, the same
  on every page. Scrolling isn't switched off (big text or a phone held sideways still needs it),
  and where a page scrolls, its felt moves with it.
- **A paper bar across the top:** Mute mic, Messages, Invite, Menu. The game sits below it, never
  under it.
- **The mic button says what it will do:** Mute mic (cobalt), or Unmute mic / Turn on mic
  (tomato).
- **Everything else opens as a paper sheet over the dimmed table,** one at a time: the menu, the
  invite, and help when the mic is blocked. Tapping the dimmed table closes it. Sheets always
  open scrolled to the top.
- **The menu is the same at every game:** the game's own "change what we're doing" actions (like
  Jigsaw's New puzzle) go at its top, above Switch game and Leave table, not in the game's tools.
- **Game tools stay on one row**, even on a 360 px phone (smaller text before a second row).
- **Messages is a sheet of sky paper.** Others' notes are paper, yours are cobalt.
- **Messages starts closed when everyone at the table has their mic on** (user, 2026-11-20):
  talking, nobody needs it. Otherwise it starts open where there's room beside the game (a
  laptop, an iPad on its side) and closed on phones. Once you open or close it yourself, it stays
  as you left it.
- **Little notes pop up over the game** and go by themselves: someone arriving ("Miranda is
  here.", with the join sound), and other people's messages while Messages is closed ("Sammy: I
  can't hear you"), which also count on the button's red dot. Arrivals and leavings are never
  counted as unread, and leavings don't pop up.
- **Before you join, the join page names everyone at the table:** "Join Jesse, Sam and Mory for a
  puzzle." That way you can back out before you're in a room with someone you'd rather avoid. The
  list refreshes while the page is open.
- **Invite links name who sent them, and optionally who they're for.** The server keeps those
  names, and the link only carries a random token, so a link can't claim to be from someone it
  isn't.
- **Privacy and House rules** (user, 2026-11-20) are plain reading pages at /privacy and /rules,
  linked under every way-in page and under the menu's Close. Keep the privacy page true to the
  code: change it in the same commit as anything it describes (what's kept, for how long, who
  else is involved), and update its date. Today: logs 30 days, puzzles 30, no cookies, fonts
  and voice set-up from our own servers only. **Before every push, read both pages against
  what's being pushed** (user, 2026-11-20); `packages/server/test/privacy.test.ts` catches the
  numbers and outside servers, the rest needs reading.

## The games

- **Card and tile games (Hearts, Spades, Dominoes)** are played on the blue mat.
  - **Name tags:** each player has a paper name tag; whose turn it is gets sunflower paper,
    lifted. **Every tag is the same size, whatever the name** (user, 2026-11-20): a long name
    shrinks a little, then ends in "…". On a phone held upright the three across the top split
    the width evenly, and yours is as wide as one of them. Tags are two lines (name, score) and
    never grow a third: someone who dropped out gets a small "zzz" after their name (not the
    word "Away"), and computer players a small computer screen. Both marks stay in view when a
    long name is cut; score sheets leave them off. Computer players have made-up robot names
    (`ROBOT_NAMES`; our own names only, never robots from films, shows or toys, and no two that
    look alike, like Beep Boop and Bleep Bloop). No "Computer" label under the name (it took
    room the tags don't have; the word is fine in a sentence that needs it, user 2026-11-20), and
    Spades has no "Partner" label either, since your partner always sits across.
  - **Spades:** your team's tags are lilac, Spades' own color.
  - **Other players' hands:** not shown. In a trick game everyone holds about the same number
    of cards, so the tags keep just the name and score.
  - **Dominoes:** card stock with navy pips, your hand straight on the mat. The tile just
    played has a sunflower edge, and the places you can play are dashed cobalt (they don't pulse).
    Lines turn at the edge of the table as an L (the turning tile just past the end of the
    line), but never at a double or right after one, which would make it look like a spinner:
    those run on a little past the edge instead (user, 2026-11-20).
  - **Your name and Scores** sit side by side, the same height, their edges lined up with the
    button's outline. Your own tag doesn't lift on your turn (the yellow says it), so the two stay
    level. There's only ever one Scores
    button: after a hand, while you look at the board, it becomes a cobalt "Back to scores".
  - **Dominoes on a phone held sideways:** there's no height for a row of names above the board
    and a row of tiles below it. Everyone's name goes down the left in turn order (yours first)
    with Scores under them, the board takes the middle, and your tiles sit in rows of four on
    the right.
  - **The domino board zooms** with a pinch, the mouse wheel (or a trackpad pinch), or a
    controller's shoulder buttons. There are no zoom buttons on screen. Drag to look around; a
    drag is never a tap.
  - **Playing a domino:** tap a tile, then tap its spot on the board. Tapping the picked tile
    again puts it back. No hint text while you play: the yellow name tag shows whose turn it
    is, the dashed spots show where a tile can go, and the board gets the room. The line under
    the board appears only when there's news ("Nothing fits: you pass", "Hand 1 is over").
    "Ends add up to" sits under your tiles.
  - **Name tags** (all three card games) keep each name and score on one line. Long ones shrink
    to fit (the other players' share one size), then end in "…".
  - **Score sheets** have one row per player (you first): the name with all the room it needs,
    then the points each hand scored, then a narrow, bold Total. The hand just ended is darker.
    Phones show the last 3 hands, bigger screens 8 (`scoreSheet.ts`).
- **Jigsaw** is played on the mat too. The frame where the finished picture goes is cream paper
  with a dashed ink edge, and the tools are a paper strip along the bottom (it wraps onto two rows
  on phones rather than hiding buttons off the edge). Chosen options are cobalt.
  - **Everyone else's pointer** is a dot in their color with their name beside it. It fades a
    few seconds after they stop moving. **While they talk, rings ripple out from it** and it
    stays, at their last spot, so you can see who's talking and where they're working (user,
    2026-11-20: that does the job of name tags here). With less motion asked for, it's a steady
    ring instead. The pointers are page elements over the table, not drawn on it, so the pulse
    doesn't redraw the puzzle every frame.
- **Tanks** is a cut-paper scene:
  - a paper sky with paper clouds
  - torn-paper hills (lilac far away, mint nearer)
  - ground made of strips of red clay paper (peach and kraft, toned down) under a thick strip of
    grass. Each strip casts a deep shadow on the one below and is lighter at its top, so they read
    as paper laid on paper; torn edges show pale fibers. (Peach, kraft and butter at full strength
    read as sherbet. In development, `?ground=kraft` or `?ground=earth` on the start page tries
    the other looks.)
  - **Sprites:** the tanks, helicopter, parachute, shell, explosion, smoke, heart and windsock are
    drawn as layered paper by `npm run sprites` (`scripts/paper-sprites.cjs`). The tank's player
    colored parts are cyan in the file, and the game recolors that cyan per player.
  - **Framing:** the whole-battlefield view always fits from a little sky above the highest
    hill down past the deepest valley. It fills the width when it can; on short, wide screens
    the map shrinks instead, and the ground past its edges shows dimmed at the sides. Your
    helicopter stays in view while you ride it.
  - **The folding bar:** on a phone held sideways (520 px tall or less), Tanks folds the bar up
    out of sight so the battle gets the full height. A paper tab in the top right corner, with a
    caret, pulls it down and pushes it back up. Using the bar or touching the battlefield folds
    it. A tomato dot on the tab means unread messages. Only Tanks does this; the other games
    keep the bar.
- **Player colors** (`packages/shared/src/palette.ts`) are paper colors: cobalt, tomato,
  sunflower and grass first, then lilac, orange, pink, white, teal and sky.
- **On the board, labels are ink with a paper-colored edge**, so they read on the sky, the
  ground and puzzle pieces alike. Names in the Tanks notes are ink, underlined in the tank's
  color (colored text is hard to read on paper).

## Where things live

- **`packages/client/src/paper.css`:** colors, paper, shadows and every shared piece (buttons,
  fields, name tags, cards, dominoes, messages).
- **`packages/client/src/paperArt.ts`:** suits, playing cards and dominoes, drawn as SVG on top of
  the CSS paper.
- **`packages/client/src/entry.css`** lays out the way in (home, start a table, join a table).
  **`packages/client/src/table.css`** styles the table around the games: the bar, sheets,
  Messages and the game picker. **`cards.css`**, **`jigsaw.css`** and **`tanks.css`** give
  each game its paper look. They override the older `room.css` and `styles.css`, which still hold
  the games' layouts.
- **`packages/client/public/art/paper/`:** one seamless paper sheet per color, made for the
  project.
  - They're 768 px tiles shown at 384 px, so the grain stays crisp on sharp screens.
  - Each paper sits on its flat color, which shows until the texture arrives.
  - Apply one with `class="paper-mint"`, or in CSS with
    `background: var(--mint) var(--mint-img) 0 0 / var(--paper-size)`.
  - Don't recompress them: tested at 60–80% quality, they lost most of their grain.
- **`packages/client/public/art/`:** the card stock, the hero picture, game icons, the card royals,
  app icons and the link-preview card.
  - The hero picture is cut out of its white background (transparent WebP).
  - The game icons (`art/games/<id>.webp`, 176 px) come from the user's felt icon sheet,
    `scripts/art/game-icons.webp`, which has a see-through background, so they're lifted out as
    drawn with no cutting (the earlier set, cut from cream felt, had a cream fringe). The jokers'
    full-size originals are in `scripts/art/` too.
  - `brand.webp`, the drawer beside "Games Drawer" on the way-in pages, is the user's cut-paper
    art cut out of its cream background (its soft shadow kept as a see-through tint). The
    browser-tab icon is still the older flat `drawer.svg`.
- **`packages/client/paper.html`:** the sample sheet (dev only, not part of the build).
