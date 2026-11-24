// Performance check: build a ~1,600-page bundle with full analysis. node scripts/perf.ts
// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { buildBundle } from '../src/engine/index.ts';
import { analyse, initProject, loadProjectSources } from '../cli/node-support.ts';

const dir = await mkdtemp(join(tmpdir(), 'bbw-perf-'));
try {
  for (let d = 0; d < 16; d++) {
    const doc = await PDFDocument.create();
    const f = await doc.embedFont(StandardFonts.TimesRoman);
    for (let n = 0; n < 100; n++) {
      const p = doc.addPage([595.28, 841.89]);
      for (let l = 0; l < 40; l++) p.drawText(`Doc ${d} page ${n + 1} line ${l} lorem ipsum dolor sit amet consectetur`, { x: 72, y: 760 - l * 17, size: 10, font: f });
    }
    await writeFile(join(dir, `2024-${String(d % 12 + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')} Doc ${d}.pdf`), await doc.save());
  }
  const t0 = performance.now();
  const { project } = await initProject(dir, { actionNo: 'HCA 1/2025', shortTitle: 'Perf' });
  const { sources } = await loadProjectSources(project, dir);
  const t1 = performance.now();
  const analysis = new Map();
  for (const [id, s] of sources) analysis.set(id, await analyse(s));
  const t2 = performance.now();
  const r = await buildBundle({ project, sources, analysis });
  const t3 = performance.now();
  const mem = process.memoryUsage().rss / 1e6;
  const pages = r.volumes.reduce((a, v) => a + v.pageCount, 0);
  console.log(`${pages} output pages in ${r.volumes.length} volumes`);
  console.log(`load ${((t1 - t0) / 1000).toFixed(1)}s, analyse ${((t2 - t1) / 1000).toFixed(1)}s, build ${((t3 - t2) / 1000).toFixed(1)}s, RSS ${mem.toFixed(0)} MB`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
