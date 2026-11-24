// Big Bundle Wright: Web Worker. All PDF work happens here, off the main thread.
// Documents arrive as bytes from the page and never leave this device.
// SPDX-License-Identifier: MPL-2.0

import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import {
  analysePdf, buildBundle, exportBundle, loadSource, planProject, projectNeedsCjkFonts, FONT_FILES, ProjectError, SourceError,
  type FontBytes, type LoadedSource, type PageAnalysis, type Project,
} from '../engine/index.ts';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { FromWorker, ToWorker, FileFlags, PlanSummary } from './protocol.ts';

// Run pdf.js in this worker (no nested worker).
(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker;

class OffscreenCanvasFactory {
  constructor(_opts?: unknown) {}
  create(w: number, h: number) {
    const canvas = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true })! };
  }
  reset(cc: { canvas: OffscreenCanvas }, w: number, h: number) { cc.canvas.width = w; cc.canvas.height = h; }
  destroy(cc: { canvas: OffscreenCanvas | null; context?: unknown }) { if (cc.canvas) { cc.canvas.width = 0; cc.canvas.height = 0; } cc.canvas = null; cc.context = null; }
  getNoAlphaContext(canvas: OffscreenCanvas) { return canvas.getContext('2d', { alpha: false, willReadFrequently: true }); }
}
class NoFilterFactory {
  constructor(_opts?: unknown) {}
  addFilter() { return 'none'; }
  addHCMFilter() { return 'none'; }
  addAlphaFilter() { return 'none'; }
  addLuminosityFilter() { return 'none'; }
  addHighlightHCMFilter() { return 'none'; }
  destroy() {}
}

// The page tells us its address in the first message (this worker runs from a blob: URL).
let base = '';
let baseOrigin = '';

// Defence in depth: this worker may only fetch the site's own static files.
const realFetch = self.fetch.bind(self);
self.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href, base || undefined);
  if (url.origin !== baseOrigin) return Promise.reject(new TypeError(`Blocked a request to another site (${url.origin}).`));
  return realFetch(input, init);
};

const assets = () => ({
  standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
  cMapUrl: `${base}pdfjs/cmaps/`,
  wasmUrl: `${base}pdfjs/wasm/`,
  CanvasFactory: OffscreenCanvasFactory,
  FilterFactory: NoFilterFactory,
  isOffscreenCanvasSupported: true,
  useWorkerFetch: false,
  disableWorkerRendering: true,
});

/** Resolve `p`, or reject as soon as the build is cancelled. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Build cancelled', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Build cancelled', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

let fontsPromise: Promise<FontBytes> | null = null;
/** Chinese fonts (about 27 MB) are fetched from this site only when the project needs them. */
async function fontsFor(project: Project, onLoading?: () => void): Promise<FontBytes | undefined> {
  if (!projectNeedsCjkFonts(project)) return undefined;
  if (!fontsPromise) {
    onLoading?.();
    const get = async (f: string) => {
      const r = await fetch(`${base}fonts/${f}`);
      if (!r.ok) throw new Error(`Could not load the Chinese font ${f} (${r.status}).`);
      return new Uint8Array(await r.arrayBuffer());
    };
    post({ type: 'fonts', state: 'loading' });
    fontsPromise = Promise.all([get(FONT_FILES.serifRegular), get(FONT_FILES.serifBold), get(FONT_FILES.sansBold)])
      .then(([serifRegular, serifBold, sansBold]) => ({ serifRegular, serifBold, sansBold }));
    fontsPromise.then(() => post({ type: 'fonts', state: 'ready' }), () => { fontsPromise = null; post({ type: 'fonts', state: 'failed' }); });
  }
  return fontsPromise;
}

const bySha = new Map<string, LoadedSource>();
const analysed = new Map<string, Promise<PageAnalysis[]>>();
let chain: Promise<unknown> = Promise.resolve();
let abort: AbortController | null = null;

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function flags(a: PageAnalysis[]): FileFlags {
  const pick = (f: (p: PageAnalysis) => boolean) => a.map((p, i) => (f(p) ? i + 1 : 0)).filter(Boolean);
  return {
    imageOnly: pick((p) => !p.hasText && p.ink > 0.002),
    edge: pick((p) => p.edgeInk.length > 0),
    corner: pick((p) => p.stampZoneInk['top-right']),
  };
}

