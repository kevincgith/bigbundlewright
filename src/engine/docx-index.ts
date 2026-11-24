// Big Bundle Wright: Word (.docx) indexes, one per volume plus the master index.
// Same rows as the PDF index; dates always DD/MM/YYYY (Hong Kong practice).
// SPDX-License-Identifier: MPL-2.0

import {
  AlignmentType, Document, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import { ZH, bi, biColumns, zhBundleName, zhPages } from './i18n.ts';
import type { IndexColumn, IndexRow } from './layout-index.ts';
import type { BundleKind, Project } from './model.ts';
import {
  CORE_COLUMNS, MASTER_COLUMNS, STATUS_LEGEND, VOLUME_COLUMNS, crossRefs, indexRows, pageRange,
  type BuildPlan, type BundlePlan, type PlanVolume,
} from './plan.ts';
import { formatDate } from './util.ts';
import { outputBaseName } from './build.ts';

export interface DocxFile {
  fileName: string;
  bytes: Uint8Array;
  kind: BundleKind | 'master';
  /** Volume letter ("" for the master index). */
  letter: string;
}

export interface DocxIndexOptions {
  /** Bilingual headings (English / 繁體中文). Word supplies its own Chinese font, so no font bytes are needed. */
  bilingual?: boolean;
}

const LATIN = 'Times New Roman';
const CJK = 'PMingLiU'; // standard Traditional Chinese font in Word; Word substitutes if missing
const FONT = { ascii: LATIN, hAnsi: LATIN, cs: LATIN, eastAsia: CJK };
const TABLE_TWIPS = 9638; // A4 (11906) less 2 × 20 mm margins (1134)

const run = (text: string, o: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}) =>
  new TextRun({ text, font: FONT, bold: o.bold, italics: o.italics, size: o.size, color: o.color });

/** One paragraph per line of `text`. */
function paras(text: string, o: { bold?: boolean; italics?: boolean; size?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; after?: number } = {}) {
  return text.split('\n').map((ln) => new Paragraph({ alignment: o.align, spacing: { after: o.after ?? 0 }, children: [run(ln, o)] }));
}

function heading(project: Project, volumeLine: string, title: string): Paragraph[] {
  const c = project.case;
  const out: Paragraph[] = [];
  out.push(...paras(c.actionNo, { bold: true, align: AlignmentType.RIGHT, after: 120 }));
  for (const ln of c.court.split('\n').filter(Boolean)) out.push(...paras(ln, { bold: true, align: AlignmentType.CENTER }));
  if (c.actionLine) out.push(...paras(c.actionLine, { bold: true, align: AlignmentType.CENTER }));
  if (c.parties.length) {
    out.push(new Paragraph({ spacing: { before: 240 }, children: [run('BETWEEN', { bold: true })] }));
    const side = (r: string) => (/defendant|respondent/i.test(r) ? 2 : /third|intervener|interested/i.test(r) ? 3 : 1);
    let prev = 0;
    for (const p of c.parties) {
      const s = side(p.role);
      if (prev && s !== prev) out.push(...paras('and', { align: AlignmentType.CENTER }));
      prev = s;
      // Name centred, role flush right (as on the PDF index).
      out.push(new Paragraph({
        children: [run('\t'), run(p.name, { bold: true }), run(`\t${p.role}`)],
        tabStops: [{ type: 'center', position: Math.round(TABLE_TWIPS / 2) }, { type: 'right', position: TABLE_TWIPS }],
      }));
    }
  }
  out.push(new Paragraph({ spacing: { before: 240 }, border: { bottom: { style: 'single', size: 6, color: '000000', space: 1 } }, children: [] }));
  const title1 = c.confidential ? [run('CONFIDENTIAL ', { bold: true, size: 28, color: 'BF1A1A' }), run(c.bundleTitle.toUpperCase(), { bold: true, size: 28 })]
    : [run(c.bundleTitle.toUpperCase(), { bold: true, size: 28 })];
  out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120 }, children: title1 }));
  out.push(...paras(volumeLine, { bold: true, align: AlignmentType.CENTER }));
  out.push(...paras(title, { bold: true, align: AlignmentType.CENTER }));
  out.push(new Paragraph({ spacing: { after: 200 }, border: { bottom: { style: 'single', size: 6, color: '000000', space: 4 } }, children: [] }));
  return out;
}

const ALIGN = { left: AlignmentType.LEFT, right: AlignmentType.RIGHT, center: AlignmentType.CENTER } as const;

