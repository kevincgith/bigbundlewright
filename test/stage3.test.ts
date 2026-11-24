// Big Bundle Wright: stage 3 tests: core bundle, transcripts, issue + 88-1 inserts,
// typed copies, project save/load.
// SPDX-License-Identifier: MPL-2.0

import { cp, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadProjectSources } from '../cli/node-support.ts';
import {
  buildBundle, freezeProject, matchSources, parseProject, planProject, serializeProject, ProjectError, SourceError,
  type BuildOutput, type BundleDoc, type Project,
} from '../src/engine/index.ts';
import { FIXTURE_DIR } from './fixtures/generate.ts';
import { FIXED, addExtra, allLinks, markerToStamp, outline, readText, setupBase, stampOf, type Base } from './helpers.ts';

let base: Base;
let project: Project;
let baseResult: BuildOutput;
let baseMarkers: Map<string, string>;

const build = (p: Project, issue = false) => buildBundle({ project: p, sources: base.sources, analysis: base.analysis, date: FIXED, issue });
const docBy = (p: Project, desc: string) => p.docs.find((d) => d.description === desc)!;
const mainOf = (r: BuildOutput) => r.volumes.filter((v) => v.kind === 'main');
async function markers(r: BuildOutput, kind: 'main' | 'core' | 'transcripts' = 'main') {
  const vols = r.volumes.filter((v) => v.kind === kind);
  return markerToStamp(vols, await Promise.all(vols.map((v) => readText(v.bytes))));
}
function newDoc(id: string, fileId: string, description: string, date: string | null, extra: Partial<BundleDoc> = {}): BundleDoc {
  return { id, fileId, description, date, type: 'document', status: 'authentic', core: false, ...extra };
}

beforeAll(async () => {
  base = await setupBase();
  project = base.project;
  for (const k of ['LATE', 'LATE2', 'TYPED', 'FURTHER', 'TX2']) await addExtra(base, structuredClone(project), k);
  baseResult = await build(project);
  baseMarkers = await markers(baseResult);
}, 180_000);

/** Project copy with extra fixture files registered. */
function withFiles(p: Project, ...keys: string[]): Project {
  const q = structuredClone(p);
  for (const k of keys) {
    const src = base.sources.get(`x-${k}`)!;
    if (!q.files.some((f) => f.id === src.ref.id)) q.files.push(src.ref);
  }
  return q;
}

describe('core bundle (PD 5.6 para 2)', () => {
  it('prompts for core documents when the bundle exceeds 100 pages', () => {
    expect(baseResult.warnings.find((w) => w.code === 'core-bundle-needed')?.message).toMatch(/321 pages.*100 pages/);
  });

  it('builds a core bundle with its own pagination and cross-references to the main bundle', async () => {
    const p = structuredClone(project);
    for (const d of ['Writ of Summons', 'Letter to D', 'Expert report']) docBy(p, d).core = true;
    const r = await build(p);
    const core = r.volumes.filter((v) => v.kind === 'core');
    expect(core.map((v) => v.fileName)).toEqual(['HCA 1234-2025 Chan v Wong Core Bundle.pdf']);
    expect([core[0].firstLabel, core[0].lastLabel]).toEqual(['C1', 'C81']);
    expect(r.warnings.some((w) => w.code === 'core-bundle-needed')).toBe(false);

    const t = await readText(core[0].bytes);
    const prelim = t.slice(0, core[0].prelimPages).map((x) => x.text).join(' ');
    expect(prelim).toContain('CORE BUNDLE');
    expect(prelim).toContain('STATUS OF DOCUMENTS');
    for (const ref of ['A 1–8', 'A 29–31', 'B 249–318']) expect(prelim).toContain(ref);
    expect(prelim).toContain('C1–C8');
    expect(prelim).toMatch(/\(1\) Deemed authentic.*Nos. 1–3 C1–C81/); // ranges merged on the front sheet
    expect(prelim).toContain('C12–C81');

    const m = markerToStamp(core, [t]);
    expect(m.get('WRIT p1')).toBe('C1');
    expect(m.get('LTR p3')).toBe('C11');
    expect(m.get('EXP p70')).toBe('C81');
    // Core links land on their pages.
    const links = await allLinks(core[0].bytes);
    expect(links.map((l) => stampOf(t[l.target!]))).toEqual(['C1', 'C9', 'C12']);
    // Tagging core documents leaves the main bundle's numbering alone.
    expect(await markers(r)).toEqual(baseMarkers);
  });

  it('avoids a prefix clash with per-volume letters (C… → CB…)', async () => {
    const p = structuredClone(project);
    p.settings.numbering = 'per-volume';
    p.settings.maxPagesPerVolume = 100;
    docBy(p, 'Writ of Summons').core = true;
    const r = await build(p);
    expect(r.plan.main.volumes.map((v) => v.letter)).toContain('C');
    expect(r.volumes.find((v) => v.kind === 'core')!.firstLabel).toBe('CB1');
  });
});

