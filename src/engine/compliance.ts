// Big Bundle Wright: PD 5.6 compliance report (data + a short PDF).
// Each check is computed from the build output, the plan and the warnings.
// SPDX-License-Identifier: MPL-2.0

import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { BuildOutput } from './build.ts';
import { describeDeadline, lodgingDeadline, type DeadlineResult } from './deadline.ts';
import { fontSetFor, type FontBytes, type FontSet } from './fonts.ts';
import { wrapText } from './layout-index.ts';
import type { BuildWarning, Project, WarningCode } from './model.ts';
import { pageRange } from './plan.ts';
import { A4, formatDate } from './util.ts';
import { outputBaseName } from './build.ts';

export type CheckStatus = 'pass' | 'warning' | 'not-applicable';

export const CHECK_STATUS_TEXT: Record<CheckStatus, string> = {
  pass: 'Pass',
  warning: 'Warning',
  'not-applicable': 'Not applicable',
};

export interface ComplianceCheck {
  id: string;
  /** PD 5.6 paragraph, e.g. "4(3)". */
  para: string;
  requirement: string;
  status: CheckStatus;
  detail: string;
  /** Warning codes that led to this result. */
  codes: WarningCode[];
}

export interface ComplianceReport {
  schema: 'bigbundle-wright/compliance@1';
  generatedAt: string;
  case: { actionNo: string; shortTitle: string; bundleTitle: string; hearingDate?: string };
  volumes: { kind: string; name: string; pages: string; contentPages: number; totalPages: number; fileName: string }[];
  physicalFiles: number;
  documentPages: number;
  checks: ComplianceCheck[];
  summary: Record<CheckStatus, number>;
  deadline?: DeadlineResult & { text: string };
  warnings: BuildWarning[];
  /** Always shown: this is a formatting tool, not legal advice. */
  disclaimer: string;
}

export interface ComplianceOptions {
  /** "Today" for the para 8 deadline check and the report date. */
  date?: Date;
  /** Labels PDF is part of the export (para 7). Default true. */
  labelsIncluded?: boolean;
}

const DISCLAIMER = 'A formatting check, not legal advice. You are responsible for compliance with PD 5.6 and any directions of the court.';

