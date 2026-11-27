# Three Thirteen: design decisions

What every game shares is in [DESIGN.md](../../DESIGN.md). This file holds what is Three Thirteen's own,
including the places where it departs from the shared rules on purpose.

**Three Thirteen** (user, 2026-11-20), with the user's family rules: two decks with their
jokers, 11 rounds (3 cards up to 13), jokers and the round's own rank wild, Ace low with no
wrapping, any number of wilds in a meld, one last turn each after someone goes out, no adding to
other people's melds. Unmelded cards: Ace 1, number cards their number, J/Q/K 10, jokers 20;
lowest total wins. You can't throw back the card you just took from the discards.

- **The table picks how many play**, 2 to 4 (never fewer than the people there), so two people
  can play without a computer going out on them. Seats come into play across from the first
  seat picked, then its sides (Dominoes too).
- **Name tags** show the name and the score, and "Went out" for whoever did: no card count
  (user, 2026-11-26), since everyone holds the round's number.
- **The middle:** the round and what's wild, the pile (with its count) and the top discard; the
  one you can take from glows sunflower.
- **Your hand:** drag cards into any order (no sort buttons; the server keeps your order). Tap
  a card to lift it, tap it again (or the discards) to throw it. Cards in a meld are tinted
  light green all over; this round's wild rank wears a small sunflower star on its top-left
  corner, sticking out past it a little (user, 2026-11-25); the card you just
  took says "Taken". A tag says "Left over: 7 pts". **Go out** appears only when you can, and
  the card that does it is outlined.
- **Between rounds:** everyone's hand, melds first, then the score sheet (headed Round), and
  Ready for the next round.
