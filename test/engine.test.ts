// Big Bundle Wright: engine tests (PD 5.6 checks on real generated PDFs).
// SPDX-License-Identifier: MPL-2.0

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildBundle, describeDeadline, loadSource, lodgingDeadline, parseFileName, safeFileName, SourceError,
  type BuildOutput, type BuiltVolume, type Project,
} from '../src/engine/index.ts';
import { BAD_DIR, FIXTURE_DIR, MAIN_SET } from './fixtures/generate.ts';
import { FIXED, linksOn, outline, readText, setupBase, stampOf, type Base, type PageText } from './helpers.ts';

let base: Base;
let project: Project;
let result: BuildOutput;
let main: BuiltVolume[];
let texts: PageText[][];

function variant(mut: (p: Project) => void): Project {
  const p = structuredClone(project);
  mut(p);
  return p;
}
const build = (p: Project) => buildBundle({ project: p, sources: base.sources, analysis: base.analysis, date: FIXED });

beforeAll(async () => {
  base = await setupBase();
  project = base.project;
  result = await build(project);
  main = result.volumes.filter((v) => v.kind === 'main');
  texts = await Promise.all(main.map((v) => readText(v.bytes)));
}, 180_000);

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
    const photo = [...base.sources.values()].find((s) => s.ref.name.endsWith('.jpg'))!;
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
    expect(main.length).toBe(2);
    for (const v of main) {
      expect(v.pageCount).toBeLessThanOrEqual(250);
      expect((await PDFDocument.load(v.bytes)).getPageCount()).toBe(v.pageCount);
    }
  });

  it('does not split a document across volumes when it fits in one', () => {
    const where = new Map<string, Set<string>>();
    for (const v of result.plan.main.volumes) for (const p of v.pages) where.set(p.docId!, (where.get(p.docId!) ?? new Set()).add(v.letter));
    for (const s of where.values()) expect(s.size).toBe(1);
  });

  it('stamps every content page top-right with consecutive numbers across volumes; front pages unnumbered', () => {
    const all: string[] = [];
    main.forEach((v, vi) => {
      const t = texts[vi];
      for (let k = v.prelimPages; k < t.length; k++) all.push(stampOf(t[k]) ?? `MISSING@${v.letter}${k}`);
      for (let k = 0; k < v.prelimPages; k++) expect(stampOf(t[k])).toBeUndefined();
    });
    expect(all).toEqual(all.map((_, i) => String(i + 1)));
    expect(result.plan.main.volumes.flatMap((v) => v.pages.map((p) => p.label))).toEqual(all);
  });

  it('puts the right source page behind every number', () => {
    let checked = 0;
    result.plan.main.volumes.forEach((v, vi) => {
      v.pages.forEach((p, k) => {
        const key = base.keyOfFile.get(p.fileId!);
        if (key === 'SCAN' || key === 'PHOTO') return; // images: no text layer
        expect(texts[vi][main[vi].prelimPages + k].text).toContain(`[${key} p${p.srcIndex! + 1}]`);
        checked++;
      });
    });
    expect(checked).toBeGreaterThan(300);
  });

  it('normalises every page to A4 and keeps landscape pages upright', () => {
    for (const t of texts) for (const p of t) expect([Math.round(p.w), Math.round(p.h)].sort()).toEqual([595, 842]);
    const all = texts.flat();
    for (const marker of ['SCHED p1', 'SCHED p2', 'SCHED p3', 'SCHED p4']) {
      const page = all.find((p) => p.text.includes(`[${marker}]`))!;
      const item = page.items.find((i) => i.str.includes(marker))!;
      expect(item.a).toBeGreaterThan(0);
      expect(Math.abs(item.b)).toBeLessThan(1e-6);
    }
    const p3 = all.find((p) => p.text.includes('[SCHED p3]'))!;
    expect(p3.w).toBeGreaterThan(p3.h);
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

  it('sets PDF page labels to the stamped numbers', async () => {
    const doc = await PDFDocument.load(main[1].bytes);
    const nums = doc.catalog.lookup(PDFName.of('PageLabels'), PDFDict).lookup(PDFName.of('Nums'), PDFArray);
    // [0 Status, 1 Index, 2 first content]
    const st = (nums.lookup(5, PDFDict).get(PDFName.of('St')) as PDFNumber).asNumber();
    expect(st).toBe(Number(main[1].firstLabel));
  });
});

