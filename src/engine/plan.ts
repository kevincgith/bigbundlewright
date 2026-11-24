// Big Bundle Wright: ordering, volumes and page numbering (pure; no PDF work).
// Handles the main bundle, the core bundle (PD 5.6 para 2) and the transcript
// bundle (paras 4-5), and re-planning after issue (para 1 inserts "88-1").
// SPDX-License-Identifier: MPL-2.0

import {
  ProjectError,
  type BuildWarning, type BundleDoc, type BundleKind, type DocStatus, type FrozenLayout,
  type PlanEntry, type PlanPage, type PlanRow, type PlanSectionRow, type Project, type Section,
} from './model.ts';
import type { IndexColumn, IndexRow } from './layout-index.ts';
import { formatDate, rangesFromLabels, volumeLetter } from './util.ts';
import { ZH, bi } from './i18n.ts';

export type { PlanEntry, PlanPage, PlanRow, PlanSectionRow };

export interface PlanVolume {
  letter: string;
  ordinal: number;
  /** "Bundle A", "Core Bundle", "Transcript Bundle B". */
  name: string;
  rows: PlanRow[];
  pages: PlanPage[];
  /** Front sheet + index pages (unnumbered). */
  prelimPageCount: number;
}

export interface BundlePlan {
  kind: BundleKind;
  volumes: PlanVolume[];
  seriesTotals: Record<string, number>;
}

export interface BuildPlan {
  main: BundlePlan;
  core?: BundlePlan;
  transcripts?: BundlePlan;
  warnings: BuildWarning[];
  /** Total physical files (volumes of every bundle), for PD 5.6 para 7. */
  physicalFiles: number;
}

/** Number of unnumbered pages (front sheet + index) a volume with these rows needs. */
export type PrelimMeasurer = (kind: BundleKind, rows: PlanRow[], xref?: CrossRef) => number;

// ---------- text helpers shared with the builder ----------

export const STATUS_ORDER: DocStatus[] = ['authentic', 'inclusion_only', 'evidence_of_contents'];

export const STATUS_LABEL: Record<DocStatus, string> = {
  authentic: 'Authentic',
  inclusion_only: 'Inclusion only',
  evidence_of_contents: 'Evidence',
};

export const STATUS_FRONT: Record<DocStatus, string> = {
  authentic: '(1) Deemed authentic (O.27 r.4) or agreed authentic',
  inclusion_only: '(2) Agreed for inclusion only',
  evidence_of_contents: '(3) Also agreed as evidence of contents, subject to weight',
};

export const STATUS_LEGEND = [
  'Status of documents (PD 5.6 para 3; RHC O.27 r.4): '
  + '"Authentic" = deemed authentic under O.27 r.4, or agreed to be authentic; '
  + '"Inclusion only" = agreed for inclusion in the bundle only; '
  + '"Evidence" = also agreed to be admissible as evidence of its contents, subject to submissions on weight.',
];

export const FRONT_LEGEND = [
  'Marked under PD 5.6 para 3. Category (3) documents are agreed as evidence of their contents; '
  + 'a party may still reserve objection to admissibility on the ground of irrelevance.',
];

export const VOLUME_COLUMNS: IndexColumn[] = [
  { key: 'tab', title: 'No.', width: 34, align: 'right' },
  { key: 'date', title: 'Date', width: 64, align: 'left' },
  { key: 'description', title: 'Description', width: 0, align: 'left' },
  { key: 'status', title: 'Status', width: 70, align: 'left' },
  { key: 'pages', title: 'Page(s)', width: 70, align: 'right' },
];

export const MASTER_COLUMNS: IndexColumn[] = [
  { key: 'tab', title: 'No.', width: 34, align: 'right' },
  { key: 'date', title: 'Date', width: 64, align: 'left' },
  { key: 'description', title: 'Description', width: 0, align: 'left' },
  { key: 'status', title: 'Status', width: 70, align: 'left' },
  { key: 'bundle', title: 'Bundle', width: 42, align: 'center' },
  { key: 'pages', title: 'Page(s)', width: 70, align: 'right' },
];

export const CORE_COLUMNS: IndexColumn[] = [
  { key: 'tab', title: 'No.', width: 30, align: 'right' },
  { key: 'date', title: 'Date', width: 62, align: 'left' },
  { key: 'description', title: 'Description', width: 0, align: 'left' },
  { key: 'status', title: 'Status', width: 70, align: 'left' },
  { key: 'bundle', title: 'Main bundle', width: 76, align: 'right' },
  { key: 'pages', title: 'Page(s)', width: 62, align: 'right' },
];

export const FRONT_COLUMNS: IndexColumn[] = [
  { key: 'status', title: 'Status', width: 150, align: 'left' },
  { key: 'description', title: 'Documents', width: 0, align: 'left' },
  { key: 'pages', title: 'Page(s)', width: 120, align: 'left' },
];

export const formatDateFor = (p: Project, iso: string | null) => formatDate(iso, p.settings.dateStyle);

