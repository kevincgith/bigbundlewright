// Big Bundle Wright: index page layout (pure: produces draw operations).
// SPDX-License-Identifier: MPL-2.0

import type { PDFFont } from 'pdf-lib';
import type { FontSet } from './fonts.ts';
import type { Party, Size } from './model.ts';
import { A4, toRoman } from './util.ts';

export type ColKey = 'tab' | 'date' | 'description' | 'status' | 'bundle' | 'pages';

export interface IndexColumn {
  key: ColKey;
  title: string;
  /** Points; 0 = takes the remaining width. */
  width: number;
  align: 'left' | 'right' | 'center';
}

export interface IndexRow {
  kind: 'section' | 'doc';
  cells: Partial<Record<ColKey, string>>;
  /** Section rows: the text spanning the table. */
  title?: string;
  /** Doc rows: link target key. */
  linkKey?: string;
}

export interface IndexHeading {
  court: string;
  actionNo: string;
  actionLine?: string;
  parties: Party[];
  bundleTitle: string;
  confidential: boolean;
  volumeLine: string;
  indexTitle: string;
  continuationLine: string;
}

export type FontKey = 'regular' | 'bold' | 'italic';
export type DrawOp =
  | { t: 'text'; x: number; y: number; size: number; font: FontKey; text: string; color?: [number, number, number] }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; w: number; grey?: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number; grey: number };

export interface IndexPageLayout {
  ops: DrawOp[];
  links: { key: string; rect: [number, number, number, number] }[];
}

export interface IndexStyle {
  headingSize: Size;
  tableSize: Size;
  borders: boolean;
}

const MARGIN = 56.69; // 20 mm
const FOOTER = 28;

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

