// Big Bundle Wright: labels for the physical files.
// Spine labels for every volume (main, core, transcripts) and, where there are more
// than 5 files in total (PD 5.6 para 7), inside-cover labels showing the volume
// prominently, to go on the top right-hand corner of the inside cover.
// A4 sheets with dashed cut lines.
// SPDX-License-Identifier: MPL-2.0

import { PDFDocument, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { fontSetFor, type FontBytes, type FontSet } from './fonts.ts';
import { zhBundleName, zhPages } from './i18n.ts';
import { wrapText } from './layout-index.ts';
import type { BundleKind, Project } from './model.ts';
import { pageRange, type BuildPlan } from './plan.ts';
import { A4 } from './util.ts';
import { outputBaseName } from './build.ts';

const MM = 72 / 25.4;
/** Spine label: 55 × 190 mm, fits the spine pocket of a standard 75–80 mm lever-arch file. */
export const SPINE_LABEL_MM = { w: 55, h: 190 } as const;
/** Inside-cover label: 90 × 60 mm. */
export const COVER_LABEL_MM = { w: 90, h: 60 } as const;

export interface LabelVolume {
  kind: BundleKind;
  letter: string;
  name: string;
  firstLabel: string;
  lastLabel: string;
}

export interface LabelsOptions {
  fonts?: FontBytes;
  /** Chinese bundle names on the labels (needs `fonts`). */
  bilingual?: boolean;
  /** Inside-cover labels: default only when there are more than 5 files (PD 5.6 para 7). */
  insideCover?: boolean;
  date?: Date;
}

export interface LabelsFile {
  fileName: string;
  bytes: Uint8Array;
  pageCount: number;
  spineLabels: number;
  insideCoverLabels: number;
}

export function labelVolumes(plan: BuildPlan): LabelVolume[] {
  return [plan.main, plan.core, plan.transcripts].flatMap((b) => b ? b.volumes.map((v) => ({
    kind: b.kind, letter: v.letter, name: v.name,
    firstLabel: v.pages[0].label, lastLabel: v.pages[v.pages.length - 1].label,
  })) : []);
}

const pagesText = (v: LabelVolume) => (v.firstLabel === v.lastLabel ? `p. ${v.firstLabel}` : `pp. ${pageRange(v.firstLabel, v.lastLabel)}`);

/** "Bundle A — HCA 1234/2025 — pp. 1–248". */
export function spineText(project: Project, v: LabelVolume): string {
  return `${v.name} — ${project.case.actionNo} — ${pagesText(v)}`;
}

/** The big text: the volume letter for main bundles, else "CORE" / "TRANSCRIPTS" (+ letter if several). */
function bigText(v: LabelVolume): string {
  if (v.kind === 'main') return v.letter;
  const base = v.kind === 'core' ? 'CORE' : 'TRANSCRIPTS';
  return v.name.endsWith(` ${v.letter}`) ? `${base} ${v.letter}` : base;
}

function fit(font: PDFFont, text: string, maxW: number, maxSize: number, minSize = 6): number {
  const w = font.widthOfTextAtSize(text, maxSize);
  return w <= maxW ? maxSize : Math.max(minSize, (maxSize * maxW) / w);
}

function cutBox(page: PDFPage, x: number, y: number, w: number, h: number) {
  page.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0.55, 0.55, 0.55), borderWidth: 0.5, borderDashArray: [4, 3] });
}

function sheetHeader(page: PDFPage, fonts: FontSet, text: string) {
  page.drawText(fonts.safe(text), { x: 15 * MM, y: A4.h - 10 * MM, size: 8, font: fonts.regular, color: rgb(0.35, 0.35, 0.35) });
}

function centredLines(page: PDFPage, lines: string[], font: PDFFont, size: number, cx: number, top: number, lead = 1.25): number {
  let y = top;
  for (const ln of lines) {
    y -= size * lead;
    page.drawText(ln, { x: cx - font.widthOfTextAtSize(ln, size) / 2, y, size, font });
  }
  return y;
}