export function sectionTitle(project: Project, s: Section, continued: boolean, bilingual = false): string {
  const prefix = project.settings.sectionPrefix ? `${project.settings.sectionPrefix} ` : '';
  const zh = bilingual && s.titleZh ? `  ${s.titleZh}` : '';
  return `${prefix}${s.letter}  ${s.title}${zh}${continued ? (bilingual ? ' (continued)（續）' : ' (continued)') : ''}`;
}

export function entryDescription(doc: BundleDoc, part?: { n: number; of: number }): string {
  const zh = doc.descriptionZh ? `\n${doc.descriptionZh}` : '';
  return `${doc.description}${part ? ` (part ${part.n} of ${part.of})` : ''}${zh}`;
}

export function pageRange(first: string, last: string): string {
  return first === last ? first : `${first}–${last}`;
}

export function bundleName(kind: BundleKind, letter: string, count: number): string {
  if (kind === 'main') return `Bundle ${letter}`;
  const base = kind === 'core' ? 'Core Bundle' : 'Transcript Bundle';
  return count > 1 ? `${base} ${letter}` : base;
}

/** "A 39–158" references into the main bundle, per doc id (for the core bundle index). */
export type CrossRef = Map<string, string>;

export function crossRefs(main: BundlePlan): CrossRef {
  const m = new Map<string, string[]>();
  for (const v of main.volumes) for (const r of v.rows) {
    if (r.kind === 'doc') m.set(r.docId, [...(m.get(r.docId) ?? []), `${v.letter} ${pageRange(r.firstLabel, r.lastLabel)}`]);
  }
  return new Map([...m].map(([k, v]) => [k, v.join('; ')]));
}

/** Index rows for one volume (or any list of plan rows). */
export function indexRows(project: Project, rows: PlanRow[], xref?: CrossRef, bilingual = false): IndexRow[] {
  const docs = new Map(project.docs.map((d) => [d.id, d]));
  const secs = new Map(project.sections.map((s) => [s.id, s]));
  return rows.map((r): IndexRow => {
    if (r.kind === 'section') {
      const s = secs.get(r.sectionId);
      return { kind: 'section', cells: {}, title: s ? sectionTitle(project, s, r.continued, bilingual) : 'Other documents' };
    }
    const d = docs.get(r.docId)!;
    return {
      kind: 'doc',
      cells: {
        tab: r.tab,
        date: formatDate(d.date, project.settings.dateStyle),
        description: entryDescription(d, r.part),
        status: bi(bilingual, STATUS_LABEL[d.status], ZH.status[d.status]),
        pages: pageRange(r.firstLabel || '8888', r.lastLabel || '8888'),
        ...(xref ? { bundle: xref.get(r.docId) ?? '' } : {}),
      },
      linkKey: `${r.docId}#${r.part?.n ?? 1}`,
    };
  });
}

/** Join page ranges, merging ranges that run on ("1–8", "9–28" → "1–28"). Inserted pages stay separate. */
export function mergeRanges(ranges: [string, string][]): string {
  const re = /^([A-Za-z]*)(\d+)$/;
  const out: [string, string][] = [];
  for (const [a, b] of ranges) {
    const prev = out[out.length - 1];
    const pm = prev && re.exec(prev[1]);
    const am = re.exec(a);
    if (pm && am && pm[1] === am[1] && +am[2] === +pm[2] + 1) prev[1] = b;
    else out.push([a, b]);
  }
  return out.map(([a, b]) => pageRange(a, b)).join(', ');
}

/** PD 5.6 para 3 front sheet: one row per status category. */
export function frontSheetRows(project: Project, rows: PlanRow[], bilingual = false): IndexRow[] {
  const docs = new Map(project.docs.map((d) => [d.id, d]));
  const entries = rows.filter((r): r is PlanEntry => r.kind === 'doc');
  return STATUS_ORDER.map((st) => {
    const mine = entries.filter((e) => docs.get(e.docId)?.status === st);
    const tabs = rangesFromLabels(mine.map((e) => e.tab));
    return {
      kind: 'doc',
      cells: {
        status: bi(bilingual, STATUS_FRONT[st], ZH.statusFront[st]),
        description: mine.length ? `No${mine.length > 1 ? 's' : ''}. ${tabs}` : bi(bilingual, 'None', ZH.none),
        pages: mine.length ? mergeRanges(mine.map((e) => [e.firstLabel || '8888', e.lastLabel || '8888'])) : '—',
      },
    };
  });
}

// ---------- ordering and checks ----------

/** Order main-bundle docs: by section (in section order) when sections are on; otherwise as given. */
export function orderedDocs(project: Project): BundleDoc[] {
  const main = project.docs.filter((d) => d.type !== 'transcript');
  if (!project.settings.sectionsEnabled) return main;
  const order = new Map(project.sections.map((s, i) => [s.id, i]));
  return main
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (order.get(a.d.sectionId ?? '') ?? 1e9) - (order.get(b.d.sectionId ?? '') ?? 1e9) || a.i - b.i)
    .map((x) => x.d);
}

