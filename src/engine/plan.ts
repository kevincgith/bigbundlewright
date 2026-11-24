// Big Bundle Wright: ordering, volumes and page numbering (pure; no PDF work).
// SPDX-License-Identifier: MPL-2.0

import type { BuildWarning, BundleDoc, DocStatus, Project, Section } from './model.ts';
import type { IndexColumn, IndexRow } from './layout-index.ts';
import { formatDate, volumeLetter } from './util.ts';

export interface PlanPage {
  kind: 'doc' | 'blank';
  docId?: string;
  fileId?: string;
  /** 0-based page index in the source file. */
  srcIndex?: number;
  /** Stamped label, e.g. "12", "A12", "C3". */
  label: string;
  /** Numbering series ("" for continuous, else the volume or section letter) for "of Y" styles. */
  series: string;
}

export interface PlanEntry {
  kind: 'doc';
  docId: string;
  tab: number;
  part?: { n: number; of: number };
  /** Index into the volume's content pages. */
  first: number;
  count: number;
  firstLabel: string;
  lastLabel: string;
}

export interface PlanSectionRow {
  kind: 'section';
  sectionId: string;
  continued: boolean;
}

export interface PlanVolume {
  letter: string;
  ordinal: number;
  rows: (PlanEntry | PlanSectionRow)[];
  pages: PlanPage[];
  indexPageCount: number;
}

export interface BuildPlan {
  volumes: PlanVolume[];
  warnings: BuildWarning[];
  /** Docs held back for a later stage (transcripts). */
  deferredDocIds: string[];
  seriesTotals: Record<string, number>;
}

export type IndexMeasurer = (rows: IndexRow[]) => number;

export const STATUS_LABEL: Record<DocStatus, string> = {
  authentic: 'Authentic',
  inclusion_only: 'Inclusion only',
  evidence_of_contents: 'Evidence',
};

export const STATUS_LEGEND = [
  'Status of documents (PD 5.6 para 3; RHC O.27 r.4): '
  + '"Authentic" = deemed authentic under O.27 r.4, or agreed to be authentic; '
  + '"Inclusion only" = agreed for inclusion in the bundle only; '
  + '"Evidence" = also agreed to be admissible as evidence of its contents, subject to submissions on weight.',
];

export const VOLUME_COLUMNS: IndexColumn[] = [
  { key: 'tab', title: 'No.', width: 30, align: 'right' },
  { key: 'date', title: 'Date', width: 64, align: 'left' },
  { key: 'description', title: 'Description', width: 0, align: 'left' },
  { key: 'status', title: 'Status', width: 62, align: 'left' },
  { key: 'pages', title: 'Page(s)', width: 70, align: 'right' },
];

export const MASTER_COLUMNS: IndexColumn[] = [
  { key: 'tab', title: 'No.', width: 30, align: 'right' },
  { key: 'date', title: 'Date', width: 64, align: 'left' },
  { key: 'description', title: 'Description', width: 0, align: 'left' },
  { key: 'status', title: 'Status', width: 58, align: 'left' },
  { key: 'bundle', title: 'Bundle', width: 42, align: 'center' },
  { key: 'pages', title: 'Page(s)', width: 70, align: 'right' },
];

export const formatDateFor = (p: Project, iso: string | null) => formatDate(iso, p.settings.dateStyle);

export function sectionTitle(project: Project, s: Section, continued: boolean): string {
  const prefix = project.settings.sectionPrefix ? `${project.settings.sectionPrefix} ` : '';
  return `${prefix}${s.letter}  ${s.title}${continued ? ' (continued)' : ''}`;
}

export function entryDescription(doc: BundleDoc, part?: { n: number; of: number }): string {
  const zh = doc.descriptionZh ? `\n${doc.descriptionZh}` : '';
  return `${doc.description}${part ? ` (part ${part.n} of ${part.of})` : ''}${zh}`;
}