function drawSpine(page: PDFPage, fonts: FontSet, project: Project, v: LabelVolume, x: number, y: number, bilingual: boolean) {
  const W = SPINE_LABEL_MM.w * MM, H = SPINE_LABEL_MM.h * MM, pad = 4 * MM;
  const cx = x + W / 2;
  const inner = W - 2 * pad;
  cutBox(page, x, y, W, H);
  let top = y + H - pad;
  // Big volume mark.
  const big = fonts.safe(bigText(v));
  const bs = fit(fonts.label, big, inner, 72);
  top -= bs * 0.85;
  page.drawText(big, { x: cx - fonts.label.widthOfTextAtSize(big, bs) / 2, y: top, size: bs, font: fonts.label });
  top -= 4 * MM;
  if (bilingual) {
    const zh = fonts.safe(zhBundleName(v.kind, v.letter, v.name));
    top = centredLines(page, [zh], fonts.label, fit(fonts.label, zh, inner, 14), cx, top);
    top -= 2 * MM;
  }
  // Case details, horizontal.
  const c = project.case;
  top = centredLines(page, wrapText(fonts.safe(c.actionNo), inner, fonts.bold, 11), fonts.bold, 11, cx, top);
  top = centredLines(page, wrapText(fonts.safe(c.shortTitle), inner, fonts.regular, 10), fonts.regular, 10, cx, top);
  top = centredLines(page, wrapText(fonts.safe(c.bundleTitle), inner, fonts.regular, 9), fonts.regular, 9, cx, top);
  top -= 4 * MM;
  page.drawLine({ start: { x: x + pad, y: top }, end: { x: x + W - pad, y: top }, thickness: 0.5, color: rgb(0.3, 0.3, 0.3) });
  top -= 4 * MM;
  // Running text down the spine (reads top to bottom).
  const text = fonts.safe(spineText(project, v));
  const avail = top - (y + pad);
  const size = fit(fonts.label, text, avail, Math.min(18, inner * 0.6));
  const tw = fonts.label.widthOfTextAtSize(text, size);
  const startY = y + pad + (avail + tw) / 2;
  page.drawText(text, { x: cx - size * 0.35, y: startY, size, font: fonts.label, rotate: degrees(-90) });
  if (bilingual) {
    const zh = fonts.safe(`${zhBundleName(v.kind, v.letter, v.name)}　${zhPages(pageRange(v.firstLabel, v.lastLabel))}`);
    const zs = Math.min(size * 0.8, fit(fonts.label, zh, avail, 14));
    page.drawText(zh, { x: cx - size * 0.35 - size * 1.3, y: y + pad + (avail + fonts.label.widthOfTextAtSize(zh, zs)) / 2, size: zs, font: fonts.label, rotate: degrees(-90) });
  }
}

function drawInsideCover(page: PDFPage, fonts: FontSet, project: Project, v: LabelVolume, x: number, y: number, bilingual: boolean) {
  const W = COVER_LABEL_MM.w * MM, H = COVER_LABEL_MM.h * MM, pad = 5 * MM;
  cutBox(page, x, y, W, H);
  // Volume mark, large, top right.
  const big = fonts.safe(bigText(v));
  const bs = fit(fonts.label, big, W * 0.6, 54);
  const right = x + W - pad;
  page.drawText(big, { x: right - fonts.label.widthOfTextAtSize(big, bs), y: y + H - pad - bs * 0.75, size: bs, font: fonts.label });
  let ty = y + H - pad - bs * 0.75 - 6 * MM;
  const name = fonts.safe(bilingual ? `${v.name}  ${zhBundleName(v.kind, v.letter, v.name)}` : v.name);
  const ns = fit(fonts.label, name, W - 2 * pad, 14);
  page.drawText(name, { x: right - fonts.label.widthOfTextAtSize(name, ns), y: ty, size: ns, font: fonts.label });
  ty -= 6 * MM;
  const c = project.case;
  const lines: [string, PDFFont, number][] = [
    [c.actionNo, fonts.bold, 10],
    [c.shortTitle, fonts.regular, 10],
    [`${c.bundleTitle} — ${pagesText(v)}`, fonts.regular, 9],
  ];
  if (bilingual) lines.push([zhPages(pageRange(v.firstLabel, v.lastLabel)), fonts.regular, 9]);
  for (const [t, f, s] of lines) {
    for (const ln of wrapText(fonts.safe(t), W - 2 * pad, f, s)) {
      if (ty < y + pad) return;
      page.drawText(ln, { x: x + pad, y: ty, size: s, font: f });
      ty -= s * 1.3;
    }
  }
}

