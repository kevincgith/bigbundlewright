// Big Bundle Wright: Chinese (Traditional) text and bilingual headings (stage 5).
// SPDX-License-Identifier: MPL-2.0
import fontkit from '@pdf-lib/fontkit';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadFonts } from '../cli/node-support.ts';
import { buildBundle, projectNeedsCjkFonts, type FontBytes, type Project } from '../src/engine/index.ts';
import { ZH_TEXT } from './fixtures/generate.ts';
import { FIXED, addExtra, readText, setupBase, stampOf, type Base } from './helpers.ts';

let base: Base;
let fonts: FontBytes;
let zhProject: Project;

beforeAll(async () => {
  base = await setupBase();
  fonts = await loadFonts();
  zhProject = structuredClone(base.project);
  const id = await addExtra(base, zhProject, 'ZH');
  zhProject.docs.push({ id: 'dzh', fileId: id, date: '2024-05-10', description: 'Letter to Defendant (Chinese)', descriptionZh: ZH_TEXT.title, type: 'correspondence', status: 'authentic', core: false });
  // Keep the chronological order.
  zhProject.docs.sort((a, b) => (a.date ?? '9999') < (b.date ?? '9999') ? -1 : (a.date ?? '9999') > (b.date ?? '9999') ? 1 : 0);
}, 180_000);

/** Every embedded TrueType font program, parsed with fontkit. */
async function embeddedFonts(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const out: { name: string; font: any }[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const ff = obj.get(PDFName.of('FontFile2'));
    if (!ff) continue;
    const raw = decodePDFRawStream(doc.context.lookup(ff) as PDFRawStream).decode();
    out.push({ name: obj.get(PDFName.of('FontName'))!.toString(), font: fontkit.create(raw as never) });
  }
  return out;
}

describe('Chinese text with the vendored Noto TC fonts', () => {
  it('index shows the Chinese description, extractable as text, with no glyph warning', async () => {
    const r = await buildBundle({ project: zhProject, sources: base.sources, analysis: base.analysis, date: FIXED, fonts });
    expect(r.cjkFonts).toBe(true);
    expect(r.warnings.filter((w) => w.code === 'unsupported-glyph')).toEqual([]);
    // The Chinese letter (10/05/2024) falls in Bundle B.
    const B = r.volumes.find((v) => v.name === 'Bundle B')!;
    const t = await readText(B.bytes);
    const prelim = t.slice(0, B.prelimPages).map((p) => p.text).join(' ');
    expect(prelim).toContain(ZH_TEXT.title);
    expect(prelim).toContain('Letter to Defendant (Chinese)');
    // The fixture page itself (drawn with the same font) round-trips too.
    const page = t.find((p) => p.text.includes('[ZH p1]'))!;
    expect(page.text.replace(/\s/g, '')).toContain(ZH_TEXT.body);
    expect(stampOf(page)).toMatch(/^\d+$/);
  });

  it('subsets the fonts: every embedded glyph parses and has an outline', async () => {
    const r = await buildBundle({ project: zhProject, sources: base.sources, date: FIXED, fonts, prelimsOnly: true });
    const B = r.volumes.find((v) => v.name === 'Bundle B')!;
    const embedded = await embeddedFonts(B.bytes);
    expect(embedded.length).toBeGreaterThanOrEqual(2);
    for (const { name, font } of embedded) {
      expect(name).toMatch(/Noto/);
      expect(font.numGlyphs).toBeLessThan(400); // a subset, not the 20,000-glyph font
      for (let g = 1; g < font.numGlyphs; g++) {
        const glyph = font.getGlyph(g);
        if (glyph.advanceWidth > 0 && glyph.path.commands.length === 0) {
          // Only spaces may be empty.
          expect(glyph.codePoints.every((cp: number) => cp === 0x20 || cp === 0x3000 || cp === 0xa0)).toBe(true);
        }
      }
    }
  });

  it('keeps index PDFs small (subset, not the full 10 MB font)', async () => {
    const withFonts = await buildBundle({ project: zhProject, sources: base.sources, date: FIXED, fonts, prelimsOnly: true });
    const without = await buildBundle({ project: zhProject, sources: base.sources, date: FIXED, prelimsOnly: true });
    const a = withFonts.volumes[1].bytes.length, b = without.volumes[1].bytes.length;
    console.log(`Bundle B index preview: ${b} bytes with standard fonts, ${a} bytes with Noto TC (subset)`);
    expect(a).toBeLessThan(b + 250_000);
  });

  it('without the fonts: falls back to the standard fonts and warns', async () => {
    const r = await buildBundle({ project: zhProject, sources: base.sources, date: FIXED, prelimsOnly: true });
    expect(r.cjkFonts).toBe(false);
    const w = r.warnings.find((x) => x.code === 'unsupported-glyph');
    expect(w?.message).toContain('致');
    const t = await readText(r.volumes[1].bytes);
    expect(t.map((p) => p.text).join(' ')).not.toContain(ZH_TEXT.title);
  });

  it('tells a browser when the fonts are needed', () => {
    expect(projectNeedsCjkFonts(base.project)).toBe(false);
    expect(projectNeedsCjkFonts(zhProject)).toBe(true);
    const p = structuredClone(base.project);
    p.settings.bilingualHeadings = true;
    expect(projectNeedsCjkFonts(p)).toBe(true);
  });
});

describe('bilingual headings', () => {
  it('puts English and Chinese headings on the index, front sheet and master index', async () => {
    const p = structuredClone(zhProject);
    p.settings.bilingualHeadings = true;
    const r = await buildBundle({ project: p, sources: base.sources, date: FIXED, fonts, prelimsOnly: true });
    expect(r.bilingual).toBe(true);
    const A = r.volumes[0];
    const t = (await readText(A.bytes)).map((x) => x.text.replace(/\s/g, ''));
    const front = t.slice(0, A.frontSheetPages).join('');
    const index = t.slice(A.frontSheetPages).join('');
    for (const s of ['STATUSOFDOCUMENTS', '文件狀況（實務指示5.6第3段）', '當作真實', '僅同意納入文件冊']) expect(front).toContain(s);
    for (const s of ['INDEX', '索引', '編號', '日期', '文件描述', '狀況', '頁碼', '真實', '文件冊A']) expect(index).toContain(s);
    // Bilingual layout must still match the plan (the build would throw otherwise).
    expect(A.prelimPages).toBe(r.plan.main.volumes[0].prelimPageCount);
    const full = await buildBundle({ project: p, sources: base.sources, analysis: base.analysis, date: FIXED, fonts });
    const m = (await readText(full.masterIndex!.bytes)).map((x) => x.text.replace(/\s/g, '')).join('');
    expect(m).toContain('總索引');
  });

  it('stays English-only (with a warning) when the fonts are not supplied', async () => {
    const p = structuredClone(base.project);
    p.settings.bilingualHeadings = true;
    const r = await buildBundle({ project: p, sources: base.sources, date: FIXED, prelimsOnly: true });
    expect(r.bilingual).toBe(false);
    expect(r.warnings.some((w) => w.code === 'unsupported-glyph' && /Bilingual/.test(w.message))).toBe(true);
    const t = (await readText(r.volumes[0].bytes)).map((x) => x.text).join(' ');
    expect(t).toContain('INDEX');
    expect(t).not.toContain('?');
  });
});
