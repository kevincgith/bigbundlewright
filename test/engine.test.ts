// Big Bundle Wright: engine tests (PD 5.6 checks on real generated PDFs).
// SPDX-License-Identifier: MPL-2.0

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString, PDFHexString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { PDFJS_ASSETS, analyse, initProject, loadProjectSources } from '../cli/node-support.ts';
import {
  buildBundle, describeDeadline, loadSource, lodgingDeadline, parseFileName, safeFileName, SourceError,
  type BuildOutput, type LoadedSource, type PageAnalysis, type Project,
} from '../src/engine/index.ts';
import { BAD_DIR, FIXTURE_DIR, MAIN_SET, generate } from './fixtures/generate.ts';

// ---------- helpers ----------

interface TextItem { str: string; x: number; y: number; a: number; b: number }
interface PageText { w: number; h: number; items: TextItem[]; text: string }

async function readText(bytes: Uint8Array): Promise<PageText[]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), ...PDFJS_ASSETS });
  const doc = await task.promise;
  const out: PageText[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    const tc = await p.getTextContent();
    const items = tc.items.filter((it): it is any => 'str' in it && it.str.trim() !== '')
      .map((it: any) => ({ str: it.str.trim(), x: it.transform[4], y: it.transform[5], a: it.transform[0], b: it.transform[1] }));
    out.push({ w: vp.width, h: vp.height, items, text: items.map((t) => t.str).join(' ') });
  }
  await task.destroy();
  return out;
}

/** The stamp: the text item in the top-right zone of the page. */
function stampOf(p: PageText): string | undefined {
  return p.items.find((t) => t.x > p.w - 150 && t.y > p.h - 45)?.str;
}

function pageIndexByRef(doc: PDFDocument) {
  const m = new Map<string, number>();
  doc.getPages().forEach((p, i) => m.set(p.ref.toString(), i));
  return m;
}

function linksOn(doc: PDFDocument, pageIdx: number) {
  const page = doc.getPage(pageIdx);
  const annots = page.node.Annots();
  const refs = pageIndexByRef(doc);
  const out: { target?: number; remote?: { file: string; page: number } }[] = [];
  if (!annots) return out;
  for (let i = 0; i < annots.size(); i++) {
    const a = doc.context.lookup(annots.get(i), PDFDict);
    if (a.get(PDFName.of('Subtype'))?.toString() !== '/Link') continue;
    const dest = a.lookupMaybe(PDFName.of('Dest'), PDFArray);
    if (dest) { out.push({ target: refs.get((dest.get(0) as PDFRef).toString()) }); continue; }
    const act = a.lookup(PDFName.of('A'), PDFDict);
    const f = act.lookup(PDFName.of('F')) as PDFString | PDFHexString;
    const d = act.lookup(PDFName.of('D'), PDFArray);
    out.push({ remote: { file: f.decodeText(), page: (d.get(0) as PDFNumber).asNumber() } });
  }
  return out;
}

function outline(doc: PDFDocument) {
  const refs = pageIndexByRef(doc);
  const out: { title: string; page: number; depth: number }[] = [];
  const root = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  const walk = (first: PDFDict | undefined, depth: number) => {
    let node = first;
    while (node) {
      const t = node.lookup(PDFName.of('Title')) as PDFString | PDFHexString;
      const dest = node.lookup(PDFName.of('Dest'), PDFArray);
      out.push({ title: t.decodeText(), page: refs.get((dest.get(0) as PDFRef).toString())!, depth });
      walk(node.lookupMaybe(PDFName.of('First'), PDFDict), depth + 1);
      node = node.lookupMaybe(PDFName.of('Next'), PDFDict);
    }
  };
  walk(root?.lookupMaybe(PDFName.of('First'), PDFDict), 0);
  return out;
}

// ---------- shared build ----------

let project: Project;
let sources: Map<string, LoadedSource>;
let analysis: Map<string, PageAnalysis[]>;
let result: BuildOutput;
let texts: PageText[][];
const keyOfFile = new Map<string, string>();
const FIXED = new Date('2026-11-24T00:00:00Z');

function variant(mut: (p: Project) => void): Project {
  const p = structuredClone(project);
  mut(p);
  return p;
}

