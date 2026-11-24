// Big Bundle Wright: low-level PDF structures pdf-lib has no API for
// (link annotations, outlines/bookmarks, page labels).
// SPDX-License-Identifier: MPL-2.0

import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFString, PDFName, PDFNumber, PDFPage, PDFRef,
} from 'pdf-lib';

/**
 * Text for PDF strings (bookmark titles, page-label prefixes, file names in links).
 * Always UTF-16 hex: pdf-lib writes PDFString.of() unescaped, so "(", ")" or "\\" in a
 * description would otherwise break the PDF syntax.
 */
export const pdfText = (s: string) => PDFHexString.fromText(s);

/** A file name for a link (/F is a byte string): escaped literal when ASCII, else UTF-16 hex. */
const pdfFileName = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? PDFString.of(s.replace(/[\\()]/g, (c) => `\\${c}`)) : PDFHexString.fromText(s));

/** Destination: top of `page` at the viewer's current zoom. */
export function destTop(doc: PDFDocument, page: PDFPage): PDFArray {
  return doc.context.obj([page.ref, 'XYZ', 0, page.getHeight(), null]) as PDFArray;
}

export function addLink(doc: PDFDocument, onPage: PDFPage, rect: [number, number, number, number], target: PDFPage) {
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: rect,
    Border: [0, 0, 0],
    Dest: destTop(doc, target),
  });
  onPage.node.addAnnot(doc.context.register(annot));
}

/** Link to a page (0-based) in another PDF file (GoToR), used by the master index. */
export function addRemoteLink(
  doc: PDFDocument, onPage: PDFPage, rect: [number, number, number, number],
  fileName: string, pageIndex: number, pageHeight: number,
) {
  const ctx = doc.context;
  const action = ctx.obj({
    S: 'GoToR',
    F: pdfFileName(fileName),
    D: [pageIndex, 'XYZ', 0, pageHeight, null],
    NewWindow: true,
  });
  const annot = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], A: action });
  onPage.node.addAnnot(ctx.register(annot));
}

export interface OutlineItem {
  title: string;
  page: PDFPage;
  open?: boolean;
  children?: OutlineItem[];
}

export function writeOutline(doc: PDFDocument, items: OutlineItem[]) {
  const ctx = doc.context;
  const rootRef = ctx.nextRef();
  const build = (list: OutlineItem[], parent: PDFRef) => {
    const refs = list.map(() => ctx.nextRef());
    let visible = 0;
    list.forEach((it, i) => {
      const dict = ctx.obj({}) as PDFDict;
      dict.set(PDFName.of('Title'), pdfText(it.title));
      dict.set(PDFName.of('Parent'), parent);
      dict.set(PDFName.of('Dest'), destTop(doc, it.page));
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < list.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      visible += 1;
      if (it.children?.length) {
        const sub = build(it.children, refs[i]);
        dict.set(PDFName.of('First'), sub.first);
        dict.set(PDFName.of('Last'), sub.last);
        const open = it.open ?? true;
        dict.set(PDFName.of('Count'), PDFNumber.of(open ? sub.visible : -sub.visible));
        if (open) visible += sub.visible;
      }
      ctx.assign(refs[i], dict);
    });
    return { first: refs[0], last: refs[refs.length - 1], visible };
  };
  if (!items.length) return;
  const top = build(items, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.visible }));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

export interface LabelRange {
  start: number; // 0-based page index
  style?: 'D' | 'r' | 'R' | 'A' | 'a';
  prefix?: string;
  first?: number;
}

export function setPageLabels(doc: PDFDocument, ranges: LabelRange[]) {
  const ctx = doc.context;
  const nums: unknown[] = [];
  for (const r of ranges) {
    const d = ctx.obj({}) as PDFDict;
    if (r.style) d.set(PDFName.of('S'), PDFName.of(r.style));
    if (r.prefix) d.set(PDFName.of('P'), pdfText(r.prefix));
    if (r.first && r.first !== 1) d.set(PDFName.of('St'), PDFNumber.of(r.first));
    nums.push(r.start, d);
  }
  const tree = ctx.obj({ Nums: nums as never });
  doc.catalog.set(PDFName.of('PageLabels'), ctx.register(tree));
}

/** Turn per-page string labels into /PageLabels ranges ("A12" → prefix "A", decimal from 12). */
export function labelRanges(labels: string[], offset: number): LabelRange[] {
  const out: LabelRange[] = [];
  let prev: { p: string; n: number } | null = null;
  labels.forEach((l, i) => {
    const m = /^(.*?)(\d+)$/.exec(l);
    const cur = m ? { p: m[1], n: +m[2] } : null;
    if (cur && prev && cur.p === prev.p && cur.n === prev.n + 1) { prev = cur; return; }
    if (cur) out.push({ start: offset + i, style: 'D', prefix: cur.p || undefined, first: cur.n });
    else out.push({ start: offset + i, prefix: l });
    prev = cur;
  });
  return out;
}
