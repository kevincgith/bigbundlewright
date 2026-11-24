// Big Bundle Wright: generate test fixtures into test/fixtures/out/.
// Every content page carries a marker "[<key> p<n>]" so tests can prove page order.
// SPDX-License-Identifier: MPL-2.0

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

const A4: [number, number] = [595.28, 841.89];
const A4L: [number, number] = [841.89, 595.28];
const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, 'out');
export const BAD_DIR = join(here, 'out-bad');
export const EXTRA_DIR = join(here, 'out-extra');

const LOREM = 'The parties agree that the matters set out below are true and accurate to the best of their knowledge and belief, '
  + 'save where otherwise stated, and that the documents referred to are copies of the originals held by the solicitors.';

async function textDoc(key: string, title: string, pages: number, opts: { cornerText?: number[]; edgeInk?: number[] } = {}) {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.TimesRoman);
  const fb = await doc.embedFont(StandardFonts.TimesRomanBold);
  for (let n = 1; n <= pages; n++) {
    const p = doc.addPage(A4);
    p.drawText(title, { x: 72, y: 760, size: 14, font: fb });
    p.drawText(`[${key} p${n}]`, { x: 72, y: 740, size: 10, font: f });
    for (let l = 0; l < 20; l++) p.drawText(LOREM.slice(0, 95), { x: 72, y: 700 - l * 24, size: 10, font: f });
    if (opts.cornerText?.includes(n)) p.drawText('REF: ABC/123/2024', { x: 470, y: 815, size: 10, font: fb });
    if (opts.edgeInk?.includes(n)) p.drawRectangle({ x: 0, y: 300, width: 40, height: 200, color: rgb(0.1, 0.1, 0.1) });
  }
  return doc.save();
}

function scanPng(lines: string[], w = 1240, h = 1754, cornerMark = true): Uint8Array {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#f7f5ef'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#222';
  g.font = '34px serif';
  lines.forEach((ln, i) => g.fillText(ln, 140, 260 + i * 56));
  if (cornerMark) { g.font = 'bold 30px sans-serif'; g.fillText('CONFIDENTIAL', w - 330, 70); }
  return new Uint8Array(c.toBuffer('image/png'));
}

async function scanDoc(key: string) {
  const doc = await PDFDocument.create();
  for (let n = 1; n <= 2; n++) {
    const png = await doc.embedPng(scanPng([`SIGNED AGREEMENT  [${key} p${n}]`, 'This is a scanned image with no text layer.', 'Signed: ______________']));
    const p = doc.addPage(A4);
    p.drawImage(png, { x: 0, y: 0, width: A4[0], height: A4[1] });
  }
  return doc.save();
}

async function landscapeDoc(key: string) {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  // 1: A4 landscape
  let p = doc.addPage(A4L);
  p.drawText(`Schedule of loss (A4 landscape) [${key} p1]`, { x: 60, y: 520, size: 14, font: f });
  // 2: US Letter landscape
  p = doc.addPage([792, 612]);
  p.drawText(`Letter landscape [${key} p2]`, { x: 60, y: 540, size: 14, font: f });
  // 3: portrait page shown landscape via /Rotate 90
  p = doc.addPage(A4);
  p.setRotation(degrees(90));
  p.drawText(`Rotated 90 [${key} p3]`, { x: 300, y: 100, size: 14, font: f, rotate: degrees(90) });
  // 4: A5 with an offset MediaBox
  p = doc.addPage([420, 595]);
  p.setMediaBox(20, 30, 420, 595);
  p.drawText(`A5 offset box [${key} p4]`, { x: 60, y: 500, size: 12, font: f });
  return doc.save();
}

function jpegPhoto(): Uint8Array {
  const c = createCanvas(1600, 1200);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 1600, 1200);
  grad.addColorStop(0, '#8aa'); grad.addColorStop(1, '#354');
  g.fillStyle = grad; g.fillRect(0, 0, 1600, 1200);
  g.fillStyle = '#fff'; g.font = '60px sans-serif'; g.fillText('Site photo', 80, 140);
  return new Uint8Array(c.toBuffer('image/jpeg', 80));
}

