// Big Bundle Wright: engine features added for the UI (coversheet, index preview).
// SPDX-License-Identifier: MPL-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import { buildBundle, type Project } from '../src/engine/index.ts';
import { FIXED, addExtra, allLinks, readText, setupBase, stampOf, type Base } from './helpers.ts';

let base: Base;
beforeAll(async () => { base = await setupBase(); await addExtra(base, structuredClone(base.project), 'LATE'); }, 180_000);

describe('coversheet (BunTool parity)', () => {
  it('puts the cover first, unnumbered, without disturbing numbers or links', async () => {
    const p: Project = structuredClone(base.project);
    p.files.push(base.sources.get('x-LATE')!.ref);
    p.case.coversheetFileId = 'x-LATE';
    const r = await buildBundle({ project: p, sources: base.sources, analysis: base.analysis, date: FIXED });
    const A = r.volumes[0];
    expect(A.coverPages).toBe(1);
    expect(A.prelimPages).toBe(3);
    const t = await readText(A.bytes);
    expect(t[0].text).toContain('[LATE p1]');
    expect(stampOf(t[0])).toBeUndefined();
    expect(stampOf(t[3])).toBe('1');
    const links = await allLinks(A.bytes);
    expect(stampOf(t[links[0].target!])).toBe('1');
    expect(A.pageCount).toBeLessThanOrEqual(250);
  });
});

describe('index preview', () => {
  it('builds only the front pages of each volume', async () => {
    const r = await buildBundle({ project: base.project, sources: base.sources, date: FIXED, prelimsOnly: true });
    for (const v of r.volumes) {
      expect(v.pageCount).toBe(v.prelimPages);
      expect(v.fileName).toMatch(/\(index preview\)\.pdf$/);
    }
    expect(r.masterIndex).toBeUndefined();
    const t = await readText(r.volumes[0].bytes);
    expect(t.map((x) => x.text).join(' ')).toContain('Bank statements');
  });
});
