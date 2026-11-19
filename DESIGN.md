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
| Computer (a computer player) | bot, AI, CPU |
| Away (someone who dropped out) | disconnected, offline |
| Your turn / Liz's turn | waiting for Liz… |
| Work in Progress | under construction, beta, still being built |

Game names are exactly as in the catalog: Tanks, Hearts, Spades, Dominoes, Jigsaw.

**How to write:**
- **Buttons say what will happen, starting with a verb:** "Start with mic on", not "OK",
  "Submit" or "Continue".
- **Use sentence case.** No all-caps labels.
- **Use people's names:** "Jesse invited you to play."
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
- **Before you join, the join page names everyone at the table:** "Join Jesse, Sam and Mory for a
  puzzle." That way you can back out before you're in a room with someone you'd rather avoid. The
  list refreshes while the page is open.
- **Invite links name who sent them, and optionally who they're for.** The server keeps those
  names, and the link only carries a random token, so a link can't claim to be from someone it
  isn't.

## The games

- **Card and tile games (Hearts, Spades, Dominoes)** are played on the blue mat.
  - **Name tags:** each player has a paper name tag; whose turn it is gets sunflower paper,
    lifted. Computer players and people who are away are marked in words.
  - **Spades:** your team's tags are lilac, Spades' own color.
  - **Other players' hands:** a small pile of cobalt card backs and the count.
  - **Dominoes:** card stock with navy pips, your hand straight on the mat. The tile just
    played has a sunflower edge, and the places you can play are dashed cobalt (they don't pulse).
  - **Your name and Scores** sit side by side, the same height. There's only ever one Scores
    button: after a hand, while you look at the board, it becomes a cobalt "Back to scores".
  - **Dominoes on a phone held sideways:** there's no height for a row of names above the board
    and a row of tiles below it. Everyone's name goes down the left in turn order (yours first)
    with Scores under them, the board takes the middle, and your tiles sit in rows of four on
    the right. The list drops the "Computer" line to fit; "Away" still shows.
  - **The domino board zooms:** pinch, mouse wheel, or the Zoom out and Zoom in buttons on
    either side of "Ends add up to" under the board. A button you can't use right now keeps its
    place, unseen, so nothing shifts. Drag to look around; a drag is never a tap.
  - **Score sheets** size their columns to whole names; a name only breaks mid-word when it
    can't fit any other way.
- **Jigsaw** is played on the mat too. The frame where the finished picture goes is cream paper
  with a dashed ink edge, and the tools are a paper strip along the bottom (it wraps onto two rows
  on phones rather than hiding buttons off the edge). Chosen options are cobalt.
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
- **`packages/client/paper.html`:** the sample sheet (dev only, not part of the build).