beforeAll(async () => {
  await generate();
  ({ project } = await initProject(FIXTURE_DIR, { actionNo: 'HCA 1234/2025', shortTitle: 'Chan v Wong' }));
  ({ sources } = await loadProjectSources(project, FIXTURE_DIR));
  analysis = new Map();
  for (const [id, s] of sources) analysis.set(id, await analyse(s));
  for (const f of project.files) keyOfFile.set(f.id, MAIN_SET.find((m) => m.name === f.name)!.key);
  result = await buildBundle({ project, sources, analysis, date: FIXED });
  texts = await Promise.all(result.volumes.map((v) => readText(v.bytes)));
}, 120_000);

// ---------- tests ----------

describe('inputs', () => {
  it('draft project reads dates and titles from file names and sorts by date', () => {
    const dated = project.docs.filter((d) => d.date);
    expect(dated.map((d) => d.date)).toEqual([...dated.map((d) => d.date)].sort());
    expect(project.docs[0]).toMatchObject({ date: '2024-01-10', description: 'Writ of Summons' });
    expect(project.docs.find((d) => d.description === 'Transcript Day 1')?.type).toBe('transcript');
  });

  it('rejects encrypted, corrupt and Word files with an error naming the file', async () => {
    for (const [name, code] of [['Encrypted.pdf', 'encrypted'], ['Corrupt.pdf', 'corrupt'], ['Witness statement.docx', 'unsupported']] as const) {
      const bytes = new Uint8Array(await readFile(join(BAD_DIR, name)));
      const err = await loadSource('x', name, bytes).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect(err.code).toBe(code);
      expect(err.message).toContain(name);
    }
    const docx = await loadSource('x', 'Witness statement.docx', new Uint8Array(await readFile(join(BAD_DIR, 'Witness statement.docx')))).catch((e) => e);
    expect(docx.message).toMatch(/Convert it to PDF first/);
  });

  it('converts a JPG to a one-page A4 PDF', () => {
    const photo = [...sources.values()].find((s) => s.ref.name.endsWith('.jpg'))!;
    expect(photo.ref.kind).toBe('image');
    const { width, height } = photo.pdf.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([842, 595]);
  });

  it('warns about duplicates by content hash', () => {
    expect(result.warnings.some((w) => w.code === 'duplicate' && w.message.includes('Letter to D (copy).pdf'))).toBe(true);
  });
});

