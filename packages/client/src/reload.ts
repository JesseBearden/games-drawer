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
