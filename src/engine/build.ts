// Big Bundle Wright: build volume PDFs from a plan.
// SPDX-License-Identifier: MPL-2.0

import { PDFDocument, degrees, rgb, type PDFPage } from 'pdf-lib';
import { standardFontSet, type FontSet } from './fonts.ts';
import { layoutIndex, type DrawOp, type IndexHeading, type IndexPageLayout, type IndexRow } from './layout-index.ts';
import type { BuildWarning, BundleKind, PageAnalysis, Project, StampPosition } from './model.ts';
import {
  CORE_COLUMNS, FRONT_COLUMNS, FRONT_LEGEND, MASTER_COLUMNS, STATUS_LEGEND, VOLUME_COLUMNS,
  crossRefs, entryDescription, formatDateFor, freezeProject, frontSheetRows, indexRows, pageRange,
  planProjectBundles, sectionTitle,
  type BuildPlan, type BundlePlan, type CrossRef, type PlanRow, type PlanVolume, type PrelimMeasurer,
} from './plan.ts';
import { addLink, addRemoteLink, labelRanges, setPageLabels, writeOutline, type OutlineItem } from './pdf-structure.ts';
import type { LoadedSource } from './sources.ts';
import { A4, fitToA4, isA4, rangesFromLabels, safeFileName } from './util.ts';

export interface BuildInput {
  project: Project;
  sources: Map<string, LoadedSource>;
  /** Per file id. Without it, no shrink-for-stamp or legibility checks are done. */
  analysis?: Map<string, PageAnalysis[]>;
  signal?: AbortSignal;
  onProgress?: (p: { phase: 'plan' | 'volume' | 'master'; volume?: string; done: number; total: number }) => void;
  /** Creation date written into the PDFs (fix it for reproducible output). */
  date?: Date;
  /** Lock page numbers after this build (returns `issuedProject`). */
  issue?: boolean;
}

export interface BuiltFile {
  fileName: string;
  bytes: Uint8Array;
  pageCount: number;
}

export interface BuiltVolume extends BuiltFile {
  kind: BundleKind;
  letter: string;
  name: string;
  firstLabel: string;
  lastLabel: string;
  /** Unnumbered pages at the front (status front sheet + index). */
  prelimPages: number;
  frontSheetPages: number;
}

export interface BuildOutput {
  plan: BuildPlan;
  /** Main volumes, then the core bundle, then the transcript bundle. */
  volumes: BuiltVolume[];
  masterIndex?: BuiltFile;
  warnings: BuildWarning[];
  /** The project with page numbers locked, when `issue` was requested. */
  issuedProject?: Project;
}

const STAMP_SIZE = { S: 10, M: 12, L: 14 } as const;
const STAMP_COLOUR = { black: rgb(0, 0, 0), red: rgb(0.75, 0.1, 0.1), blue: rgb(0.1, 0.2, 0.7) } as const;

export function outputBaseName(project: Project): string {
  return [safeFileName(project.case.actionNo), safeFileName(project.case.shortTitle)].filter(Boolean).join(' ');
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Build cancelled', 'AbortError');
}

function drawOps(page: PDFPage, ops: DrawOp[], fonts: FontSet) {
  for (const op of ops) {
    if (op.t === 'text') {
      page.drawText(op.text, { x: op.x, y: op.y, size: op.size, font: fonts[op.font], color: op.color ? rgb(...op.color) : rgb(0, 0, 0) });
    } else if (op.t === 'line') {
      const g = op.grey ?? 0;
      page.drawLine({ start: { x: op.x1, y: op.y1 }, end: { x: op.x2, y: op.y2 }, thickness: op.w, color: rgb(g, g, g) });
    } else {
      page.drawRectangle({ x: op.x, y: op.y, width: op.w, height: op.h, color: rgb(op.grey, op.grey, op.grey) });
    }
  }
}

function safeRows(rows: IndexRow[], fonts: FontSet): IndexRow[] {
  return rows.map((r) => ({
    ...r,
    title: r.title !== undefined ? fonts.safe(r.title) : undefined,
    cells: Object.fromEntries(Object.entries(r.cells).map(([k, v]) => [k, fonts.safe(v ?? '')])),
  }));
}

function heading(project: Project, fonts: FontSet, volumeLine: string, title: string, contLine: string): IndexHeading {
  const c = project.case;
  return {
    court: fonts.safe(c.court),
    actionNo: fonts.safe(c.actionNo),
    actionLine: c.actionLine ? fonts.safe(c.actionLine) : undefined,
    parties: c.parties.map((p) => ({ name: fonts.safe(p.name), role: fonts.safe(p.role) })),
    bundleTitle: fonts.safe(c.bundleTitle),
    confidential: !!c.confidential,
    volumeLine: fonts.safe(volumeLine),
    indexTitle: title,
    continuationLine: fonts.safe(contLine),
  };
}