describe('transcript bundle (PD 5.6 paras 4-5)', () => {
  it('outputs transcripts as their own bundle numbered T1…', async () => {
    const tx = baseResult.volumes.filter((v) => v.kind === 'transcripts');
    expect(tx.map((v) => v.fileName)).toEqual(['HCA 1234-2025 Chan v Wong Transcript Bundle.pdf']);
    expect([tx[0].firstLabel, tx[0].lastLabel]).toEqual(['T1', 'T12']);
    expect(tx[0].frontSheetPages).toBe(0);
    const m = await markers(baseResult, 'transcripts');
    expect(m.get('TX1 p1')).toBe('T1');
    expect(m.get('TX1 p12')).toBe('T12');
    expect(baseResult.plan.main.volumes.some((v) => v.pages.some((p) => base.keyOfFile.get(p.fileId!) === 'TX1'))).toBe(false);
  });
});

describe('typed copies (PD 5.6 para 6)', () => {
  it('before issue: interleaves the typed copy after the page and numbers it normally', async () => {
    const p = withFiles(project, 'TYPED');
    docBy(p, 'Signed agreement (scan)').typedCopies = [{ afterPage: 1, fileId: 'x-TYPED' }];
    const r = await build(p);
    const m = await markers(r);
    expect(m.get('TYPED p1')).toBe('37');
    expect(m.get('BANK p1')).toBe('40'); // everything after shifts by one before issue
    const row = r.plan.main.volumes[0].rows.find((x) => x.kind === 'doc' && x.docId === docBy(p, 'Signed agreement (scan)').id)!;
    expect(row).toMatchObject({ firstLabel: '36', lastLabel: '38' });
  });

  it('rejects a typed copy set after a page that does not exist', async () => {
    const p = withFiles(project, 'TYPED');
    docBy(p, 'Signed agreement (scan)').typedCopies = [{ afterPage: 5, fileId: 'x-TYPED' }];
    await expect(build(p)).rejects.toThrow(/after page 5, but the document has 2/);
  });
});

