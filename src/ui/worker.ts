// Big Bundle Wright: Web Worker. All PDF work happens here, off the main thread.
// Documents arrive as bytes from the page and never leave this device.
// SPDX-License-Identifier: MPL-2.0

import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import {
  analysePdf, buildBundle, loadSource, planProject, ProjectError, SourceError,
  type LoadedSource, type PageAnalysis, type Project,
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
        const plan = await planProject(m.project);
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
        const out = await buildBundle({
          project: m.project, sources, analysis, signal, issue: m.issue, prelimsOnly: m.prelimsOnly,
          onProgress: (p) => post({ type: 'progress', reqId: m.reqId, phase: p.phase === 'volume' ? `Building ${p.volume}` : p.phase === 'master' ? 'Master index' : 'Planning', done: p.done, total: p.total }),
        });
        const files = [...out.volumes, ...(out.masterIndex ? [out.masterIndex] : [])].map((v) => ({ fileName: v.fileName, bytes: v.bytes, pageCount: v.pageCount }));
        post({ type: 'built', reqId: m.reqId, files, warnings: out.warnings, issuedProject: out.issuedProject }, files.map((f) => f.bytes.buffer as ArrayBuffer));
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
