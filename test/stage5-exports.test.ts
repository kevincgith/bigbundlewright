// Big Bundle Wright: stage 5 exports (Word index, labels, compliance report, ZIP, CLI --zip).
// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';
import { initProject, loadFonts } from '../cli/node-support.ts';
import {
  buildBundle, buildDocxIndexes, buildLabels, complianceReport, complianceReportPdf, exportBundle, parseProject,
  planProject, spineText, labelVolumes, type BuildOutput, type FontBytes, type Project,
} from '../src/engine/index.ts';
import { FIXTURE_DIR, ZH_TEXT } from './fixtures/generate.ts';
import { FIXED, addExtra, readText, setupBase, type Base } from './helpers.ts';

let base: Base;
let fonts: FontBytes;
let built: BuildOutput;

/** Symbols the user does not want in any output (check marks, crosses, emoji). */
const NO_SYMBOLS = /[\u2713-\u2718\u2705\u274c\u274e\u2b50\u2600-\u26ff\u{1f300}-\u{1faff}]/u;

beforeAll(async () => {
  base = await setupBase();
  fonts = await loadFonts();
  built = await buildBundle({ project: base.project, sources: base.sources, analysis: base.analysis, date: FIXED, fonts });
}, 180_000);

async function docxText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml')!.async('string');
  return xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
}

describe('Word index (.docx)', () => {
  it('one per volume (main, core, transcripts) plus the master index, with DD/MM/YYYY dates', async () => {
    const p: Project = structuredClone(base.project);
    p.settings.dateStyle = 'DD Month YYYY'; // the Word index still uses DD/MM/YYYY
    p.docs.find((d) => /Statement of Claim/.test(d.description))!.core = true;
    const plan = await planProject(p, fonts);
    const files = await buildDocxIndexes(p, plan);
    const names = files.map((f) => f.fileName);
    expect(names).toEqual([
      'HCA 1234-2025 Chan v Wong Bundle A Index.docx',
      'HCA 1234-2025 Chan v Wong Bundle B Index.docx',
      'HCA 1234-2025 Chan v Wong Core Bundle Index.docx',
      'HCA 1234-2025 Chan v Wong Transcript Bundle Index.docx',
      'HCA 1234-2025 Chan v Wong Master Index.docx',
    ]);
    const a = await docxText(files[0].bytes);
    expect(a).toContain('HCA 1234/2025');
    expect(a).toContain('IN THE HIGH COURT OF THE');
    expect(a).toContain('BUNDLE A');
    expect(a).toContain('INDEX');
    for (const t of ['No.', 'Date', 'Description', 'Status', 'Page(s)']) expect(a).toContain(t);
    expect(a).toContain('10/01/2024');
    expect(a).toContain('Writ of Summons');
    expect(a).not.toContain('January');
    const core = await docxText(files[2].bytes);
    expect(core).toContain('Main bundle');
    expect(core).toMatch(/A 9–28/);
    const master = await docxText(files[4].bytes);
    expect(master).toContain('MASTER INDEX');
    expect(master).toContain('Board minutes');
    expect(master).toContain('Expert report');
    // A valid Word package.
    const zip = await JSZip.loadAsync(files[0].bytes);
    expect(zip.file('[Content_Types].xml')).toBeTruthy();
    expect(NO_SYMBOLS.test(a + core + master)).toBe(false);
  });

  it('carries Chinese descriptions and bilingual headings', async () => {
    const p: Project = structuredClone(base.project);
    const id = await addExtra(base, p, 'ZH');
    p.docs.push({ id: 'dzh', fileId: id, date: '2024-08-01', description: 'Chinese letter', descriptionZh: ZH_TEXT.title, type: 'correspondence', status: 'authentic', core: false });
    const plan = await planProject(p, fonts);
    const files = await buildDocxIndexes(p, plan, { bilingual: true });
    const all = (await Promise.all(files.map((f) => docxText(f.bytes)))).join('\n');
    expect(all).toContain(ZH_TEXT.title);
    for (const s of ['索引', '總索引', '編號', '日期', '文件描述', '頁碼', '文件冊A']) expect(all).toContain(s);
  });
});