describe('volumes and pagination (PD 5.6 paras 4(3), 5)', () => {
  it('splits 300+ pages into volumes that never exceed 250 pages', async () => {
    expect(result.volumes.length).toBe(2);
    for (const v of result.volumes) {
      expect(v.pageCount).toBeLessThanOrEqual(250);
      expect((await PDFDocument.load(v.bytes)).getPageCount()).toBe(v.pageCount);
    }
  });

  it('does not split a document across volumes when it fits in one', () => {
    const where = new Map<string, Set<string>>();
    for (const v of result.plan.volumes) for (const p of v.pages) where.set(p.docId!, (where.get(p.docId!) ?? new Set()).add(v.letter));
    for (const s of where.values()) expect(s.size).toBe(1);
  });

  it('stamps every content page top-right with consecutive numbers across volumes', () => {
    const all: string[] = [];
    result.volumes.forEach((v, vi) => {
      const t = texts[vi];
      for (let k = v.indexPages; k < t.length; k++) all.push(stampOf(t[k]) ?? `MISSING@${v.letter}${k}`);
      for (let k = 0; k < v.indexPages; k++) expect(stampOf(t[k])).toBeUndefined();
    });
    expect(all).toEqual(all.map((_, i) => String(i + 1)));
    expect(result.plan.volumes.flatMap((v) => v.pages.map((p) => p.label))).toEqual(all);
  });

  it('puts the right source page behind every number', () => {
    let checked = 0;
    result.plan.volumes.forEach((v, vi) => {
      v.pages.forEach((p, k) => {
        const key = keyOfFile.get(p.fileId!);
        if (key === 'SCAN' || key === 'PHOTO') return; // images: no text layer
        expect(texts[vi][result.volumes[vi].indexPages + k].text).toContain(`[${key} p${p.srcIndex! + 1}]`);
        checked++;
      });
    });
    expect(checked).toBeGreaterThan(300);
  });

  it('normalises every page to A4 and keeps landscape pages upright', () => {
    for (const t of texts) for (const p of t) {
      const dims = [Math.round(p.w), Math.round(p.h)].sort();
      expect(dims).toEqual([595, 842]);
    }
    const all = texts.flat();
    for (const marker of ['[SCHED p1]', '[SCHED p2]', '[SCHED p3]', '[SCHED p4]']) {
      const page = all.find((p) => p.text.includes(marker))!;
      const item = page.items.find((i) => marker.includes(i.str) || i.str.includes(marker.slice(1, -1)) || page.text.includes(marker))!;
      expect(item.a).toBeGreaterThan(0);
      expect(Math.abs(item.b)).toBeLessThan(1e-6);
    }
    const p3 = all.find((p) => p.text.includes('[SCHED p3]'))!;
    expect(p3.w).toBeGreaterThan(p3.h); // shown as landscape
  });

  it('keeps the stamp clear: content in the corner is shrunk out of the way, and reported', () => {
    const min1 = texts.flat().find((p) => p.text.includes('[MIN p1]'))!;
    const inZone = min1.items.filter((t) => t.x > min1.w - 132 && t.y > min1.h - 40);
    expect(inZone.map((t) => t.str)).toEqual([stampOf(min1)]);
    const shrunk = result.warnings.filter((w) => w.code === 'shrunk-for-stamp');
    expect(shrunk.map((w) => w.message).join(' ')).toMatch(/Board minutes.*159–160/);
    expect(shrunk.some((w) => w.message.includes('Signed agreement'))).toBe(true);
  });

  it('flags image-only pages and content at the edge', () => {
    const img = result.warnings.filter((w) => w.code === 'image-only').map((w) => w.message).join(' ');
    expect(img).toContain('Signed agreement (scan)');
    expect(result.warnings.find((w) => w.code === 'edge-content')?.pages).toEqual(['163']);
  });

  it('keeps transcripts out of the main bundle', () => {
    const tx = project.docs.find((d) => d.type === 'transcript')!;
    expect(result.plan.volumes.some((v) => v.pages.some((p) => p.docId === tx.id))).toBe(false);
    expect(result.plan.deferredDocIds).toEqual([tx.id]);
  });

  it('sets PDF page labels to the stamped numbers', async () => {
    const doc = await PDFDocument.load(result.volumes[1].bytes);
    const nums = doc.catalog.lookup(PDFName.of('PageLabels'), PDFDict).lookup(PDFName.of('Nums'), PDFArray);
    const st = (nums.lookup(3, PDFDict).get(PDFName.of('St')) as PDFNumber).asNumber();
    expect(st).toBe(Number(result.volumes[1].firstLabel));
  });
});