/** Stable chronological sort (undated last), within sections when they are on. */
export function sortChronologically(project: Project): BundleDoc[] {
  const key = (d: BundleDoc) => d.date ?? '9999-99-99';
  const secOrder = new Map(project.sections.map((s, i) => [s.id, i]));
  return project.docs
    .map((d, i) => ({ d, i }))
    .sort((a, b) => {
      if (project.settings.sectionsEnabled) {
        const s = (secOrder.get(a.d.sectionId ?? '') ?? 1e9) - (secOrder.get(b.d.sectionId ?? '') ?? 1e9);
        if (s) return s;
      }
      return key(a.d) < key(b.d) ? -1 : key(a.d) > key(b.d) ? 1 : a.i - b.i;
    })
    .map((x) => x.d);
}

export function chronologyWarnings(project: Project, docs: BundleDoc[]): BuildWarning[] {
  const out: BuildWarning[] = [];
  let lastDate: string | null = null;
  let lastSection: string | undefined;
  let lastDesc = '';
  for (const d of docs) {
    if (project.settings.sectionsEnabled && d.sectionId !== lastSection) { lastDate = null; lastSection = d.sectionId; }
    if (!d.date) {
      out.push({ code: 'undated', docId: d.id, message: `"${d.description}" has no date; check where it belongs in the chronological order.` });
      continue;
    }
    if (lastDate && d.date < lastDate) {
      out.push({
        code: 'not-chronological', docId: d.id,
        message: `"${d.description}" (${formatDate(d.date, 'DD/MM/YYYY')}) comes after "${lastDesc}" (${formatDate(lastDate, 'DD/MM/YYYY')}); PD 5.6 para 4(2) expects chronological order from the front.`,
      });
    }
    lastDate = d.date; lastDesc = d.description;
  }
  return out;
}

// ---------- packing ----------

interface PageRef { fileId: string; srcIndex: number }

/** The pages of a document: its own pages with any typed copies interleaved (PD 5.6 para 6). */
export function docPageRefs(project: Project, d: BundleDoc): PageRef[] {
  const files = new Map(project.files.map((f) => [f.id, f]));
  const f = files.get(d.fileId);
  if (!f) throw new ProjectError(`"${d.description}" refers to a file that is not in the project (${d.fileId}).`);
  for (const tc of d.typedCopies ?? []) {
    if (!files.has(tc.fileId)) throw new ProjectError(`A typed copy for "${d.description}" refers to a missing file (${tc.fileId}).`);
    if (tc.afterPage < 1 || tc.afterPage > f.pageCount) {
      throw new ProjectError(`A typed copy for "${d.description}" is set after page ${tc.afterPage}, but the document has ${f.pageCount} page(s).`);
    }
  }
  const out: PageRef[] = [];
  for (let k = 0; k < f.pageCount; k++) {
    out.push({ fileId: d.fileId, srcIndex: k });
    for (const tc of (d.typedCopies ?? []).filter((t) => t.afterPage === k + 1)) {
      const tf = files.get(tc.fileId)!;
      for (let j = 0; j < tf.pageCount; j++) out.push({ fileId: tc.fileId, srcIndex: j });
    }
  }
  return out;
}

interface Draft {
  letter?: string;
  rows: PlanRow[];
  pages: PlanPage[];
  lastSectionId?: string;
  hasDocs: boolean;
}

interface PackOptions {
  kind: BundleKind;
  measure: PrelimMeasurer;
  limit: number;
  tabStart: number;
  /** Continue filling this volume first (used when appending after issue). */
  initial?: Draft;
  sectionsSeen?: Set<string>;
  /** Widest label this bundle is likely to use; index rows are measured with it until real labels exist. */
  labelHint: string;
}

/**
 * Pack documents into volumes of at most `limit` physical pages (front sheet and index
 * included). A document is split only if it cannot fit in an empty volume.
 * Pages come back unlabelled (label "").
 */