/** A tiny PDF with an /Encrypt dictionary in its trailer (simulated: pdf-lib cannot encrypt). */
function encryptedPdf(): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${'a'.repeat(64)}> /U <${'b'.repeat(64)}> /P -44 >>`,
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<${'1'.repeat(32)}> <${'1'.repeat(32)}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export const MAIN_SET: { name: string; key: string; pages: number }[] = [
  { name: '2024-01-10 Writ of Summons.pdf', key: 'WRIT', pages: 8 },
  { name: '2024-02-20 Statement of Claim.pdf', key: 'SOC', pages: 20 },
  { name: '2024-03-15 Letter to D.pdf', key: 'LTR', pages: 3 },
  { name: '2024-03-20 Schedule of loss.pdf', key: 'SCHED', pages: 4 },
  { name: '2024-03-25 Signed agreement (scan).pdf', key: 'SCAN', pages: 2 },
  { name: '2024-03-26 Site photo.jpg', key: 'PHOTO', pages: 1 },
  { name: '2024-04-01 Bank statements.pdf', key: 'BANK', pages: 120 },
  { name: '2024-05-02 Board minutes.pdf', key: 'MIN', pages: 90 },
  { name: '2024-06-30 Expert report.pdf', key: 'EXP', pages: 70 },
  { name: '2024-07-01 Transcript Day 1.pdf', key: 'TX1', pages: 12 },
  { name: 'Letter to D (copy).pdf', key: 'LTR', pages: 3 },
];

/** Late documents for inserts (PD 5.6 para 1) and a typed copy (para 6). */
export const EXTRA_SET: { name: string; key: string; pages: number }[] = [
  { name: '2024-04-15 Late letter.pdf', key: 'LATE', pages: 3 },
  { name: '2024-04-20 Second late letter.pdf', key: 'LATE2', pages: 2 },
  { name: 'Typed copy of agreement p1.pdf', key: 'TYPED', pages: 1 },
  { name: '2024-08-01 Further document.pdf', key: 'FURTHER', pages: 2 },
  { name: '2024-07-02 Transcript Day 2.pdf', key: 'TX2', pages: 5 },
];

export async function generate() {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await rm(BAD_DIR, { recursive: true, force: true });
  await rm(EXTRA_DIR, { recursive: true, force: true });
  await mkdir(FIXTURE_DIR, { recursive: true });
  await mkdir(BAD_DIR, { recursive: true });
  await mkdir(EXTRA_DIR, { recursive: true });
  for (const e of EXTRA_SET) await writeFile(join(EXTRA_DIR, e.name), await textDoc(e.key, e.name.replace(/\.pdf$/, ''), e.pages));
  const w = (n: string, b: Uint8Array) => writeFile(join(FIXTURE_DIR, n), b);
  const letter = await textDoc('LTR', 'Letter to Defendant', 3);
  await w(MAIN_SET[0].name, await textDoc('WRIT', 'Writ of Summons', 8));
  await w(MAIN_SET[1].name, await textDoc('SOC', 'Statement of Claim', 20));
  await w(MAIN_SET[2].name, letter);
  await w(MAIN_SET[3].name, await landscapeDoc('SCHED'));
  await w(MAIN_SET[4].name, await scanDoc('SCAN'));
  await w(MAIN_SET[5].name, jpegPhoto());
  await w(MAIN_SET[6].name, await textDoc('BANK', 'Bank statements', 120));
  await w(MAIN_SET[7].name, await textDoc('MIN', 'Board minutes', 90, { cornerText: [1, 2], edgeInk: [5] }));
  await w(MAIN_SET[8].name, await textDoc('EXP', 'Expert report', 70));
  await w(MAIN_SET[9].name, await textDoc('TX1', 'Transcript Day 1', 12));
  await w(MAIN_SET[10].name, letter); // duplicate content

  await writeFile(join(BAD_DIR, 'Encrypted.pdf'), encryptedPdf());
  const good = await textDoc('X', 'Truncated', 2);
  await writeFile(join(BAD_DIR, 'Corrupt.pdf'), good.slice(0, 40));
  await writeFile(join(BAD_DIR, 'Witness statement.docx'), new TextEncoder().encode('PK\u0003\u0004 not really a docx'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await generate();
  console.log(`Fixtures written to ${FIXTURE_DIR} and ${BAD_DIR}`);
}