function queueAnalysis(src: LoadedSource) {
  const sha = src.ref.sha256;
  if (analysed.has(sha)) return;
  const p = chain.then(() => {
    if (!bySha.has(sha)) throw new Error('File was removed.');
    return analysePdf(pdfjs as never, src.pdfBytes, assets() as never);
  });
  chain = p.catch(() => undefined);
  analysed.set(sha, p);
  p.then((a) => post({ type: 'analysed', sha, flags: flags(a) }), (e) => post({ type: 'analysis-failed', sha, message: String((e as Error).message ?? e) }));
}

function sourcesFor(project: Project) {
  const m = new Map<string, LoadedSource>();
  const missing: string[] = [];
  for (const f of project.files) {
    const s = bySha.get(f.sha256);
    if (s) m.set(f.id, { ...s, ref: { ...s.ref, id: f.id } }); else missing.push(f.name);
  }
  if (missing.length) throw new ProjectError(`These files need to be added again before building: ${missing.map((n) => `"${n}"`).join(', ')}.`);
  return m;
}

function summarise(plan: Awaited<ReturnType<typeof planProject>>): PlanSummary {
  const vols = [plan.main, plan.core, plan.transcripts].filter(Boolean).flatMap((b) => b!.volumes.map((v) => ({
    kind: b!.kind, name: v.name,
    first: v.pages[0]?.label ?? '', last: v.pages[v.pages.length - 1]?.label ?? '',
    pages: v.prelimPageCount + v.pages.length,
  })));
  // Where each document lands: "Bundle A, pages 39–158" (parts joined), main and transcript bundles.
  const where: Record<string, string[]> = {};
  for (const b of [plan.main, plan.transcripts]) {
    for (const v of b?.volumes ?? []) for (const r of v.rows) {
      if (r.kind !== 'doc') continue;
      const range = r.firstLabel === r.lastLabel ? `page ${r.firstLabel}` : `pages ${r.firstLabel}–${r.lastLabel}`;
      (where[r.docId] ??= []).push(`${v.name}, ${range}`);
    }
  }
  const placement = Object.fromEntries(Object.entries(where).map(([k, v]) => [k, v.join('; ')]));
  return { volumes: vols, warnings: plan.warnings, physicalFiles: plan.physicalFiles, placement };
}