describe('index, front sheet, hyperlinks and bookmarks', () => {
  it('front sheet comes first and states each status category (PD 5.6 para 3)', () => {
    for (const [vi, v] of main.entries()) {
      expect(v.frontSheetPages).toBe(1);
      const t = texts[vi][0].text;
      expect(t).toContain('STATUS OF DOCUMENTS');
      expect(t).toContain('(1) Deemed authentic');
      expect(t).toContain('(2) Agreed for inclusion only');
      expect(t).toContain('(3) Also agreed as evidence of contents');
    }
    expect(texts[0][0].text).toMatch(/Nos\. 1–8 1–248/); // adjacent ranges merged
  });

  it('index rows show page ranges that match the stamps, and each link lands on the first page', async () => {
    for (const [vi, v] of main.entries()) {
      const doc = await PDFDocument.load(v.bytes);
      const entries = result.plan.main.volumes[vi].rows.filter((r) => r.kind === 'doc');
      const links = Array.from({ length: v.prelimPages }, (_, k) => linksOn(doc, k)).flat();
      expect(links.length).toBe(entries.length);
      const indexText = texts[vi].slice(v.frontSheetPages, v.prelimPages).map((p) => p.text).join(' ');
      entries.forEach((e, n) => {
        if (e.kind !== 'doc') return;
        expect(indexText).toContain(e.firstLabel === e.lastLabel ? e.firstLabel : `${e.firstLabel}–${e.lastLabel}`);
        expect(stampOf(texts[vi][links[n].target!])).toBe(e.firstLabel);
        expect(stampOf(texts[vi][links[n].target! + e.count - 1])).toBe(e.lastLabel);
      });
    }
  });

  it('bookmarks show the page number and land on that page', async () => {
    for (const [vi, v] of main.entries()) {
      const items = outline(await PDFDocument.load(v.bytes));
      expect(items[0].title).toBe(`Bundle ${v.letter} (pp. ${v.firstLabel}–${v.lastLabel})`);
      expect(items[1]).toMatchObject({ title: 'Status of documents', page: 0, depth: 1 });
      expect(items[2]).toMatchObject({ title: 'Index', page: 1, depth: 1 });
      const docs = items.filter((i) => /— p\. /.test(i.title));
      expect(docs.length).toBe(result.plan.main.volumes[vi].rows.filter((r) => r.kind === 'doc').length);
      for (const b of docs) expect(stampOf(texts[vi][b.page])).toBe(b.title.split('— p. ')[1]);
    }
  });

  it('master index links point into the right volume file and page', async () => {
    const doc = await PDFDocument.load(result.masterIndex!.bytes);
    const links = Array.from({ length: doc.getPageCount() }, (_, k) => linksOn(doc, k)).flat();
    const entries = result.plan.main.volumes.flatMap((v) => v.rows.filter((r) => r.kind === 'doc'));
    expect(links.length).toBe(entries.length);
    links.forEach((l, n) => {
      const vi = main.findIndex((v) => v.fileName === l.remote!.file);
      expect(vi).toBeGreaterThanOrEqual(0);
      const e = entries[n];
      if (e.kind === 'doc') expect(stampOf(texts[vi][l.remote!.page])).toBe(e.firstLabel);
    });
  });

  it('names output files "<Action No> <Short title> Bundle A.pdf" with the slash made file-safe', () => {
    expect(main.map((v) => v.fileName)).toEqual(['HCA 1234-2025 Chan v Wong Bundle A.pdf', 'HCA 1234-2025 Chan v Wong Bundle B.pdf']);
    expect(safeFileName('HCA 1234/2025: A*B?')).toBe('HCA 1234-2025 AB');
  });

  it('rebuilds byte-for-byte identically from the same inputs', async () => {
    const again = await build(project);
    expect(Buffer.from(again.volumes[0].bytes).equals(Buffer.from(result.volumes[0].bytes))).toBe(true);
  });
});