function packDocs(project: Project, docs: BundleDoc[], o: PackOptions): Draft[] {
  const s = project.settings;
  const useSections = o.kind === 'main' && s.sectionsEnabled;
  const drafts: Draft[] = [];
  const newDraft = (): Draft => ({ rows: [], pages: [], hasDocs: false });
  let cur = o.initial ?? newDraft();
  const sectionsSeen = o.sectionsSeen ?? new Set<string>();
  const close = () => { if (cur.hasDocs) drafts.push(cur); cur = newDraft(); };
  let tab = o.tabStart;
  const parts = new Map<string, PlanEntry[]>();

  for (const d of docs) {
    tab++;
    let remaining = docPageRefs(project, d);
    const blank = s.printable && remaining.length % 2 === 1 ? 1 : 0;
    let partNo = 0;
    while (remaining.length) {
      const secId = useSections ? (d.sectionId ?? '') : undefined;
      const secRow: PlanSectionRow | null = secId !== undefined && cur.lastSectionId !== secId
        ? { kind: 'section', sectionId: secId, continued: sectionsSeen.has(secId) }
        : null;
      const entry: PlanEntry = { kind: 'doc', docId: d.id, tab: String(tab), first: 0, count: 0, firstLabel: o.labelHint, lastLabel: o.labelHint };
      // A continuing part carries "(part n of m)": measure with it (m unknown yet, so a wide placeholder).
      if (partNo > 0) entry.part = { n: partNo + 1, of: 99 };
      const rowsWith = [...cur.rows, ...(secRow ? [secRow] : []), entry];
      const prelim = o.measure(o.kind, rowsWith);

      const place = (refs: PageRef[], withBlank: boolean) => {
        if (secRow) { cur.rows.push(secRow); cur.lastSectionId = secId; sectionsSeen.add(secId!); }
        entry.first = cur.pages.length;
        entry.count = refs.length;
        for (const r of refs) cur.pages.push({ kind: 'doc', docId: d.id, fileId: r.fileId, srcIndex: r.srcIndex, label: '', series: '' });
        if (withBlank) cur.pages.push({ kind: 'blank', docId: d.id, label: '', series: '' });
        cur.rows.push(entry);
        cur.hasDocs = true;
        parts.set(d.id, [...(parts.get(d.id) ?? []), entry]);
      };

      if (cur.pages.length + remaining.length + blank + prelim <= o.limit) {
        place(remaining, blank === 1);
        remaining = [];
        break;
      }
      if (cur.hasDocs) { close(); continue; }
      // Empty volume and the document still does not fit: split it.
      partNo++;
      entry.part = { n: partNo, of: 99 };
      const cap = o.limit - o.measure(o.kind, rowsWith);
      if (cap < 1) throw new ProjectError(`The page limit (${o.limit}) is too small to fit even the index of a volume.`);
      place(remaining.slice(0, cap), false);
      remaining = remaining.slice(cap);
      close();
    }
  }
  close();

  for (const entries of parts.values()) {
    if (entries.length > 1) entries.forEach((e, i) => { e.part = { n: i + 1, of: entries.length }; });
    else delete entries[0].part;
  }
  return drafts;
}

// ---------- labelling ----------

/** The page's number within its series ("C12" in series "C" → 12), or null for inserted pages ("88-1"). */
function baseNumber(p: PlanPage): number | null {
  if (!p.label.startsWith(p.series)) return null;
  const rest = p.label.slice(p.series.length);
  return /^\d+$/.test(rest) ? +rest : null;
}

function seriesFor(project: Project, kind: BundleKind, prefix: string, volLetter: string, docId?: string): string {
  if (kind !== 'main') return prefix;
  const s = project.settings;
  if (s.numbering === 'per-volume') return volLetter;
  if (s.numbering === 'per-section' && s.sectionsEnabled) {
    const d = project.docs.find((x) => x.id === docId);
    return project.sections.find((x) => x.id === d?.sectionId)?.letter ?? '';
  }
  return '';
}

/** Give every unlabelled page the next number in its series. */
function labelNewPages(project: Project, kind: BundleKind, prefix: string, vols: { letter: string; pages: PlanPage[] }[]) {
  const counters = new Map<string, number>();
  for (const v of vols) for (const p of v.pages) {
    const n = baseNumber(p);
    if (n !== null) counters.set(p.series, Math.max(counters.get(p.series) ?? 0, n));
  }
  for (const v of vols) for (const p of v.pages) {
    if (p.label) continue;
    const series = seriesFor(project, kind, prefix, v.letter, p.docId);
    const n = (counters.get(series) ?? 0) + 1;
    counters.set(series, n);
    p.series = series;
    p.label = `${series}${n}`;
  }
}

/** Recompute each entry's first page, span and labels from the pages. */
function refreshEntries(v: { rows: PlanRow[]; pages: PlanPage[] }) {
  for (const r of v.rows) {
    if (r.kind !== 'doc') continue;
    let first = -1, last = -1;
    v.pages.forEach((p, i) => {
      if (p.kind === 'doc' && p.docId === r.docId) { if (first < 0) first = i; last = i; }
    });
    if (first < 0) throw new ProjectError(`Internal error: no pages for index entry ${r.tab}.`);
    r.first = first;
    r.count = last - first + 1;
    r.firstLabel = v.pages[first].label;
    r.lastLabel = v.pages[last].label;
  }
}