describe('issue and additional documents (PD 5.6 para 1)', () => {
  let issued: Project;
  beforeAll(async () => {
    const r = await build(project, true);
    issued = r.issuedProject!;
  });

  it('issuing records the layout and file hashes', () => {
    expect(issued.frozen?.issuedAt).toBe(FIXED.toISOString());
    expect(Object.keys(issued.frozen!.fileHashes).length).toBeGreaterThan(5);
    expect(issued.frozen!.bundles.main!.volumes.length).toBe(2);
    expect(issued.frozen!.bundles.transcripts!.volumes.length).toBe(1);
  });

  it('inserts late documents as 88-1, 88-2… without changing any existing number', async () => {
    const p = withFiles(issued, 'LATE', 'LATE2');
    p.docs.push(newDoc('late1', 'x-LATE', 'Late letter', '2024-04-15', { insertAfter: '88' }));
    p.docs.push(newDoc('late2', 'x-LATE2', 'Second late letter', '2024-04-20', { insertAfter: '88' }));
    const r = await build(p);
    const m = await markers(r);
    for (const [k, v] of baseMarkers) expect(m.get(k)).toBe(v);
    expect(['LATE p1', 'LATE p2', 'LATE p3', 'LATE2 p1', 'LATE2 p2'].map((k) => m.get(k))).toEqual(['88-1', '88-2', '88-3', '88-4', '88-5']);

    const vA = r.plan.main.volumes[0];
    const at = vA.pages.findIndex((x) => x.label === '88');
    expect(vA.pages.slice(at, at + 7).map((x) => x.label)).toEqual(['88', '88-1', '88-2', '88-3', '88-4', '88-5', '89']);

    // Index rows and links.
    const A = mainOf(r)[0];
    const t = await readText(A.bytes);
    const index = t.slice(A.frontSheetPages, A.prelimPages).map((x) => x.text).join(' ');
    expect(index).toMatch(/7-1 15\/04\/2024 Late letter Authentic 88-1–88-3/);
    expect(index).toMatch(/7-2 20\/04\/2024 Second late letter Authentic 88-4–88-5/);
    expect(index).toContain('39–158'); // bank statements' range unchanged
    const links = await allLinks(A.bytes);
    expect(links.map((l) => stampOf(t[l.target!]))).toContain('88-1');
    const bm = outline(await PDFDocument.load(A.bytes)).find((b) => b.title.startsWith('7-1.'))!;
    expect(bm.title).toBe('7-1. Late letter (15/04/2024) — p. 88-1');
    expect(stampOf(t[bm.page])).toBe('88-1');

    // Volume A is now over the limit: warned, not renumbered.
    expect(r.warnings.find((w) => w.code === 'volume-over-limit')?.message).toMatch(/Bundle A has 255 pages/);
  });

  it('continues the -n sequence after re-issue', async () => {
    const p = withFiles(issued, 'LATE', 'FURTHER');
    p.docs.push(newDoc('late1', 'x-LATE', 'Late letter', '2024-04-15', { insertAfter: '88' }));
    const r1 = await build(p, true);
    const p2 = withFiles(r1.issuedProject!, 'FURTHER');
    p2.docs.push(newDoc('fur', 'x-FURTHER', 'Further document', '2024-04-16', { insertAfter: '88' }));
    const m = await markers(await build(p2));
    expect([m.get('LATE p3'), m.get('FURTHER p1'), m.get('FURTHER p2')]).toEqual(['88-3', '88-4', '88-5']);
  });

  it('refuses an insert after an inserted page or a page that does not exist', async () => {
    const p = withFiles(issued, 'LATE');
    p.docs.push(newDoc('late1', 'x-LATE', 'Late letter', '2024-04-15', { insertAfter: '88-1' }));
    await expect(build(p)).rejects.toThrow(/after page 88-1, which is itself an inserted page/);
    p.docs[p.docs.length - 1].insertAfter = '9999';
    await expect(build(p)).rejects.toThrow(ProjectError);
  });

  it('adds a typed copy after issue as 36-1', async () => {
    const p = withFiles(issued, 'TYPED');
    docBy(p, 'Signed agreement (scan)').typedCopies = [{ afterPage: 1, fileId: 'x-TYPED' }];
    const r = await build(p);
    const m = await markers(r);
    expect(m.get('TYPED p1')).toBe('36-1');
    for (const [k, v] of baseMarkers) expect(m.get(k)).toBe(v);
    const labels = r.plan.main.volumes[0].pages.map((x) => x.label);
    expect(labels.slice(labels.indexOf('36'), labels.indexOf('36') + 3)).toEqual(['36', '36-1', '37']);
  });

  it('appends a new document with no insert point at the end, continuing the numbers', async () => {
    const p = withFiles(issued, 'FURTHER');
    p.docs.push(newDoc('fur', 'x-FURTHER', 'Further document', '2024-08-01'));
    const r = await build(p);
    const m = await markers(r);
    expect([m.get('FURTHER p1'), m.get('FURTHER p2')]).toEqual(['322', '323']);
    expect(r.warnings.find((w) => w.code === 'appended-after-issue')?.message).toMatch(/placed at the end \(pages 322–323\)/);
    expect(r.plan.main.volumes[1].rows.at(-1)).toMatchObject({ tab: '11', firstLabel: '322' });
  });

  it('puts a late transcript at the end of the transcript bundle', async () => {
    const p = withFiles(issued, 'TX2');
    p.docs.push(newDoc('tx2', 'x-TX2', 'Transcript Day 2', '2024-07-02', { type: 'transcript' }));
    const r = await build(p);
    const m = await markers(r, 'transcripts');
    expect([m.get('TX2 p1'), m.get('TX2 p5')]).toEqual(['T13', 'T17']);
  });

  it('refuses to remove a document, or use a changed file, after issue', async () => {
    const p = structuredClone(issued);
    p.docs = p.docs.filter((d) => d.description !== 'Letter to D');
    await expect(build(p)).rejects.toThrow(/"Letter to D" is in the issued bundle but has been removed/);
    const q = structuredClone(issued);
    q.files[0].sha256 = 'f'.repeat(64);
    await expect(planProject(q)).rejects.toThrow(/different content from the version in the issued bundle/);
  });

  it('keeps the core bundle numbering locked too', async () => {
    const p0 = structuredClone(project);
    docBy(p0, 'Writ of Summons').core = true;
    const r0 = await build(p0, true);
    const p = withFiles(r0.issuedProject!, 'LATE');
    p.docs.push(newDoc('late1', 'x-LATE', 'Late letter', '2024-04-15', { insertAfter: '88', core: true }));
    const r = await build(p);
    const m = await markers(r, 'core');
    expect(m.get('WRIT p8')).toBe('C8');
    expect(m.get('LATE p1')).toBe('C9');
    expect(r.warnings.some((w) => w.code === 'appended-after-issue' && /Core Bundle pages C9–C11/.test(w.message))).toBe(true);
  });
});