export function pageRange(first: string, last: string): string {
  return first === last ? first : `${first}–${last}`;
}

/** Index rows for one volume (or any list of plan rows). */
export function indexRows(project: Project, rows: (PlanEntry | PlanSectionRow)[]): IndexRow[] {
  const docs = new Map(project.docs.map((d) => [d.id, d]));
  const secs = new Map(project.sections.map((s) => [s.id, s]));
  return rows.map((r): IndexRow => {
    if (r.kind === 'section') {
      const s = secs.get(r.sectionId);
      return { kind: 'section', cells: {}, title: s ? sectionTitle(project, s, r.continued) : 'Other documents' };
    }
    const d = docs.get(r.docId)!;
    return {
      kind: 'doc',
      cells: {
        tab: String(r.tab),
        date: formatDate(d.date, project.settings.dateStyle),
        description: entryDescription(d, r.part),
        status: STATUS_LABEL[d.status],
        pages: pageRange(r.firstLabel || '888', r.lastLabel || '888'),
      },
      linkKey: `${r.docId}#${r.part?.n ?? 1}`,
    };
  });
}

/** Order docs: by section (in section order) when sections are on; otherwise as given. */
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

interface Draft {
  rows: (PlanEntry | PlanSectionRow)[];
  pages: PlanPage[];
  lastSectionId?: string;
  hasDocs: boolean;
}

/**
 * Pack documents into volumes of at most `maxPagesPerVolume` physical pages
 * (index pages included). A document is split only if it cannot fit in an empty volume.
 */
