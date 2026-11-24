// Copy pdf.js runtime assets into public/ so they are self-hosted (no CDN).
// SPDX-License-Identifier: MPL-2.0
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const out = join(import.meta.dirname, '..', 'public', 'pdfjs');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const d of ['standard_fonts', 'cmaps', 'wasm']) await cp(join(root, d), join(out, d), { recursive: true });
// Chinese fonts (served from this site, loaded only when a project needs them).
const fontsOut = join(import.meta.dirname, '..', 'public', 'fonts');
await rm(fontsOut, { recursive: true, force: true });
await mkdir(fontsOut, { recursive: true });
for (const f of ['NotoSerifTC-Regular.ttf', 'NotoSerifTC-Bold.ttf', 'NotoSansTC-Bold.ttf', 'OFL.txt', 'OFL-NotoSansTC.txt']) {
  await cp(join(import.meta.dirname, '..', 'fonts', f), join(fontsOut, f));
}
console.log('pdf.js assets and fonts copied to public/');
