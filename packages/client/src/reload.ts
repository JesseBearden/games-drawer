/** The site gets this long to answer before we decide it can't be reached. */
const ANSWER_WAIT_MS = 5000;

/**
 * Reload for an update, but only once the site has answered. "Online" only means Wi-Fi: reloading
 * with no internet behind it leaves the browser's error page, and from the home screen icon there
 * is no way back from that. `wanted` is asked again after the wait (they may have moved on).
 */
export async function reloadIfSiteAnswers(wanted: () => boolean): Promise<boolean> {
  try {
    const noAnswer = new Promise<null>((done) => setTimeout(() => done(null), ANSWER_WAIT_MS));
    const res = await Promise.race([fetch('/healthz', { cache: 'no-store' }), noAnswer]);
    if (!res?.ok) return false;
  } catch {
    return false;
  }
  return wanted() && reloadForUpdate();
}

/**
 * This page is from before an update (the server says so, or a piece of it is gone). A page opened
 * from the home screen has no reload button, so reload it ourselves (it comes back to the same
 * table), once: if that didn't help, the caller says so instead.
 */
export function reloadForUpdate(): boolean {
  const KEY = 'gd.reloadedForUpdate';
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  location.reload();
  return true;
}
