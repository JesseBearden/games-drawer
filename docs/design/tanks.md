# Tanks: design decisions

What every game shares is in [DESIGN.md](../../DESIGN.md). This file holds what is Tanks' own,
including the places where it departs from the shared rules on purpose.

**Tanks** is a felt scene: a muted blue sky, slate felt mountains, and ground in layers of olive,
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
