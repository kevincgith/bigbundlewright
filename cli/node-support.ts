// Big Bundle Wright: Node glue for the engine (file system + pdf.js assets).
// SPDX-License-Identifier: MPL-2.0

import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  analysePdf, loadSource, parseFileName, SourceError, DEFAULT_SETTINGS, matchSources, describeMatch, FONT_FILES,
  type BundleDoc, type FontBytes, type LoadedSource, type PageAnalysis, type Project,
} from '../src/engine/index.ts';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
export const PDFJS_ASSETS = {
  standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + '/',
  cMapUrl: join(pdfjsRoot, 'cmaps') + '/',
  wasmUrl: join(pdfjsRoot, 'wasm') + '/',
};

/** The vendored Noto TC fonts at the repo root. */
export const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts');

/** Read the vendored Noto TC fonts (fonts/) for BuildInput.fonts. */
export async function loadFonts(dir = FONTS_DIR): Promise<FontBytes> {
  const read = async (name: string) => new Uint8Array(await readFile(join(dir, name)));
  return {
    serifRegular: await read(FONT_FILES.serifRegular),
    serifBold: await read(FONT_FILES.serifBold),
    sansBold: await read(FONT_FILES.sansBold),
  };
}

export const INPUT_EXT = /\.(pdf|png|jpe?g)$/i;

export async function analyse(src: LoadedSource): Promise<PageAnalysis[]> {
  return analysePdf(pdfjs as never, src.pdfBytes, PDFJS_ASSETS);
}

/**
 * Load every file the project refers to from `dir`. Files are recognised by content
 * hash, so renamed files are found; a file whose content changed is an error.
 */
export async function loadProjectSources(project: Project, dir: string) {
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !/\.json$/i.test(e.name)).map((e) => e.name);
  const loaded: LoadedSource[] = [];
  const unreadable = new Map<string, SourceError>();
  for (const name of names) {
    try {
      loaded.push(await loadSource(name, name, new Uint8Array(await readFile(join(dir, name)))));
    } catch (e) {
      if (e instanceof SourceError) unreadable.set(name, e); else throw e;
    }
  }
  const m = matchSources(project.files, loaded.map((l) => ({ name: l.ref.name, sha256: l.ref.sha256 })));
  for (const f of m.missing) {
    const err = unreadable.get(f.name);
    if (err) throw err;
  }
  const { errors, notes } = describeMatch(m);
  if (errors.length) throw new SourceError(m.changed[0]?.file.name ?? m.missing[0].name, 'hash-mismatch', errors.join('\n'));
  const sources = new Map<string, LoadedSource>();
  for (const [id, i] of m.matched) sources.set(id, { ...loaded[i], ref: { ...loaded[i].ref, id } });
  return { sources, notes };
}

/** Scan a folder and draft a project (dates and titles from file names, sorted by date). */
export async function initProject(dir: string, opts: { actionNo?: string; shortTitle?: string } = {}): Promise<{ project: Project; errors: SourceError[] }> {
  const names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name).sort();
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