export function complianceReport(project: Project, out: BuildOutput, opts: ComplianceOptions = {}): ComplianceReport {
  const { plan, warnings } = out;
  const now = opts.date ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const has = (...codes: WarningCode[]) => warnings.filter((w) => codes.includes(w.code));
  const codesOf = (ws: BuildWarning[]) => [...new Set(ws.map((w) => w.code))];
  const checks: ComplianceCheck[] = [];
  const add = (id: string, para: string, requirement: string, status: CheckStatus, detail: string, ws: BuildWarning[] = []) =>
    checks.push({ id, para, requirement, status, detail, codes: codesOf(ws) });

  const s = project.settings;
  const mainPages = plan.main.volumes.flatMap((v) => v.pages);
  const documentPages = mainPages.filter((p) => p.kind === 'doc').length;
  const inserted = mainPages.filter((p) => /-\d+$/.test(p.label)).length;

  // Para 1: no duplication; additional documents numbered 88-1, 88-2…
  const dup = has('duplicate');
  add('no-duplicates', '1', 'No unnecessary or duplicated documents', dup.length ? 'warning' : 'pass',
    dup.length ? `${dup.length} set(s) of files with identical content.` : 'No two files have identical content. Check for unnecessary documents yourself.', dup);
  const late = has('insert-before-issue', 'appended-after-issue');
  add('additional-docs', '1', 'Additional documents inserted as 88-1, 88-2… without renumbering',
    late.length ? 'warning' : project.frozen ? 'pass' : 'not-applicable',
    late.length ? late.map((w) => w.message).join(' ')
      : project.frozen ? (inserted ? `Page numbers are locked; ${inserted} inserted page(s) numbered after the page they follow.` : 'Page numbers are locked; no documents inserted since issue.')
        : 'Bundle not issued yet; documents are numbered in normal order.', late);

  // Para 2: core bundle over 100 pages.
  const coreNeeded = has('core-bundle-needed');
  add('core-bundle', '2', 'Core bundle where the agreed bundle exceeds 100 pages',
    coreNeeded.length ? 'warning' : plan.core ? 'pass' : 'not-applicable',
    coreNeeded.length ? coreNeeded[0].message
      : plan.core ? `Core bundle prepared (${plan.core.volumes.reduce((a, v) => a + v.pages.length, 0)} pages) for ${documentPages} pages of documents.`
        : `${documentPages} pages of documents, not over 100.`, coreNeeded);

  // Para 3: status of documents marked.
  add('status-marked', '3', 'Status of each document marked on the front of the bundle',
    s.frontSheet ? 'pass' : 'warning',
    s.frontSheet ? 'Status front sheet at the front of each main and core volume; status column in every index.'
      : 'The status front sheet is turned off; status appears only in the index column.');

  // Para 4(2): chronological order.
  const chrono = has('not-chronological', 'undated');
  add('chronological', '4(2)', 'Documents in chronological order from the front', chrono.length ? 'warning' : 'pass',
    chrono.length ? `${has('not-chronological').length} out of order, ${has('undated').length} undated.` : 'All documents are dated and in date order.', chrono);

  // Para 4(3): consecutive numbering, top right.
  const stamp = has('non-compliant-setting').filter((w) => /4\(3\)/.test(w.message));
  add('numbering', '4(3)', 'Pages numbered consecutively in the top right-hand corner', stamp.length ? 'warning' : 'pass',
    stamp.length ? stamp.map((w) => w.message).join(' ')
      : `Every page numbered at the top right (${s.numbering === 'continuous' ? 'one run across all volumes' : s.numbering === 'per-volume' ? 'restarting in each volume with its letter' : 'per section'}); index and front sheet pages are not numbered.`, stamp);

  // Para 4(4)/6: legibility.
  const legible = has('image-only', 'edge-content', 'analysis-skipped');
  const shrunk = has('shrunk-for-stamp');
  add('legible', '4(4)', 'Copies legible; nothing cut off at the edges',
    legible.length ? 'warning' : 'pass',
    legible.length ? legible.map((w) => w.message).join(' ')
      : `Every page has a text layer and nothing within 5 mm of the edge.${shrunk.length ? ` ${shrunk.length} document(s) had pages reduced slightly to keep the page number clear.` : ''}`, [...legible, ...shrunk]);

  // Para 5: volume limit; transcripts separate.
  const over = [...has('volume-over-limit'), ...has('non-compliant-setting').filter((w) => /para 5/.test(w.message))];
  const allVols = [plan.main, plan.core, plan.transcripts].flatMap((b) => b?.volumes ?? []);
  const maxPages = Math.max(...allVols.map((v) => v.pages.length));
  add('volume-limit', '5', 'No file over 250 pages', over.length ? 'warning' : 'pass',
    over.length ? over.map((w) => w.message).join(' ') : `Largest file: ${maxPages} numbered pages (limit ${Math.min(250, s.maxPagesPerVolume)}).`, over);
  add('transcripts-separate', '5', 'Transcripts in a separate bundle', plan.transcripts ? 'pass' : 'not-applicable',
    plan.transcripts ? `Transcript bundle: ${plan.transcripts.volumes.length} file(s), numbered separately.` : 'No transcripts in the bundle.');

  // Para 6: typed copies of illegible documents.
  const imageOnly = has('image-only');
  const typed = project.docs.filter((d) => d.typedCopies?.length).length;
  add('typed-copies', '6', 'Typed copies of documents that are hard to read',
    imageOnly.length && !typed ? 'warning' : 'pass',
    imageOnly.length
      ? `${imageOnly.length} document(s) have image-only pages${typed ? `; ${typed} document(s) have typed copies interleaved` : ''}. Check each is legible or add a typed copy.`
      : typed ? `${typed} document(s) have typed copies interleaved.` : 'No pages flagged as image-only.', imageOnly);

  // Para 7: more than 5 files: inside-cover labels.
  const labels = opts.labelsIncluded ?? true;
  add('inside-cover-labels', '7', 'Over 5 files: each labelled on the top right of the inside cover',
    plan.physicalFiles > 5 ? (labels ? 'pass' : 'warning') : 'not-applicable',
    plan.physicalFiles > 5
      ? (labels ? `${plan.physicalFiles} files; inside-cover labels are in the labels PDF.` : `${plan.physicalFiles} files; produce inside-cover labels.`)
      : `${plan.physicalFiles} file(s) in total, not more than 5.`, has('inside-cover-labels'));

  // Para 8: lodging deadline.
  let deadline: ComplianceReport['deadline'];
  const hd = project.case.hearingDate;
  if (!hd) {
    add('lodging-deadline', '8', 'Lodged at least 72 hours (excluding weekends and general holidays) before the hearing', 'not-applicable',
      'No hearing date set; add it to calculate the lodging deadline.');
  } else {
    try {
      const r = lodgingDeadline(hd);
      deadline = { ...r, text: describeDeadline(r) };
      const late = today > r.lastLodgingDay;
      add('lodging-deadline', '8', 'Lodged at least 72 hours (excluding weekends and general holidays) before the hearing',
        late ? 'warning' : 'pass',
        late ? `${deadline.text} That date has passed (report dated ${formatDate(today, 'DD/MM/YYYY')}).` : deadline.text);
    } catch (e) {
      add('lodging-deadline', '8', 'Lodged at least 72 hours (excluding weekends and general holidays) before the hearing', 'warning', (e as Error).message);
    }
  }

  const summary: Record<CheckStatus, number> = { pass: 0, warning: 0, 'not-applicable': 0 };
  for (const c of checks) summary[c.status]++;
  const c = project.case;
  return {
    schema: 'bigbundle-wright/compliance@1',
    generatedAt: now.toISOString(),
    case: { actionNo: c.actionNo, shortTitle: c.shortTitle, bundleTitle: c.bundleTitle, ...(hd ? { hearingDate: hd } : {}) },
    volumes: out.volumes.map((v) => ({
      kind: v.kind, name: v.name, pages: pageRange(v.firstLabel, v.lastLabel),
      contentPages: v.pageCount - v.prelimPages, totalPages: v.pageCount, fileName: v.fileName,
    })),
    physicalFiles: plan.physicalFiles,
    documentPages,
    checks, summary, deadline, warnings,
    disclaimer: DISCLAIMER,
  };
}