/** Lay out the unnumbered front pages of a volume: status front sheet, then index. */
function layoutPrelims(project: Project, fonts: FontSet, kind: BundleKind, rows: PlanRow[], volName: string, range: string, xref?: CrossRef) {
  const s = project.settings;
  const line = `${volName.toUpperCase()}  (pages ${range})`;
  const front: IndexPageLayout[] = s.frontSheet && kind !== 'transcripts'
    ? layoutIndex(fonts, heading(project, fonts, line, 'STATUS OF DOCUMENTS (PD 5.6 para 3)', `${project.case.actionNo} — ${volName} — Status of documents (continued)`),
      FRONT_COLUMNS, safeRows(frontSheetRows(project, rows), fonts), s.index, FRONT_LEGEND)
    : [];
  const index = layoutIndex(fonts, heading(project, fonts, line, 'INDEX', `${project.case.actionNo} — ${volName} — Index (continued)`),
    kind === 'core' ? CORE_COLUMNS : VOLUME_COLUMNS, safeRows(indexRows(project, rows, kind === 'core' ? xref : undefined), fonts), s.index,
    kind === 'transcripts' ? [] : STATUS_LEGEND);
  return { front, index };
}

/** Planner measurement uses the same fonts and layout used to draw. */
async function makeMeasurer(project: Project): Promise<PrelimMeasurer> {
  const scratch = await PDFDocument.create();
  const fonts = await standardFontSet(scratch);
  return (kind, rows, xref) => {
    const { front, index } = layoutPrelims(project, fonts, kind, rows, kind === 'main' ? 'Bundle A' : 'Transcript Bundle A', '8888–8888', xref);
    return front.length + index.length;
  };
}

/** Plan without building (e.g. to issue a project or preview volume splits). */
export async function planProject(project: Project): Promise<BuildPlan> {
  return planProjectBundles(project, await makeMeasurer(project));
}

function stampText(project: Project, plan: BundlePlan, label: string, series: string): string {
  const st = project.settings.stamp;
  const total = `${series}${plan.seriesTotals[series]}`;
  const core = st.style === 'PageX' ? `Page ${label}`
    : st.style === 'XofY' ? `${label} of ${total}`
    : st.style === 'XslashY' ? `${label}/${total}`
    : st.style === 'PageXofY' ? `Page ${label} of ${total}`
    : label;
  return `${st.prefix}${core}`;
}

/** Draw the page number on a white backing box. */
function drawStamp(page: PDFPage, text: string, fonts: FontSet, project: Project) {
  const st = project.settings.stamp;
  const size = STAMP_SIZE[st.size];
  const { width: W, height: H } = page.getSize();
  const tw = fonts.stamp.widthOfTextAtSize(text, size);
  const padX = 5, padY = 3.5;
  const bw = tw + 2 * padX, bh = size + 2 * padY;
  const inset = { x: 18, y: 14 };
  const pos: StampPosition = st.position;
  const bx = pos.endsWith('right') ? W - inset.x - bw : pos.endsWith('left') ? inset.x : (W - bw) / 2;
  const by = pos.startsWith('top') ? H - inset.y - bh : inset.y;
  page.drawRectangle({ x: bx, y: by, width: bw, height: bh, color: rgb(1, 1, 1) });
  page.drawText(text, { x: bx + padX, y: by + padY + size * 0.18, size, font: fonts.stamp, color: STAMP_COLOUR[st.colour] });
}

function outlineTitle(project: Project, tab: string, desc: string, date: string | null, first: string): string {
  const style = project.settings.outlineStyle;
  const d = date ? formatDateFor(project, date) : '';
  const base = `${tab}. ${desc}`;
  if (style === 'plain') return base;
  if (style === 'withPage') return `${base} — p. ${first}`;
  if (style === 'withDate') return d ? `${base} (${d})` : base;
  return `${base}${d ? ` (${d})` : ''} — p. ${first}`;
}

type Notes = Map<string, { imageOnly: string[]; edge: string[]; shrunk: string[]; relaid: string[] }>;

interface VolumeContext {
  project: Project;
  sources: Map<string, LoadedSource>;
  analysis?: Map<string, PageAnalysis[]>;
  signal?: AbortSignal;
  created: Date;
  notes?: Notes;
  unsupported: Set<string>;
  onPages: (n: number) => void;
}

