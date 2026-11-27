# Mahjong: design decisions

What every game shares is in [DESIGN.md](../../DESIGN.md). This file holds what is Mahjong's own,
including the places where it departs from the shared rules on purpose.

**Mahjong** (user, 2026-11-22/23; the user's phone mockups): Hong Kong style, 144 tiles, always
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
- **Sounds:** tiles clack (made in code, `tileClack` in audio.ts): every discard, three for a
  set taken and one per tile dealt. The shuffle (`tileShuffle`) is a recording, the same busy
  wash Dominoes uses (user, 2026-11-26).
- **After a hand:** the winner's tiles face up, and with points each item it scored with a
  plain explanation, then the score sheet and Ready for the next hand.