function table(columns: IndexColumn[], rows: IndexRow[]): Table {
  // Column widths: the PDF widths are points of a 481.9 pt table; scale to twips.
  const fixed = columns.reduce((a, c) => a + c.width, 0);
  const flex = columns.filter((c) => c.width === 0).length;
  const pt = columns.map((c) => (c.width === 0 ? (481.9 - fixed) / Math.max(1, flex) : c.width));
  const widths = pt.map((w) => Math.round((w / 481.9) * TABLE_TWIPS));
  const cell = (text: string, i: number, o: { bold?: boolean; shade?: string; span?: number; align?: keyof typeof ALIGN } = {}) => new TableCell({
    width: { size: o.span ? TABLE_TWIPS : widths[i], type: WidthType.DXA },
    columnSpan: o.span,
    shading: o.shade ? { type: ShadingType.CLEAR, color: 'auto', fill: o.shade } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: paras(text, { bold: o.bold, align: ALIGN[o.align ?? columns[i].align], size: 20 }),
  });
  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: columns.map((c, i) => cell(c.title, i, { bold: true, shade: 'E0E0E0' })),
  });
  const body = rows.map((r) => new TableRow({
    cantSplit: true,
    children: r.kind === 'section'
      ? [cell(r.title ?? '', 0, { bold: true, shade: 'F2F2F2', span: columns.length, align: 'left' })]
      : columns.map((c, i) => cell(r.cells[c.key] ?? '', i)),
  }));
  return new Table({ width: { size: TABLE_TWIPS, type: WidthType.DXA }, columnWidths: widths, rows: [header, ...body] });
}

/** Index rows with dates forced to DD/MM/YYYY. */
function wordRows(project: Project, rows: IndexRow[]): IndexRow[] {
  const docs = new Map(project.docs.map((d) => [d.id, d]));
  return rows.map((r) => {
    if (r.kind !== 'doc' || !r.linkKey) return r;
    const d = docs.get(r.linkKey.split('#')[0]);
    return d ? { ...r, cells: { ...r.cells, date: formatDate(d.date, 'DD/MM/YYYY') } } : r;
  });
}

async function pack(title: string, children: (Paragraph | Table)[], legend: string[]): Promise<Uint8Array> {
  const doc = new Document({
    creator: 'Big Bundle Wright',
    lastModifiedBy: 'Big Bundle Wright',
    title,
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      children: [...children, ...legend.flatMap((l) => paras(l, { italics: true, size: 18 }))],
    }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}

function volumeLine(kind: BundleKind, v: PlanVolume, b: boolean): string {
  const range = pageRange(v.pages[0].label, v.pages[v.pages.length - 1].label);
  return bi(b, `${v.name.toUpperCase()}  (pages ${range})`, `${zhBundleName(kind, v.letter, v.name)}（${zhPages(range)}）`);
}

/** Word index for one volume. */
export async function docxVolumeIndex(project: Project, plan: BuildPlan, bundle: BundlePlan, vol: PlanVolume, opts: DocxIndexOptions = {}): Promise<DocxFile> {
  const b = !!opts.bilingual;
  const kind = bundle.kind;
  const xref = kind === 'core' ? crossRefs(plan.main) : undefined;
  const cols = biColumns(kind === 'core' ? CORE_COLUMNS : VOLUME_COLUMNS, b);
  const rows = wordRows(project, indexRows(project, vol.rows, xref, b));
  const legend = kind === 'transcripts' ? [] : b ? [...STATUS_LEGEND, ZH.statusLegend] : STATUS_LEGEND;
  const bytes = await pack(`${project.case.actionNo} ${vol.name} Index`,
    [...heading(project, volumeLine(kind, vol, b), bi(b, 'INDEX', ZH.index)), table(cols, rows), new Paragraph({ children: [] })], legend);
  return { fileName: `${outputBaseName(project)} ${vol.name} Index.docx`, bytes, kind, letter: vol.letter };
}

/** Word master index across all main volumes (with a Bundle column). */
export async function docxMasterIndex(project: Project, plan: BuildPlan, opts: DocxIndexOptions = {}): Promise<DocxFile> {
  const b = !!opts.bilingual;
  const rows: IndexRow[] = [];
  for (const v of plan.main.volumes) {
    const vr = indexRows(project, v.rows, undefined, b);
    v.rows.forEach((r, k) => {
      if (r.kind === 'section') { if (!r.continued) rows.push(vr[k]); return; }
      rows.push({ ...vr[k], cells: { ...vr[k].cells, bundle: v.letter } });
    });
  }
  const vols = plan.main.volumes;
  const first = vols[0], last = vols[vols.length - 1];
  const range = pageRange(first.pages[0].label, last.pages[last.pages.length - 1].label);
  const line = bi(b, `BUNDLES ${first.letter}–${last.letter}  (pages ${range})`, `${ZH.bundles}${first.letter}至${last.letter}（${zhPages(range)}）`);
  const bytes = await pack(`${project.case.actionNo} Master Index`,
    [...heading(project, line, bi(b, 'MASTER INDEX', ZH.masterIndex)), table(biColumns(MASTER_COLUMNS, b), wordRows(project, rows)), new Paragraph({ children: [] })],
    b ? [...STATUS_LEGEND, ZH.statusLegend] : STATUS_LEGEND);
  return { fileName: `${outputBaseName(project)} Master Index.docx`, bytes, kind: 'master', letter: '' };
}

/** Word indexes for every volume (main, core, transcripts), plus the master index when there is more than one main volume. */
export async function buildDocxIndexes(project: Project, plan: BuildPlan, opts: DocxIndexOptions = {}): Promise<DocxFile[]> {
  const out: DocxFile[] = [];
  for (const bundle of [plan.main, plan.core, plan.transcripts]) {
    if (!bundle) continue;
    for (const v of bundle.volumes) out.push(await docxVolumeIndex(project, plan, bundle, v, opts));
  }
  if (plan.main.volumes.length > 1) out.push(await docxMasterIndex(project, plan, opts));
  return out;
}