// ---------- PDF ----------

const M = 50;
const STATUS_COLOUR: Record<CheckStatus, [number, number, number]> = {
  pass: [0.1, 0.45, 0.2], warning: [0.75, 0.35, 0.0], 'not-applicable': [0.4, 0.4, 0.4],
};

class Flow {
  doc: PDFDocument;
  fonts: FontSet;
  page!: PDFPage;
  y = 0;
  constructor(doc: PDFDocument, fonts: FontSet) { this.doc = doc; this.fonts = fonts; this.newPage(); }
  newPage() { this.page = this.doc.addPage([A4.w, A4.h]); this.y = A4.h - M; }
  need(h: number) { if (this.y - h < M) this.newPage(); }
  text(s: string, x: number, size: number, font: PDFFont, width: number, colour?: [number, number, number]): number {
    const lines = wrapText(this.fonts.safe(s), width, font, size);
    for (const ln of lines) {
      this.need(size * 1.3);
      this.y -= size * 1.3;
      this.page.drawText(ln, { x, y: this.y, size, font, color: colour ? rgb(...colour) : rgb(0, 0, 0) });
    }
    return lines.length;
  }
}

export async function complianceReportPdf(report: ComplianceReport, opts: { fonts?: FontBytes; date?: Date } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = await fontSetFor(doc, opts.fonts);
  const f = new Flow(doc, fonts);
  const W = A4.w - 2 * M;
  const c = report.case;
  f.text(`${c.actionNo}  ${c.shortTitle}`, M, 11, fonts.bold, W);
  f.text('PD 5.6 compliance report', M, 16, fonts.bold, W);
  f.text(`${c.bundleTitle}. Generated by Big Bundle Wright on ${formatDate(report.generatedAt.slice(0, 10), 'DD/MM/YYYY')}.`, M, 9, fonts.regular, W);
  f.y -= 6;
  f.text(`Files: ${report.volumes.map((v) => `${v.name} (pp. ${v.pages})`).join('; ')}. ${report.physicalFiles} file(s), ${report.documentPages} pages of documents in the main bundle.`, M, 9.5, fonts.regular, W);
  f.text(`Result: ${report.summary.pass} passed, ${report.summary.warning} with warnings, ${report.summary['not-applicable']} not applicable.`, M, 10, fonts.bold, W);
  f.y -= 8;

  // Checks: Para | Requirement / detail | Result
  const colPara = 40, colRes = 80, colMain = W - colPara - colRes;
  for (const ch of report.checks) {
    const reqLines = wrapText(fonts.safe(ch.requirement), colMain - 8, fonts.bold, 10).length;
    const detLines = wrapText(fonts.safe(ch.detail), colMain - 8, fonts.regular, 9).length;
    const h = reqLines * 13 + detLines * 11.7 + 10;
    f.need(h);
    const top = f.y;
    f.page.drawLine({ start: { x: M, y: top }, end: { x: M + W, y: top }, thickness: 0.4, color: rgb(0.6, 0.6, 0.6) });
    f.page.drawText(fonts.safe(`para ${ch.para}`), { x: M + 2, y: top - 13, size: 9, font: fonts.regular });
    const res = CHECK_STATUS_TEXT[ch.status];
    f.page.drawText(res, { x: M + W - colRes + 4, y: top - 13, size: 10, font: fonts.bold, color: rgb(...STATUS_COLOUR[ch.status]) });
    f.y = top - 3;
    f.text(ch.requirement, M + colPara + 4, 10, fonts.bold, colMain - 8);
    f.text(ch.detail, M + colPara + 4, 9, fonts.regular, colMain - 8);
    f.y = Math.min(f.y, top - h + 4);
  }
  f.page.drawLine({ start: { x: M, y: f.y }, end: { x: M + W, y: f.y }, thickness: 0.4, color: rgb(0.6, 0.6, 0.6) });
  f.y -= 14;

  f.text(`All warnings (${report.warnings.length})`, M, 12, fonts.bold, W);
  if (!report.warnings.length) f.text('None.', M, 9.5, fonts.regular, W);
  report.warnings.forEach((w, i) => {
    f.y -= 2;
    f.text(`${i + 1}. [${w.code}] ${w.message}`, M, 9, fonts.regular, W);
  });
  f.y -= 10;
  f.text(report.disclaimer, M, 8.5, fonts.italic, W);

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const t = `${i + 1} / ${pages.length}`;
    p.drawText(t, { x: (A4.w - fonts.regular.widthOfTextAtSize(t, 8)) / 2, y: M / 2, size: 8, font: fonts.regular });
  });
  const created = opts.date ?? new Date(report.generatedAt);
  doc.setTitle(`${c.actionNo} ${c.shortTitle} – PD 5.6 compliance report`);
  doc.setProducer('Big Bundle Wright');
  doc.setCreator('Big Bundle Wright');
  doc.setLanguage('en-HK');
  doc.setCreationDate(created);
  doc.setModificationDate(created);
  return doc.save({ useObjectStreams: true });
}

export const complianceFileBase = (project: Project) => `${outputBaseName(project)} PD 5.6 compliance report`;