describe('labels', () => {
  it('a spine label per volume, including core and transcript bundles', async () => {
    const p: Project = structuredClone(base.project);
    p.docs.find((d) => /Statement of Claim/.test(d.description))!.core = true;
    const plan = await planProject(p, fonts);
    const vols = labelVolumes(plan);
    expect(vols.map((v) => v.name)).toEqual(['Bundle A', 'Bundle B', 'Core Bundle', 'Transcript Bundle']);
    expect(spineText(p, vols[0])).toMatch(/^Bundle A — HCA 1234\/2025 — pp\. 1–\d+$/);
    expect(spineText(p, vols[3])).toBe('Transcript Bundle — HCA 1234/2025 — pp. T1–T12');
    const l = await buildLabels(p, plan, { fonts, date: FIXED });
    expect(l.fileName).toBe('HCA 1234-2025 Chan v Wong Labels.pdf');
    expect(l.spineLabels).toBe(4);
    expect(l.insideCoverLabels).toBe(0); // 4 files: PD 5.6 para 7 does not apply
    expect(l.pageCount).toBe(2); // 3 spine labels per sheet
    const t = (await readText(l.bytes)).map((x) => x.text.replace(/\s+/g, ' ')).join(' | ');
    for (const v of vols) expect(t.replace(/\s/g, '')).toContain(spineText(p, v).replace(/\s/g, ''));
    expect(t).toContain('Chan v Wong');
    expect(NO_SYMBOLS.test(t)).toBe(false);
  });

  it('adds inside-cover labels when there are more than 5 files (PD 5.6 para 7)', async () => {
    const p: Project = structuredClone(base.project);
    p.settings.maxPagesPerVolume = 60;
    const plan = await planProject(p, fonts);
    expect(plan.physicalFiles).toBeGreaterThan(5);
    const l = await buildLabels(p, plan, { fonts, date: FIXED });
    expect(l.insideCoverLabels).toBe(plan.physicalFiles);
    const t = await readText(l.bytes);
    const coverPages = t.filter((x) => /Inside-cover labels/.test(x.text));
    expect(coverPages.length).toBe(Math.ceil(plan.physicalFiles / 8));
    // The volume letter is drawn large, at the top right of its label.
    const big = coverPages[0].items.filter((i) => i.str === 'A' && i.a > 30);
    expect(big.length).toBe(1);
    expect(big[0].x).toBeGreaterThan(150);
  });

  it('works without the Chinese fonts', async () => {
    const plan = await planProject(base.project);
    const l = await buildLabels(base.project, plan, { date: FIXED });
    const t = (await readText(l.bytes)).map((x) => x.text).join(' ');
    expect(t).toContain('HCA 1234/2025');
  });
});

