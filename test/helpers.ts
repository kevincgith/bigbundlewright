// Big Bundle Wright: shared test helpers.
// SPDX-License-Identifier: MPL-2.0

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, type PDFHexString, type PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFJS_ASSETS, analyse, initProject, loadProjectSources } from '../cli/node-support.ts';
import { loadSource, type LoadedSource, type PageAnalysis, type Project } from '../src/engine/index.ts';
import { EXTRA_DIR, EXTRA_SET, FIXTURE_DIR, MAIN_SET, generate } from './fixtures/generate.ts';

export interface TextItem { str: string; x: number; y: number; a: number; b: number }
export interface PageText { w: number; h: number; items: TextItem[]; text: string }

export async function readText(bytes: Uint8Array): Promise<PageText[]> {
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
export function stampOf(p: PageText): string | undefined {
  return p.items.find((t) => t.x > p.w - 150 && t.y > p.h - 45)?.str;
}

function pageIndexByRef(doc: PDFDocument) {
  const m = new Map<string, number>();
  doc.getPages().forEach((p, i) => m.set(p.ref.toString(), i));
  return m;
}

export function linksOn(doc: PDFDocument, pageIdx: number) {
  const annots = doc.getPage(pageIdx).node.Annots();
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

export async function allLinks(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return Array.from({ length: doc.getPageCount() }, (_, k) => linksOn(doc, k)).flat();
}

export function outline(doc: PDFDocument) {
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

export const FIXED = new Date('2026-11-24T00:00:00Z');

export interface Base {
  project: Project;
  sources: Map<string, LoadedSource>;
  analysis: Map<string, PageAnalysis[]>;
  /** File id → marker key used inside the fixture pages. */
  keyOfFile: Map<string, string>;
}

/** Generate fixtures, draft a project from them, load and analyse every file. */
export async function setupBase(): Promise<Base> {
  await generate();
  const { project } = await initProject(FIXTURE_DIR, { actionNo: 'HCA 1234/2025', shortTitle: 'Chan v Wong' });
  const { sources } = await loadProjectSources(project, FIXTURE_DIR);
  const analysis = new Map<string, PageAnalysis[]>();
  for (const [id, s] of sources) analysis.set(id, await analyse(s));
  const keyOfFile = new Map<string, string>();
  for (const f of project.files) keyOfFile.set(f.id, MAIN_SET.find((m) => m.name === f.name)!.key);
  return { project, sources, analysis, keyOfFile };
}

/** Add an extra fixture file to a project + source map; returns its file id. */
export async function addExtra(base: Base, project: Project, key: string): Promise<string> {
  const e = EXTRA_SET.find((x) => x.key === key)!;
  const id = `x-${key}`;
  const src = await loadSource(id, e.name, new Uint8Array(await readFile(join(EXTRA_DIR, e.name))));
  base.sources.set(id, src);
  base.analysis.set(id, await analyse(src));
  base.keyOfFile.set(id, key);
  if (!project.files.some((f) => f.id === id)) project.files.push(src.ref);
  return id;
}

/** Map every content page's marker "[KEY pN]" to its stamped label, across the given volumes. */
export function markerToStamp(vols: { prelimPages: number }[], texts: PageText[][]): Map<string, string> {
  const m = new Map<string, string>();
  vols.forEach((v, vi) => {
    for (let k = v.prelimPages; k < texts[vi].length; k++) {
      const mk = /\[([A-Z0-9]+ p\d+)\]/.exec(texts[vi][k].text);
      if (mk) m.set(mk[1], stampOf(texts[vi][k])!);
    }
  });
  return m;
}