function finalize(project: Project, kind: BundleKind, vols: { letter: string; rows: PlanRow[]; pages: PlanPage[] }[],
  measure: PrelimMeasurer, warnings: BuildWarning[], fixedNames?: Map<string, string>): BundlePlan {
  const seriesTotals: Record<string, number> = {};
  for (const v of vols) {
    refreshEntries(v);
    for (const p of v.pages) {
      if (p.kind !== 'doc' && p.kind !== 'blank') continue;
      const n = baseNumber(p);
      if (n !== null) seriesTotals[p.series] = Math.max(seriesTotals[p.series] ?? 0, n);
    }
  }
  const volumes = vols.map((v, i): PlanVolume => {
    const prelimPageCount = measure(kind, v.rows);
    // After issue, volume names never change ("Core Bundle" stays; a new one is "Core Bundle B").
    const name = fixedNames?.get(v.letter) ?? bundleName(kind, v.letter, fixedNames ? Math.max(2, vols.length) : vols.length);
    const total = prelimPageCount + v.pages.length;
    if (total > project.settings.maxPagesPerVolume) {
      warnings.push({ code: 'volume-over-limit', message: `${name} has ${total} pages, over the ${project.settings.maxPagesPerVolume}-page limit (PD 5.6 para 5). After issue, pages cannot be moved without renumbering; consider re-issuing the bundle or lodging the extra pages in a supplementary file.` });
    }
    return { letter: v.letter, ordinal: i + 1, name, rows: v.rows, pages: v.pages, prelimPageCount };
  });
  return { kind, volumes, seriesTotals };
}

/** A label at least as wide as any this bundle will use, so the index is never measured too short. */
function labelHint(project: Project, kind: BundleKind, prefix: string, extraPages: number, docs: BundleDoc[]): string {
  const s = project.settings;
  const pages = extraPages + docs.reduce((a, d) => a + docPageRefs(project, d).length + 1, 0);
  const digits = Math.max(4, String(pages).length);
  const letters = kind !== 'main' ? prefix.length
    : s.numbering === 'per-volume' ? 2
    : s.numbering === 'per-section' && s.sectionsEnabled ? Math.max(1, ...project.sections.map((x) => x.letter.length))
    : 0;
  return `${'W'.repeat(letters)}${'8'.repeat(digits)}`;
}

function planFresh(project: Project, kind: BundleKind, docs: BundleDoc[], prefix: string,
  measure: PrelimMeasurer, warnings: BuildWarning[]): BundlePlan {
  const drafts = packDocs(project, docs, { kind, measure, limit: project.settings.maxPagesPerVolume, tabStart: 0, labelHint: labelHint(project, kind, prefix, 0, docs) });
  const vols = drafts.map((d, i) => ({ letter: volumeLetter(i), rows: d.rows, pages: d.pages }));
  labelNewPages(project, kind, prefix, vols);
  for (const v of vols) for (const r of v.rows) {
    if (r.kind === 'doc' && r.part) {
      const d = project.docs.find((x) => x.id === r.docId)!;
      if (r.part.n === 1) warnings.push({ code: 'doc-split', docId: d.id, message: `"${d.description}" alone exceeds the ${project.settings.maxPagesPerVolume}-page limit, so it is split across ${r.part.of} volumes.` });
    }
  }
  return finalize(project, kind, vols, measure, warnings);
}

/**
 * Re-plan an issued bundle. Existing page numbers never change. New material is placed:
 *  - typed copies of a page → after that page, numbered "45-1";
 *  - documents with `insertAfter` → after that page, numbered "88-1, 88-2…" (PD 5.6 para 1);
 *  - other new documents → at the end, continuing the numbering.
 */