describe('project save and load', () => {
  it('round-trips, including an issued layout, and rebuilds byte-for-byte', async () => {
    const r0 = await build(project, true);
    const p = withFiles(r0.issuedProject!, 'LATE');
    p.docs.push(newDoc('late1', 'x-LATE', 'Late letter', '2024-04-15', { insertAfter: '88' }));
    const text = serializeProject(p);
    expect(text).not.toMatch(/%PDF|JVBER/); // no document content
    const { project: loaded, warnings } = parseProject(text);
    expect(warnings).toEqual([]);
    expect(loaded).toEqual(p);
    const a = await build(p);
    const b = await build(loaded);
    for (let i = 0; i < a.volumes.length; i++) expect(Buffer.from(a.volumes[i].bytes).equals(Buffer.from(b.volumes[i].bytes))).toBe(true);
  });

  it('fills in settings missing from older files', () => {
    const raw = JSON.parse(serializeProject(project));
    delete raw.settings.frontSheet;
    delete raw.settings.stamp.size;
    const { project: p } = parseProject(JSON.stringify(raw));
    expect(p.settings.frontSheet).toBe(true);
    expect(p.settings.stamp.size).toBe('M');
  });

  it('rejects broken files with a clear message', () => {
    expect(() => parseProject('{not json')).toThrow(/not a valid project file/);
    expect(() => parseProject('{"schema":"something-else"}')).toThrow(/not a Big Bundle Wright project file/);
    const raw = JSON.parse(serializeProject(project));
    raw.docs[0].fileId = 'nope';
    expect(() => parseProject(JSON.stringify(raw))).toThrow(/"Writ of Summons" refers to a file that is not in the project/);
    raw.docs[0].fileId = project.docs[0].fileId;
    raw.docs[0].date = '2024-13-01';
    expect(() => parseProject(JSON.stringify(raw))).toThrow(/invalid date "2024-13-01"/);
  });

  it('matches re-added files by content: renamed found, changed flagged, missing listed', () => {
    const [f1, f2, f3] = project.files;
    const m = matchSources([f1, f2, f3], [
      { name: 'renamed.pdf', sha256: f1.sha256 },
      { name: f2.name, sha256: 'e'.repeat(64) },
    ]);
    expect(m.matched.get(f1.id)).toBe(0);
    expect(m.renamed).toEqual([{ file: f1, as: 'renamed.pdf' }]);
    expect(m.changed.map((c) => c.file.id)).toEqual([f2.id]);
    expect(m.missing.map((f) => f.id)).toEqual([f3.id]);
  });

  it('CLI loader finds a renamed file and refuses a changed one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bbw-io-'));
    try {
      await cp(FIXTURE_DIR, dir, { recursive: true });
      await rename(join(dir, '2024-03-15 Letter to D.pdf'), join(dir, 'letter renamed.pdf'));
      const { sources, notes } = await loadProjectSources(project, dir);
      expect(sources.size).toBe(project.files.length);
      expect(notes.join(' ')).toMatch(/found as "letter renamed.pdf"/);
      await writeFile(join(dir, '2024-01-10 Writ of Summons.pdf'), (await PDFDocument.create().then(async (d) => { d.addPage(); return d.save(); })));
      const err = await loadProjectSources(project, dir).catch((e) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect(err.message).toMatch(/"2024-01-10 Writ of Summons.pdf" does not match the file used before/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('freezeProject', () => {
  it('only records hashes for files the bundle uses', async () => {
    const p = withFiles(project, 'LATE'); // registered but unused
    const plan = await planProject(p);
    const f = freezeProject(p, plan, FIXED.toISOString());
    expect(f.frozen!.fileHashes['x-LATE']).toBeUndefined();
  });
});
