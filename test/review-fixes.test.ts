// Big Bundle Wright: regression tests for the code-review findings (engine).
// SPDX-License-Identifier: MPL-2.0

import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildBundle, complianceReport, fitToA4, lodgingDeadline, parseProject, planProject, serializeProject, ProjectError, STAMP_ZONE,
  type BundleDoc, type Project,
} from '../src/engine/index.ts';
import { FIXED, outline, readText, setupBase, stampOf, type Base } from './helpers.ts';

let base: Base;
beforeAll(async () => { base = await setupBase(); }, 180_000);

const docBy = (p: Project, desc: string) => p.docs.find((d) => d.description === desc)!;
const build = (p: Project, extra: Partial<Parameters<typeof buildBundle>[0]> = {}) =>
  buildBundle({ project: p, sources: base.sources, analysis: base.analysis, date: FIXED, ...extra });
const only = (p: Project, descs: string[]) => { p.docs = descs.map((d) => docBy(p, d)); return p; };
const newDoc = (id: string, fileId: string, description: string, date: string, extra: Partial<BundleDoc> = {}): BundleDoc =>
  ({ id, fileId, description, date, type: 'document', status: 'authentic', core: false, ...extra });

describe('PDF strings with brackets and backslashes', () => {
  it('keep the PDF valid and the bookmark titles exact', async () => {
    const p = structuredClone(base.project);
    p.settings.outlineStyle = 'plain';
    docBy(p, 'Letter to D').description = 'Letter re item 3) of the contract';
    docBy(p, 'Writ of Summons').description = 'Writ (amended C:\\new\\b';
    const r = await build(p);
    const A = r.volumes[0];
    const t = await readText(A.bytes); // pdf.js must be able to open it
    expect(t.length).toBe(A.pageCount);
    const titles = outline(await PDFDocument.load(A.bytes)).map((o) => o.title);
    expect(titles).toContain('3. Letter re item 3) of the contract');
    expect(titles).toContain('1. Writ (amended C:\\new\\b');
  });
});

describe('section letters', () => {
  it('must be capital letters A-Z, unique', () => {
    const raw = JSON.parse(serializeProject(base.project));
    raw.sections = [{ id: 's1', letter: '甲', title: 'Pleadings' }];
    expect(() => parseProject(JSON.stringify(raw))).toThrow(/Section letter "甲" must be 1 to 3 capital letters/);
    raw.sections = [{ id: 's1', letter: 'B2', title: 'x' }];
    expect(() => parseProject(JSON.stringify(raw))).toThrow(ProjectError);
    raw.sections = [{ id: 's1', letter: 'A', title: 'x' }, { id: 's2', letter: 'A', title: 'y' }];
    expect(() => parseProject(JSON.stringify(raw))).toThrow(/used twice/);
  });

  it('multi-letter series get correct "of Y" totals and no duplicate labels after issue', async () => {
    const p = only(structuredClone(base.project), ['Writ of Summons', 'Statement of Claim', 'Letter to D']);
    p.settings.sectionsEnabled = true;
    p.settings.numbering = 'per-section';
    p.settings.stamp.style = 'XofY';
    p.sections = [{ id: 's1', letter: 'A', title: 'Pleadings' }, { id: 's2', letter: 'BB', title: 'Letters' }];
    docBy(p, 'Writ of Summons').sectionId = 's1';
    docBy(p, 'Statement of Claim').sectionId = 's1';
    docBy(p, 'Letter to D').sectionId = 's2';
    const r = await build(p, { issue: true });
    expect(r.plan.main.seriesTotals).toEqual({ A: 28, BB: 3 });
    const t = await readText(r.volumes[0].bytes);
    expect(stampOf(t[r.volumes[0].prelimPages + 28])).toBe('BB1 of BB3');
    // Append to section A after issue: labels stay unique.
    const q = structuredClone(r.issuedProject!);
    q.docs.push(newDoc('late', docBy(q, 'Writ of Summons').fileId, 'Late pleading', '2024-08-01', { sectionId: 's1' }));
    const r2 = await build(q);
    const labels = r2.plan.main.volumes.flatMap((v) => v.pages.map((x) => x.label));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.slice(-8)).toEqual(['A29', 'A30', 'A31', 'A32', 'A33', 'A34', 'A35', 'A36']);
  });

  it('per-section numbering with sections off falls back to consecutive numbers, with a warning', async () => {
    const p = only(structuredClone(base.project), ['Writ of Summons', 'Letter to D']);
    p.settings.numbering = 'per-section';
    p.sections = [{ id: 's1', letter: 'A', title: 'x' }];
    docBy(p, 'Letter to D').sectionId = 's1';
    const plan = await planProject(p);
    expect(plan.main.volumes[0].pages.map((x) => x.label)).toEqual(Array.from({ length: 11 }, (_, i) => String(i + 1)));
    expect(plan.warnings.some((w) => /sections are off/.test(w.message))).toBe(true);
  });
});

