// Big Bundle Wright: page analysis (text layer, ink near stamp zone and edges).
// Uses pdf.js, injected by the caller so the engine works in a Web Worker and in Node.
// SPDX-License-Identifier: MPL-2.0

import type { PageAnalysis, StampPosition } from './model.ts';
import { EDGE_MARGIN, STAMP_ZONE, fitToA4 } from './util.ts';

type PdfjsLib = typeof import('pdfjs-dist');

export interface PdfjsAssets {
  standardFontDataUrl?: string;
  cMapUrl?: string;
  wasmUrl?: string;
}

/** Pixels per output point used for the low-resolution analysis render. */
const K = 0.5;
const INK_LUMA = 200;

const POSITIONS: StampPosition[] = ['top-right', 'top-centre', 'top-left', 'bottom-right', 'bottom-centre', 'bottom-left'];

/** Output-page rectangle (x from left, y from top) that a stamp at `pos` occupies. */
export function stampZone(pos: StampPosition, outW: number, outH: number) {
  const x = pos.endsWith('right') ? outW - STAMP_ZONE.w
    : pos.endsWith('left') ? 0 : (outW - STAMP_ZONE.w) / 2;
  const y = pos.startsWith('top') ? 0 : outH - STAMP_ZONE.h;
  return { x, y, w: STAMP_ZONE.w, h: STAMP_ZONE.h };
}

export async function analysePdf(
  pdfjs: PdfjsLib,
  pdfBytes: Uint8Array,
  assets: PdfjsAssets,
  opts: { signal?: AbortSignal; onPage?: (i: number, n: number) => void } = {},
): Promise<PageAnalysis[]> {
  // pdf.js may detach the buffer it is given, so pass a copy.
  const task = pdfjs.getDocument({
    data: pdfBytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    cMapPacked: true,
    ...assets,
  });
  const doc = await task.promise;
  const out: PageAnalysis[] = [];
  try {
    const factory = doc.canvasFactory as {
      create(w: number, h: number): { canvas: any; context: CanvasRenderingContext2D };
      destroy(cc: unknown): void;
    };
    for (let i = 1; i <= doc.numPages; i++) {
      if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const page = await doc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const vw = vp1.width, vh = vp1.height;

      const tc = await page.getTextContent();
      const hasText = tc.items.some((it) => 'str' in it && it.str.trim().length > 0);

      const fit = fitToA4(vw, vh);
      const vp = page.getViewport({ scale: fit.scale * K });
      const cw = Math.max(1, Math.ceil(vp.width)), ch = Math.max(1, Math.ceil(vp.height));
      const cc = factory.create(cw, ch);
      await page.render({ canvasContext: cc.context, canvas: cc.canvas, viewport: vp, background: 'rgb(255,255,255)' }).promise;
      const data = cc.context.getImageData(0, 0, cw, ch).data;
      factory.destroy(cc);

      const isInk = (px: number, py: number) => {
        const o = (py * cw + px) * 4;
        if (data[o + 3] < 128) return false;
        return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] < INK_LUMA;
      };
      let inkCount = 0;
      for (let py = 0; py < ch; py++) for (let px = 0; px < cw; px++) if (isInk(px, py)) inkCount++;

      // Output rect (x from left, y from top, in points) → fraction of ink pixels inside it.
      const topOff = fit.outH - (fit.y + vh * fit.scale);
      const inkIn = (r: { x: number; y: number; w: number; h: number }) => {
        const x0 = Math.max(0, Math.floor((r.x - fit.x) * K)), x1 = Math.min(cw, Math.ceil((r.x + r.w - fit.x) * K));
        const y0 = Math.max(0, Math.floor((r.y - topOff) * K)), y1 = Math.min(ch, Math.ceil((r.y + r.h - topOff) * K));
        if (x1 <= x0 || y1 <= y0) return { n: 0, frac: 0 };
        let n = 0;
        for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) if (isInk(px, py)) n++;
        return { n, frac: n / ((x1 - x0) * (y1 - y0)) };
      };

      const stampZoneInk = {} as Record<StampPosition, boolean>;
      for (const pos of POSITIONS) {
        const z = inkIn(stampZone(pos, fit.outW, fit.outH));
        stampZoneInk[pos] = z.n >= 3 && z.frac > 0.002;
      }
      const m = EDGE_MARGIN;
      const edges = {
        top: { x: 0, y: 0, w: fit.outW, h: m },
        bottom: { x: 0, y: fit.outH - m, w: fit.outW, h: m },
        left: { x: 0, y: 0, w: m, h: fit.outH },
        right: { x: fit.outW - m, y: 0, w: m, h: fit.outH },
      };
      const edgeInk = (Object.keys(edges) as (keyof typeof edges)[])
        .filter((k) => { const z = inkIn(edges[k]); return z.n >= 3 && z.frac > 0.004; });

      out.push({
        width: vw,
        height: vh,
        rotate: (((page.rotate % 360) + 360) % 360) as PageAnalysis['rotate'],
        hasText,
        ink: inkCount / (cw * ch),
        stampZoneInk,
        edgeInk,
      });
      page.cleanup();
      opts.onPage?.(i, doc.numPages);
    }
  } finally {
    await task.destroy();
  }
  return out;
}
