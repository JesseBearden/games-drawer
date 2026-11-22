/**
 * Changing what's on screen without rebuilding it. Setting innerHTML throws every element away:
 * a tap that had begun on one is lost, glides stop dead, pictures decode again, and the browser
 * lays it all out again. Both helpers keep the elements that are still wanted.
 */

/** What names an element among its siblings. (Elements without one are matched by place and tag.) */
const KEY_ATTRS = ['data-key', 'data-card', 'data-tile', 'data-alias', 'data-peer', 'data-game', 'data-seat', 'data-players', 'data-bid', 'data-act', 'data-v'];

function keyOf(n: Node | null): string | null {
  if (!(n instanceof Element)) return null;
  for (const a of KEY_ATTRS) {
    const v = n.getAttribute(a);
    if (v !== null) return `${a}=${v}`;
  }
  return null;
}

const alike = (a: Node, b: Node) => a.nodeType === b.nodeType && a.nodeName === b.nodeName;

const shown = new WeakMap<Element, { html: string; first: ChildNode | null }>();
const template = document.createElement('template');

/**
 * Like `el.innerHTML = html`, changing only what differs. True if anything had to change. Inline
 * styles the html doesn't mention are left alone (they're the layout code's).
 */
export function patchHtml(el: Element, html: string): boolean {
  const was = shown.get(el);
  // (Same html, and nobody has emptied it meanwhile.)
  if (was?.html === html && was.first === el.firstChild) return false;
  template.innerHTML = html;
  patchChildren(el, template.content);
  template.innerHTML = '';
  shown.set(el, { html, first: el.firstChild });
  return true;
}

function patchChildren(parent: Element, next: ParentNode) {
  const wanted = [...next.childNodes];
  const keys = new Set(wanted.map(keyOf).filter((k) => k !== null));
  for (const n of [...parent.childNodes]) {
    const key = keyOf(n);
    if (key !== null && !keys.has(key)) n.remove();
  }
  let at = parent.firstChild;
  for (const want of wanted) {
    const key = keyOf(want);
    let match: ChildNode | null = null;
    for (let n: ChildNode | null = at; n; n = n.nextSibling) {
      if (keyOf(n) === key && alike(n, want)) {
        match = n;
        break;
      }
    }
    if (!match) {
      parent.insertBefore(document.importNode(want, true), at);
      continue;
    }
    if (match === at) at = at.nextSibling;
    else parent.insertBefore(match, at);
    patchNode(match, want);
  }
  while (at) {
    const after: ChildNode | null = at.nextSibling;
    at.remove();
    at = after;
  }
}

function patchNode(node: ChildNode, want: ChildNode) {
  if (!(node instanceof Element) || !(want instanceof Element)) {
    if (node.nodeValue !== want.nodeValue) node.nodeValue = want.nodeValue;
    return;
  }
  if (node.isEqualNode(want)) return;
  for (const { name } of [...node.attributes]) if (name !== 'style' && !want.hasAttribute(name)) node.removeAttribute(name);
  for (const { name, value } of [...want.attributes]) if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  patchChildren(node, want);
}

export interface KeyedItem {
  key: string;
  className: string;
  /** The element's html, made only when there isn't one with this key already. Its class is replaced. */
  make(): string;
  style?: string;
}

const itemKeys = new WeakMap<Element, string>();

/**
 * A list of cards or tiles: the element for each key is kept (class and style updated), new ones
 * are made, gone ones removed, and only those out of place are moved.
 */
export function syncKeyed(parent: Element, items: readonly KeyedItem[]) {
  const keys = new Set(items.map((i) => i.key));
  const byKey = new Map<string, HTMLElement>();
  for (const el of [...parent.children] as HTMLElement[]) {
    const key = itemKeys.get(el);
    if (key !== undefined && keys.has(key) && !byKey.has(key)) byKey.set(key, el);
    else el.remove();
  }
  let at = parent.firstElementChild;
  for (const item of items) {
    let el = byKey.get(item.key);
    if (!el) {
      template.innerHTML = item.make();
      el = document.importNode(template.content.firstElementChild!, true) as HTMLElement;
      itemKeys.set(el, item.key);
    }
    if (el.className !== item.className) el.className = item.className;
    if (item.style !== undefined && el.getAttribute('style') !== item.style) el.setAttribute('style', item.style);
    if (el === at) {
      at = at.nextElementSibling;
    } else if (at && el === at.nextElementSibling) {
      // One card moved along: move it, not each card it passed (moving stops a card's glide).
      parent.append(at);
      at = el.nextElementSibling;
    } else {
      parent.insertBefore(el, at);
    }
  }
}
