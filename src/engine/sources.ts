// Big Bundle Wright: load and validate input files.
// SPDX-License-Identifier: MPL-2.0

import { PDFDocument } from 'pdf-lib';
import { SourceError, type SourceFileRef } from './model.ts';
import { A4, sha256Hex } from './util.ts';

export interface LoadedSource {
  ref: SourceFileRef;
  /** PDF bytes. For images, a generated one-page A4 PDF. */
  pdfBytes: Uint8Array;
  pdf: PDFDocument;
}

type Kind = 'pdf' | 'png' | 'jpg' | null;

function sniff(bytes: Uint8Array): Kind {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}

const OFFICE_EXT = /\.(docx?|rtf|odt|msg|eml|xlsx?|pptx?|txt|html?)$/i;

export async function imageToA4Pdf(bytes: Uint8Array, kind: 'png' | 'jpg'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const img = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const landscape = img.width > img.height;
  const [pw, ph] = landscape ? [A4.h, A4.w] : [A4.w, A4.h];
  const margin = 28.35; // 10 mm
  const s = Math.min((pw - 2 * margin) / img.width, (ph - 2 * margin) / img.height);
  const page = doc.addPage([pw, ph]);
  const w = img.width * s, h = img.height * s;
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  return doc.save({ updateFieldAppearances: false });
}

/**
 * Load one input file. Throws SourceError with a message that names the file.
 */
export async function loadSource(id: string, name: string, bytes: Uint8Array): Promise<LoadedSource> {
  if (bytes.length === 0) throw new SourceError(name, 'empty', `"${name}" is empty (0 bytes).`);
  const sha256 = await sha256Hex(bytes);
  const kind = sniff(bytes);
  if (!kind) {
    const hint = OFFICE_EXT.test(name)
      ? 'Word, email and other office files are not supported yet. Convert it to PDF first.'
      : 'Only PDF, JPG and PNG files are supported.';
    throw new SourceError(name, 'unsupported', `"${name}" is not a PDF or image. ${hint}`);
  }
  let pdfBytes = bytes;
  if (kind !== 'pdf') {
    try {
      pdfBytes = await imageToA4Pdf(bytes, kind);
    } catch (e) {
      throw new SourceError(name, 'corrupt', `"${name}" could not be opened as a picture. Try opening it and saving it again, then add it again.`);
    }
  }
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(pdfBytes, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'EncryptedPDFError' || /encrypt/i.test(err.message)) {
      throw new SourceError(name, 'encrypted',
        `"${name}" is encrypted or password-protected. Remove the protection (open it and "Print to PDF", or ask the sender for an unprotected copy), then add it again.`);
    }
    throw new SourceError(name, 'corrupt', `"${name}" could not be opened. It may be damaged. Try opening it and saving or printing it again as a PDF, then add it again.`);
  }
  const pageCount = pdf.getPageCount();
  if (pageCount === 0) throw new SourceError(name, 'empty', `"${name}" has no pages.`);
  return {
    ref: { id, name, sha256, kind: kind === 'pdf' ? 'pdf' : 'image', pageCount },
    pdfBytes,
    pdf,
  };
}