function planFrozen(project: Project, kind: BundleKind, frozen: FrozenLayout, docs: BundleDoc[], prefix: string,
  measure: PrelimMeasurer, warnings: BuildWarning[]): BundlePlan {
  const fb = frozen.bundles[kind]!;
  const vols = structuredClone(fb.volumes);
  const files = new Map(project.files.map((f) => [f.id, f]));
  const byId = new Map(docs.map((d) => [d.id, d]));
  const allDocs = new Map(project.docs.map((d) => [d.id, d]));
  const what = kind === 'main' ? 'the issued bundle' : kind === 'core' ? 'the issued core bundle' : 'the issued transcript bundle';

  const frozenDocIds = new Set<string>();
  for (const v of vols) for (const p of v.pages) {
    if (p.kind !== 'doc') continue;
    frozenDocIds.add(p.docId!);
    const f = files.get(p.fileId!);
    if (!f) throw new ProjectError(`A file used in ${what} (${p.fileId}) has been removed from the project. Pages cannot be removed after issue without renumbering.`);
    if (frozen.fileHashes[p.fileId!] && frozen.fileHashes[p.fileId!] !== f.sha256) {
      throw new ProjectError(`"${f.name}" has different content from the version in ${what}. Restore the original file, or re-issue the bundle.`);
    }
  }
  for (const id of frozenDocIds) {
    if (!byId.has(id)) {
      const title = allDocs.get(id)?.description ?? frozen.docTitles?.[id];
      throw new ProjectError(`${title ? `"${title}"` : `Document ${id}`} is in ${what} but has been removed. Documents cannot be removed after issue without renumbering; re-issue the bundle instead.`);
    }
  }

  // Locate pages by label.
  const find = (label: string) => {
    for (let vi = 0; vi < vols.length; vi++) {
      const pi = vols[vi].pages.findIndex((p) => p.label === label);
      if (pi >= 0) return { vi, pi };
    }
    return null;
  };

  interface Ins { anchor: string; refs: PageRef[]; doc: BundleDoc; newRow: boolean }
  const inserts: Ins[] = [];
  const appends: BundleDoc[] = [];

  for (const d of docs) {
    if (frozenDocIds.has(d.id)) {
      for (const tc of d.typedCopies ?? []) {
        const present = vols.some((v) => v.pages.some((p) => p.docId === d.id && p.fileId === tc.fileId));
        if (present) continue;
        const anchorPage = vols.flatMap((v) => v.pages).find((p) => p.docId === d.id && p.fileId === d.fileId && p.srcIndex === tc.afterPage - 1);
        if (!anchorPage) throw new ProjectError(`Typed copy for "${d.description}": page ${tc.afterPage} is not in ${what}.`);
        if (/-\d+$/.test(anchorPage.label)) throw new ProjectError(`Typed copy for "${d.description}": page ${anchorPage.label} is itself an inserted page; re-issue the bundle to add a typed copy after it.`);
        const tf = files.get(tc.fileId);
        if (!tf) throw new ProjectError(`A typed copy for "${d.description}" refers to a missing file (${tc.fileId}).`);
        inserts.push({ anchor: anchorPage.label, refs: Array.from({ length: tf.pageCount }, (_, j) => ({ fileId: tc.fileId, srcIndex: j })), doc: d, newRow: false });
      }
      continue;
    }
    if (d.insertAfter) {
      const at = d.insertAfter.trim();
      if (/-\d+$/.test(at)) {
        throw new ProjectError(`"${d.description}" is set to go after page ${at}, which is itself an inserted page. Use the original page (${at.replace(/-\d+$/, '')}); the new pages will follow the existing inserts.`);
      }
      if (find(at)) { inserts.push({ anchor: at, refs: docPageRefs(project, d), doc: d, newRow: true }); continue; }
      if (kind === 'main') throw new ProjectError(`"${d.description}" is set to go after page ${at}, but there is no page ${at} in ${what}.`);
    }
    appends.push(d);
  }

  for (const ins of inserts) {
    const loc = find(ins.anchor)!;
    const vol = vols[loc.vi];
    const anchorPage = vol.pages[loc.pi];
    let pos = loc.pi + 1;
    let k = 0;
    while (pos < vol.pages.length && vol.pages[pos].label.startsWith(`${ins.anchor}-`)) pos++;
    for (const p of vol.pages) {
      const m = new RegExp(`^${ins.anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`).exec(p.label);
      if (m) k = Math.max(k, +m[1]);
    }
    const newPages: PlanPage[] = ins.refs.map((r) => ({
      kind: 'doc', docId: ins.doc.id, fileId: r.fileId, srcIndex: r.srcIndex, label: `${ins.anchor}-${++k}`, series: anchorPage.series,
    }));
    vol.pages.splice(pos, 0, ...newPages);
    if (ins.newRow) {
      const ri = vol.rows.findIndex((r) => r.kind === 'doc' && r.docId === anchorPage.docId);
      const anchorRow = vol.rows[ri] as PlanEntry;
      let rpos = ri + 1;
      let n = 0;
      while (rpos < vol.rows.length) {
        const r = vol.rows[rpos];
        if (r.kind === 'doc' && r.tab.startsWith(`${anchorRow.tab}-`)) { n = Math.max(n, +r.tab.split('-').pop()!); rpos++; } else break;
      }
      vol.rows.splice(rpos, 0, { kind: 'doc', docId: ins.doc.id, tab: `${anchorRow.tab}-${n + 1}`, first: 0, count: 0, firstLabel: '', lastLabel: '' });
    }
  }

  if (appends.length) {
    const last = vols[vols.length - 1];
    const tabStart = Math.max(0, ...vols.flatMap((v) => v.rows).filter((r): r is PlanEntry => r.kind === 'doc').map((r) => parseInt(r.tab, 10)));
    const sectionsSeen = new Set(vols.flatMap((v) => v.rows).filter((r): r is PlanSectionRow => r.kind === 'section').map((r) => r.sectionId));
    const lastSection = [...last.rows].reverse().find((r): r is PlanSectionRow => r.kind === 'section');
    const initial: Draft = { letter: last.letter, rows: last.rows, pages: last.pages, hasDocs: true, lastSectionId: lastSection?.sectionId };
    const existing = vols.reduce((a, v) => a + v.pages.length, 0);
    const drafts = packDocs(project, appends, { kind, measure, limit: project.settings.maxPagesPerVolume, tabStart, sectionsSeen, initial, labelHint: labelHint(project, kind, prefix, existing, appends) });
    // drafts[0] is `initial` (the last issued volume, extended in place); the rest are new volumes.
    for (const d of drafts.slice(1)) vols.push({ letter: volumeLetter(vols.length), rows: d.rows, pages: d.pages });
    labelNewPages(project, kind, prefix, vols);
    const lastDated = [...frozenDocIds].map((id) => allDocs.get(id)?.date).filter(Boolean).sort().pop();
    for (const d of appends) {
      const pages = vols.flatMap((v) => v.pages).filter((p) => p.docId === d.id);
      const range = pageRange(pages[0].label, pages[pages.length - 1].label);
      const late = d.date && lastDated && d.date < lastDated;
      const where = kind === 'main' ? '' : `${kind === 'core' ? 'Core Bundle' : 'Transcript Bundle'} `;
      warnings.push({
        code: 'appended-after-issue', docId: d.id,
        message: kind !== 'main' && d.insertAfter
          ? `"${d.description}" is placed at the end of the ${where.trim()} (pages ${range}); its "insert after" page ${d.insertAfter} applies to the main bundle.`
          : `"${d.description}" was added after issue with no "insert after" page, so it is placed at the end (${where}pages ${range})${late ? ' and is out of chronological order. To place it in date order, set the page it should follow (it will be numbered like 88-1)' : ''}.`,
      });
    }
  }

  // Pages added since issue are numbered from the current list, so they are provisional until re-issued.
  const added = [...inserts.map((i) => i.doc), ...appends];
  if (added.length) {
    const ranges = [...new Set(added.map((d) => d.id))].map((id) => {
      const pages = vols.flatMap((v) => v.pages).filter((p) => p.docId === id && !frozenDocIds.has(id) || (p.docId === id && /-\d+$/.test(p.label)));
      const doc = allDocs.get(id)!;
      return pages.length ? `"${doc.description}" ${pageRange(pages[0].label, pages[pages.length - 1].label)}` : '';
    }).filter(Boolean);
    warnings.push({
      code: 'provisional-numbers',
      message: `Pages added since the ${kind === 'main' ? 'bundle' : kind === 'core' ? 'core bundle' : 'transcript bundle'} was issued (${ranges.join('; ')}) are numbered provisionally: their numbers can change if other late documents are added, removed or reordered. Use "Build and re-issue" before lodging them, to lock the numbers.`,
    });
  }
  const fixedNames = new Map(fb.volumes.map((v) => [v.letter, bundleName(kind, v.letter, fb.volumes.length)]));
  return finalize(project, kind, vols, measure, warnings, fixedNames);
}