describe('after issue', () => {
  it('a new main volume does not take over the issued core bundle prefix or name', async () => {
    const p = only(structuredClone(base.project), ['Writ of Summons', 'Statement of Claim', 'Bank statements']);
    p.settings.numbering = 'per-volume';
    p.settings.maxPagesPerVolume = 130;
    docBy(p, 'Writ of Summons').core = true;
    const r = await build(p, { issue: true });
    expect(r.plan.main.volumes.map((v) => v.letter)).toEqual(['A', 'B']);
    expect(r.plan.core!.volumes[0]).toMatchObject({ name: 'Core Bundle' });
    expect(r.plan.core!.volumes[0].pages[0].label).toBe('C1');

    const q = structuredClone(r.issuedProject!);
    const expert = base.project.docs.find((d) => d.description === 'Expert report')!;
    q.docs.push({ ...structuredClone(expert), id: 'exp2', core: true });
    const r2 = await build(q);
    expect(r2.plan.main.volumes.map((v) => v.letter)).toEqual(['A', 'B', 'C']);
    const core = r2.plan.core!;
    expect(core.volumes[0].name).toBe('Core Bundle');
    expect(core.volumes.flatMap((v) => v.pages).map((x) => x.label).slice(7, 10)).toEqual(['C8', 'C9', 'C10']);
    expect(r2.warnings.some((w) => w.code === 'label-clash')).toBe(true);
  });

  it('pages added since issue are flagged as provisional until re-issued', async () => {
    const r = await build(structuredClone(base.project), { issue: true });
    const q = structuredClone(r.issuedProject!);
    q.docs.push(newDoc('late', docBy(q, 'Letter to D').fileId, 'Late letter', '2024-04-15', { insertAfter: '88' }));
    const r2 = await build(q);
    const w = r2.warnings.find((x) => x.code === 'provisional-numbers');
    expect(w?.message).toMatch(/"Late letter" 88-1–88-3.*Build and re-issue/);
    const r3 = await build(q, { issue: true });
    const r4 = await build(r3.issuedProject!);
    expect(r4.warnings.some((x) => x.code === 'provisional-numbers')).toBe(false);
  });

  it('warns that "X of Y" totals change on issued pages when pages are added', async () => {
    const p = structuredClone(base.project);
    p.settings.stamp.style = 'XofY';
    const r = await build(p, { issue: true });
    const plan = await planProject(r.issuedProject!);
    expect(plan.warnings.some((w) => /"of Y" total on issued pages changes/.test(w.message))).toBe(true);
  });
});

describe('page limit', () => {
  it('rejects a non-numeric limit instead of hanging', async () => {
    const raw = JSON.parse(serializeProject(base.project));
    raw.settings.maxPagesPerVolume = '250 pages';
    expect(() => parseProject(JSON.stringify(raw))).toThrow(/whole number from 10 to 5000/);
    const p = structuredClone(base.project);
    (p.settings as { maxPagesPerVolume: unknown }).maxPagesPerVolume = Number.NaN;
    await expect(planProject(p)).rejects.toThrow(ProjectError);
  });

  it('never exceeds the limit when real labels are wider than the measuring placeholder', async () => {
    const p = structuredClone(base.project);
    const letter = docBy(p, 'Letter to D');
    p.docs = Array.from({ length: 300 }, (_, i) => ({ ...structuredClone(letter), id: `L${i}`, description: `Letter number ${i + 1} to the defendant's solicitors`, core: i % 2 === 0 }));
    p.settings.numbering = 'per-volume';
    for (const limit of [120, 200]) {
      p.settings.maxPagesPerVolume = limit;
      const plan = await planProject(p);
      for (const b of [plan.main, plan.core!]) for (const v of b.volumes) expect(v.prelimPageCount + v.pages.length).toBeLessThanOrEqual(limit);
      expect(plan.warnings.some((w) => w.code === 'volume-over-limit')).toBe(false);
    }
  }, 120_000);
});