describe('index, hyperlinks and bookmarks', () => {
  it('index rows show page ranges that match the stamps, and each link lands on the first page', async () => {
    for (const [vi, v] of result.volumes.entries()) {
      const doc = await PDFDocument.load(v.bytes);
      const entries = result.plan.volumes[vi].rows.filter((r) => r.kind === 'doc');
      const links = Array.from({ length: v.indexPages }, (_, k) => linksOn(doc, k)).flat();
      expect(links.length).toBe(entries.length);
      const indexText = texts[vi].slice(0, v.indexPages).map((p) => p.text).join(' ');
      entries.forEach((e, n) => {
        if (e.kind !== 'doc') return;
        const range = e.firstLabel === e.lastLabel ? e.firstLabel : `${e.firstLabel}–${e.lastLabel}`;
        expect(indexText).toContain(range);
        expect(stampOf(texts[vi][links[n].target!])).toBe(e.firstLabel);
        expect(stampOf(texts[vi][links[n].target! + e.count - 1])).toBe(e.lastLabel);
      });
    }
  });

  it('bookmarks show the page number and land on that page', async () => {
    for (const [vi, v] of result.volumes.entries()) {
      const doc = await PDFDocument.load(v.bytes);
      const items = outline(doc);
      expect(items[0].title).toBe(`Bundle ${v.letter} (pp. ${v.firstLabel}–${v.lastLabel})`);
      expect(items[1]).toMatchObject({ title: 'Index', page: 0, depth: 1 });
      const docs = items.filter((i) => /— p\. /.test(i.title));
      expect(docs.length).toBe(result.plan.volumes[vi].rows.filter((r) => r.kind === 'doc').length);
      for (const b of docs) {
        const label = b.title.split('— p. ')[1];
        expect(stampOf(texts[vi][b.page])).toBe(label);
      }
    }
  });

  it('master index links point into the right volume file and page', async () => {
    const doc = await PDFDocument.load(result.masterIndex!.bytes);
    const links = Array.from({ length: doc.getPageCount() }, (_, k) => linksOn(doc, k)).flat();
    const entries = result.plan.volumes.flatMap((v) => v.rows.filter((r) => r.kind === 'doc').map((r) => ({ r, v })));
    expect(links.length).toBe(entries.length);
    links.forEach((l, n) => {
      const vi = result.volumes.findIndex((v) => v.fileName === l.remote!.file);
      expect(vi).toBeGreaterThanOrEqual(0);
      const e = entries[n].r;
      if (e.kind === 'doc') expect(stampOf(texts[vi][l.remote!.page])).toBe(e.firstLabel);
    });
  });

  it('names output files "<Action No> <Short title> Bundle A.pdf" with the slash made file-safe', () => {
    expect(result.volumes.map((v) => v.fileName)).toEqual(['HCA 1234-2025 Chan v Wong Bundle A.pdf', 'HCA 1234-2025 Chan v Wong Bundle B.pdf']);
    expect(safeFileName('HCA 1234/2025: A*B?')).toBe('HCA 1234-2025 AB');
  });

  it('rebuilds byte-for-byte identically from the same inputs', async () => {
    const again = await buildBundle({ project, sources, analysis, date: FIXED });
    expect(Buffer.from(again.volumes[0].bytes).equals(Buffer.from(result.volumes[0].bytes))).toBe(true);
  });
});

describe('options', () => {
  it('splits a document only when it alone exceeds the limit', async () => {
    const p = variant((x) => { x.settings.maxPagesPerVolume = 60; });
    const r = await buildBundle({ project: p, sources, date: FIXED });
    for (const v of r.volumes) expect(v.pageCount).toBeLessThanOrEqual(60);
    const split = r.warnings.filter((w) => w.code === 'doc-split').map((w) => w.message);
    expect(split.join(' ')).toMatch(/Bank statements/);
    expect(split.join(' ')).toMatch(/Board minutes/);
    expect(split.join(' ')).toMatch(/Expert report/);
    expect(split.join(' ')).not.toMatch(/Writ|Statement of Claim/);
    const labels = r.plan.volumes.flatMap((v) => v.pages.map((x) => x.label));
    expect(labels).toEqual(labels.map((_, i) => String(i + 1)));
  });

  it('restarts numbering per volume with a prefix (A1…, B1…)', async () => {
    const p = variant((x) => { x.settings.numbering = 'per-volume'; });
    const r = await buildBundle({ project: p, sources, date: FIXED });
    expect(r.volumes.map((v) => [v.firstLabel, v.lastLabel])).toEqual([['A1', 'A248'], ['B1', 'B73']]);
    const t = await readText(r.volumes[1].bytes);
    expect(stampOf(t[r.volumes[1].indexPages])).toBe('B1');
  });

  it('numbers per section with sections on (Bates style)', async () => {
    const p = variant((x) => {
      x.settings.sectionsEnabled = true;
      x.settings.numbering = 'per-section';
      x.sections = [{ id: 's1', letter: 'A', title: 'Pleadings' }, { id: 's2', letter: 'B', title: 'Documents' }];
      x.docs.forEach((d) => { d.sectionId = /Writ|Claim/.test(d.description) ? 's1' : 's2'; });
    });
    const r = await buildBundle({ project: p, sources, date: FIXED });
    const labels = r.plan.volumes.flatMap((v) => v.pages.map((x) => x.label));
    expect(labels.slice(0, 29)).toEqual([...Array.from({ length: 28 }, (_, i) => `A${i + 1}`), 'B1']);
    const t = await readText(r.volumes[0].bytes);
    expect(t[0].text).toContain('Section A Pleadings');
    expect(t[r.volumes[1].indexPages > 0 ? 0 : 0].text).toBeTruthy();
    const t2 = await readText(r.volumes[1].bytes);
    expect(t2[0].text).toContain('Section B Documents (continued)');
  });

  it('warns when the order is not chronological', async () => {
    const p = variant((x) => { [x.docs[0], x.docs[1]] = [x.docs[1], x.docs[0]]; });
    const r = await buildBundle({ project: p, sources, date: FIXED });
    expect(r.warnings.some((w) => w.code === 'not-chronological' && w.message.includes('Writ of Summons'))).toBe(true);
  });

  it('flags non-compliant numbering settings', async () => {
    const p = variant((x) => { x.settings.stamp.position = 'bottom-centre'; x.settings.maxPagesPerVolume = 300; });
    const r = await buildBundle({ project: p, sources, date: FIXED });
    const msgs = r.warnings.filter((w) => w.code === 'non-compliant-setting').map((w) => w.message).join(' ');
    expect(msgs).toMatch(/top right-hand corner/);
    expect(msgs).toMatch(/250 pages/);
  });

  it('adds a blank page after odd-length documents in printable mode, keeping numbers consistent', async () => {
    const p = variant((x) => { x.settings.printable = true; });
    const r = await buildBundle({ project: p, sources, date: FIXED });
    const v = r.plan.volumes[0];
    const letter = v.rows.find((e) => e.kind === 'doc' && e.count === 3)!;
    expect(v.pages[(letter as any).first + 3].kind).toBe('blank');
  });
});