/** Labels already used by the main bundle's series, to pick a non-clashing core/transcript prefix. */
function pickPrefix(want: string, alt: string, used: Set<string>) {
  return used.has(want) ? alt : want;
}

/** The prefix an issued core/transcript bundle already uses (e.g. "C" or "CB"). */
function issuedPrefix(frozen: FrozenLayout | undefined, kind: BundleKind): string | undefined {
  return frozen?.bundles[kind]?.volumes.flatMap((v) => v.pages).find((p) => p.kind === 'doc' && baseNumber(p) !== null)?.series;
}

export function planProjectBundles(project: Project, measure: PrelimMeasurer): BuildPlan {
  const s = project.settings;
  const limit = s.maxPagesPerVolume;
  if (!Number.isInteger(limit) || limit < 10 || limit > 5000) {
    throw new ProjectError(`The page limit per file must be a whole number from 10 to 5000 (it is "${limit}").`);
  }
  const warnings: BuildWarning[] = [];
  if (s.numbering === 'per-section' && !s.sectionsEnabled) {
    warnings.push({ code: 'non-compliant-setting', message: 'Numbering is set to restart in each section, but sections are off, so pages are numbered consecutively instead.' });
  }
  const frozen = project.frozen;
  const mainDocs = orderedDocs(project);
  const transcriptDocs = project.docs.filter((d) => d.type === 'transcript');
  const coreDocs = mainDocs.filter((d) => d.core);

  if (!frozen) {
    warnings.push(...chronologyWarnings(project, mainDocs));
    for (const d of project.docs.filter((x) => x.insertAfter)) {
      warnings.push({ code: 'insert-before-issue', docId: d.id, message: `"${d.description}" is marked to go after page ${d.insertAfter}, but the bundle has not been issued yet, so it is placed in normal order and numbered normally.` });
    }
  }

  // Duplicate content.
  const byHash = new Map<string, string[]>();
  for (const f of project.files) byHash.set(f.sha256, [...(byHash.get(f.sha256) ?? []), f.name]);
  for (const names of byHash.values()) {
    if (names.length > 1) warnings.push({ code: 'duplicate', message: `Identical content: ${names.map((n) => `"${n}"`).join(', ')}.` });
  }

  if (!mainDocs.length) throw new ProjectError('There are no documents for the main bundle.');
  const main = frozen?.bundles.main
    ? planFrozen(project, 'main', frozen, mainDocs, '', measure, warnings)
    : planFresh(project, 'main', mainDocs, '', measure, warnings);

  const used = new Set(Object.keys(main.seriesTotals));
  const filePages = new Map(project.files.map((f) => [f.id, f.pageCount]));
  const docPages = mainDocs.reduce((a, d) => a + (filePages.get(d.fileId) ?? 0)
    + (d.typedCopies ?? []).reduce((b, t) => b + (filePages.get(t.fileId) ?? 0), 0), 0);

  let core: BundlePlan | undefined;
  const xref = crossRefs(main);
  const coreMeasure: PrelimMeasurer = (k, rows) => measure(k, rows, xref);
  const corePrefix = issuedPrefix(frozen, 'core') ?? pickPrefix('C', 'CB', used);
  const txPrefix = issuedPrefix(frozen, 'transcripts') ?? pickPrefix('T', 'TB', used);
  if (frozen?.bundles.core) {
    core = planFrozen(project, 'core', frozen, coreDocs, corePrefix, coreMeasure, warnings);
  } else if (coreDocs.length) {
    core = planFresh(project, 'core', coreDocs, corePrefix, coreMeasure, warnings);
  } else if (docPages > 100) {
    warnings.push({ code: 'core-bundle-needed', message: `The agreed bundle has ${docPages} pages of documents. PD 5.6 para 2 says a core bundle should be prepared where it exceeds 100 pages: tag the core documents.` });
  }

  let transcripts: BundlePlan | undefined;
  if (frozen?.bundles.transcripts) {
    transcripts = planFrozen(project, 'transcripts', frozen, transcriptDocs, txPrefix, measure, warnings);
  } else if (transcriptDocs.length) {
    transcripts = planFresh(project, 'transcripts', transcriptDocs, txPrefix, measure, warnings);
  }
  for (const [b, pre] of [[core, corePrefix], [transcripts, txPrefix]] as const) {
    if (b && used.has(pre)) {
      warnings.push({ code: 'label-clash', message: `The main bundle now has page numbers starting "${pre}", the same as the ${b.kind === 'core' ? 'core' : 'transcript'} bundle (issued before the new volume was added). Re-issue the bundle so the numbers are unique.` });
    }
  }
  if (frozen && /of|slash/i.test(s.stamp.style)) {
    warnings.push({ code: 'non-compliant-setting', message: 'With "X of Y" style page numbers, the "of Y" total on issued pages changes when pages are added after issue. Use plain numbers to keep issued pages unchanged.' });
  }

  const physicalFiles = main.volumes.length + (core?.volumes.length ?? 0) + (transcripts?.volumes.length ?? 0);
  if (physicalFiles > 5) {
    warnings.push({ code: 'inside-cover-labels', message: `There are ${physicalFiles} files in total. PD 5.6 para 7: label each on the top right-hand corner of the inside cover (labels are produced with the export).` });
  }
  if (s.stamp.position !== 'top-right') {
    warnings.push({ code: 'non-compliant-setting', message: `Page numbers are set to the ${s.stamp.position.replace('-', ' ')}; PD 5.6 para 4(3) requires the top right-hand corner.` });
  }
  if (s.stamp.style === 'None') {
    warnings.push({ code: 'non-compliant-setting', message: 'Page numbering is turned off; PD 5.6 para 4(3) requires consecutive page numbers.' });
  }
  if (s.maxPagesPerVolume > 250) {
    warnings.push({ code: 'non-compliant-setting', message: `The volume limit is ${s.maxPagesPerVolume} pages; PD 5.6 para 5 says a file should never include more than 250 pages.` });
  }
  return { main, core, transcripts, warnings, physicalFiles };
}