/** Example documents for the walk-through, generated here (nothing is downloaded). */
async function exampleFiles() {
  const set: [string, string, number][] = [
    ['2025-01-03 Writ of Summons.pdf', 'WRIT OF SUMMONS', 3],
    ['2025-02-14 Statement of Claim.pdf', 'STATEMENT OF CLAIM', 6],
    ['2025-03-21 Defence.pdf', 'DEFENCE', 5],
    ['2025-05-02 Letter Lee & Co to Ho Solicitors.pdf', 'LETTER', 2],
    ['2025-05-09 Reply Ho Solicitors to Lee & Co.pdf', 'LETTER', 1],
    ['2025-06-30 Witness statement of Chan Tai Man.pdf', 'WITNESS STATEMENT OF CHAN TAI MAN', 8],
  ];
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const [name, heading, pages] of set) {
    const doc = await PDFDocument.create();
    const serif = await doc.embedFont(StandardFonts.TimesRoman);
    const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
    for (let n = 1; n <= pages; n++) {
      const pg = doc.addPage([595.28, 841.89]);
      pg.drawText('HCA 1234/2025', { x: 72, y: 770, size: 11, font: bold });
      pg.drawText(heading, { x: 72, y: 730, size: 14, font: bold });
      pg.drawText(`Page ${n} of ${pages}`, { x: 72, y: 710, size: 10, font: serif, color: rgb(0.35, 0.35, 0.4) });
      for (let l = 0; l < 22; l++) pg.drawText('This is an example document made by Big Bundle Wright for the walk-through. It is not a real case.', { x: 72, y: 670 - l * 24, size: 10.5, font: serif });
    }
    out.push({ name, bytes: await doc.save() });
  }
  return out;
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init':
        base = m.base;
        baseOrigin = new URL(m.base).origin;
        break;
      case 'forget':
        bySha.delete(m.sha);
        analysed.delete(m.sha);
        break;
      case 'samples': {
        const files = await exampleFiles();
        post({ type: 'samples', reqId: m.reqId, files }, files.map((f) => f.bytes.buffer as ArrayBuffer));
        break;
      }
      case 'ingest': {
        const src = await loadSource(m.tempId, m.name, new Uint8Array(m.bytes));
        if (!bySha.has(src.ref.sha256)) bySha.set(src.ref.sha256, src);
        post({ type: 'ingested', reqId: m.reqId, ref: src.ref });
        queueAnalysis(bySha.get(src.ref.sha256)!);
        break;
      }
      case 'plan': {
        const plan = await planProject(m.project, await fontsFor(m.project));
        post({ type: 'planned', reqId: m.reqId, summary: summarise(plan) });
        break;
      }
      case 'build': {
        abort?.abort();
        abort = new AbortController();
        const signal = abort.signal;
        const sources = sourcesFor(m.project);
        // Wait for page analysis (it runs in the background as files are added).
        const shas = [...new Set(m.project.files.map((f) => f.sha256))];
        const analysis = new Map<string, PageAnalysis[]>();
        let done = 0;
        for (const sha of shas) {
          if (signal.aborted) throw new DOMException('Build cancelled', 'AbortError');
          const pending = analysed.get(sha);
          const a = pending ? await abortable(pending.catch(() => undefined), signal) : undefined;
          for (const f of m.project.files) if (f.sha256 === sha && a) analysis.set(f.id, a);
          post({ type: 'progress', reqId: m.reqId, phase: 'Checking the pages', done: ++done, total: shas.length });
        }
        const fonts = await abortable(fontsFor(m.project, () => post({ type: 'progress', reqId: m.reqId, phase: 'Loading the Chinese lettering', done: 0, total: 1 })), signal);
        const phaseName: Record<string, string> = { plan: 'Working out the pages', master: 'Making the master index', docx: 'Making the Word copy of the index', labels: 'Making the spine and cover labels', report: 'Checking against PD 5.6', zip: 'Putting the files together' };
        const onProgress = (p: { phase: string; volume?: string; done: number; total: number }) =>
          post({ type: 'progress', reqId: m.reqId, phase: p.phase === 'volume' ? `Making ${p.volume}` : phaseName[p.phase] ?? p.phase, done: p.done, total: p.total });
        if (m.prelimsOnly) {
          const out = await buildBundle({ project: m.project, sources, analysis, signal, fonts, prelimsOnly: true, onProgress });
          const files = out.volumes.map((v) => ({ fileName: v.fileName, bytes: v.bytes, kind: 'volume', pageCount: v.pageCount }));
          post({ type: 'built', reqId: m.reqId, files, warnings: out.warnings }, files.map((f) => f.bytes.buffer as ArrayBuffer));
        } else {
          const out = await exportBundle({ project: m.project, sources, analysis, signal, fonts, issue: m.issue, onProgress });
          const pages = new Map(out.build.volumes.map((v) => [v.fileName, v.pageCount] as const));
          if (out.build.masterIndex) pages.set(out.build.masterIndex.fileName, out.build.masterIndex.pageCount);
          // Copy each file so every transferred buffer is distinct.
          const files = out.files.map((f) => ({ fileName: f.name, kind: f.kind, bytes: f.bytes.slice(), pageCount: pages.get(f.name) }));
          const zip = { fileName: out.zipName, bytes: out.zip };
          post({ type: 'built', reqId: m.reqId, files, zip, checks: out.report.checks, warnings: out.build.warnings, issuedProject: out.build.issuedProject },
            [...files.map((f) => f.bytes.buffer as ArrayBuffer), zip.bytes.buffer as ArrayBuffer]);
        }
        break;
      }
      case 'cancel':
        abort?.abort();
        break;
    }
  } catch (err) {
    const x = err as Error & { code?: string; fileName?: string };
    post({
      type: 'error', reqId: 'reqId' in m ? m.reqId : '',
      name: x instanceof SourceError ? 'SourceError' : x instanceof ProjectError ? 'ProjectError' : x.name,
      code: x.code, fileName: x.fileName, message: x.message ?? String(err),
    });
  }
};