async function buildVolume(ctx: VolumeContext, kind: BundleKind, bplan: BundlePlan, vol: PlanVolume, xref?: CrossRef): Promise<BuiltVolume> {
  const { project, sources, analysis, signal } = ctx;
  const s = project.settings;
  const docs = new Map(project.docs.map((d) => [d.id, d]));
  const note = (docId: string, k: 'imageOnly' | 'edge' | 'shrunk' | 'relaid', label: string) => {
    if (!ctx.notes) return;
    const e = ctx.notes.get(docId) ?? { imageOnly: [], edge: [], shrunk: [], relaid: [] };
    e[k].push(label);
    ctx.notes.set(docId, e);
  };

  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = await standardFontSet(doc);
  const firstLabel = vol.pages[0].label, lastLabel = vol.pages[vol.pages.length - 1].label;
  const range = pageRange(firstLabel, lastLabel);
  const { front, index } = layoutPrelims(project, fonts, kind, vol.rows, vol.name, range, xref);
  if (front.length + index.length !== vol.prelimPageCount) {
    throw new Error(`Internal error: front pages for ${vol.name} laid out to ${front.length + index.length} pages, planned ${vol.prelimPageCount}.`);
  }
  const draw = (l: IndexPageLayout) => { const p = doc.addPage([A4.w, A4.h]); drawOps(p, l.ops, fonts); return p; };
  const frontPages = front.map(draw);
  const indexPages = index.map(draw);

  // ---- content pages ----
  const contentPages: PDFPage[] = [];
  let i = 0;
  while (i < vol.pages.length) {
    checkAbort(signal);
    const pg = vol.pages[i];
    if (pg.kind === 'blank') { contentPages.push(doc.addPage([A4.w, A4.h])); i++; continue; }
    // Run of consecutive pages from the same file and document.
    let j = i;
    while (j < vol.pages.length && vol.pages[j].kind === 'doc' && vol.pages[j].fileId === pg.fileId && vol.pages[j].docId === pg.docId) j++;
    const run = vol.pages.slice(i, j);
    const src = sources.get(pg.fileId!);
    if (!src) throw new Error(`Missing source file for "${docs.get(pg.docId!)?.description}" (${pg.fileId}).`);
    const an = analysis?.get(pg.fileId!);
    const srcPages = src.pdf.getPages();
    const decide = run.map((p) => {
      const sp = srcPages[p.srcIndex!];
      const a = an?.[p.srcIndex!];
      const crop = sp.getCropBox();
      const media = sp.getMediaBox();
      const rot = ((sp.getRotation().angle % 360) + 360) % 360;
      const clear = !!a && s.stamp.style !== 'None' && a.stampZoneInk[s.stamp.position];
      const sameBox = crop.x === media.x && crop.y === media.y && crop.width === media.width && crop.height === media.height;
      const copy = !clear && rot === 0 && sameBox && media.x === 0 && media.y === 0 && isA4(media.width, media.height);
      return { p, sp, a, crop, rot, clear, copy };
    });
    const toCopy = decide.filter((d) => d.copy).map((d) => d.p.srcIndex!);
    const copied = toCopy.length ? await doc.copyPages(src.pdf, toCopy) : [];
    let ci = 0;
    for (const d of decide) {
      let out: PDFPage;
      if (d.copy) {
        out = doc.addPage(copied[ci++]);
      } else {
        const { crop, rot } = d;
        const emb = await doc.embedPage(d.sp, { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height });
        const vw = rot % 180 === 0 ? crop.width : crop.height;
        const vh = rot % 180 === 0 ? crop.height : crop.width;
        const fit = fitToA4(vw, vh, d.clear);
        const VW = vw * fit.scale, VH = vh * fit.scale;
        const at = rot === 0 ? { x: fit.x, y: fit.y, r: 0 }
          : rot === 90 ? { x: fit.x, y: fit.y + VH, r: -90 }
          : rot === 180 ? { x: fit.x + VW, y: fit.y + VH, r: 180 }
          : { x: fit.x + VW, y: fit.y, r: 90 };
        out = doc.addPage([fit.outW, fit.outH]);
        out.drawPage(emb, { x: at.x, y: at.y, xScale: fit.scale, yScale: fit.scale, rotate: degrees(at.r) });
        if (d.clear) note(d.p.docId!, 'shrunk', d.p.label);
        const annots = d.sp.node.Annots();
        if (annots && annots.size() > 0) note(d.p.docId!, 'relaid', d.p.label);
      }
      if (d.a) {
        if (!d.a.hasText && d.a.ink > 0.002) note(d.p.docId!, 'imageOnly', d.p.label);
        if (d.a.edgeInk.length) note(d.p.docId!, 'edge', d.p.label);
      }
      contentPages.push(out);
    }
    ctx.onPages(run.length);
    i = j;
  }

  // ---- stamps ----
  if (s.stamp.style !== 'None') {
    vol.pages.forEach((p, k) => drawStamp(contentPages[k], fonts.safe(stampText(project, bplan, p.label, p.series)), fonts, project));
  }

  // ---- index hyperlinks ----
  const entryPage = new Map<string, PDFPage>();
  for (const r of vol.rows) if (r.kind === 'doc') entryPage.set(`${r.docId}#${r.part?.n ?? 1}`, contentPages[r.first]);
  index.forEach((l, k) => {
    for (const link of l.links) {
      const target = entryPage.get(link.key);
      if (target) addLink(doc, indexPages[k], link.rect, target);
    }
  });

  // ---- bookmarks ----
  const secs = new Map(project.sections.map((x) => [x.id, x]));
  const top: OutlineItem = { title: `${vol.name} (pp. ${range})`, page: frontPages[0] ?? indexPages[0], children: [] };
  if (frontPages.length) top.children!.push({ title: 'Status of documents', page: frontPages[0] });
  top.children!.push({ title: 'Index', page: indexPages[0] });
  let secNode: OutlineItem | null = null;
  for (const r of vol.rows) {
    if (r.kind === 'section') {
      const sec = secs.get(r.sectionId);
      secNode = { title: sec ? sectionTitle(project, sec, r.continued) : 'Other documents', page: contentPages[0], children: [] };
      top.children!.push(secNode);
      continue;
    }
    const d = docs.get(r.docId)!;
    const item = { title: outlineTitle(project, r.tab, entryDescription(d, r.part).replace('\n', ' / '), d.date, r.firstLabel), page: contentPages[r.first] };
    if (secNode) {
      if (!secNode.children!.length) secNode.page = item.page;
      secNode.children!.push(item);
    } else top.children!.push(item);
  }
  writeOutline(doc, [top]);

  // ---- page labels ----
  setPageLabels(doc, [
    ...(frontPages.length ? [{ start: 0, style: 'r' as const, prefix: 'Status ' }] : []),
    { start: frontPages.length, style: 'r', prefix: 'Index ' },
    ...labelRanges(vol.pages.map((p) => p.label), frontPages.length + indexPages.length),
  ]);

  const c = project.case;
  doc.setTitle(`${c.actionNo} ${c.shortTitle} – ${c.bundleTitle} – ${vol.name}`, { showInWindowTitleBar: true });
  doc.setSubject(`${c.bundleTitle}, ${vol.name}, pages ${range}`);
  doc.setProducer('Big Bundle Wright');
  doc.setCreator('Big Bundle Wright');
  doc.setLanguage('en-HK');
  doc.setCreationDate(ctx.created);
  doc.setModificationDate(ctx.created);
  for (const ch of fonts.unsupported) ctx.unsupported.add(ch);
  const bytes = await doc.save({ useObjectStreams: true });
  return {
    kind, letter: vol.letter, name: vol.name,
    fileName: `${outputBaseName(project)} ${vol.name}.pdf`,
    bytes, pageCount: doc.getPageCount(), firstLabel, lastLabel,
    prelimPages: frontPages.length + indexPages.length, frontSheetPages: frontPages.length,
  };
}