/** Lock page numbers: returns a copy of the project with `frozen` set from this plan. */
export function freezeProject(project: Project, plan: BuildPlan, issuedAt: string): Project {
  const strip = (b?: BundlePlan) => b && { volumes: b.volumes.map((v) => ({ letter: v.letter, rows: structuredClone(v.rows), pages: structuredClone(v.pages) })) };
  const used = new Set<string>();
  for (const b of [plan.main, plan.core, plan.transcripts]) for (const v of b?.volumes ?? []) for (const p of v.pages) if (p.fileId) used.add(p.fileId);
  const fileHashes = Object.fromEntries(project.files.filter((f) => used.has(f.id)).map((f) => [f.id, f.sha256]));
  const bundles: FrozenLayout['bundles'] = { main: strip(plan.main) };
  if (plan.core) bundles.core = strip(plan.core);
  if (plan.transcripts) bundles.transcripts = strip(plan.transcripts);
  const docIds = new Set<string>();
  for (const b of [plan.main, plan.core, plan.transcripts]) for (const v of b?.volumes ?? []) for (const p of v.pages) if (p.docId) docIds.add(p.docId);
  const docTitles = Object.fromEntries(project.docs.filter((d) => docIds.has(d.id)).map((d) => [d.id, d.description]));
  return { ...structuredClone(project), frozen: { issuedAt, fileHashes, docTitles, bundles } };
}

export function unfreezeProject(project: Project): Project {
  const p = structuredClone(project);
  delete p.frozen;
  return p;
}
