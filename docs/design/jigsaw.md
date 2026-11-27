# Jigsaw: design decisions

What every game shares is in [DESIGN.md](../../DESIGN.md). This file holds what is Jigsaw's own,
including the places where it departs from the shared rules on purpose.

**Jigsaw** is played on calm light-grey felt. Every loose piece casts a small shadow; joined
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