describe('options', () => {
  it('splits a document only when it alone exceeds the limit', async () => {
    const r = await build(variant((x) => { x.settings.maxPagesPerVolume = 60; }));
    for (const v of r.volumes) expect(v.pageCount).toBeLessThanOrEqual(60);
    const split = r.warnings.filter((w) => w.code === 'doc-split').map((w) => w.message).join(' ');
    expect(split).toMatch(/Bank statements/);
    expect(split).toMatch(/Board minutes/);
    expect(split).toMatch(/Expert report/);
    expect(split).not.toMatch(/Writ|Statement of Claim/);
    const labels = r.plan.main.volumes.flatMap((v) => v.pages.map((x) => x.label));
    expect(labels).toEqual(labels.map((_, i) => String(i + 1)));
  });

  it('restarts numbering per volume with a prefix (A1…, B1…)', async () => {
    const r = await build(variant((x) => { x.settings.numbering = 'per-volume'; }));
    const m = r.volumes.filter((v) => v.kind === 'main');
    expect(m.map((v) => [v.firstLabel, v.lastLabel])).toEqual([['A1', 'A248'], ['B1', 'B73']]);
    const t = await readText(m[1].bytes);
    expect(stampOf(t[m[1].prelimPages])).toBe('B1');
  });

  it('numbers per section with sections on (Bates style)', async () => {
    const r = await build(variant((x) => {
      x.settings.sectionsEnabled = true;
      x.settings.numbering = 'per-section';
      x.sections = [{ id: 's1', letter: 'A', title: 'Pleadings' }, { id: 's2', letter: 'B', title: 'Documents' }];
      x.docs.forEach((d) => { d.sectionId = /Writ|Claim/.test(d.description) ? 's1' : 's2'; });
    }));
    const labels = r.plan.main.volumes.flatMap((v) => v.pages.map((x) => x.label));
    expect(labels.slice(0, 29)).toEqual([...Array.from({ length: 28 }, (_, i) => `A${i + 1}`), 'B1']);
    const t = await readText(r.volumes[0].bytes);
    expect(t.slice(0, r.volumes[0].prelimPages).map((p) => p.text).join(' ')).toContain('Section A Pleadings');
    const t2 = await readText(r.volumes[1].bytes);
    expect(t2.slice(0, r.volumes[1].prelimPages).map((p) => p.text).join(' ')).toContain('Section B Documents (continued)');
  });

  it('warns when the order is not chronological', async () => {
    const r = await build(variant((x) => { [x.docs[0], x.docs[1]] = [x.docs[1], x.docs[0]]; }));
    expect(r.warnings.some((w) => w.code === 'not-chronological' && w.message.includes('Writ of Summons'))).toBe(true);
  });

  it('flags non-compliant numbering settings', async () => {
    const r = await build(variant((x) => { x.settings.stamp.position = 'bottom-centre'; x.settings.maxPagesPerVolume = 300; }));
    const msgs = r.warnings.filter((w) => w.code === 'non-compliant-setting').map((w) => w.message).join(' ');
    expect(msgs).toMatch(/top right-hand corner/);
    expect(msgs).toMatch(/250 pages/);
  });

  it('adds a blank page after odd-length documents in printable mode', async () => {
    const r = await build(variant((x) => { x.settings.printable = true; }));
    const v = r.plan.main.volumes[0];
    const letter = v.rows.find((e) => e.kind === 'doc' && e.count === 3)!;
    expect(v.pages[(letter as { first: number }).first + 3].kind).toBe('blank');
  });

  it('can turn the front sheet off', async () => {
    const r = await build(variant((x) => { x.settings.frontSheet = false; }));
    expect(r.volumes[0].frontSheetPages).toBe(0);
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

  it('skips a holiday inside the count (National Day)', () => {
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
    expect((await readdir(FIXTURE_DIR)).length).toBe(MAIN_SET.length);
    expect(project.files.reduce((a, f) => a + f.pageCount, 0)).toBeGreaterThan(300);
  });
});
