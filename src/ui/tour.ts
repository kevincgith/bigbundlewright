// Big Bundle Wright: a step-by-step walk-through of the page.
// Each step highlights one part of the page and explains it. Keyboard: Right/Left to move, Esc to close.
// SPDX-License-Identifier: MPL-2.0

import { announce, h } from './dom.ts';

export interface TourStep {
  /** Part of the page to highlight; none for an introduction or closing step. */
  target?: () => Element | null | undefined;
  title: string;
  body: (Node | string)[];
  /** Extra buttons on this step (e.g. "Use example documents"). */
  actions?: { label: string; primary?: boolean; run: () => void | Promise<void> }[];
}

let active: (() => void) | null = null;

export function tourIsOpen() { return active !== null; }

export function startTour(steps: TourStep[], opts: { onClose?: () => void } = {}) {
  active?.();
  let index = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const page = ['.hero', 'main', '.site-foot'].map((s) => document.querySelector<HTMLElement>(s)).filter(Boolean) as HTMLElement[];
  const wasInert = page.map((el) => el.inert);

  const hole = h('div', { class: 'tour-hole' });
  const shade = h('div', { class: 'tour-shade' }, hole);
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title' });
  document.body.append(shade, card);
  page.forEach((el) => { el.inert = true; });

  const close = () => {
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('scrollend', place, true);
    document.removeEventListener('keydown', onKey, true);
    shade.remove();
    card.remove();
    page.forEach((el, i) => { el.inert = wasInert[i]; });
    active = null;
    opts.onClose?.();
  };
  active = close;

  function place() {
    const step = steps[index];
    const el = step.target?.();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    if (!el) {
      hole.className = 'tour-hole none';
      card.style.left = `${Math.max(12, (vw - cw) / 2)}px`;
      card.style.top = `${Math.max(12, (vh - ch) / 2)}px`;
      return;
    }
    hole.className = 'tour-hole';
    const r = el.getBoundingClientRect();
    const pad = 6;
    const top = Math.max(4, r.top - pad), left = Math.max(4, r.left - pad);
    const bottom = Math.min(vh - 4, r.bottom + pad), right = Math.min(vw - 4, r.right + pad);
    Object.assign(hole.style, { top: `${top}px`, left: `${left}px`, width: `${Math.max(0, right - left)}px`, height: `${Math.max(0, bottom - top)}px` });
    // Card below the highlight if it fits, else above, else over the bottom of the screen.
    let y = bottom + 14;
    if (y + ch > vh - 12) y = top - ch - 14;
    if (y < 12) y = vh - ch - 12;
    const x = Math.min(Math.max(12, left), vw - cw - 12);
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  function show(i: number) {
    index = Math.max(0, Math.min(steps.length - 1, i));
    const step = steps[index];
    const last = index === steps.length - 1;
    card.replaceChildren(
      h('div', { class: 'tour-count' }, `Step ${index + 1} of ${steps.length}`),
      h('h2', { id: 'tour-title' }, step.title),
      h('div', null, ...step.body),
      h('div', { class: 'tour-dots', 'aria-hidden': 'true' }, ...steps.map((_, k) => h('i', { class: k === index ? 'on' : '' }))),
      h('div', { class: 'tour-actions' },
        h('button', { class: 'btn ghost small', onclick: close }, last ? 'Close' : 'Skip the tour'),
        h('span', null,
          index > 0 ? h('button', { class: 'btn small', onclick: () => show(index - 1) }, 'Back') : null,
          ...(step.actions ?? []).map((a) => h('button', {
            class: `btn small${a.primary ? ' primary' : ''}`,
            onclick: async () => { await a.run(); show(index + 1); },
          }, a.label)),
          !step.actions?.some((a) => a.primary)
            ? h('button', { class: 'btn small primary', dataset: { primary: '1' }, onclick: () => (last ? close() : show(index + 1)) }, last ? 'Finish' : 'Next')
            : null)),
    );
    const el = step.target?.();
    el?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    requestAnimationFrame(place);
    if (!reduced) { setTimeout(place, 350); setTimeout(place, 900); } // after smooth scrolling settles
    (card.querySelector<HTMLElement>('.btn.primary') ?? card.querySelector<HTMLElement>('button'))?.focus();
    announce(`Step ${index + 1} of ${steps.length}: ${step.title}`);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); if (index < steps.length - 1) show(index + 1); }
    else if (e.key === 'ArrowLeft' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); if (index > 0) show(index - 1); }
    else if (e.key === 'Tab') {
      // Keep focus inside the tour card.
      const f = [...card.querySelectorAll<HTMLElement>('button')];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  }

  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  window.addEventListener('scrollend', place, true);
  document.addEventListener('keydown', onKey, true);
  show(0);
}
