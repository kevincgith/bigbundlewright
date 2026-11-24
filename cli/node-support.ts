// Big Bundle Wright: Node glue for the engine (file system + pdf.js assets).
// SPDX-License-Identifier: MPL-2.0

import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  analysePdf, loadSource, parseFileName, SourceError, DEFAULT_SETTINGS,
  type BundleDoc, type LoadedSource, type PageAnalysis, type Project,
} from '../src/engine/index.ts';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
export const PDFJS_ASSETS = {
  standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + '/',
  cMapUrl: join(pdfjsRoot, 'cmaps') + '/',
  wasmUrl: join(pdfjsRoot, 'wasm') + '/',
};

export const INPUT_EXT = /\.(pdf|png|jpe?g)$/i;

export async function analyse(src: LoadedSource): Promise<PageAnalysis[]> {
  return analysePdf(pdfjs as never, src.pdfBytes, PDFJS_ASSETS);
}

/** Load every file the project refers to from `dir`, matching by name then by hash. */
export async function loadProjectSources(project: Project, dir: string) {
  const names = (await readdir(dir)).filter((n) => INPUT_EXT.test(n) || /\.\w+$/.test(n));
  const sources = new Map<string, LoadedSource>();
  const notes: string[] = [];
  const hashCache = new Map<string, LoadedSource | SourceError>();
  const tryLoad = async (name: string, id: string) => {
    const cached = hashCache.get(name);
    if (cached) return cached;
    try {
      const r = await loadSource(id, name, new Uint8Array(await readFile(join(dir, name))));
      hashCache.set(name, r);
      return r;
    } catch (e) {
      if (e instanceof SourceError) { hashCache.set(name, e); return e; }
      throw e;
    }
  };
  for (const f of project.files) {
    let hit: LoadedSource | null = null;
    if (names.includes(f.name)) {
      const r = await tryLoad(f.name, f.id);
      if (r instanceof SourceError) throw r;
      if (r.ref.sha256 === f.sha256) hit = r;
      else notes.push(`"${f.name}" has changed since the project was saved (content hash differs); looking for the original by content.`);
    }
    if (!hit) {
      for (const n of names) {
        const r = await tryLoad(n, f.id);
        if (!(r instanceof SourceError) && r.ref.sha256 === f.sha256) { hit = r; notes.push(`"${f.name}" found as "${n}".`); break; }
      }
    }
    if (!hit) throw new SourceError(f.name, 'hash-mismatch', `"${f.name}" (sha256 ${f.sha256.slice(0, 12)}…) was not found in ${dir} with matching content.`);
    sources.set(f.id, { ...hit, ref: { ...hit.ref, id: f.id } });
  }
  return { sources, notes };
}

/** Scan a folder and draft a project (dates and titles from file names, sorted by date). */
export async function initProject(dir: string, opts: { actionNo?: string; shortTitle?: string } = {}): Promise<{ project: Project; errors: SourceError[] }> {
  const names = (await readdir(dir)).filter((n) => !n.startsWith('.')).sort();
  const files: Project['files'] = [];
  const docs: BundleDoc[] = [];
  const errors: SourceError[] = [];
  let n = 0;
  for (const name of names) {
    if (/\.json$/i.test(name)) continue;
    const id = `f${++n}`;
    try {
      const src = await loadSource(id, name, new Uint8Array(await readFile(join(dir, name))));
      files.push(src.ref);
      const { date, title } = parseFileName(name);
      docs.push({
        id: `d${n}`, fileId: id, date, description: title,
        type: /transcript/i.test(name) ? 'transcript' : 'document',
        status: 'authentic', core: false,
      });
    } catch (e) {
      if (e instanceof SourceError) errors.push(e); else throw e;
    }
  }
  docs.sort((a, b) => (a.date ?? '9999') < (b.date ?? '9999') ? -1 : (a.date ?? '9999') > (b.date ?? '9999') ? 1 : 0);
  const project: Project = {
    schema: 'bigbundle-wright/project@1',
    case: {
      court: 'IN THE HIGH COURT OF THE\nHONG KONG SPECIAL ADMINISTRATIVE REGION\nCOURT OF FIRST INSTANCE',
      actionNo: opts.actionNo ?? 'HCA ____/20__',
      parties: [{ name: 'PLAINTIFF NAME', role: 'Plaintiff' }, { name: 'DEFENDANT NAME', role: 'Defendant' }],
      shortTitle: opts.shortTitle ?? 'Short title',
      bundleTitle: 'Trial Bundle',
    },
    settings: structuredClone(DEFAULT_SETTINGS),
    files,
    docs,
    sections: [],
  };
  return { project, errors };
}
