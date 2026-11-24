// Render selected PDF pages to PNG for visual checks: node scripts/preview.ts <pdf> <outdir> 1,2,40
// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFJS_ASSETS } from '../cli/node-support.ts';

const [file, outDir, list] = process.argv.slice(2);
const data = new Uint8Array(await readFile(file));
const doc = await pdfjs.getDocument({ data, ...PDFJS_ASSETS }).promise;
await mkdir(outDir, { recursive: true });
const pages = list ? list.split(',').map(Number) : [1];
for (const n of pages) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1.2 });
  const f = doc.canvasFactory as any;
  const cc = f.create(Math.ceil(vp.width), Math.ceil(vp.height));
  await page.render({ canvasContext: cc.context, canvas: cc.canvas, viewport: vp }).promise;
  const out = join(outDir, `${basename(file, '.pdf')}-p${n}.png`);
  await writeFile(out, cc.canvas.toBuffer('image/png'));
  console.log(out);
}
