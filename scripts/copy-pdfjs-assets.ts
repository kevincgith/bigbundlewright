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
console.log('pdf.js assets copied to public/pdfjs');
