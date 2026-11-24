// Big Bundle Wright: small pure helpers.
// SPDX-License-Identifier: MPL-2.0

import type { DateStyle } from './model.ts';

export const A4 = { w: 595.28, h: 841.89 } as const;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- dates ----------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];

export function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export function formatDate(iso: string | null, style: DateStyle): string {
  if (!iso || style === 'None') return '';
  const [y, m, d] = iso.split('-');
  const mi = +m - 1;
  switch (style) {
    case 'DD/MM/YYYY': return `${d}/${m}/${y}`;
    case 'YYYY-MM-DD': return iso;
    case 'DD-MM-YYYY': return `${d}-${m}-${y}`;
    case 'MM/DD/YYYY': return `${m}/${d}/${y}`;
    case 'DD Mon. YYYY': return `${+d} ${MONTHS_SHORT[mi]} ${y}`;
    case 'DD Month YYYY': return `${+d} ${MONTHS[mi]} ${y}`;
    case 'Mon. DD, YYYY': return `${MONTHS_SHORT[mi]} ${+d}, ${y}`;
    case 'Month DD, YYYY': return `${MONTHS[mi]} ${+d}, ${y}`;
  }
}

const MONTH_LOOKUP: Record<string, number> = {};
MONTHS.forEach((name, i) => {
  MONTH_LOOKUP[name.toLowerCase()] = i + 1;
  MONTH_LOOKUP[name.slice(0, 3).toLowerCase()] = i + 1;
});
MONTH_LOOKUP['sept'] = 9;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Pull a leading date and a title out of a file name.
 * Hong Kong convention: numeric dates are day-first (15.03.2024 = 15 March).
 */
export function parseFileName(fileName: string): { date: string | null; title: string } {
  const base = fileName.replace(/\.[A-Za-z0-9]{2,5}$/, '');
  const tryIso = (y: number, m: number, d: number) => {
    const iso = `${y}-${pad(m)}-${pad(d)}`;
    return isValidIsoDate(iso) ? iso : null;
  };
  const patterns: [RegExp, (m: RegExpExecArray) => string | null][] = [
    [/^(\d{4})[-._ ](\d{1,2})[-._ ](\d{1,2})(?!\d)/, (m) => tryIso(+m[1], +m[2], +m[3])],
    [/^(\d{4})(\d{2})(\d{2})(?!\d)/, (m) => tryIso(+m[1], +m[2], +m[3])],
    [/^(\d{1,2})[-._ ](\d{1,2})[-._ ](\d{4})(?!\d)/, (m) => tryIso(+m[3], +m[2], +m[1])],
    [/^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?[ -](\d{4})(?!\d)/, (m) => {
      const mo = MONTH_LOOKUP[m[2].toLowerCase()];
      return mo ? tryIso(+m[3], mo, +m[1]) : null;
    }],
  ];
  for (const [re, fn] of patterns) {
    const m = re.exec(base);
    if (m) {
      const date = fn(m);
      if (date) {
        const title = base.slice(m[0].length).replace(/^[\s\-_.,–—]+/, '').trim();
        return { date, title: title || base };
      }
    }
  }
  return { date: null, title: base.replace(/[_]+/g, ' ').trim() };
}

/** Make a string safe as a file name on Windows, macOS and Linux. "HCA 1234/2025" → "HCA 1234-2025". */
export function safeFileName(s: string): string {
  return s
    .replace(/[\/\\]/g, '-')
    .replace(/[:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

export function volumeLetter(i: number): string {
  // A..Z, then AA, AB… (spreadsheet style)
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function toRoman(n: number): string {
  const map: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'],
    [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

// ---------- page geometry ----------

export interface Fit {
  /** Output page size. */
  outW: number;
  outH: number;
  /** Scale applied to the visual source page. */
  scale: number;
  /** Bottom-left of the placed visual box on the output page. */
  x: number;
  y: number;
}

/** Stamp zone, measured from the top-right corner of the output page (points). */
export const STAMP_ZONE = { w: 132, h: 40 } as const;
/** Binding / copier margin checked for edge content (5 mm). */
export const EDGE_MARGIN = 14.17;

/**
 * Fit a visual page (w × h, already rotated) onto A4 in the same orientation.
 * With `clearStamp`, the content is shrunk just enough to leave the stamp strip clear.
 */
export function fitToA4(w: number, h: number, clearStamp = false, edge: 'top' | 'bottom' = 'top'): Fit {
  const landscape = w > h;
  const outW = landscape ? A4.h : A4.w;
  const outH = landscape ? A4.w : A4.h;
  let scale = Math.min(outW / w, outH / h);
  if (!clearStamp) {
    return { outW, outH, scale, x: (outW - w * scale) / 2, y: (outH - h * scale) / 2 };
  }
  const availH = outH - STAMP_ZONE.h;
  scale = Math.min(scale, availH / h);
  const x = (outW - w * scale) / 2;
  // Centre the content in the part of the page the stamp does not use.
  const gap = Math.max(0, availH - h * scale) / 2;
  const y = edge === 'top' ? gap : STAMP_ZONE.h + gap;
  return { outW, outH, scale, x, y };
}

export function isA4(w: number, h: number, tol = 2): boolean {
  return (Math.abs(w - A4.w) < tol && Math.abs(h - A4.h) < tol)
    || (Math.abs(w - A4.h) < tol && Math.abs(h - A4.w) < tol);
}

export function rangesFromLabels(labels: string[]): string {
  // Compress ["12","13","14","20"] → "12–14, 20". Non-numeric labels are listed as-is.
  const out: string[] = [];
  let start: string | null = null;
  let prev: { p: string; n: number } | null = null;
  let last = '';
  const parse = (l: string) => {
    const m = /^(.*?)(\d+)$/.exec(l);
    return m ? { p: m[1], n: +m[2] } : null;
  };
  for (const l of labels) {
    const cur = parse(l);
    if (start !== null && cur && prev && cur.p === prev.p && cur.n === prev.n + 1) {
      prev = cur; last = l; continue;
    }
    if (start !== null) out.push(start === last ? start : `${start}–${last}`);
    start = l; last = l; prev = cur;
  }
  if (start !== null) out.push(start === last ? start : `${start}–${last}`);
  return out.join(', ');
}