export async function buildBundle(input: BuildInput): Promise<BuildOutput> {
  const { project, signal } = input;
  const created = input.date ?? new Date();
  input.onProgress?.({ phase: 'plan', done: 0, total: 1 });
  const plan = await planProject(project);

  const warnings: BuildWarning[] = [...plan.warnings];
  if (!input.analysis) warnings.push({ code: 'analysis-skipped', message: 'Page analysis was skipped: occupied corners, image-only pages and edge content were not checked.' });

  const notes: Notes = new Map();
  const unsupported = new Set<string>();
  const bundles = [plan.main, plan.core, plan.transcripts].filter((b): b is BundlePlan => !!b);
  const totalPages = bundles.reduce((a, b) => a + b.volumes.reduce((x, v) => x + v.pages.length, 0), 0);
  let done = 0;
  const xref = crossRefs(plan.main);

  const volumes: BuiltVolume[] = [];
  for (const b of bundles) {
    for (const vol of b.volumes) {
      checkAbort(signal);
      volumes.push(await buildVolume({
        project, sources: input.sources, analysis: input.analysis, signal, created, unsupported,
        notes: b.kind === 'core' ? undefined : notes, // core pages repeat the main bundle's
        onPages: (n) => { done += n; input.onProgress?.({ phase: 'volume', volume: vol.name, done, total: totalPages }); },
      }, b.kind, b, vol, xref));
    }
  }

  const docs = new Map(project.docs.map((d) => [d.id, d]));
  for (const [docId, e] of notes) {
    const d = docs.get(docId)!;
    if (e.imageOnly.length) warnings.push({ code: 'image-only', docId, pages: e.imageOnly, message: `"${d.description}": page(s) ${rangesFromLabels(e.imageOnly)} are images with no text layer (not searchable). Check legibility (PD 5.6 paras 4(4), 6); attach a typed copy if needed.` });
    if (e.edge.length) warnings.push({ code: 'edge-content', docId, pages: e.edge, message: `"${d.description}": page(s) ${rangesFromLabels(e.edge)} have content within 5 mm of the edge, which binding or copying may cut off (PD 5.6 para 6).` });
    if (e.shrunk.length) warnings.push({ code: 'shrunk-for-stamp', docId, pages: e.shrunk, message: `"${d.description}": page(s) ${rangesFromLabels(e.shrunk)} had content where the page number goes, so the page was reduced slightly to keep the number clear.` });
    if (e.relaid.length) warnings.push({ code: 'relaid-annotations-dropped', docId, pages: e.relaid, message: `"${d.description}": page(s) ${rangesFromLabels(e.relaid)} were re-laid onto A4; links or comments on those pages were not carried over.` });
  }
  if (unsupported.size) {
    warnings.push({ code: 'unsupported-glyph', message: `Index text contains characters the current font cannot show (${[...unsupported].join(' ')}); they were replaced with "?". Chinese index text needs the Noto TC fonts (stage 5).` });
  }

  let masterIndex: BuiltFile | undefined;
  const mainBuilt = volumes.filter((v) => v.kind === 'main');
  if (mainBuilt.length > 1) {
    checkAbort(signal);
    input.onProgress?.({ phase: 'master', done: 0, total: 1 });
    masterIndex = await buildMasterIndex(project, plan.main, mainBuilt, created);
  }

  return {
    plan, volumes, masterIndex, warnings,
    issuedProject: input.issue ? freezeProject(project, plan, created.toISOString()) : undefined,
  };
}

