// Big Bundle Wright: Web Worker. All PDF work happens here, off the main thread.
// Documents arrive as bytes from the page and never leave this device.
// SPDX-License-Identifier: MPL-2.0

import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import {
  analysePdf, buildBundle, exportBundle, loadSource, planProject, projectNeedsCjkFonts, FONT_FILES, ProjectError, SourceError,
  type FontBytes, type LoadedSource, type PageAnalysis, type Project,
} from '../engine/index.ts';
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

const assetBase = new URL('../pdfjs/', new URL(import.meta.env.BASE_URL, self.location.href)).href;
const ASSETS = {
  standardFontDataUrl: `${assetBase}standard_fonts/`,
  cMapUrl: `${assetBase}cmaps/`,
  wasmUrl: `${assetBase}wasm/`,
  CanvasFactory: OffscreenCanvasFactory,
  FilterFactory: NoFilterFactory,
  isOffscreenCanvasSupported: true,
  useWorkerFetch: false,
  disableWorkerRendering: true,
};

const fontBase = new URL('../fonts/', new URL(import.meta.env.BASE_URL, self.location.href)).href;
let fontsPromise: Promise<FontBytes> | null = null;
/** Chinese fonts (about 27 MB) are fetched from this site only when the project needs them. */
async function fontsFor(project: Project, onLoading?: () => void): Promise<FontBytes | undefined> {
  if (!projectNeedsCjkFonts(project)) return undefined;
  if (!fontsPromise) {
    onLoading?.();
    const get = async (f: string) => {
      const r = await fetch(fontBase + f);
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
  const p = chain.then(() => analysePdf(pdfjs as never, src.pdfBytes, ASSETS as never));
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
  return { volumes: vols, warnings: plan.warnings, physicalFiles: plan.physicalFiles };
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
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
        abort = new AbortController();
        const signal = abort.signal;
        const sources = sourcesFor(m.project);
        // Wait for page analysis (it runs in the background as files are added).
        const shas = [...new Set(m.project.files.map((f) => f.sha256))];
        const analysis = new Map<string, PageAnalysis[]>();
        let done = 0;
        for (const sha of shas) {
          if (signal.aborted) throw new DOMException('Build cancelled', 'AbortError');
          const a = await analysed.get(sha)!.catch(() => undefined);
          for (const f of m.project.files) if (f.sha256 === sha && a) analysis.set(f.id, a);
          post({ type: 'progress', reqId: m.reqId, phase: 'Checking pages', done: ++done, total: shas.length });
        }
        const fonts = await fontsFor(m.project, () => post({ type: 'progress', reqId: m.reqId, phase: 'Loading Chinese fonts', done: 0, total: 1 }));
        const phaseName: Record<string, string> = { plan: 'Planning', master: 'Master index', docx: 'Word indexes', labels: 'Labels', report: 'Compliance report', zip: 'Packing ZIP' };
        const onProgress = (p: { phase: string; volume?: string; done: number; total: number }) =>
          post({ type: 'progress', reqId: m.reqId, phase: p.phase === 'volume' ? `Building ${p.volume}` : phaseName[p.phase] ?? p.phase, done: p.done, total: p.total });
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
        abort = null;
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