describe('stamp clearance', () => {
  it('keeps the bottom strip clear for bottom positions', () => {
    const top = fitToA4(595.28, 841.89, true, 'top');
    const bottom = fitToA4(595.28, 841.89, true, 'bottom');
    expect(top.y + 841.89 * top.scale).toBeLessThanOrEqual(841.89 - STAMP_ZONE.h + 0.01);
    expect(bottom.y).toBeGreaterThanOrEqual(STAMP_ZONE.h - 0.01);
  });
});

describe('project-file validation', () => {
  const bad = (mut: (raw: any) => void) => {
    const raw = JSON.parse(serializeProject(base.project));
    mut(raw);
    return () => parseProject(JSON.stringify(raw));
  };
  it.each([
    ['parties null', (r: any) => { r.case.parties = null; }, /parties/],
    ['court null', (r: any) => { r.case.court = null; }, /"court" must be text/],
    ['insertAfter number', (r: any) => { r.docs[0].insertAfter = 88; }, /insert after page/],
    ['typedCopies not a list', (r: any) => { r.docs[0].typedCopies = 'x'; }, /typed copies must be a list/],
    ['typed copy page not an integer', (r: any) => { r.docs[0].typedCopies = [{ fileId: r.files[0].id, afterPage: 1.5 }]; }, /typed copy needs/],
    ['bad stamp size', (r: any) => { r.settings.stamp.size = 'XL'; }, /stamp.size/],
    ['bad date style', (r: any) => { r.settings.dateStyle = 'D/M/Y'; }, /dateStyle/],
    ['invalid hearing date', (r: any) => { r.case.hearingDate = '2026-02-30'; }, /not a valid date/],
    ['non-integer page count', (r: any) => { r.files[0].pageCount = 2.5; }, /incomplete/],
    ['frozen without bundles', (r: any) => { r.frozen = { issuedAt: 'x', fileHashes: {} }; }, /issued layout is damaged/],
  ])('%s', (_name, mut, msg) => {
    expect(bad(mut)).toThrow(msg);
  });
});

describe('lodging deadline and report date', () => {
  it('rejects impossible hearing dates', () => {
    expect(() => lodgingDeadline('2026-02-30')).toThrow(/not a valid hearing date/);
    expect(() => lodgingDeadline('2026-13-01')).toThrow(/not a valid hearing date/);
  });

  it('judges "deadline passed" by the Hong Kong date, not UTC', async () => {
    const p = only(structuredClone(base.project), ['Writ of Summons']);
    p.case.hearingDate = '2026-03-09'; // last lodging day Tue 03/03/2026
    const out = await build(p);
    // 17:30 UTC on 3 March is 01:30 on 4 March in Hong Kong: too late.
    const rep = complianceReport(p, out, { date: new Date('2026-03-03T17:30:00Z') });
    expect(rep.checks.find((c) => c.para === '8')!.status).toBe('warning');
    const early = complianceReport(p, out, { date: new Date('2026-03-03T15:00:00Z') }); // 23:00 HK, still 3 March
    expect(early.checks.find((c) => c.para === '8')!.status).toBe('pass');
  });
});

describe('very long descriptions', () => {
  it('continue onto the next index page instead of running off the bottom', async () => {
    const p = only(structuredClone(base.project), ['Writ of Summons', 'Letter to D']);
    const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ');
    docBy(p, 'Writ of Summons').description = `${words} END-OF-DESCRIPTION`;
    const r = await build(p);
    const A = r.volumes[0];
    const t = await readText(A.bytes);
    const prelim = t.slice(0, A.prelimPages);
    expect(prelim.map((x) => x.text).join(' ')).toContain('END-OF-DESCRIPTION');
    for (const pg of prelim) for (const it of pg.items) expect(it.y).toBeGreaterThan(20);
  });
});
