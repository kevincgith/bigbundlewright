// Big Bundle Wright: tiny DOM helpers (no framework).
// SPDX-License-Identifier: MPL-2.0

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; dataset?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'open') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

// Typing that has not been committed yet (an input event since the last change event).
// A re-render carries that text across instead of resetting the box to the saved value.
document.addEventListener('input', (e) => { (e.target as HTMLElement).dataset && ((e.target as HTMLElement).dataset.dirty = '1'); }, true);
document.addEventListener('change', (e) => { delete (e.target as HTMLElement).dataset?.dirty; }, true);

// While an input method (e.g. Chinese) is composing, re-rendering the focused section would
// break the composition, so that section's render waits until composition ends.
let composing = false;
const deferred = new Map<Element, Child[]>();
document.addEventListener('compositionstart', () => { composing = true; }, true);
document.addEventListener('compositionend', () => {
  composing = false;
  const jobs = [...deferred];
  deferred.clear();
  setTimeout(() => { for (const [t, c] of jobs) replace(t, ...c); }, 0);
}, true);

/** Replace an element's children, keeping focus (and uncommitted typing) on the element with the same data-key. */
export function replace(target: Element, ...children: Child[]) {
  const active = document.activeElement as HTMLElement | null;
  const inside = !!active && target.contains(active);
  if (composing && inside) { deferred.set(target, children); return; }
  const key = inside ? active!.dataset.key : undefined;
  const isText = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  const sel = isText ? [(active as HTMLInputElement).selectionStart, (active as HTMLInputElement).selectionEnd] : null;
  const draft = isText && active!.dataset.dirty === '1' ? (active as HTMLInputElement).value : null;
  target.replaceChildren();
  append(target, children);
  if (key) {
    const again = target.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (again) {
      if (draft !== null && (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement) && again.value !== draft) {
        again.value = draft;
        again.dataset.dirty = '1';
      }
      again.focus();
      if (sel && (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement) && sel[0] !== null) {
        try { again.setSelectionRange(sel[0], sel[1]); } catch { /* not a text input */ }
      }
    }
  }
}

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function uid(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

let liveEl: HTMLElement | null = null;
/** Announce a message to screen readers. */
export function announce(msg: string) {
  liveEl ??= document.getElementById('live');
  if (liveEl) { liveEl.textContent = ''; setTimeout(() => { liveEl!.textContent = msg; }, 30); }
}