export function wrapText(text: string, width: number, font: PDFFont, size: number): string[] {
  const lines: string[] = [];
  const w = (s: string) => font.widthOfTextAtSize(s, size);
  for (const para of text.split('\n')) {
    const tokens = para.match(/[⺀-鿿豈-﫿＀-￯　-〿]|[^\s⺀-鿿豈-﫿＀-￯　-〿]+|\s+/g) ?? [];
    let line = '';
    let space = false;
    for (const tok of tokens) {
      if (/^\s+$/.test(tok)) { space = line.length > 0; continue; }
      const joiner = space && !(CJK.test(tok) && CJK.test(line.slice(-1))) ? ' ' : '';
      const cand = line + joiner + tok;
      space = false;
      if (w(cand) <= width) { line = cand; continue; }
      if (line) lines.push(line);
      if (w(tok) <= width) { line = tok; continue; }
      // Hard-break an over-long token.
      let chunk = '';
      for (const ch of tok) {
        if (w(chunk + ch) > width && chunk) { lines.push(chunk); chunk = ch; } else chunk += ch;
      }
      line = chunk;
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

const sz = (s: Size, m: number) => (s === 'S' ? m - 1 : s === 'L' ? m + 1 : m);

/**
 * Lay out an index. Pages are A4 portrait. Returns one layout per page.
 * `fonts.safe` must already have been applied to all strings by the caller.
 */
export function layoutIndex(
  fonts: FontSet,
  heading: IndexHeading,
  columns: IndexColumn[],
  rows: IndexRow[],
  style: IndexStyle,
  legend: string[],
): IndexPageLayout[] {
  const PW = A4.w, PH = A4.h, W = PW - 2 * MARGIN;
  const fs = sz(style.tableSize, 10);
  const hs = sz(style.headingSize, 11);
  const ts = hs + 3;
  const lead = fs * 1.25;
  const padX = 4, padY = 3.5;
  const font = (k: FontKey) => fonts[k];
  const tw = (s: string, k: FontKey, size: number) => font(k).widthOfTextAtSize(s, size);

  const fixed = columns.reduce((a, c) => a + c.width, 0);
  const flex = columns.filter((c) => c.width === 0).length;
  const colW = columns.map((c) => (c.width === 0 ? (W - fixed) / Math.max(1, flex) : c.width));
  const colX = colW.map((_, i) => MARGIN + colW.slice(0, i).reduce((a, b) => a + b, 0));

  const pages: IndexPageLayout[] = [];
  let page!: IndexPageLayout;
  let y = 0;

  const text = (s: string, x: number, yy: number, size: number, k: FontKey, color?: [number, number, number]) =>
    page.ops.push({ t: 'text', x, y: yy, size, font: k, text: s, ...(color ? { color } : {}) });
  const centred = (s: string, size: number, k: FontKey, color?: [number, number, number]) => {
    for (const line of wrapText(s, W, font(k), size)) {
      y -= size * 1.3;
      text(line, (PW - tw(line, k, size)) / 2, y, size, k, color);
    }
  };
  const rule = (w = 0.75) => page.ops.push({ t: 'line', x1: MARGIN, y1: y, x2: PW - MARGIN, y2: y, w });

  const tableHeader = () => {
    // Titles may be two lines ("No.\n編號") when headings are bilingual.
    const titles = columns.map((c) => c.title.split('\n'));
    const h = Math.max(...titles.map((t) => t.length)) * lead + 2 * padY;
    page.ops.push({ t: 'rect', x: MARGIN, y: y - h, w: W, h, grey: 0.88 });
    columns.forEach((c, i) => {
      titles[i].forEach((ln, j) => {
        const lineW = tw(ln, 'bold', fs);
        const x = c.align === 'right' ? colX[i] + colW[i] - padX - lineW
          : c.align === 'center' ? colX[i] + (colW[i] - lineW) / 2 : colX[i] + padX;
        text(ln, x, y - padY - fs * 0.85 - j * lead, fs, 'bold');
      });
    });
    y -= h;
    page.ops.push({ t: 'line', x1: MARGIN, y1: y, x2: PW - MARGIN, y2: y, w: 0.6 });
  };

  const newPage = (withTableHeader: boolean) => {
    page = { ops: [], links: [] };
    pages.push(page);
    y = PH - MARGIN;
    if (pages.length > 1) {
      y -= hs;
      text(heading.continuationLine, MARGIN, y, hs - 1, 'italic');
      y -= hs * 0.9;
    }
    if (withTableHeader) tableHeader();
  };

  // ---- first page heading ----
  newPage(false);
  y -= hs;
  text(heading.actionNo, PW - MARGIN - tw(heading.actionNo, 'bold', hs), y, hs, 'bold');
  y -= hs * 0.6;
  for (const line of heading.court.split('\n').filter(Boolean)) centred(line, hs, 'bold');
  if (heading.actionLine) centred(heading.actionLine, hs, 'bold');
  if (heading.parties.length) {
    y -= hs * 0.9;
    y -= hs * 1.3;
    text('BETWEEN', MARGIN, y, hs, 'bold');
    const side = (r: string) => (/defendant|respondent/i.test(r) ? 2 : /third|intervener|interested/i.test(r) ? 3 : 1);
    let prevSide = 0;
    const roleW = 130;
    for (const p of heading.parties) {
      const s = side(p.role);
      if (prevSide && s !== prevSide) centred('and', hs, 'regular');
      prevSide = s;
      const nameLines = wrapText(p.name, W - 2 * roleW, font('bold'), hs);
      nameLines.forEach((ln, i) => {
        y -= hs * 1.3;
        text(ln, (PW - tw(ln, 'bold', hs)) / 2, y, hs, 'bold');
        if (i === 0) text(p.role, PW - MARGIN - tw(p.role, 'regular', hs), y, hs, 'regular');
      });
    }
  }
  y -= hs;
  rule();
  y -= 4;
  if (heading.confidential) {
    const full = `CONFIDENTIAL ${heading.bundleTitle}`.toUpperCase();
    y -= ts * 1.3;
    const x0 = (PW - tw(full, 'bold', ts)) / 2;
    text('CONFIDENTIAL', x0, y, ts, 'bold', [0.75, 0.1, 0.1]);
    text(heading.bundleTitle.toUpperCase(), x0 + tw('CONFIDENTIAL ', 'bold', ts), y, ts, 'bold');
  } else {
    centred(heading.bundleTitle.toUpperCase(), ts, 'bold');
  }
  centred(heading.volumeLine, hs, 'bold');
  centred(heading.indexTitle, hs, 'bold');
  y -= hs * 0.7;
  rule();
  y -= 8;
  tableHeader();

  // ---- rows ----
  const bottom = MARGIN + FOOTER;
  for (const row of rows) {
    if (row.kind === 'section') {
      const lines = wrapText(row.title ?? '', W - 2 * padX, font('bold'), fs);
      const h = lines.length * lead + 2 * padY;
      if (y - h < bottom) newPage(true);
      page.ops.push({ t: 'rect', x: MARGIN, y: y - h, w: W, h, grey: 0.95 });
      lines.forEach((ln, i) => text(ln, MARGIN + padX, y - padY - fs * 0.85 - i * lead, fs, 'bold'));
      y -= h;
      if (style.borders) page.ops.push({ t: 'line', x1: MARGIN, y1: y, x2: PW - MARGIN, y2: y, w: 0.4, grey: 0.5 });
      continue;
    }
    const cellLines = columns.map((c, i) => wrapText(row.cells[c.key] ?? '', colW[i] - 2 * padX, font('regular'), fs));
    const h = Math.max(...cellLines.map((l) => l.length)) * lead + 2 * padY;
    if (y - h < bottom) newPage(true);
    columns.forEach((c, i) => {
      cellLines[i].forEach((ln, j) => {
        const lw = tw(ln, 'regular', fs);
        const x = c.align === 'right' ? colX[i] + colW[i] - padX - lw
          : c.align === 'center' ? colX[i] + (colW[i] - lw) / 2 : colX[i] + padX;
        text(ln, x, y - padY - fs * 0.85 - j * lead, fs, 'regular');
      });
    });
    if (row.linkKey) page.links.push({ key: row.linkKey, rect: [MARGIN, y - h, PW - MARGIN, y] });
    y -= h;
    if (style.borders) page.ops.push({ t: 'line', x1: MARGIN, y1: y, x2: PW - MARGIN, y2: y, w: 0.4, grey: 0.5 });
  }

  // ---- legend ----
  if (legend.length) {
    y -= fs;
    const ls = fs - 1;
    for (const para of legend) {
      const lines = wrapText(para, W, font('italic'), ls);
      if (y - lines.length * ls * 1.3 < bottom) newPage(false);
      for (const ln of lines) { y -= ls * 1.3; text(ln, MARGIN, y, ls, 'italic'); }
      y -= ls * 0.4;
    }
  }

  // ---- footers: roman page numbers, bottom centre (index pages are not bundle-paginated) ----
  pages.forEach((p, i) => {
    const r = toRoman(i + 1);
    p.ops.push({ t: 'text', x: (PW - fonts.regular.widthOfTextAtSize(r, 9)) / 2, y: MARGIN / 2, size: 9, font: 'regular', text: r });
  });
  return pages;
}