describe('compliance report', () => {
  it('computes a result for each PD 5.6 check from the build', () => {
    const r = complianceReport(base.project, built, { date: FIXED });
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(r.checks.map((c) => c.para)).toEqual(['1', '1', '2', '3', '4(2)', '4(3)', '4(4)', '5', '5', '6', '7', '8']);
    expect(by['no-duplicates'].status).toBe('warning'); // "Letter to D (copy)"
    expect(by['core-bundle'].status).toBe('warning'); // over 100 pages, no core documents
    expect(by['status-marked'].status).toBe('pass');
    expect(by['chronological'].status).toBe('warning'); // one undated document
    expect(by['numbering'].status).toBe('pass');
    expect(by['legible'].status).toBe('warning'); // the scan and the photo
    expect(by['volume-limit'].status).toBe('pass');
    expect(by['transcripts-separate'].status).toBe('pass');
    expect(by['inside-cover-labels'].status).toBe('not-applicable');
    expect(by['lodging-deadline'].status).toBe('not-applicable');
    expect(r.warnings).toEqual(built.warnings);
    expect(r.summary.pass + r.summary.warning + r.summary['not-applicable']).toBe(12);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('flags settings that break para 4(3) and para 5, and a core bundle passes para 2', async () => {
    const p: Project = structuredClone(base.project);
    p.settings.stamp.position = 'bottom-centre';
    p.settings.maxPagesPerVolume = 300;
    p.docs.find((d) => /Statement of Claim/.test(d.description))!.core = true;
    const out = await buildBundle({ project: p, sources: base.sources, date: FIXED, fonts });
    const by = Object.fromEntries(complianceReport(p, out, { date: FIXED }).checks.map((c) => [c.id, c]));
    expect(by['numbering'].status).toBe('warning');
    expect(by['volume-limit'].status).toBe('warning');
    expect(by['core-bundle'].status).toBe('pass');
    expect(by['legible'].status).toBe('warning'); // no analysis: not checked
  });

  it('para 8: gives the lodging deadline, and warns once it has passed', () => {
    const p: Project = structuredClone(base.project);
    p.case.hearingDate = '2026-12-14'; // Monday
    const ok = complianceReport(p, built, { date: FIXED }).checks.find((c) => c.para === '8')!;
    expect(ok.status).toBe('pass');
    expect(ok.detail).toContain('Tuesday 08/12/2026');
    const late = complianceReport(p, built, { date: new Date('2026-12-09T09:00:00Z') }).checks.find((c) => c.para === '8')!;
    expect(late.status).toBe('warning');
    p.case.hearingDate = '2031-01-06'; // outside the holiday data
    expect(complianceReport(p, built, { date: FIXED }).checks.find((c) => c.para === '8')!.status).toBe('warning');
  });

  it('PDF lists every check in words and the full warnings list', async () => {
    const r = complianceReport(base.project, built, { date: FIXED });
    const pdf = await complianceReportPdf(r, { fonts, date: FIXED });
    const t = (await readText(pdf)).map((x) => x.text).join(' ');
    expect(t).toContain('PD 5.6 compliance report');
    for (const w of ['Pass', 'Warning', 'Not applicable']) expect(t).toContain(w);
    expect(t).toContain(`All warnings (${r.warnings.length})`);
    for (const w of r.warnings) expect(t.replace(/\s/g, '')).toContain(`[${w.code}]`);
    expect(NO_SYMBOLS.test(t)).toBe(false);
  });
});

describe('ZIP export', () => {
  it('packages volumes, master index, Word indexes, labels, report and project', async () => {
    const phases = new Set<string>();
    const p: Project = structuredClone(base.project);
    const ex = await exportBundle({ project: p, sources: base.sources, analysis: base.analysis, date: FIXED, fonts, issue: true, onProgress: (x) => phases.add(x.phase) });
    expect(ex.zipName).toBe('HCA 1234-2025 Chan v Wong Trial Bundle.zip');
    for (const ph of ['plan', 'volume', 'master', 'docx', 'labels', 'report', 'zip']) expect(phases.has(ph)).toBe(true);
    const zip = await JSZip.loadAsync(ex.zip);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual([
      'HCA 1234-2025 Chan v Wong Bundle A Index.docx',
      'HCA 1234-2025 Chan v Wong Bundle A.pdf',
      'HCA 1234-2025 Chan v Wong Bundle B Index.docx',
      'HCA 1234-2025 Chan v Wong Bundle B.pdf',
      'HCA 1234-2025 Chan v Wong Labels.pdf',
      'HCA 1234-2025 Chan v Wong Master Index.docx',
      'HCA 1234-2025 Chan v Wong Master Index.pdf',
      'HCA 1234-2025 Chan v Wong PD 5.6 compliance report.json',
      'HCA 1234-2025 Chan v Wong PD 5.6 compliance report.pdf',
      'HCA 1234-2025 Chan v Wong Transcript Bundle Index.docx',
      'HCA 1234-2025 Chan v Wong Transcript Bundle.pdf',
      'HCA 1234-2025 Chan v Wong project.json',
    ]);
    // Contents are exactly the built files.
    const a = await zip.file('HCA 1234-2025 Chan v Wong Bundle A.pdf')!.async('uint8array');
    expect(a).toEqual(ex.build.volumes[0].bytes);
    const report = JSON.parse(await zip.file('HCA 1234-2025 Chan v Wong PD 5.6 compliance report.json')!.async('string'));
    expect(report.checks.length).toBe(12);
    // The project file is the issued project, and it loads.
    const proj = parseProject(await zip.file('HCA 1234-2025 Chan v Wong project.json')!.async('string')).project;
    expect(proj.frozen).toBeTruthy();
    expect(proj.docs.length).toBe(p.docs.length);
  });

  it('can be cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await exportBundle({ project: base.project, sources: base.sources, date: FIXED, signal: ac.signal }).catch((e) => e);
    expect(err.name).toBe('AbortError');
  });

  it('CLI build --zip writes the ZIP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bbw-zip-'));
    try {
      await cp(FIXTURE_DIR, dir, { recursive: true });
      const { project } = await initProject(dir, { actionNo: 'HCA 1234/2025', shortTitle: 'Chan v Wong' });
      await writeFile(join(dir, 'project.json'), JSON.stringify(project));
      const { stdout } = await promisify(execFile)(process.execPath, ['cli/cli.ts', 'build', join(dir, 'project.json'), '--out', join(dir, 'out'), '--zip', '--no-analyse'], { cwd: join(import.meta.dirname, '..') });
      expect(stdout).toContain('OK HCA 1234-2025 Chan v Wong Trial Bundle.zip');
      expect(NO_SYMBOLS.test(stdout)).toBe(false);
      expect(await readdir(join(dir, 'out'))).toEqual(['HCA 1234-2025 Chan v Wong Trial Bundle.zip']);
      const zip = await JSZip.loadAsync(await readFile(join(dir, 'out', 'HCA 1234-2025 Chan v Wong Trial Bundle.zip')));
      expect(Object.keys(zip.files).length).toBe(12);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