export function planBundle(project: Project, measure: IndexMeasurer): BuildPlan {
  const s = project.settings;
  const limit = s.maxPagesPerVolume;
  const files = new Map(project.files.map((f) => [f.id, f]));
  const warnings: BuildWarning[] = [];
  const docs = orderedDocs(project);
  const deferredDocIds = project.docs.filter((d) => d.type === 'transcript').map((d) => d.id);
  if (deferredDocIds.length) {
    warnings.push({ code: 'deferred-feature', message: `${deferredDocIds.length} transcript(s) are kept out of the main bundle (PD 5.6 paras 4-5); the separate transcript bundle is built in stage 3.` });
  }
  warnings.push(...chronologyWarnings(project, docs));

  // Duplicate content.
  const byHash = new Map<string, string[]>();
  for (const f of project.files) byHash.set(f.sha256, [...(byHash.get(f.sha256) ?? []), f.name]);
  for (const names of byHash.values()) {
    if (names.length > 1) warnings.push({ code: 'duplicate', message: `Identical content: ${names.map((n) => `"${n}"`).join(', ')}.` });
  }

  const volumes: Draft[] = [];
  const newDraft = (): Draft => ({ rows: [], pages: [], hasDocs: false });
  let cur = newDraft();
  const sectionsSeen = new Set<string>();
  const measureRows = (rows: (PlanEntry | PlanSectionRow)[]) => measure(indexRows(project, rows));
  const close = () => { if (cur.hasDocs) volumes.push(cur); cur = newDraft(); };
  let tab = 0;
  const parts = new Map<string, PlanEntry[]>();

  for (const d of docs) {
    const f = files.get(d.fileId);
    if (!f) throw new Error(`Document "${d.description}" refers to a missing file (${d.fileId}).`);
    tab++;
    let remaining = Array.from({ length: f.pageCount }, (_, i) => i);
    let partNo = 0;
    while (remaining.length) {
      const secId = s.sectionsEnabled ? (d.sectionId ?? '') : undefined;
      const secRow: PlanSectionRow | null = secId !== undefined && cur.lastSectionId !== secId
        ? { kind: 'section', sectionId: secId, continued: sectionsSeen.has(secId) }
        : null;
      const entry: PlanEntry = { kind: 'doc', docId: d.id, tab, first: 0, count: 0, firstLabel: '', lastLabel: '' };
      const blank = s.printable && f.pageCount % 2 === 1 ? 1 : 0;
      const rowsWith = [...cur.rows, ...(secRow ? [secRow] : []), entry];
      const idx = measureRows(rowsWith);

      const place = (pageIdx: number[], withBlank: boolean) => {
        if (secRow) { cur.rows.push(secRow); cur.lastSectionId = secId; sectionsSeen.add(secId!); }
        entry.first = cur.pages.length;
        entry.count = pageIdx.length;
        for (const p of pageIdx) cur.pages.push({ kind: 'doc', docId: d.id, fileId: d.fileId, srcIndex: p, label: '', series: '' });
        if (withBlank) cur.pages.push({ kind: 'blank', docId: d.id, label: '', series: '' });
        cur.rows.push(entry);
        cur.hasDocs = true;
        parts.set(d.id, [...(parts.get(d.id) ?? []), entry]);
      };

      if (cur.pages.length + remaining.length + blank + idx <= limit) {
        if (partNo > 0) entry.part = { n: partNo + 1, of: 0 };
        place(remaining, blank === 1);
        remaining = [];
        break;
      }
      if (cur.hasDocs) { close(); continue; }
      // Empty volume and the document still does not fit: split it.
      partNo++;
      entry.part = { n: partNo, of: 0 };
      const cap = limit - measureRows(rowsWith);
      if (cap < 1) throw new Error(`The page limit (${limit}) is too small to fit even the index of a volume.`);
      place(remaining.slice(0, cap), false);
      remaining = remaining.slice(cap);
      close();
    }
  }
  close();

  for (const [docId, entries] of parts) {
    if (entries.length > 1) {
      entries.forEach((e, i) => { e.part = { n: i + 1, of: entries.length }; });
      const d = project.docs.find((x) => x.id === docId)!;
      warnings.push({ code: 'doc-split', docId, message: `"${d.description}" alone exceeds the ${limit}-page limit, so it is split across ${entries.length} volumes.` });
    } else {
      delete entries[0].part;
    }
  }

  // ---- numbering ----
  const secLetter = new Map(project.sections.map((x) => [x.id, x.letter]));
  const docSection = new Map(project.docs.map((d) => [d.id, d.sectionId ?? '']));
  const seriesTotals: Record<string, number> = {};
  const counters = new Map<string, number>();
  const out: PlanVolume[] = volumes.map((v, vi) => {
    const letter = volumeLetter(vi);
    for (const p of v.pages) {
      const series = s.numbering === 'continuous' ? ''
        : s.numbering === 'per-volume' ? letter
        : (secLetter.get(docSection.get(p.docId!) ?? '') ?? '');
      const n = (counters.get(series) ?? 0) + 1;
      counters.set(series, n);
      p.series = series;
      p.label = `${series}${n}`;
      seriesTotals[series] = n;
    }
    for (const r of v.rows) {
      if (r.kind !== 'doc') continue;
      r.firstLabel = v.pages[r.first].label;
      r.lastLabel = v.pages[r.first + r.count - 1].label;
    }
    return { letter, ordinal: vi + 1, rows: v.rows, pages: v.pages, indexPageCount: measureRows(v.rows) };
  });

  if (s.stamp.position !== 'top-right') {
    warnings.push({ code: 'non-compliant-setting', message: `Page numbers are set to the ${s.stamp.position.replace('-', ' ')}; PD 5.6 para 4(3) requires the top right-hand corner.` });
  }
  if (s.stamp.style === 'None') {
    warnings.push({ code: 'non-compliant-setting', message: 'Page numbering is turned off; PD 5.6 para 4(3) requires consecutive page numbers.' });
  }
  if (limit > 250) {
    warnings.push({ code: 'non-compliant-setting', message: `The volume limit is ${limit} pages; PD 5.6 para 5 says a file should never include more than 250 pages.` });
  }
  return { volumes: out, warnings, deferredDocIds, seriesTotals };
}
