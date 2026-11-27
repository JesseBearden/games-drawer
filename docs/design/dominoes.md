# Dominoes: design decisions

What every game shares is in [DESIGN.md](../../DESIGN.md). This file holds what is Dominoes' own,
including the places where it departs from the shared rules on purpose.

**Dominoes**: the places you can play are dashed (they don't pulse). Lines turn at the edge of
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