/** Number of physical files above which PD 5.6 para 7 asks for inside-cover labels. */
export const INSIDE_COVER_THRESHOLD = 5;

export async function buildLabels(project: Project, plan: BuildPlan, opts: LabelsOptions = {}): Promise<LabelsFile> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = await fontSetFor(doc, opts.fonts);
  const bilingual = !!opts.bilingual && fonts.cjk;
  const vols = labelVolumes(plan);
  const c = project.case;
  const caseLine = `${c.actionNo} ${c.shortTitle}`;

  // Spine labels: 3 per A4 sheet.
  const SW = SPINE_LABEL_MM.w * MM, SH = SPINE_LABEL_MM.h * MM, gap = 5 * MM;
  const perSheet = 3;
  const x0 = (A4.w - (perSheet * SW + (perSheet - 1) * gap)) / 2;
  const y0 = A4.h - 20 * MM - SH;
  for (let i = 0; i < vols.length; i += perSheet) {
    const page = doc.addPage([A4.w, A4.h]);
    sheetHeader(page, fonts, `Spine labels: ${caseLine}. Cut along the dashed lines.`);
    vols.slice(i, i + perSheet).forEach((v, k) => drawSpine(page, fonts, project, v, x0 + k * (SW + gap), y0, bilingual));
  }

  // Inside-cover labels: 2 × 4 per A4 sheet.
  const inside = opts.insideCover ?? plan.physicalFiles > INSIDE_COVER_THRESHOLD;
  if (inside) {
    const CW = COVER_LABEL_MM.w * MM, CH = COVER_LABEL_MM.h * MM;
    const cols = 2, rows = 4, per = cols * rows;
    const cx0 = (A4.w - (cols * CW + (cols - 1) * gap)) / 2;
    const cy0 = A4.h - 20 * MM;
    for (let i = 0; i < vols.length; i += per) {
      const page = doc.addPage([A4.w, A4.h]);
      sheetHeader(page, fonts, `Inside-cover labels (PD 5.6 para 7): ${caseLine}. Stick on the top right-hand corner of the inside cover.`);
      vols.slice(i, i + per).forEach((v, k) => {
        const col = k % cols, row = Math.floor(k / cols);
        drawInsideCover(page, fonts, project, v, cx0 + col * (CW + gap), cy0 - (row + 1) * CH - row * gap, bilingual);
      });
    }
  }

  const created = opts.date ?? new Date();
  doc.setTitle(`${c.actionNo} ${c.shortTitle} – Labels`);
  doc.setProducer('Big Bundle Wright');
  doc.setCreator('Big Bundle Wright');
  doc.setLanguage('en-HK');
  doc.setCreationDate(created);
  doc.setModificationDate(created);
  const bytes = await doc.save({ useObjectStreams: true });
  return {
    fileName: `${outputBaseName(project)} Labels.pdf`, bytes, pageCount: doc.getPageCount(),
    spineLabels: vols.length, insideCoverLabels: inside ? vols.length : 0,
  };
}