async function buildMasterIndex(project: Project, main: BundlePlan, built: BuiltVolume[], created: Date): Promise<BuiltFile> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = await standardFontSet(doc);
  const rows: IndexRow[] = [];
  const targets = new Map<string, { file: string; pageIndex: number }>();
  main.volumes.forEach((v, vi) => {
    const vr = indexRows(project, v.rows);
    v.rows.forEach((r, k) => {
      if (r.kind === 'section') {
        if (!r.continued) rows.push(vr[k]);
        return;
      }
      const row = { ...vr[k], cells: { ...vr[k].cells, bundle: v.letter } };
      rows.push(row);
      targets.set(row.linkKey!, { file: built[vi].fileName, pageIndex: built[vi].prelimPages + r.first });
    });
  });
  const first = built[0], last = built[built.length - 1];
  const head = heading(project, fonts,
    `BUNDLES ${first.letter}–${last.letter}  (pages ${pageRange(first.firstLabel, last.lastLabel)})`,
    'MASTER INDEX', `${project.case.actionNo} — Master Index (continued)`);
  const layout = layoutIndex(fonts, head, MASTER_COLUMNS, safeRows(rows, fonts), project.settings.index, STATUS_LEGEND);
  layout.forEach((l) => {
    const p = doc.addPage([A4.w, A4.h]);
    drawOps(p, l.ops, fonts);
    for (const link of l.links) {
      const t = targets.get(link.key);
      if (t) addRemoteLink(doc, p, link.rect, t.file, t.pageIndex, A4.h);
    }
  });
  setPageLabels(doc, [{ start: 0, style: 'r', prefix: 'Master Index ' }]);
  const c = project.case;
  doc.setTitle(`${c.actionNo} ${c.shortTitle} – ${c.bundleTitle} – Master Index`, { showInWindowTitleBar: true });
  doc.setProducer('Big Bundle Wright');
  doc.setCreator('Big Bundle Wright');
  doc.setLanguage('en-HK');
  doc.setCreationDate(created);
  doc.setModificationDate(created);
  const bytes = await doc.save({ useObjectStreams: true });
  return { fileName: `${outputBaseName(project)} Master Index.pdf`, bytes, pageCount: doc.getPageCount() };
}