describe('lodging deadline (PD 5.6 para 8)', () => {
  it('skips the weekend', () => {
    const r = lodgingDeadline('2026-03-09'); // Monday
    expect(r.cutoffDate).toBe('2026-03-04');
    expect(r.lastLodgingDay).toBe('2026-03-03');
    expect(r.excluded.map((e) => e.date)).toEqual(['2026-03-08', '2026-03-07']);
  });

  it('skips Easter and Ching Ming general holidays', () => {
    const r = lodgingDeadline('2026-04-08');
    expect(r.cutoffDate).toBe('2026-03-31');
    expect(r.lastLodgingDay).toBe('2026-03-30');
    expect(r.excluded.map((e) => e.date)).toEqual(['2026-04-07', '2026-04-06', '2026-04-05', '2026-04-04', '2026-04-03']);
    expect(describeDeadline(r)).toBe('Lodge by close of business on Monday 30/03/2026 (the 72 hours run out at 00:00 on Tuesday 31/03/2026).');
  });

  it('skips a holiday that falls before the cut-off when finding the last lodging day', () => {
    // Hearing Mon 2026-10-05. Count back: Fri 2 (1), Thu 1 Oct is National Day (skip), Wed 30 Sep (2), Tue 29 (3).
    const r = lodgingDeadline('2026-10-05');
    expect(r.cutoffDate).toBe('2026-09-29');
    expect(r.lastLodgingDay).toBe('2026-09-28');
  });

  it('refuses dates outside the holiday data rather than guessing', () => {
    expect(() => lodgingDeadline('2028-01-10')).toThrow(/No Hong Kong general holiday data/);
  });
});

describe('file-name parsing', () => {
  it.each([
    ['2024-03-15 Letter to D.pdf', '2024-03-15', 'Letter to D'],
    ['20240315_Letter.pdf', '2024-03-15', 'Letter'],
    ['15.03.2024 - Board minutes.pdf', '2024-03-15', 'Board minutes'],
    ['15 March 2024 Witness statement of Chan.pdf', '2024-03-15', 'Witness statement of Chan'],
    ['3rd Sept 2024 email.pdf', '2024-09-03', 'email'],
    ['2024-02-30 Not a date.pdf', null, '2024-02-30 Not a date'],
    ['Letter to D (copy).pdf', null, 'Letter to D (copy)'],
  ])('%s', (name, date, title) => {
    expect(parseFileName(name)).toEqual({ date, title });
  });
});

describe('fixtures', () => {
  it('include every case the brief asks for', async () => {
    const names = await readdir(FIXTURE_DIR);
    expect(names.length).toBe(MAIN_SET.length);
    expect(project.files.reduce((a, f) => a + f.pageCount, 0)).toBeGreaterThan(300);
  });
});
