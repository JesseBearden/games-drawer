/**
 * A phone's browser held sideways (not opened from the home screen icon): the page scrolls a
 * little, so a swipe up tucks the browser's tabs and address bar away and the game gets the whole
 * screen (user, 2026-11-23; Tanks and Mahjong). The game stays pinned to the screen (styles.css
 * "tuck-bars"), so where the page is scrolled to never shows; main.ts leaves that scroll alone.
 *
 * Safari only tucks its bars when a swipe scrolls the page down. So whenever the bars are showing
 * again (the phone turned upright and back, or a tap on the bar brought them back), once nobody is
 * touching the screen and things have settled, the page goes back to the top: the next swipe up
 * always has room. Without this, turning the phone upright and back could leave the page scrolled
 * to the bottom, and a swipe up did nothing until a swipe down (user, 2026-11-23).
 *
 * On an iPhone with the bars showing, "Swipe up for fullscreen" shows briefly across the middle,
 * faint, and taps go through it. Held upright at first, it waits for the phone to be turned.
 *
 * Returns what to call when the game closes.
 */
export function tuckBars(small: boolean): () => void {
  if (!small) return () => {};
  const homeScreen = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (homeScreen) return () => {};
  const root = document.documentElement;
  root.classList.add('tuck-bars');
  const landscape = () => matchMedia('(orientation: landscape)').matches;

  // The tallest the page has been held sideways, which is with the bars tucked away. Shorter than
  // that by more than a little, they're showing.
  let tallest = 0;
  const measure = () => {
    if (landscape()) tallest = Math.max(tallest, window.innerHeight);
  };
  measure();

  let touching = 0;
  let settle: number | undefined;
  const toTop = () => {
    measure();
    if (touching || !landscape() || window.scrollY <= 0) return;
    if (window.innerHeight < tallest - 30) window.scrollTo(0, 0);
  };
  const settleSoon = () => {
    clearTimeout(settle);
    settle = window.setTimeout(toTop, 500);
  };
  const onTouch = (e: TouchEvent) => {
    touching = e.touches.length;
    settleSoon();
  };

  // The hint. iPhones report the screen's size held upright, so its width is the height there is
  // to fill sideways, before anything has been measured.
  let hinted = false;
  let hint: HTMLElement | null = null;
  let hintTimer: number | undefined;
  const barsShowing = () => window.innerHeight < Math.max(tallest, Math.min(screen.width, screen.height)) - 30;
  const maybeHint = () => {
    if (hinted || !/iPhone|iPod/.test(navigator.userAgent) || !landscape()) return;
    hinted = true;
    const arena = document.getElementById('arena');
    if (!arena || !barsShowing()) return;
    hint = document.createElement('div');
    hint.className = 'swipe-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.textContent = 'Swipe up for fullscreen';
    arena.append(hint);
    hintTimer = window.setTimeout(hideHint, 2800);
  };
  const hideHint = () => {
    const el = hint;
    if (!el) return;
    hint = null;
    clearTimeout(hintTimer);
    el.classList.add('gone');
    window.setTimeout(() => el.remove(), 450);
  };

  const onResize = () => {
    measure();
    settleSoon();
    // They swiped the bars away while the hint was up: it's done its job.
    if (hint && !barsShowing()) hideHint();
  };
  const onTurn = () => {
    settleSoon();
    window.setTimeout(maybeHint, 300);
  };
  const firstHint = window.setTimeout(maybeHint, 700);
  const passive = { passive: true } as const;
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', settleSoon, passive);
  window.addEventListener('orientationchange', onTurn);
  for (const ev of ['touchstart', 'touchend', 'touchcancel'] as const) window.addEventListener(ev, onTouch, passive);

  return () => {
    clearTimeout(firstHint);
    clearTimeout(settle);
    hint?.remove();
    hint = null;
    clearTimeout(hintTimer);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', settleSoon);
    window.removeEventListener('orientationchange', onTurn);
    for (const ev of ['touchstart', 'touchend', 'touchcancel'] as const) window.removeEventListener(ev, onTouch);
    root.classList.remove('tuck-bars');
    window.scrollTo(0, 0);
  };
}
